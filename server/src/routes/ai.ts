import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireAdmin, CircleRequest } from '../middleware/circle';
import { encryptCredentials } from '../utils/crypto';
import { assertSafeIntegrationUrl, UnsafeUrlError } from '../utils/urlGuard';
import {
    aiComplete,
    AiError,
    DEFAULT_BASE_URLS,
    loadAiSettingsRow,
    decryptStoredApiKey,
    type AiProvider,
    type AiSettings,
    type AiSettingsRow,
} from '../services/ai';
import {
    PARSE_SCHEMA,
    buildParsePrompt,
    validateParsedItems,
    type CircleMemberRef,
} from '../services/ai/assistant';
import logger from '../lib/logger';

const router = Router();

// All AI settings are scoped to the active care circle (X-Circle-Id header).
router.use(authMiddleware);
router.use(circleMiddleware);

const PROVIDERS: AiProvider[] = ['ollama', 'openai', 'anthropic'];

const toAiSettings = (row: AiSettingsRow): AiSettings => ({
    provider: row.provider,
    base_url: row.base_url,
    api_key: decryptStoredApiKey(row.encrypted_api_key),
    model: row.model,
});

const handleAiError = (res: Response, error: unknown, context: string) => {
    if (error instanceof AiError) {
        // The code is machine-readable (the client maps it to a localized message).
        // The detailed `message` can leak an internal provider URL, so it is only
        // surfaced outside production; in production we send a generic message.
        const body: { success: false; error: string; message?: string } = {
            success: false,
            error: error.code,
        };
        if (process.env.NODE_ENV !== 'production') {
            body.message = error.message;
        }
        return res.status(502).json(body);
    }
    logger.error(`ai.${context}_error`, {
        error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Internal server error' });
};

// GET /api/ai/settings : visible to every circle member; the key NEVER leaves the server.
router.get('/settings', async (req: CircleRequest, res) => {
    try {
        const row = await loadAiSettingsRow(req.circleId!);
        if (!row) {
            return res.json({ success: true, data: { configured: false, enabled: false } });
        }
        res.json({
            success: true,
            data: {
                configured: Boolean(row.model),
                enabled: row.enabled,
                provider: row.provider,
                base_url: row.base_url,
                model: row.model,
                has_api_key: Boolean(row.encrypted_api_key),
                companion_enabled: row.companion_enabled,
            },
        });
    } catch (error) {
        console.error('Get AI settings error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// PUT /api/ai/settings : circle admins only. Empty api_key keeps the stored one,
// explicit null clears it; the key is encrypted at rest (AES-256-GCM).
router.put('/settings', requireAdmin, async (req: CircleRequest, res) => {
    try {
        const { provider, base_url, api_key, model, enabled, companion_enabled } = req.body as {
            provider?: string;
            base_url?: string | null;
            api_key?: string | null;
            model?: string;
            enabled?: boolean;
            companion_enabled?: boolean;
        };

        if (!provider || !PROVIDERS.includes(provider as AiProvider)) {
            return res.status(400).json({ success: false, error: 'provider invalide' });
        }
        const cleanedModel = typeof model === 'string' ? model.trim().slice(0, 100) : '';
        if (!cleanedModel) {
            return res.status(400).json({ success: false, error: 'model est requis' });
        }

        // Anthropic uses the official endpoint, so there is no base URL to store.
        let cleanedBaseUrl: string | null = null;
        if (provider !== 'anthropic') {
            const rawUrl = typeof base_url === 'string' ? base_url.trim().replace(/\/+$/, '') : '';
            if (rawUrl) {
                try {
                    await assertSafeIntegrationUrl(rawUrl);
                } catch (e) {
                    return res.status(400).json({
                        success: false,
                        error: e instanceof UnsafeUrlError ? e.message : 'URL invalide',
                    });
                }
                cleanedBaseUrl = rawUrl;
            }
        }

        // api_key: undefined/'' keeps the existing key; explicit null clears it; string replaces it.
        let encryptedKeyExpr: string | null | undefined;
        if (api_key === null) {
            encryptedKeyExpr = null;
        } else if (typeof api_key === 'string' && api_key.trim()) {
            encryptedKeyExpr = encryptCredentials({ api_key: api_key.trim() });
        } else {
            encryptedKeyExpr = undefined; // keep
        }

        const result = await query(
            `INSERT INTO ai_settings (circle_id, provider, base_url, encrypted_api_key, model, enabled, companion_enabled)
             VALUES ($1, $2, $3, $4, $5, $6, $8)
             ON CONFLICT (circle_id) DO UPDATE SET
               provider = EXCLUDED.provider,
               base_url = EXCLUDED.base_url,
               encrypted_api_key = CASE WHEN $7 THEN EXCLUDED.encrypted_api_key ELSE ai_settings.encrypted_api_key END,
               model = EXCLUDED.model,
               enabled = EXCLUDED.enabled,
               companion_enabled = EXCLUDED.companion_enabled,
               updated_at = NOW()
             RETURNING provider, base_url, encrypted_api_key, model, enabled, companion_enabled`,
            [
                req.circleId,
                provider,
                cleanedBaseUrl,
                encryptedKeyExpr === undefined ? null : encryptedKeyExpr,
                cleanedModel,
                enabled === undefined ? true : Boolean(enabled),
                encryptedKeyExpr !== undefined, // $7: replace/clear the key?
                Boolean(companion_enabled), // $8
            ]
        );

        const row = result.rows[0] as AiSettingsRow;
        res.json({
            success: true,
            data: {
                configured: Boolean(row.model),
                enabled: row.enabled,
                provider: row.provider,
                base_url: row.base_url,
                model: row.model,
                has_api_key: Boolean(row.encrypted_api_key),
                companion_enabled: row.companion_enabled,
            },
        });
    } catch (error) {
        console.error('Update AI settings error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/ai/test : circle admins only, trivial completion through the abstraction.
// Body fields override the saved settings so "Tester" works before saving;
// an empty api_key falls back to the stored (decrypted) one.
router.post('/test', requireAdmin, async (req: CircleRequest, res) => {
    try {
        const row = await loadAiSettingsRow(req.circleId!);
        const body = req.body as { provider?: string; base_url?: string; api_key?: string; model?: string };

        const provider = (PROVIDERS.includes(body.provider as AiProvider) ? body.provider : row?.provider) as
            | AiProvider
            | undefined;
        const model = (typeof body.model === 'string' && body.model.trim()) || row?.model || '';
        if (!provider || !model) {
            return res.status(400).json({ success: false, error: 'AI_NOT_CONFIGURED' });
        }

        const settings: AiSettings = {
            provider,
            base_url:
                (typeof body.base_url === 'string' && body.base_url.trim().replace(/\/+$/, '')) ||
                row?.base_url ||
                DEFAULT_BASE_URLS[provider],
            api_key:
                (typeof body.api_key === 'string' && body.api_key.trim()) ||
                decryptStoredApiKey(row?.encrypted_api_key ?? null),
            model: model.trim().slice(0, 100),
        };

        const result = await aiComplete(settings, {
            system: 'Tu es un test de connexion. Réponds uniquement en JSON.',
            user: 'Réponds avec {"ok":true}',
            jsonSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['ok'],
                properties: { ok: { type: 'boolean' } },
            },
        });

        if (result.ok !== true) {
            return res.status(502).json({
                success: false,
                error: 'AI_INVALID_RESPONSE',
                message: 'Le modèle a répondu, mais pas le JSON attendu',
            });
        }
        res.json({ success: true, message: 'OK' });
    } catch (error) {
        handleAiError(res, error, 'test');
    }
});

/** Loads + checks the circle's configured & enabled settings, or sends the 4xx response. */
const requireConfiguredAi = async (req: CircleRequest, res: Response): Promise<AiSettings | null> => {
    const row = await loadAiSettingsRow(req.circleId!);
    if (!row || !row.model) {
        res.status(400).json({ success: false, error: 'AI_NOT_CONFIGURED' });
        return null;
    }
    if (!row.enabled) {
        res.status(400).json({ success: false, error: 'AI_DISABLED' });
        return null;
    }
    return toAiSettings(row);
};

// POST /api/ai/parse : any circle member, natural-language note to validated proposals.
// Nothing is saved: the client confirms then POSTs to the existing endpoints.
router.post('/parse', async (req: CircleRequest, res) => {
    try {
        const settings = await requireConfiguredAi(req, res);
        if (!settings) return;

        const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
        if (!text) {
            return res.status(400).json({ success: false, error: 'text est requis' });
        }

        const membersResult = await query(
            `SELECT m.id, u.name
             FROM circle_members m
             JOIN users u ON u.id = m.user_id
             WHERE m.circle_id = $1
             ORDER BY u.name`,
            [req.circleId]
        );
        const members = membersResult.rows as CircleMemberRef[];

        const raw = await aiComplete(settings, {
            system: buildParsePrompt(members),
            user: text.slice(0, 2000),
            jsonSchema: PARSE_SCHEMA,
        });

        const items = validateParsedItems(raw, members);
        res.json({ success: true, data: { items } });
    } catch (error) {
        handleAiError(res, error, 'parse');
    }
});

export default router;

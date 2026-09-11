import { Router } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireAdmin, CircleRequest } from '../middleware/circle';
import { encryptCredentials } from '../utils/crypto';
import { assertSafeIntegrationUrl, UnsafeUrlError } from '../utils/urlGuard';
import { safeFetch } from '../utils/safeFetch';
import { testHomeAssistantConnection, syncHomeAssistant } from '../services/integrations/homeassistant';
import { testGrocyConnection, syncGrocy } from '../services/integrations/grocy';
import { testNextcloudConnection, syncNextcloud } from '../services/integrations/nextcloud';
import { testImmichConnection, syncImmich, fetchImmichRandomPhoto } from '../services/integrations/immich';
import { broadcastToCircle } from '../lib/broadcaster';

const router = Router();

// All integrations are scoped to the active care circle (X-Circle-Id header).
router.use(authMiddleware);
router.use(circleMiddleware);

const INTEGRATION_TYPES = ['homeassistant', 'grocy', 'nextcloud', 'immich', 'whisper'] as const;

// Whisper (speaches / faster-whisper-server, API compatible OpenAI): un simple
// GET /v1/models suffit à vérifier que le service répond (clé Bearer optionnelle).
async function testWhisperConnection(baseUrl: string, apiKey?: string): Promise<{ success: boolean; message: string }> {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    try {
        // safeFetch validates + pins the target and applies the 10s timeout.
        const response = await safeFetch(`${baseUrl}/v1/models`, { headers }, { timeoutMs: 10_000 });
        if (response.status === 401 || response.status === 403) {
            return { success: false, message: 'Clé API Whisper invalide' };
        }
        if (!response.ok) {
            return { success: false, message: `Le service Whisper a répondu ${response.status}` };
        }
        return { success: true, message: 'Connexion au service Whisper réussie' };
    } catch (e) {
        if (e instanceof UnsafeUrlError) {
            return { success: false, message: e.message };
        }
        const message = e instanceof Error && e.name === 'AbortError'
            ? 'Le service Whisper ne répond pas (10s)'
            : 'Service Whisper injoignable';
        return { success: false, message };
    }
}

// GET /api/integrations : every circle member can see what is connected
router.get('/', async (req: CircleRequest, res) => {
    try {
        const result = await query(
            `SELECT id, type, display_name, base_url, config, status, last_synced_at, last_error, created_at
             FROM integrations WHERE circle_id = $1 ORDER BY type`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows });
    } catch {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/integrations/immich/photo - proxy a random photo from the circle's
// Immich instance (the Immich API key never reaches the browser).
router.get('/immich/photo', async (req: CircleRequest, res) => {
    try {
        const result = await query(
            `SELECT base_url, encrypted_credentials FROM integrations
             WHERE circle_id = $1 AND type = 'immich'`,
            [req.circleId]
        );
        const integ = result.rows[0] as { base_url: string; encrypted_credentials: string | null } | undefined;
        if (!integ || !integ.encrypted_credentials) {
            return res.status(404).json({ success: false, error: 'Aucune integration Immich configuree' });
        }

        // Re-validate the stored URL at use time (DNS answers can change).
        await assertSafeIntegrationUrl(integ.base_url);

        const photo = await fetchImmichRandomPhoto(integ.base_url, integ.encrypted_credentials);
        res.set('Content-Type', photo.contentType);
        res.set('Cache-Control', 'no-store');
        res.send(photo.buffer);
    } catch (e) {
        if (e instanceof UnsafeUrlError) {
            return res.status(400).json({ success: false, error: e.message });
        }
        res.status(502).json({ success: false, error: 'Immich indisponible' });
    }
});

// POST /api/integrations/test - test without saving (circle admins)
router.post('/test', requireAdmin, async (req: CircleRequest, res) => {
    const { type, base_url, apiKey, token } = req.body as Record<string, string>;
    const cleanUrl = (base_url || '').replace(/\/$/, '');

    try {
        await assertSafeIntegrationUrl(cleanUrl);

        let result: { success: boolean; message: string };
        switch (type) {
            case 'homeassistant': result = await testHomeAssistantConnection(cleanUrl, token); break;
            case 'grocy':         result = await testGrocyConnection(cleanUrl, apiKey); break;
            case 'nextcloud':     result = await testNextcloudConnection(cleanUrl, (req.body as Record<string, string>).username, (req.body as Record<string, string>).password); break;
            case 'immich':        result = await testImmichConnection(cleanUrl, apiKey); break;
            case 'whisper':       result = await testWhisperConnection(cleanUrl, apiKey); break;
            default:              result = { success: false, message: "Type d'integration inconnu" };
        }
        res.json(result);
    } catch (e) {
        res.json({ success: false, message: e instanceof Error ? e.message : 'Erreur inconnue' });
    }
});

// POST /api/integrations - connect (circle admins)
router.post('/', requireAdmin, async (req: CircleRequest, res) => {
    const { type, base_url, display_name, config: configFromBody, apiKey, token, username, password, ha_entity_id } = req.body as Record<string, string> & { config?: object };

    if (!type || !base_url) {
        return res.status(400).json({ success: false, error: 'type et base_url sont requis' });
    }
    if (!(INTEGRATION_TYPES as readonly string[]).includes(type)) {
        return res.status(400).json({ success: false, error: "Type d'integration inconnu" });
    }

    const credentials: Record<string, string> = {};
    if (apiKey) credentials.apiKey = apiKey;
    if (token) credentials.token = token;
    if (username) credentials.username = username;
    if (password) credentials.password = password;

    // Merge any integration-specific config fields
    const extraConfig: Record<string, string> = {};
    if (ha_entity_id) extraConfig.ha_entity_id = ha_entity_id;
    const config = Object.keys(extraConfig).length > 0 ? { ...(configFromBody || {}), ...extraConfig } : (configFromBody || {});

    const cleanUrl = base_url.replace(/\/$/, '');

    // Validate the URL at save time (it is validated again at every use).
    try {
        await assertSafeIntegrationUrl(cleanUrl);
    } catch (e) {
        return res.status(400).json({ success: false, error: e instanceof UnsafeUrlError ? e.message : 'URL invalide' });
    }

    const encrypted = Object.keys(credentials).length > 0 ? encryptCredentials(credentials) : null;

    try {
        const result = await query(
            `INSERT INTO integrations (circle_id, type, display_name, base_url, encrypted_credentials, config, status)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'connected')
             ON CONFLICT (circle_id, type) DO UPDATE SET
               display_name = EXCLUDED.display_name,
               base_url = EXCLUDED.base_url,
               encrypted_credentials = COALESCE(EXCLUDED.encrypted_credentials, integrations.encrypted_credentials),
               config = EXCLUDED.config,
               status = 'connected',
               last_error = NULL,
               updated_at = NOW()
             RETURNING id, type, display_name, base_url, config, status, last_synced_at, created_at`,
            [req.circleId, type, display_name || type, cleanUrl, encrypted, JSON.stringify(config || {})]
        );
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'integrations', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/integrations/:id/sync (circle admins)
router.post('/:id/sync', requireAdmin, async (req: CircleRequest, res) => {
    try {
        const integResult = await query(
            'SELECT * FROM integrations WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (integResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Integration introuvable' });
        }

        const integ = integResult.rows[0] as {
            id: string; type: string; base_url: string;
            encrypted_credentials: string; config: Record<string, unknown>;
        };

        await query("UPDATE integrations SET status = 'syncing', updated_at = NOW() WHERE id = $1", [integ.id]);

        try {
            // Re-validate the stored URL at use time (DNS answers can change).
            await assertSafeIntegrationUrl(integ.base_url);

            let syncResult: { imported: number; errors: number };

            switch (integ.type) {
                case 'homeassistant': syncResult = await syncHomeAssistant(integ.id, req.circleId!, integ.base_url, integ.encrypted_credentials, integ.config || {}); break;
                case 'grocy':         syncResult = await syncGrocy(integ.id, req.circleId!, integ.base_url, integ.encrypted_credentials); break;
                case 'nextcloud':     syncResult = await syncNextcloud(integ.id, req.circleId!, integ.base_url, integ.encrypted_credentials, integ.config || {}); break;
                case 'immich':        syncResult = await syncImmich(integ.id, req.circleId!, integ.base_url, integ.encrypted_credentials); break;
                // Whisper est appelé à la demande (transcription): rien à synchroniser.
                case 'whisper':       syncResult = { imported: 0, errors: 0 }; break;
                default: throw new Error('Type inconnu');
            }

            await query(
                "UPDATE integrations SET status = 'connected', last_synced_at = NOW(), last_error = NULL, updated_at = NOW() WHERE id = $1",
                [integ.id]
            );

            await broadcastToCircle(req.circleId!, { type: 'update', entity: 'integrations', action: 'synced' });
            res.json({ success: true, data: syncResult });
        } catch (syncError) {
            const msg = syncError instanceof Error ? syncError.message : 'Sync error';
            await query("UPDATE integrations SET status = 'error', last_error = $2, updated_at = NOW() WHERE id = $1", [integ.id, msg]);
            res.status(500).json({ success: false, error: msg });
        }
    } catch {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// DELETE /api/integrations/:id (circle admins)
router.delete('/:id', requireAdmin, async (req: CircleRequest, res) => {
    try {
        const result = await query(
            'DELETE FROM integrations WHERE id = $1 AND circle_id = $2 RETURNING id',
            [req.params.id, req.circleId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Integration introuvable' });
        }
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'integrations', action: 'deleted' });
        res.json({ success: true });
    } catch {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

import { Router, Response } from 'express';
import { query, getClient } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireJournalWriter, CircleRequest } from '../middleware/circle';
import { decryptCredentials } from '../utils/crypto';
import { UnsafeUrlError } from '../utils/urlGuard';
import { safeFetch } from '../utils/safeFetch';
import { aiComplete, getAiSettings } from '../services/ai';
import {
    VOICE_JOURNAL_SCHEMA,
    buildVoiceJournalPrompt,
    validateVoiceJournal,
    type VoiceJournalResult,
} from '../services/ai/assistant';
import { broadcastToCircle } from '../lib/broadcaster';
import logger from '../lib/logger';

// Journal vocal: l'aidant dicte une note, le serveur la transcrit via un
// service Whisper auto-hébergé compatible OpenAI (speaches, faster-whisper-server)
// configuré dans integrations (type 'whisper'), puis l'IA du cercle range la
// dictée en entrée de journal + articles de courses.

const router = Router();

router.use(authMiddleware);
router.use(circleMiddleware);

// data URL audio: type MIME de base + paramètres optionnels (;codecs=opus) + base64
const AUDIO_DATA_URL_REGEX = /^data:(audio\/[a-z0-9.+-]+)((?:;[a-zA-Z0-9.+=_-]+)*);base64,([A-Za-z0-9+/]+={0,2})$/;
const ALLOWED_AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/mpeg'];
const AUDIO_EXTENSIONS: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'mp4',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mpeg': 'mp3',
};
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const DEFAULT_WHISPER_MODEL = 'Systran/faster-whisper-small';
const DEFAULT_WHISPER_LANGUAGE = 'fr';
const MAX_TEXT_LENGTH = 8000;

/** Approximate decoded size of a base64 payload without allocating a buffer */
const base64ByteSize = (base64: string): number => {
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
};

interface WhisperIntegration {
    base_url: string;
    encrypted_credentials: string | null;
    config: Record<string, unknown> | null;
}

/** The circle's whisper integration, or null when not configured. */
async function loadWhisperIntegration(circleId: string): Promise<WhisperIntegration | null> {
    const result = await query(
        `SELECT base_url, encrypted_credentials, config FROM integrations
         WHERE circle_id = $1 AND type = 'whisper'`,
        [circleId]
    );
    return (result.rows[0] as WhisperIntegration) ?? null;
}

// POST /api/voice/transcribe : { audio: data URL } -> { text }
// Sent as multipart/form-data to <base_url>/v1/audio/transcriptions
// (OpenAI-compatible Whisper endpoint). Node 20: FormData/Blob globals.
router.post('/transcribe', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    try {
        const audio = typeof req.body?.audio === 'string' ? req.body.audio : '';
        const match = audio.match(AUDIO_DATA_URL_REGEX);
        if (!match) {
            return res.status(400).json({
                success: false,
                error: 'audio must be a base64 audio data URL (webm, ogg, mp4 or wav)',
            });
        }
        const baseType = match[1].toLowerCase();
        if (!ALLOWED_AUDIO_TYPES.includes(baseType)) {
            return res.status(400).json({ success: false, error: `Unsupported audio type: ${baseType}` });
        }
        if (base64ByteSize(match[3]) > MAX_AUDIO_BYTES) {
            return res.status(400).json({ success: false, error: 'Audio must be at most 10 MB' });
        }

        const integration = await loadWhisperIntegration(req.circleId!);
        if (!integration) {
            return res.status(400).json({ success: false, error: 'WHISPER_NOT_CONFIGURED' });
        }

        // The stored URL is re-validated AND its IP pinned at request time by
        // safeFetch below (DNS answers can change between save and use).

        // Optional Bearer key, encrypted at rest like every integration credential.
        let apiKey: string | null = null;
        if (integration.encrypted_credentials) {
            try {
                apiKey = decryptCredentials(integration.encrypted_credentials).apiKey ?? null;
            } catch {
                apiKey = null;
            }
        }

        const config = integration.config ?? {};
        const model = typeof config.model === 'string' && config.model.trim()
            ? config.model.trim()
            : DEFAULT_WHISPER_MODEL;
        const language = typeof config.language === 'string' && config.language.trim()
            ? config.language.trim()
            : DEFAULT_WHISPER_LANGUAGE;

        const buffer = Buffer.from(match[3], 'base64');
        const form = new FormData();
        form.append(
            'file',
            new Blob([new Uint8Array(buffer)], { type: baseType + match[2] }),
            `audio.${AUDIO_EXTENSIONS[baseType]}`
        );
        form.append('model', model);
        form.append('language', language);

        const headers: Record<string, string> = {};
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

        // Type via safeFetch's return to avoid colliding with Express's Response.
        let response: Awaited<ReturnType<typeof safeFetch>>;
        try {
            // safeFetch validates the scheme, resolves+validates every IP and PINS
            // the connection to a vetted address, then applies the timeout.
            response = await safeFetch(
                `${integration.base_url.replace(/\/+$/, '')}/v1/audio/transcriptions`,
                { method: 'POST', headers, body: form },
                { timeoutMs: TRANSCRIBE_TIMEOUT_MS }
            );
        } catch (fetchError) {
            // A guard rejection (blocked/metadata host, bad scheme) is surfaced as
            // a 400 by the outer handler, so let UnsafeUrlError propagate.
            if (fetchError instanceof UnsafeUrlError) throw fetchError;
            const detail = fetchError instanceof Error && fetchError.name === 'AbortError'
                ? `Le service Whisper n'a pas répondu en ${TRANSCRIBE_TIMEOUT_MS / 1000}s`
                : 'Service Whisper injoignable';
            return res.status(502).json({ success: false, error: 'WHISPER_UNAVAILABLE', message: detail });
        }

        if (!response.ok) {
            // Do NOT log the raw Whisper response body: it can echo back the
            // transcribed audio or other sensitive content. Keep the status only.
            logger.warn('voice.transcribe_failed', { status: response.status });
            return res.status(502).json({
                success: false,
                error: 'WHISPER_UNAVAILABLE',
                message: `Le service Whisper a répondu ${response.status}`,
            });
        }

        const json = (await response.json().catch(() => null)) as { text?: unknown } | null;
        const text = json && typeof json.text === 'string' ? json.text.trim() : '';
        res.json({ success: true, data: { text } });
    } catch (error) {
        if (error instanceof UnsafeUrlError) {
            return res.status(400).json({ success: false, error: error.message });
        }
        logger.error('voice.transcribe_error', {
            error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/voice/journal : { text } -> the circle's AI files the dictation as
// a clean journal entry + shopping items. Without a configured AI, the raw text
// becomes a plain 'note' entry and no shopping item is created.
router.post('/journal', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, MAX_TEXT_LENGTH) : '';
    if (!text) {
        return res.status(400).json({ success: false, error: 'text is required' });
    }

    let filed: VoiceJournalResult = { type: 'note', content: text, shopping_items: [] };
    try {
        const settings = await getAiSettings(req.circleId!);
        if (settings) {
            const raw = await aiComplete(settings, {
                system: buildVoiceJournalPrompt(),
                user: text,
                jsonSchema: VOICE_JOURNAL_SCHEMA,
            });
            filed = validateVoiceJournal(raw, text);
        }
    } catch (aiError) {
        // Graceful degradation: the dictation is never lost, it lands as a raw note.
        logger.warn('voice.journal_ai_failed', {
            error: aiError instanceof Error ? aiError.message : String(aiError),
        });
        filed = { type: 'note', content: text, shopping_items: [] };
    }

    const client = await getClient();
    try {
        const userResult = await client.query('SELECT name FROM users WHERE id = $1', [req.userId]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        const authorName = userResult.rows[0].name;

        await client.query('BEGIN');

        const entryResult = await client.query(
            `INSERT INTO journal_entries (circle_id, author_user_id, author_name, type, content)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [req.circleId, req.userId, authorName, filed.type, filed.content]
        );
        const entry = entryResult.rows[0];

        const savedItems = [];
        for (const name of filed.shopping_items) {
            const itemResult = await client.query(
                `INSERT INTO shopping_items (circle_id, name, category, added_by)
                 VALUES ($1, $2, $3, $4) RETURNING *`,
                [req.circleId, name, 'Autre', req.userId]
            );
            savedItems.push(itemResult.rows[0]);
        }

        await client.query('COMMIT');

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'journal', action: 'created' });
        if (savedItems.length > 0) {
            await broadcastToCircle(req.circleId!, { type: 'update', entity: 'shopping', action: 'created' });
        }

        res.json({ success: true, data: { entry: { ...entry, photos: [] }, shopping_items: savedItems } });
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('voice.journal_error', {
            error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
        client.release();
    }
});

export default router;

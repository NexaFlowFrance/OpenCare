import { Router, Response } from 'express';
import { query, getClient } from '../db';
import { authMiddleware } from '../middleware/auth';
import {
    circleMiddleware,
    requireJournalWriter,
    caregiverLinkMiddleware,
    CircleRequest,
    CaregiverLinkRequest,
} from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';

const router = Router();

const JOURNAL_ENTRY_TYPES = ['visit', 'note', 'vital', 'medication', 'incident', 'mood'];
// Magic links cannot log medication entries (intakes are confirmed elsewhere)
const LINK_ENTRY_TYPES = ['visit', 'note', 'vital', 'mood', 'incident'];
const VITAL_TYPES = ['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'];

const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = Math.floor(1.5 * 1024 * 1024);
// Strict allowlist: raster images only. SVG is excluded on purpose (stored XSS via
// embedded scripts when a data URL is rendered inline).
const IMAGE_DATA_URL_REGEX = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i;

/** Approximate decoded size of a base64 payload without allocating a buffer */
const base64ByteSize = (base64: string): number => {
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
};

const parseDate = (value: unknown): Date | null => {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
};

/** Lateral join aggregating the photos of each entry as a JSON array */
const PHOTO_JOIN = `
    LEFT JOIN LATERAL (
        SELECT COALESCE(json_agg(json_build_object(
            'id', p.id,
            'entry_id', p.entry_id,
            'file_path', p.file_path,
            'mime_type', p.mime_type,
            'size_bytes', p.size_bytes,
            'created_at', p.created_at
        ) ORDER BY p.created_at), '[]'::json) AS photos
        FROM journal_photos p
        WHERE p.entry_id = e.id
    ) ph ON TRUE`;

// ============================================================
// Magic link routes (no account): caregiverLinkMiddleware only.
// Registered before the authenticated block below.
// ============================================================

// Today's overview for an external caregiver: entries, recipient first name,
// medication intakes of the day, link display name.
router.get('/link/:linkToken/today', caregiverLinkMiddleware, async (req: CaregiverLinkRequest, res: Response) => {
    try {
        const link = req.caregiverLink!;
        const circleId = link.circle_id;

        const [entriesResult, recipientResult, intakesResult] = await Promise.all([
            query(
                `SELECT e.*, ph.photos
                 FROM journal_entries e
                 ${PHOTO_JOIN}
                 WHERE e.circle_id = $1
                   AND e.occurred_at >= date_trunc('day', CURRENT_TIMESTAMP)
                   AND e.occurred_at < date_trunc('day', CURRENT_TIMESTAMP) + INTERVAL '1 day'
                 ORDER BY e.occurred_at DESC`,
                [circleId]
            ),
            query('SELECT first_name FROM care_recipients WHERE circle_id = $1', [circleId]),
            query(
                `SELECT i.id, i.medication_id, i.schedule_id, i.due_at, i.status, i.confirmed_at,
                        m.name AS medication_name, m.dosage, m.form, m.instructions
                 FROM medication_intakes i
                 JOIN medications m ON m.id = i.medication_id
                 WHERE i.circle_id = $1
                   AND i.due_at >= date_trunc('day', CURRENT_TIMESTAMP)
                   AND i.due_at < date_trunc('day', CURRENT_TIMESTAMP) + INTERVAL '1 day'
                 ORDER BY i.due_at`,
                [circleId]
            ),
        ]);

        res.json({
            success: true,
            data: {
                display_name: link.display_name,
                role_label: link.role_label ?? null,
                recipient_first_name: recipientResult.rows[0]?.first_name ?? null,
                entries: entriesResult.rows,
                intakes: intakesResult.rows,
            },
        });
    } catch (error) {
        console.error('Caregiver link today error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Write a journal entry through a magic link (no account)
router.post('/link/:linkToken/entries', caregiverLinkMiddleware, async (req: CaregiverLinkRequest, res: Response) => {
    try {
        const link = req.caregiverLink!;
        const { type, content, occurred_at } = req.body;

        if (typeof type !== 'string' || !LINK_ENTRY_TYPES.includes(type)) {
            return res.status(400).json({ success: false, error: 'Invalid entry type' });
        }
        if (typeof content !== 'string' || !content.trim()) {
            return res.status(400).json({ success: false, error: 'Content is required' });
        }

        let occurredAt: Date | null = null;
        if (occurred_at !== undefined && occurred_at !== null) {
            occurredAt = parseDate(occurred_at);
            if (!occurredAt) {
                return res.status(400).json({ success: false, error: 'Invalid occurred_at date' });
            }
        }

        const result = await query(
            `INSERT INTO journal_entries (circle_id, caregiver_link_id, author_name, type, content, occurred_at)
             VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_TIMESTAMP))
             RETURNING *`,
            [link.circle_id, link.id, link.display_name, type, content.trim(), occurredAt]
        );

        await broadcastToCircle(link.circle_id, { type: 'update', entity: 'journal', action: 'created' });
        res.json({ success: true, data: { ...result.rows[0], photos: [] } });
    } catch (error) {
        console.error('Caregiver link create entry error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================================
// Authenticated routes (member of the circle)
// ============================================================
router.use(authMiddleware, circleMiddleware);

// Paginated list of the circle's entries, most recent first, with photos.
// Cursor pagination via ?before=<occurred_at>. Neighbors only see the last 7 days.
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const parsedLimit = parseInt(String(req.query.limit), 10);
        const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 50 : parsedLimit, 1), 200);

        const conditions: string[] = ['e.circle_id = $1'];
        const values: unknown[] = [req.circleId];
        let idx = 2;

        if (typeof req.query.before === 'string' && req.query.before) {
            const before = parseDate(req.query.before);
            if (!before) {
                return res.status(400).json({ success: false, error: 'Invalid before cursor' });
            }
            conditions.push(`e.occurred_at < $${idx++}`);
            values.push(before);
        }

        if (typeof req.query.type === 'string' && req.query.type) {
            if (!JOURNAL_ENTRY_TYPES.includes(req.query.type)) {
                return res.status(400).json({ success: false, error: 'Invalid entry type' });
            }
            conditions.push(`e.type = $${idx++}`);
            values.push(req.query.type);
        }

        if (typeof req.query.author === 'string' && req.query.author) {
            conditions.push(`e.author_user_id = $${idx++}`);
            values.push(req.query.author);
        }

        // Neighbors have a partial read scope: the last 7 days only
        if (req.circleRole === 'neighbor') {
            conditions.push(`e.occurred_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'`);
        }

        values.push(limit);
        const result = await query(
            `SELECT e.*, ph.photos
             FROM journal_entries e
             ${PHOTO_JOIN}
             WHERE ${conditions.join(' AND ')}
             ORDER BY e.occurred_at DESC
             LIMIT $${idx}`,
            values
        );

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List journal entries error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create an entry (every role except viewer). Optional photos as image data URLs
// (the client compresses before upload). A 'vital' entry whose data carries a
// measurement also feeds the vitals table, linked by journal_entry_id.
router.post('/', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    const { type, content, data, occurred_at, photos } = req.body;

    if (typeof type !== 'string' || !JOURNAL_ENTRY_TYPES.includes(type)) {
        return res.status(400).json({ success: false, error: 'Invalid entry type' });
    }

    // Le role neighbor ecrit des notes simples: pas d'entrees de sante
    // (les types vital/medication alimentent les donnees medicales du cercle).
    if (req.circleRole === 'neighbor' && (type === 'vital' || type === 'medication')) {
        return res.status(403).json({ success: false, error: 'Insufficient role' });
    }

    const cleanContent = typeof content === 'string' ? content : '';
    const cleanData: Record<string, unknown> =
        data && typeof data === 'object' && !Array.isArray(data) ? data : {};

    let occurredAt: Date | null = null;
    if (occurred_at !== undefined && occurred_at !== null) {
        occurredAt = parseDate(occurred_at);
        if (!occurredAt) {
            return res.status(400).json({ success: false, error: 'Invalid occurred_at date' });
        }
    }

    // Validate photos before opening the transaction
    const cleanPhotos: Array<{ dataUrl: string; mimeType: string; sizeBytes: number }> = [];
    if (photos !== undefined && photos !== null) {
        if (!Array.isArray(photos) || photos.length > MAX_PHOTOS) {
            return res.status(400).json({ success: false, error: `Photos must be an array of at most ${MAX_PHOTOS} images` });
        }
        for (const photo of photos) {
            const match = typeof photo === 'string' ? photo.match(IMAGE_DATA_URL_REGEX) : null;
            if (!match) {
                return res.status(400).json({ success: false, error: 'Photos must be base64 image data URLs' });
            }
            const sizeBytes = base64ByteSize(match[2]);
            if (sizeBytes > MAX_PHOTO_BYTES) {
                return res.status(400).json({ success: false, error: 'Each photo must be at most 1.5 MB' });
            }
            cleanPhotos.push({ dataUrl: photo, mimeType: match[1].toLowerCase(), sizeBytes });
        }
    }

    // Validate the optional structured vital measurement before the transaction
    let vitalPayload: { vital_type: string; value: number; value2: number | null; unit: string | null } | null = null;
    if (type === 'vital' && cleanData.vital_type !== undefined) {
        const vitalType = cleanData.vital_type;
        if (typeof vitalType !== 'string' || !VITAL_TYPES.includes(vitalType)) {
            return res.status(400).json({ success: false, error: 'Invalid vital type' });
        }
        const value = Number(cleanData.value);
        if (!Number.isFinite(value)) {
            return res.status(400).json({ success: false, error: 'Invalid vital value' });
        }
        let value2: number | null = null;
        if (cleanData.value2 !== undefined && cleanData.value2 !== null) {
            value2 = Number(cleanData.value2);
            if (!Number.isFinite(value2)) {
                return res.status(400).json({ success: false, error: 'Invalid vital value2' });
            }
        }
        const unit = typeof cleanData.unit === 'string' && cleanData.unit.trim() ? cleanData.unit.trim() : null;
        vitalPayload = { vital_type: vitalType, value, value2, unit };
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
            `INSERT INTO journal_entries (circle_id, author_user_id, author_name, type, content, data, occurred_at)
             VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, CURRENT_TIMESTAMP))
             RETURNING *`,
            [req.circleId, req.userId, authorName, type, cleanContent, JSON.stringify(cleanData), occurredAt]
        );
        const entry = entryResult.rows[0];

        const savedPhotos = [];
        for (const photo of cleanPhotos) {
            const photoResult = await client.query(
                `INSERT INTO journal_photos (entry_id, file_path, mime_type, size_bytes)
                 VALUES ($1, $2, $3, $4) RETURNING *`,
                [entry.id, photo.dataUrl, photo.mimeType, photo.sizeBytes]
            );
            savedPhotos.push(photoResult.rows[0]);
        }

        if (vitalPayload) {
            await client.query(
                `INSERT INTO vitals (circle_id, type, value, value2, unit, measured_at, journal_entry_id, recorded_by_user)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    req.circleId,
                    vitalPayload.vital_type,
                    vitalPayload.value,
                    vitalPayload.value2,
                    vitalPayload.unit,
                    entry.occurred_at,
                    entry.id,
                    req.userId,
                ]
            );
        }

        await client.query('COMMIT');

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'journal', action: 'created' });
        if (vitalPayload) {
            await broadcastToCircle(req.circleId!, { type: 'update', entity: 'vitals', action: 'created' });
        }

        res.json({ success: true, data: { ...entry, photos: savedPhotos } });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Create journal entry error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Update an entry: its author, or any entry if admin
router.put('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT id, author_user_id FROM journal_entries WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Entry not found' });
        }
        const isAuthor = existing.rows[0].author_user_id === req.userId;
        if (!isAuthor && req.circleRole !== 'admin') {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }

        const { content, data, occurred_at, type } = req.body;
        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (typeof content === 'string') {
            fields.push(`content = $${idx++}`);
            values.push(content);
        }
        if (data !== undefined) {
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                return res.status(400).json({ success: false, error: 'Invalid data payload' });
            }
            fields.push(`data = $${idx++}`);
            values.push(JSON.stringify(data));
        }
        if (occurred_at !== undefined) {
            const occurredAt = parseDate(occurred_at);
            if (!occurredAt) {
                return res.status(400).json({ success: false, error: 'Invalid occurred_at date' });
            }
            fields.push(`occurred_at = $${idx++}`);
            values.push(occurredAt);
        }
        if (type !== undefined) {
            if (typeof type !== 'string' || !JOURNAL_ENTRY_TYPES.includes(type)) {
                return res.status(400).json({ success: false, error: 'Invalid entry type' });
            }
            fields.push(`type = $${idx++}`);
            values.push(type);
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No changes provided' });
        }

        values.push(req.params.id, req.circleId);
        const result = await query(
            `UPDATE journal_entries SET ${fields.join(', ')} WHERE id = $${idx} AND circle_id = $${idx + 1} RETURNING *`,
            values
        );

        const photosResult = await query(
            'SELECT * FROM journal_photos WHERE entry_id = $1 ORDER BY created_at',
            [req.params.id]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'journal', action: 'updated' });
        res.json({ success: true, data: { ...result.rows[0], photos: photosResult.rows } });
    } catch (error) {
        console.error('Update journal entry error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete an entry: its author, or any entry if admin
router.delete('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT id, author_user_id FROM journal_entries WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Entry not found' });
        }
        const isAuthor = existing.rows[0].author_user_id === req.userId;
        if (!isAuthor && req.circleRole !== 'admin') {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }

        await query('DELETE FROM journal_entries WHERE id = $1 AND circle_id = $2', [req.params.id, req.circleId]);

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'journal', action: 'deleted' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete journal entry error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

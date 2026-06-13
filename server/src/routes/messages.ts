import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireJournalWriter, CircleRequest } from '../middleware/circle';
import { broadcast, broadcastToCircle, WsAction, WsUpdatePayload } from '../lib/broadcaster';

const router = Router();

router.use(authMiddleware, circleMiddleware);

const MAX_CONTENT_LENGTH = 5000;
const MAX_ATTACHMENTS = 2;
const MAX_ATTACHMENT_BYTES = Math.floor(1.5 * 1024 * 1024);
// Strict allowlist: raster images or PDF only. SVG is excluded on purpose (stored
// XSS via embedded scripts when a data URL is rendered inline).
const ATTACHMENT_DATA_URL_REGEX = /^data:(image\/(?:png|jpe?g|webp|gif)|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/i;

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

const parseLimit = (raw: unknown): number => {
    const parsed = parseInt(String(raw), 10);
    return Math.min(Math.max(Number.isNaN(parsed) ? 50 : parsed, 1), 200);
};

const MESSAGE_SELECT = `
    SELECT m.id, m.circle_id, m.channel, m.author_user_id, m.recipient_user_id,
           m.content, m.attachments, m.edited_at, m.created_at,
           u.name AS author_name, u.avatar_url AS author_avatar
    FROM messages m
    JOIN users u ON u.id = m.author_user_id`;

/** DM updates are pushed to the two participants only, never to the whole circle */
const broadcastDm = (circleId: string, authorId: string, recipientId: string | null, action: WsAction): void => {
    const payload: WsUpdatePayload = { type: 'update', entity: 'messages', action, circleId };
    broadcast(authorId, payload);
    if (recipientId && recipientId !== authorId) {
        broadcast(recipientId, payload);
    }
};

const isCircleMember = async (circleId: string, userId: string): Promise<boolean> => {
    const result = await query(
        'SELECT 1 FROM circle_members WHERE circle_id = $1 AND user_id = $2',
        [circleId, userId]
    );
    return result.rows.length > 0;
};

// Circle feed, most recent first. Cursor pagination via ?before=<created_at>.
// Viewers have read access to the feed.
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const limit = parseLimit(req.query.limit);

        const conditions: string[] = ["m.circle_id = $1", "m.channel = 'circle'"];
        const values: unknown[] = [req.circleId];
        let idx = 2;

        if (typeof req.query.before === 'string' && req.query.before) {
            const before = parseDate(req.query.before);
            if (!before) {
                return res.status(400).json({ success: false, error: 'Invalid before cursor' });
            }
            conditions.push(`m.created_at < $${idx++}`);
            values.push(before);
        }

        values.push(limit);
        const result = await query(
            `${MESSAGE_SELECT}
             WHERE ${conditions.join(' AND ')}
             ORDER BY m.created_at DESC
             LIMIT $${idx}`,
            values
        );

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List messages error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// List the user's DM conversations in this circle: one row per interlocutor
// with the last exchanged message and its timestamp.
router.get('/dm', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT conv.other_user_id, u.name AS other_user_name, u.avatar_url AS other_user_avatar,
                    conv.id AS last_message_id, conv.author_user_id AS last_author_user_id,
                    conv.content AS last_message, conv.created_at AS last_message_at
             FROM (
                 SELECT DISTINCT ON (CASE WHEN m.author_user_id = $2 THEN m.recipient_user_id ELSE m.author_user_id END)
                        m.id, m.author_user_id, m.content, m.created_at,
                        CASE WHEN m.author_user_id = $2 THEN m.recipient_user_id ELSE m.author_user_id END AS other_user_id
                 FROM messages m
                 WHERE m.circle_id = $1
                   AND m.channel = 'dm'
                   AND (m.author_user_id = $2 OR m.recipient_user_id = $2)
                 ORDER BY CASE WHEN m.author_user_id = $2 THEN m.recipient_user_id ELSE m.author_user_id END,
                          m.created_at DESC
             ) conv
             JOIN users u ON u.id = conv.other_user_id
             ORDER BY conv.created_at DESC`,
            [req.circleId, req.userId]
        );

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List DM conversations error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// DM thread between the logged-in user and :userId within this circle,
// both directions, same cursor pagination as the circle feed.
router.get('/dm/:userId', async (req: CircleRequest, res: Response) => {
    try {
        const otherUserId = req.params.userId;

        if (!(await isCircleMember(req.circleId!, otherUserId))) {
            return res.status(404).json({ success: false, error: 'User is not a member of this circle' });
        }

        const limit = parseLimit(req.query.limit);

        const conditions: string[] = [
            'm.circle_id = $1',
            "m.channel = 'dm'",
            '((m.author_user_id = $2 AND m.recipient_user_id = $3) OR (m.author_user_id = $3 AND m.recipient_user_id = $2))',
        ];
        const values: unknown[] = [req.circleId, req.userId, otherUserId];
        let idx = 4;

        if (typeof req.query.before === 'string' && req.query.before) {
            const before = parseDate(req.query.before);
            if (!before) {
                return res.status(400).json({ success: false, error: 'Invalid before cursor' });
            }
            conditions.push(`m.created_at < $${idx++}`);
            values.push(before);
        }

        values.push(limit);
        const result = await query(
            `${MESSAGE_SELECT}
             WHERE ${conditions.join(' AND ')}
             ORDER BY m.created_at DESC
             LIMIT $${idx}`,
            values
        );

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List DM messages error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Post a message to the circle feed or as a DM (every role except viewer).
// Attachments are small images or PDFs sent as base64 data URLs.
router.post('/', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { content, channel, recipient_user_id, attachments } = req.body;

        const cleanContent = typeof content === 'string' ? content.trim() : '';
        if (!cleanContent) {
            return res.status(400).json({ success: false, error: 'Content is required' });
        }
        if (cleanContent.length > MAX_CONTENT_LENGTH) {
            return res.status(400).json({ success: false, error: `Content must be at most ${MAX_CONTENT_LENGTH} characters` });
        }

        const cleanChannel = channel === undefined || channel === null ? 'circle' : channel;
        if (cleanChannel !== 'circle' && cleanChannel !== 'dm') {
            return res.status(400).json({ success: false, error: 'Invalid channel' });
        }

        let recipientUserId: string | null = null;
        if (cleanChannel === 'dm') {
            if (typeof recipient_user_id !== 'string' || !recipient_user_id) {
                return res.status(400).json({ success: false, error: 'recipient_user_id is required for direct messages' });
            }
            if (recipient_user_id === req.userId) {
                return res.status(400).json({ success: false, error: 'Cannot send a direct message to yourself' });
            }
            if (!(await isCircleMember(req.circleId!, recipient_user_id))) {
                return res.status(400).json({ success: false, error: 'Recipient is not a member of this circle' });
            }
            recipientUserId = recipient_user_id;
        }

        const cleanAttachments: Array<{ name: string; path: string; mime: string }> = [];
        if (attachments !== undefined && attachments !== null) {
            if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) {
                return res.status(400).json({ success: false, error: `Attachments must be an array of at most ${MAX_ATTACHMENTS} files` });
            }
            for (const attachment of attachments) {
                if (!attachment || typeof attachment !== 'object') {
                    return res.status(400).json({ success: false, error: 'Invalid attachment' });
                }
                const name = typeof attachment.name === 'string' ? attachment.name.trim() : '';
                if (!name || name.length > 255) {
                    return res.status(400).json({ success: false, error: 'Each attachment needs a name (255 characters max)' });
                }
                const match = typeof attachment.data === 'string' ? attachment.data.match(ATTACHMENT_DATA_URL_REGEX) : null;
                if (!match) {
                    return res.status(400).json({ success: false, error: 'Attachments must be base64 image or PDF data URLs' });
                }
                if (base64ByteSize(match[2]) > MAX_ATTACHMENT_BYTES) {
                    return res.status(400).json({ success: false, error: 'Each attachment must be at most 1.5 MB' });
                }
                cleanAttachments.push({ name, path: attachment.data, mime: match[1].toLowerCase() });
            }
        }

        const result = await query(
            `INSERT INTO messages (circle_id, channel, author_user_id, recipient_user_id, content, attachments)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [req.circleId, cleanChannel, req.userId, recipientUserId, cleanContent, JSON.stringify(cleanAttachments)]
        );
        const message = result.rows[0];

        const authorResult = await query('SELECT name, avatar_url FROM users WHERE id = $1', [req.userId]);

        if (cleanChannel === 'dm') {
            broadcastDm(req.circleId!, req.userId!, recipientUserId, 'created');
        } else {
            await broadcastToCircle(req.circleId!, { type: 'update', entity: 'messages', action: 'created' });
        }

        res.json({
            success: true,
            data: {
                ...message,
                author_name: authorResult.rows[0]?.name ?? null,
                author_avatar: authorResult.rows[0]?.avatar_url ?? null,
            },
        });
    } catch (error) {
        console.error('Create message error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Edit the content of one's own message
router.put('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT id, author_user_id, channel, recipient_user_id FROM messages WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Message not found' });
        }
        const message = existing.rows[0];
        if (message.author_user_id !== req.userId) {
            return res.status(403).json({ success: false, error: 'You can only edit your own messages' });
        }

        const cleanContent = typeof req.body.content === 'string' ? req.body.content.trim() : '';
        if (!cleanContent) {
            return res.status(400).json({ success: false, error: 'Content is required' });
        }
        if (cleanContent.length > MAX_CONTENT_LENGTH) {
            return res.status(400).json({ success: false, error: `Content must be at most ${MAX_CONTENT_LENGTH} characters` });
        }

        const result = await query(
            'UPDATE messages SET content = $1, edited_at = NOW() WHERE id = $2 AND circle_id = $3 RETURNING *',
            [cleanContent, req.params.id, req.circleId]
        );

        const authorResult = await query('SELECT name, avatar_url FROM users WHERE id = $1', [req.userId]);

        if (message.channel === 'dm') {
            broadcastDm(req.circleId!, message.author_user_id, message.recipient_user_id, 'updated');
        } else {
            await broadcastToCircle(req.circleId!, { type: 'update', entity: 'messages', action: 'updated' });
        }

        res.json({
            success: true,
            data: {
                ...result.rows[0],
                author_name: authorResult.rows[0]?.name ?? null,
                author_avatar: authorResult.rows[0]?.avatar_url ?? null,
            },
        });
    } catch (error) {
        console.error('Update message error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete a message: its author, or any message if admin
router.delete('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT id, author_user_id, channel, recipient_user_id FROM messages WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Message not found' });
        }
        const message = existing.rows[0];
        const isAuthor = message.author_user_id === req.userId;
        if (!isAuthor && req.circleRole !== 'admin') {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }

        await query('DELETE FROM messages WHERE id = $1 AND circle_id = $2', [req.params.id, req.circleId]);

        if (message.channel === 'dm') {
            broadcastDm(req.circleId!, message.author_user_id, message.recipient_user_id, 'deleted');
        } else {
            await broadcastToCircle(req.circleId!, { type: 'update', entity: 'messages', action: 'deleted' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Delete message error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

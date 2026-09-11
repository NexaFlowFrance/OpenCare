import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import {
    circleMiddleware,
    requireContentWriter,
    requireJournalWriter,
    CircleRequest,
} from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';

const router = Router();
router.use(authMiddleware);
router.use(circleMiddleware);

const NOTE_COLORS = ['yellow', 'pink', 'blue', 'green', 'orange'] as const;
const MAX_CONTENT_LENGTH = 500;

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Naive local "YYYY-MM-DDTHH:mm:ss" string. TIMESTAMP columns round-trip as
 * naive local strings, so expiry must be compared against JS local time,
 * NOT with SQL NOW(), which depends on the DB session timezone.
 */
const naiveLocal = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

// The client computes expiry choices ("end of today", +24h, ...) and sends a
// naive local timestamp; the server only checks the shape and stores it.
const NAIVE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/** Returns the validated expires_at (string or null), or undefined if invalid. */
const parseExpiresAt = (value: unknown): string | null | undefined => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string' && NAIVE_TIMESTAMP_RE.test(value)) return value;
    return undefined;
};

// Read the circle's notes (every member, non-expired only, newest first)
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT * FROM circle_notes
             WHERE circle_id = $1 AND (expires_at IS NULL OR expires_at > $2)
             ORDER BY created_at DESC
             LIMIT 50`,
            [req.circleId, naiveLocal()]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Get notes error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Stick a note on the board (any role except viewer)
router.post('/', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { content, color, expires_at } = req.body;

        const cleanedContent = typeof content === 'string' ? content.trim() : '';
        if (!cleanedContent || cleanedContent.length > MAX_CONTENT_LENGTH) {
            return res.status(400).json({ success: false, error: 'Content must be 1-500 characters' });
        }

        const noteColor = NOTE_COLORS.includes(color) ? color : 'yellow';

        const expiresAt = parseExpiresAt(expires_at);
        if (expiresAt === undefined) {
            return res.status(400).json({ success: false, error: 'Invalid expires_at' });
        }

        // The note is signed with the logged-in account's name.
        const userResult = await query('SELECT name FROM users WHERE id = $1', [req.userId]);
        const authorName: string = (userResult.rows[0]?.name || 'Cercle').slice(0, 100);

        const result = await query(
            `INSERT INTO circle_notes (circle_id, author_name, content, color, expires_at)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [req.circleId, authorName, cleanedContent, noteColor, expiresAt]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'notes', action: 'created' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Create note error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Edit a note: it's a shared board, so any writing member may rewrite it
router.put('/:id', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { id } = req.params;
        const { content, color, expires_at } = req.body;

        const updates: string[] = [];
        const values: unknown[] = [];
        let i = 1;
        const pushUpdate = (column: string, value: unknown) => {
            updates.push(`${column} = $${i}`);
            values.push(value);
            i += 1;
        };

        if (content !== undefined) {
            const cleanedContent = typeof content === 'string' ? content.trim() : '';
            if (!cleanedContent || cleanedContent.length > MAX_CONTENT_LENGTH) {
                return res.status(400).json({ success: false, error: 'Content must be 1-500 characters' });
            }
            pushUpdate('content', cleanedContent);
        }
        if (color !== undefined) {
            pushUpdate('color', NOTE_COLORS.includes(color) ? color : 'yellow');
        }
        if (expires_at !== undefined) {
            const expiresAt = parseExpiresAt(expires_at);
            if (expiresAt === undefined) {
                return res.status(400).json({ success: false, error: 'Invalid expires_at' });
            }
            pushUpdate('expires_at', expiresAt);
        }

        if (updates.length === 0) {
            return res.status(400).json({ success: false, error: 'No fields to update' });
        }

        values.push(id, req.circleId);
        const result = await query(
            `UPDATE circle_notes SET ${updates.join(', ')}
             WHERE id = $${i} AND circle_id = $${i + 1} RETURNING *`,
            values
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Note not found' });
        }

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'notes', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update note error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Remove a note. author_name is plain text so authorship cannot be verified:
// deletion is reserved to content writers (admin and family).
router.delete('/:id', requireContentWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { id } = req.params;

        const result = await query(
            'DELETE FROM circle_notes WHERE id = $1 AND circle_id = $2 RETURNING id',
            [id, req.circleId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Note not found' });
        }

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'notes', action: 'deleted' });
        res.json({ success: true, message: 'Note deleted' });
    } catch (error) {
        console.error('Delete note error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireRole, CircleRequest } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';

const router = Router();

router.use(authMiddleware, circleMiddleware);

const DOCUMENT_CATEGORIES = ['prescription', 'report', 'insurance', 'legal', 'other'];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Strict allowlist: raster images or PDF only. SVG is excluded on purpose (stored
// XSS via embedded scripts when a data URL is rendered inline).
const FILE_DATA_URL_REGEX = /^data:(image\/(?:png|jpe?g|webp|gif)|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/i;

/** Approximate decoded size of a base64 payload without allocating a buffer */
const base64ByteSize = (base64: string): number => {
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
};

// Documents are sensitive (insurance, legal rulings): neighbors cannot read them.
const requireDocumentReader = requireRole('admin', 'family', 'professional', 'viewer');
// A professional can upload too (e.g. a physiotherapist dropping a report).
const requireDocumentUploader = requireRole('admin', 'family', 'professional');

// Light projection: the file itself (a data URL) is only returned by GET /:id
const DOCUMENT_LIST_FIELDS = `d.id, d.circle_id, d.title, d.category, d.mime_type,
    d.size_bytes, d.uploaded_by, d.notes, d.created_at`;

// List the circle's documents, optional ?category= filter, most recent first
router.get('/', requireDocumentReader, async (req: CircleRequest, res: Response) => {
    try {
        const conditions: string[] = ['d.circle_id = $1'];
        const values: unknown[] = [req.circleId];

        if (typeof req.query.category === 'string' && req.query.category) {
            if (!DOCUMENT_CATEGORIES.includes(req.query.category)) {
                return res.status(400).json({ success: false, error: 'Invalid category' });
            }
            conditions.push('d.category = $2');
            values.push(req.query.category);
        }

        const result = await query(
            `SELECT ${DOCUMENT_LIST_FIELDS}, u.name AS uploaded_by_name
             FROM documents d
             LEFT JOIN users u ON u.id = d.uploaded_by
             WHERE ${conditions.join(' AND ')}
             ORDER BY d.created_at DESC`,
            values
        );

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List documents error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Full document, file_path included (a base64 data URL)
router.get('/:id', requireDocumentReader, async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT d.*, u.name AS uploaded_by_name
             FROM documents d
             LEFT JOIN users u ON u.id = d.uploaded_by
             WHERE d.id = $1 AND d.circle_id = $2`,
            [req.params.id, req.circleId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Document not found' });
        }
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Get document error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Upload a document (admin, family and professional)
router.post('/', requireDocumentUploader, async (req: CircleRequest, res: Response) => {
    try {
        const { title, category, file, notes } = req.body;

        const cleanTitle = typeof title === 'string' ? title.trim() : '';
        if (!cleanTitle) {
            return res.status(400).json({ success: false, error: 'Title is required' });
        }

        const cleanCategory = category === undefined || category === null ? 'other' : category;
        if (typeof cleanCategory !== 'string' || !DOCUMENT_CATEGORIES.includes(cleanCategory)) {
            return res.status(400).json({ success: false, error: 'Invalid category' });
        }

        const match = typeof file === 'string' ? file.match(FILE_DATA_URL_REGEX) : null;
        if (!match) {
            return res.status(400).json({ success: false, error: 'File must be a base64 image or PDF data URL' });
        }
        const sizeBytes = base64ByteSize(match[2]);
        if (sizeBytes > MAX_FILE_BYTES) {
            return res.status(400).json({ success: false, error: 'File must be at most 5 MB' });
        }

        const cleanNotes = typeof notes === 'string' && notes.trim() ? notes.trim() : null;

        const result = await query(
            `INSERT INTO documents (circle_id, title, category, file_path, mime_type, size_bytes, uploaded_by, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, circle_id, title, category, mime_type, size_bytes, uploaded_by, notes, created_at`,
            [req.circleId, cleanTitle, cleanCategory, file, match[1].toLowerCase(), sizeBytes, req.userId, cleanNotes]
        );

        const userResult = await query('SELECT name FROM users WHERE id = $1', [req.userId]);

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'documents', action: 'created' });
        res.json({
            success: true,
            data: { ...result.rows[0], uploaded_by_name: userResult.rows[0]?.name ?? null },
        });
    } catch (error) {
        console.error('Create document error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update metadata only (title, category, notes): the uploader, or admin/family
router.put('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT id, uploaded_by FROM documents WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Document not found' });
        }
        const isUploader = existing.rows[0].uploaded_by === req.userId;
        if (!isUploader && req.circleRole !== 'admin' && req.circleRole !== 'family') {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }

        const { title, category, notes } = req.body;
        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (title !== undefined) {
            if (typeof title !== 'string' || !title.trim()) {
                return res.status(400).json({ success: false, error: 'Title is required' });
            }
            fields.push(`title = $${idx++}`);
            values.push(title.trim());
        }
        if (category !== undefined) {
            if (typeof category !== 'string' || !DOCUMENT_CATEGORIES.includes(category)) {
                return res.status(400).json({ success: false, error: 'Invalid category' });
            }
            fields.push(`category = $${idx++}`);
            values.push(category);
        }
        if (notes !== undefined) {
            if (notes !== null && typeof notes !== 'string') {
                return res.status(400).json({ success: false, error: 'Invalid notes' });
            }
            fields.push(`notes = $${idx++}`);
            values.push(typeof notes === 'string' && notes.trim() ? notes.trim() : null);
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No changes provided' });
        }

        values.push(req.params.id, req.circleId);
        const result = await query(
            `UPDATE documents SET ${fields.join(', ')} WHERE id = $${idx} AND circle_id = $${idx + 1}
             RETURNING id, circle_id, title, category, mime_type, size_bytes, uploaded_by, notes, created_at`,
            values
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'documents', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update document error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete a document: the uploader, or admin
router.delete('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT id, uploaded_by FROM documents WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Document not found' });
        }
        const isUploader = existing.rows[0].uploaded_by === req.userId;
        if (!isUploader && req.circleRole !== 'admin') {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }

        await query('DELETE FROM documents WHERE id = $1 AND circle_id = $2', [req.params.id, req.circleId]);

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'documents', action: 'deleted' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete document error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

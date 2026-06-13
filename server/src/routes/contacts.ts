import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireContentWriter, CircleRequest } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';

const router = Router();

router.use(authMiddleware, circleMiddleware);

const CONTACT_CATEGORIES = ['doctor', 'nurse', 'aide', 'physio', 'pharmacy', 'family', 'neighbor', 'other'];

// Optional free-text fields: trimmed, empty strings stored as NULL
const OPTIONAL_TEXT_FIELDS = ['organization', 'phone', 'phone2', 'email', 'address', 'notes'] as const;

const cleanOptionalText = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;

// The circle's address book, readable by every member
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            'SELECT * FROM contacts WHERE circle_id = $1 ORDER BY name ASC',
            [req.circleId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List contacts error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create a contact (admin and family)
router.post('/', requireContentWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { name, category, has_key } = req.body;

        const cleanName = typeof name === 'string' ? name.trim() : '';
        if (!cleanName) {
            return res.status(400).json({ success: false, error: 'Name is required' });
        }

        const cleanCategory = category === undefined || category === null ? 'other' : category;
        if (typeof cleanCategory !== 'string' || !CONTACT_CATEGORIES.includes(cleanCategory)) {
            return res.status(400).json({ success: false, error: 'Invalid category' });
        }

        const result = await query(
            `INSERT INTO contacts (circle_id, name, category, organization, phone, phone2, email, address, has_key, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [
                req.circleId,
                cleanName,
                cleanCategory,
                cleanOptionalText(req.body.organization),
                cleanOptionalText(req.body.phone),
                cleanOptionalText(req.body.phone2),
                cleanOptionalText(req.body.email),
                cleanOptionalText(req.body.address),
                has_key === true,
                cleanOptionalText(req.body.notes),
            ]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'contacts', action: 'created' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Create contact error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update a contact (admin and family)
router.put('/:id', requireContentWriter, async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT id FROM contacts WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Contact not found' });
        }

        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (req.body.name !== undefined) {
            if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
                return res.status(400).json({ success: false, error: 'Name is required' });
            }
            fields.push(`name = $${idx++}`);
            values.push(req.body.name.trim());
        }
        if (req.body.category !== undefined) {
            if (typeof req.body.category !== 'string' || !CONTACT_CATEGORIES.includes(req.body.category)) {
                return res.status(400).json({ success: false, error: 'Invalid category' });
            }
            fields.push(`category = $${idx++}`);
            values.push(req.body.category);
        }
        if (req.body.has_key !== undefined) {
            fields.push(`has_key = $${idx++}`);
            values.push(req.body.has_key === true);
        }
        for (const field of OPTIONAL_TEXT_FIELDS) {
            if (field in req.body) {
                fields.push(`${field} = $${idx++}`);
                values.push(cleanOptionalText(req.body[field]));
            }
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No changes provided' });
        }

        values.push(req.params.id, req.circleId);
        const result = await query(
            `UPDATE contacts SET ${fields.join(', ')} WHERE id = $${idx} AND circle_id = $${idx + 1} RETURNING *`,
            values
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'contacts', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update contact error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete a contact (admin and family)
router.delete('/:id', requireContentWriter, async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT id FROM contacts WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Contact not found' });
        }

        await query('DELETE FROM contacts WHERE id = $1 AND circle_id = $2', [req.params.id, req.circleId]);

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'contacts', action: 'deleted' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete contact error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

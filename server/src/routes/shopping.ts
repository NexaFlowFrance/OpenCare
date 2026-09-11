import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireJournalWriter, CircleRequest } from '../middleware/circle';
import { toNullIfEmpty, toOptionalNumber } from '../lib/normalize';
import { broadcastToCircle } from '../lib/broadcaster';

const router = Router();

// Auth + active circle on every route
router.use(authMiddleware);
router.use(circleMiddleware);

// List the circle's shopping items (every member, viewer included)
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            'SELECT * FROM shopping_items WHERE circle_id = $1 ORDER BY created_at DESC',
            [req.circleId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Get shopping items error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Add an item (any role except viewer: the home aide adds paracetamol too).
// Categories are free-form strings, the server does not enforce a list.
router.post('/', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { name, category, quantity, unit, notes } = req.body;
        const cleanedName = typeof name === 'string' ? name.trim() : '';
        const cleanedCategory = typeof category === 'string' && category.trim() ? category.trim() : 'other';
        const parsedQuantity = quantity !== undefined ? toOptionalNumber(quantity) : null;

        if (!cleanedName) {
            return res.status(400).json({ success: false, error: 'name is required' });
        }

        if (quantity !== undefined && quantity !== '' && quantity !== null && parsedQuantity === null) {
            return res.status(400).json({ success: false, error: 'Invalid quantity format' });
        }

        const result = await query(
            `INSERT INTO shopping_items (circle_id, name, category, quantity, unit, notes, added_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [
                req.circleId,
                cleanedName,
                cleanedCategory,
                parsedQuantity,
                toNullIfEmpty(unit),
                toNullIfEmpty(notes),
                req.userId,
            ]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'shopping', action: 'created' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Create shopping item error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update an item, including checking it off (any role except viewer)
router.put('/:id', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { id } = req.params;
        const { name, category, quantity, unit, is_checked, notes } = req.body;

        const cleanedName = name !== undefined ? toNullIfEmpty(name) : undefined;
        const cleanedCategory = category !== undefined ? toNullIfEmpty(category) : undefined;
        const parsedQuantity = quantity !== undefined ? toOptionalNumber(quantity) : undefined;

        if (quantity !== undefined && quantity !== '' && quantity !== null && parsedQuantity === null) {
            return res.status(400).json({ success: false, error: 'Invalid quantity format' });
        }

        const result = await query(
            `UPDATE shopping_items
             SET name = COALESCE($1, name),
                 category = COALESCE($2, category),
                 quantity = COALESCE($3, quantity),
                 unit = COALESCE($4, unit),
                 is_checked = COALESCE($5, is_checked),
                 notes = COALESCE($6, notes)
             WHERE id = $7 AND circle_id = $8 RETURNING *`,
            [
                cleanedName,
                cleanedCategory,
                parsedQuantity,
                unit !== undefined ? toNullIfEmpty(unit) : undefined,
                is_checked !== undefined ? Boolean(is_checked) : undefined,
                notes !== undefined ? toNullIfEmpty(notes) : undefined,
                id,
                req.circleId,
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Item not found' });
        }

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'shopping', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update shopping item error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete an item (any role except viewer)
router.delete('/:id', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { id } = req.params;

        const result = await query(
            'DELETE FROM shopping_items WHERE id = $1 AND circle_id = $2 RETURNING id',
            [id, req.circleId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Item not found' });
        }

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'shopping', action: 'deleted' });
        res.json({ success: true, message: 'Item deleted' });
    } catch (error) {
        console.error('Delete shopping item error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Clear checked items (any role except viewer)
router.delete('/checked/clear', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    try {
        await query(
            'DELETE FROM shopping_items WHERE circle_id = $1 AND is_checked = true',
            [req.circleId]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'shopping', action: 'deleted' });
        res.json({ success: true, message: 'Checked items cleared' });
    } catch (error) {
        console.error('Clear checked items error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

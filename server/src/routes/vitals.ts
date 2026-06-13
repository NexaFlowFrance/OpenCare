import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireRole, CircleRequest } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';

const router = Router();

// Donnees de sante: la matrice de docs/SPEC.md exclut le role neighbor
// (lecture pour viewer, ecriture pour admin/family/professional).
router.use(authMiddleware, circleMiddleware, requireRole('admin', 'family', 'professional', 'viewer'));

const requireHealthWriter = requireRole('admin', 'family', 'professional');

const VITAL_TYPES = ['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'];

const parseDate = (value: unknown): Date | null => {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
};

// List measurements, oldest first (ready for charts).
// Optional filters: ?type=, ?from= and ?to= (bounds on measured_at), ?limit= (default 500).
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const parsedLimit = parseInt(String(req.query.limit), 10);
        const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 500 : parsedLimit, 1), 2000);

        const conditions: string[] = ['circle_id = $1'];
        const values: unknown[] = [req.circleId];
        let idx = 2;

        if (typeof req.query.type === 'string' && req.query.type) {
            if (!VITAL_TYPES.includes(req.query.type)) {
                return res.status(400).json({ success: false, error: 'Invalid vital type' });
            }
            conditions.push(`type = $${idx++}`);
            values.push(req.query.type);
        }

        if (typeof req.query.from === 'string' && req.query.from) {
            const from = parseDate(req.query.from);
            if (!from) {
                return res.status(400).json({ success: false, error: 'Invalid from date' });
            }
            conditions.push(`measured_at >= $${idx++}`);
            values.push(from);
        }

        if (typeof req.query.to === 'string' && req.query.to) {
            const to = parseDate(req.query.to);
            if (!to) {
                return res.status(400).json({ success: false, error: 'Invalid to date' });
            }
            conditions.push(`measured_at <= $${idx++}`);
            values.push(to);
        }

        values.push(limit);
        const result = await query(
            `SELECT * FROM vitals
             WHERE ${conditions.join(' AND ')}
             ORDER BY measured_at ASC
             LIMIT $${idx}`,
            values
        );

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List vitals error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Latest measurement of each type
router.get('/latest', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT DISTINCT ON (type) *
             FROM vitals
             WHERE circle_id = $1
             ORDER BY type, measured_at DESC`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Latest vitals error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Record a measurement (every role except viewer)
router.post('/', requireHealthWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { type, value, value2, unit, measured_at, notes } = req.body;

        if (typeof type !== 'string' || !VITAL_TYPES.includes(type)) {
            return res.status(400).json({ success: false, error: 'Invalid vital type' });
        }

        const numValue = Number(value);
        if (value === undefined || value === null || value === '' || !Number.isFinite(numValue)) {
            return res.status(400).json({ success: false, error: 'Invalid value' });
        }

        let numValue2: number | null = null;
        if (value2 !== undefined && value2 !== null && value2 !== '') {
            numValue2 = Number(value2);
            if (!Number.isFinite(numValue2)) {
                return res.status(400).json({ success: false, error: 'Invalid value2' });
            }
        }

        let measuredAt: Date | null = null;
        if (measured_at !== undefined && measured_at !== null) {
            measuredAt = parseDate(measured_at);
            if (!measuredAt) {
                return res.status(400).json({ success: false, error: 'Invalid measured_at date' });
            }
        }

        const result = await query(
            `INSERT INTO vitals (circle_id, type, value, value2, unit, measured_at, recorded_by_user, notes)
             VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_TIMESTAMP), $7, $8)
             RETURNING *`,
            [
                req.circleId,
                type,
                numValue,
                numValue2,
                typeof unit === 'string' && unit.trim() ? unit.trim() : null,
                measuredAt,
                req.userId,
                typeof notes === 'string' && notes.trim() ? notes.trim() : null,
            ]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'vitals', action: 'created' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Create vital error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update a measurement: its author (recorded_by_user) or an admin
router.put('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT id, recorded_by_user FROM vitals WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Vital not found' });
        }
        const isAuthor = existing.rows[0].recorded_by_user === req.userId;
        if (!isAuthor && req.circleRole !== 'admin') {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }

        const { type, value, value2, unit, measured_at, notes } = req.body;
        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (type !== undefined) {
            if (typeof type !== 'string' || !VITAL_TYPES.includes(type)) {
                return res.status(400).json({ success: false, error: 'Invalid vital type' });
            }
            fields.push(`type = $${idx++}`);
            values.push(type);
        }

        if (value !== undefined) {
            const numValue = Number(value);
            if (value === null || value === '' || !Number.isFinite(numValue)) {
                return res.status(400).json({ success: false, error: 'Invalid value' });
            }
            fields.push(`value = $${idx++}`);
            values.push(numValue);
        }

        if (value2 !== undefined) {
            if (value2 === null || value2 === '') {
                fields.push(`value2 = $${idx++}`);
                values.push(null);
            } else {
                const numValue2 = Number(value2);
                if (!Number.isFinite(numValue2)) {
                    return res.status(400).json({ success: false, error: 'Invalid value2' });
                }
                fields.push(`value2 = $${idx++}`);
                values.push(numValue2);
            }
        }

        if (unit !== undefined) {
            fields.push(`unit = $${idx++}`);
            values.push(typeof unit === 'string' && unit.trim() ? unit.trim() : null);
        }

        if (measured_at !== undefined) {
            const measuredAt = parseDate(measured_at);
            if (!measuredAt) {
                return res.status(400).json({ success: false, error: 'Invalid measured_at date' });
            }
            fields.push(`measured_at = $${idx++}`);
            values.push(measuredAt);
        }

        if (notes !== undefined) {
            fields.push(`notes = $${idx++}`);
            values.push(typeof notes === 'string' && notes.trim() ? notes.trim() : null);
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No changes provided' });
        }

        values.push(req.params.id, req.circleId);
        const result = await query(
            `UPDATE vitals SET ${fields.join(', ')} WHERE id = $${idx} AND circle_id = $${idx + 1} RETURNING *`,
            values
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'vitals', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update vital error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete a measurement: its author or an admin
router.delete('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT id, recorded_by_user FROM vitals WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Vital not found' });
        }
        const isAuthor = existing.rows[0].recorded_by_user === req.userId;
        if (!isAuthor && req.circleRole !== 'admin') {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }

        await query('DELETE FROM vitals WHERE id = $1 AND circle_id = $2', [req.params.id, req.circleId]);

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'vitals', action: 'deleted' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete vital error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

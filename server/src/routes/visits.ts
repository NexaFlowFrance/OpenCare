import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireAdmin, CircleRequest } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';
import { VISIT_COLUMNS } from '../lib/visits';

// Visites (cote aidant) : la liste de qui est passe voir le proche, declaree
// depuis l'ecran patient. Les check-in eux-memes passent par /api/kiosk/visits.
// Mounted on /api/visits by app.ts.
const router = Router();
router.use(authMiddleware, circleMiddleware);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 92;

// GET /api/visits?from=YYYY-MM-DD&to=YYYY-MM-DD (default: last 30 days)
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const to = typeof req.query.to === 'string' && DATE_RE.test(req.query.to) ? req.query.to : null;
        const from = typeof req.query.from === 'string' && DATE_RE.test(req.query.from) ? req.query.from : null;
        const result = await query(
            `SELECT ${VISIT_COLUMNS}
             FROM visits
             WHERE circle_id = $1
               AND checked_in_at >= COALESCE($2::date, CURRENT_DATE - 30)
               AND checked_in_at < COALESCE($3::date, CURRENT_DATE) + interval '1 day'
               AND checked_in_at >= COALESCE($3::date, CURRENT_DATE) - ($4 || ' days')::interval
             ORDER BY checked_in_at DESC
             LIMIT 500`,
            [req.circleId, from, to, String(MAX_DAYS)]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List visits error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// DELETE /api/visits/:id : an admin removes a wrong check-in (journal entry too).
router.delete('/:id', requireAdmin, async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            'DELETE FROM visits WHERE id = $1 AND circle_id = $2 RETURNING journal_entry_id',
            [req.params.id, req.circleId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }
        if (result.rows[0].journal_entry_id) {
            await query('DELETE FROM journal_entries WHERE id = $1', [result.rows[0].journal_entry_id]);
        }
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'visits', action: 'deleted' });
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'journal', action: 'deleted' });
        res.json({ success: true, data: {} });
    } catch (error) {
        console.error('Delete visit error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

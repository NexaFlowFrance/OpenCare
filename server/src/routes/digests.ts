import { Router } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireAdmin, CircleRequest } from '../middleware/circle';
import { AiError } from '../services/ai';
import { generateDigestForCircle, currentWeekStart } from '../lib/digestScheduler';
import logger from '../lib/logger';

const router = Router();

// Weekly digests are scoped to the active care circle (X-Circle-Id header).
router.use(authMiddleware);
router.use(circleMiddleware);

// GET /api/digests : the 12 most recent weekly digests of the circle.
router.get('/', async (req: CircleRequest, res) => {
    try {
        const result = await query(
            `SELECT id, to_char(week_start, 'YYYY-MM-DD') AS week_start, content, created_at
             FROM weekly_digests
             WHERE circle_id = $1
             ORDER BY week_start DESC
             LIMIT 12`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        logger.error('digest.list_error', {
            error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/digests/generate : circle admins only. Generates (or regenerates)
// the digest of the CURRENT week (current Monday) on demand.
router.post('/generate', requireAdmin, async (req: CircleRequest, res) => {
    try {
        const digest = await generateDigestForCircle(req.circleId!, currentWeekStart());
        if (!digest) {
            return res.status(400).json({ success: false, error: 'AI_NOT_CONFIGURED' });
        }
        res.json({ success: true, data: digest });
    } catch (error) {
        if (error instanceof AiError) {
            // Machine-readable code (the client maps it to a localized message);
            // `message` carries the provider detail.
            return res.status(502).json({ success: false, error: error.code, message: error.message });
        }
        logger.error('digest.generate_error', {
            error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

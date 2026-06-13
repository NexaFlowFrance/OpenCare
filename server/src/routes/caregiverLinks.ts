import { Router, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireContentWriter, CircleRequest } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';

// Management of magic links for external caregivers without an account.
// The public consumption endpoints live in journal.ts and medications.ts.
const router = Router();

router.use(authMiddleware, circleMiddleware, requireContentWriter);

const MAX_EXPIRES_IN_DAYS = 365;

// Every link of the circle with a computed status (active | expired | revoked)
const LINK_SELECT = `
    SELECT l.id, l.circle_id, l.token, l.display_name, l.role_label, l.created_by,
           l.revoked, l.expires_at, l.last_used_at, l.created_at,
           u.name AS created_by_name,
           CASE WHEN l.revoked THEN 'revoked'
                WHEN l.expires_at IS NOT NULL AND l.expires_at <= CURRENT_TIMESTAMP THEN 'expired'
                ELSE 'active' END AS status
    FROM caregiver_links l
    LEFT JOIN users u ON u.id = l.created_by`;

// List all the circle's links, including expired and revoked ones
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `${LINK_SELECT}
             WHERE l.circle_id = $1
             ORDER BY l.created_at DESC`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List caregiver links error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create a magic link, e.g. for 'Nadia, auxiliaire de vie'.
// expires_in_days: null means no expiration, otherwise 1 to 365 days.
router.post('/', async (req: CircleRequest, res: Response) => {
    try {
        const { display_name, role_label, expires_in_days } = req.body;

        const cleanDisplayName = typeof display_name === 'string' ? display_name.trim() : '';
        if (!cleanDisplayName) {
            return res.status(400).json({ success: false, error: 'display_name is required' });
        }
        if (cleanDisplayName.length > 100) {
            return res.status(400).json({ success: false, error: 'display_name must be at most 100 characters' });
        }

        let cleanRoleLabel: string | null = null;
        if (role_label !== undefined && role_label !== null) {
            if (typeof role_label !== 'string' || role_label.trim().length > 100) {
                return res.status(400).json({ success: false, error: 'role_label must be at most 100 characters' });
            }
            cleanRoleLabel = role_label.trim() || null;
        }

        let expiresAt: Date | null = null;
        if (expires_in_days !== undefined && expires_in_days !== null) {
            const days = Number(expires_in_days);
            if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRES_IN_DAYS) {
                return res.status(400).json({ success: false, error: `expires_in_days must be between 1 and ${MAX_EXPIRES_IN_DAYS}` });
            }
            expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        }

        const token = crypto.randomBytes(32).toString('hex');

        const inserted = await query(
            `INSERT INTO caregiver_links (circle_id, token, display_name, role_label, created_by, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [req.circleId, token, cleanDisplayName, cleanRoleLabel, req.userId, expiresAt]
        );

        const result = await query(`${LINK_SELECT} WHERE l.id = $1`, [inserted.rows[0].id]);

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true, data: { ...result.rows[0], url: `/care/${token}` } });
    } catch (error) {
        console.error('Create caregiver link error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Rename, relabel or revoke/reactivate a link
router.put('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT id FROM caregiver_links WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Link not found' });
        }

        const { display_name, role_label, revoked } = req.body;
        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (display_name !== undefined) {
            if (typeof display_name !== 'string' || !display_name.trim() || display_name.trim().length > 100) {
                return res.status(400).json({ success: false, error: 'Invalid display_name' });
            }
            fields.push(`display_name = $${idx++}`);
            values.push(display_name.trim());
        }
        if (role_label !== undefined) {
            if (role_label !== null && (typeof role_label !== 'string' || role_label.trim().length > 100)) {
                return res.status(400).json({ success: false, error: 'Invalid role_label' });
            }
            fields.push(`role_label = $${idx++}`);
            values.push(typeof role_label === 'string' && role_label.trim() ? role_label.trim() : null);
        }
        if (revoked !== undefined) {
            if (typeof revoked !== 'boolean') {
                return res.status(400).json({ success: false, error: 'revoked must be a boolean' });
            }
            fields.push(`revoked = $${idx++}`);
            values.push(revoked);
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No changes provided' });
        }

        values.push(req.params.id);
        await query(
            `UPDATE caregiver_links SET ${fields.join(', ')} WHERE id = $${idx}`,
            values
        );

        const result = await query(`${LINK_SELECT} WHERE l.id = $1`, [req.params.id]);

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update caregiver link error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Permanently delete a link
router.delete('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT id FROM caregiver_links WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Link not found' });
        }

        await query('DELETE FROM caregiver_links WHERE id = $1', [req.params.id]);

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete caregiver link error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

import { Router, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { circleMiddleware, requireAdmin, CircleRequest } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';
import { normalizeEmail } from '../lib/normalize';

const router = Router();

const VALID_ROLES = ['admin', 'family', 'professional', 'neighbor', 'viewer'];

// Public preview of an invite (shown before signup). No auth.
router.get('/info/:token', async (req, res) => {
    try {
        const result = await query(
            `SELECT i.role, i.invitee_email, i.expires_at,
                    c.name AS circle_name,
                    r.first_name AS recipient_first_name,
                    u.name AS inviter_name
             FROM circle_invites i
             JOIN care_circles c ON c.id = i.circle_id
             LEFT JOIN care_recipients r ON r.circle_id = i.circle_id
             LEFT JOIN users u ON u.id = i.created_by
             WHERE i.token = $1 AND i.status = 'pending' AND i.expires_at > NOW()`,
            [req.params.token]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Invitation invalide ou expirée' });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Invite info error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// An existing, logged-in account accepts an invite and joins the circle.
router.post('/accept/:token', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT id, circle_id, invitee_email, role FROM circle_invites
             WHERE token = $1 AND status = 'pending' AND expires_at > NOW()`,
            [req.params.token]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Invitation invalide ou expirée' });
        }

        const invite = result.rows[0];

        if (invite.invitee_email) {
            const me = await query('SELECT email FROM users WHERE id = $1', [req.userId]);
            if (normalizeEmail(me.rows[0]?.email ?? '') !== normalizeEmail(invite.invitee_email)) {
                return res.status(403).json({ success: false, error: 'Cette invitation est réservée à une autre adresse e-mail' });
            }
        }

        const existing = await query(
            'SELECT id FROM circle_members WHERE circle_id = $1 AND user_id = $2',
            [invite.circle_id, req.userId]
        );
        if (existing.rows.length > 0) {
            return res.status(400).json({ success: false, error: 'Vous êtes déjà membre de ce cercle' });
        }

        await query(
            'INSERT INTO circle_members (circle_id, user_id, role) VALUES ($1, $2, $3)',
            [invite.circle_id, req.userId, invite.role]
        );
        await query("UPDATE circle_invites SET status = 'accepted' WHERE id = $1", [invite.id]);

        await broadcastToCircle(invite.circle_id, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true, data: { circle_id: invite.circle_id } });
    } catch (error) {
        console.error('Accept invite error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Management endpoints: scoped to the active circle, admin only.
router.use(authMiddleware, circleMiddleware, requireAdmin);

// List pending invites of the circle
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT i.id, i.token, i.invitee_email, i.role, i.status, i.expires_at, i.created_at,
                    u.name AS created_by_name
             FROM circle_invites i
             LEFT JOIN users u ON u.id = i.created_by
             WHERE i.circle_id = $1 AND i.status = 'pending' AND i.expires_at > NOW()
             ORDER BY i.created_at DESC`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List invites error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create an invite (role chosen by the admin, optional target email, 1 to 30 days)
router.post('/', async (req: CircleRequest, res: Response) => {
    try {
        const { role, invitee_email, expires_in_days } = req.body;

        const cleanedRole = typeof role === 'string' && VALID_ROLES.includes(role) ? role : 'family';
        const days = Number.parseInt(String(expires_in_days ?? 7), 10);
        const cleanedDays = Number.isNaN(days) ? 7 : Math.min(Math.max(days, 1), 30);
        const cleanedEmail = typeof invitee_email === 'string' && invitee_email.trim()
            ? normalizeEmail(invitee_email)
            : null;

        const token = crypto.randomBytes(32).toString('hex');

        const result = await query(
            `INSERT INTO circle_invites (circle_id, created_by, token, invitee_email, role, expires_at)
             VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' days')::interval)
             RETURNING id, token, invitee_email, role, status, expires_at, created_at`,
            [req.circleId, req.userId, token, cleanedEmail, cleanedRole, String(cleanedDays)]
        );

        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Create invite error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Revoke an invite
router.delete('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            "UPDATE circle_invites SET status = 'revoked' WHERE id = $1 AND circle_id = $2 RETURNING id",
            [req.params.id, req.circleId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Invite not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Revoke invite error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

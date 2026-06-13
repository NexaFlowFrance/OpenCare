import { Router, Response } from 'express';
import { query, getClient } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { circleMiddleware, requireAdmin, CircleRequest } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';

const router = Router();

router.use(authMiddleware);

const RECIPIENT_FIELDS = `id, circle_id, first_name, last_name, birth_date, photo_url, address, phone,
    blood_type, allergies, medical_history, mobility_notes, diet_notes, social_security_number,
    insurance_info, advance_directives, gp_name, gp_phone, notes, created_at, updated_at`;

// Le role neighbor ne voit que l'identite d'affichage du proche: la matrice de
// docs/SPEC.md lui refuse les donnees medicales et administratives.
const RECIPIENT_FIELDS_MINIMAL = 'id, circle_id, first_name, last_name, photo_url, created_at, updated_at';

const recipientFieldsFor = (role: string | undefined) =>
    role === 'neighbor' ? RECIPIENT_FIELDS_MINIMAL : RECIPIENT_FIELDS;

// List the circles of the logged-in user, with their role and the recipient identity
router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT c.id, c.name, c.currency, c.settings, c.created_at,
                    m.role, m.color,
                    r.id AS recipient_id, r.first_name AS recipient_first_name,
                    r.last_name AS recipient_last_name, r.photo_url AS recipient_photo_url,
                    r.birth_date AS recipient_birth_date,
                    (SELECT COUNT(*) FROM circle_members cm WHERE cm.circle_id = c.id)::int AS member_count
             FROM care_circles c
             JOIN circle_members m ON m.circle_id = c.id AND m.user_id = $1
             LEFT JOIN care_recipients r ON r.circle_id = c.id
             ORDER BY c.created_at`,
            [req.userId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List circles error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create a circle around a cared-for person. The creator becomes admin.
router.post('/', async (req: AuthRequest, res: Response) => {
    const client = await getClient();
    try {
        const { name, recipient_first_name, recipient_last_name, recipient_birth_date } = req.body;
        const cleanedFirstName = typeof recipient_first_name === 'string' ? recipient_first_name.trim() : '';

        if (!cleanedFirstName) {
            return res.status(400).json({ success: false, error: 'Le prénom du proche est requis' });
        }

        const circleName = (typeof name === 'string' && name.trim()) ? name.trim() : cleanedFirstName;

        await client.query('BEGIN');

        const circleResult = await client.query(
            'INSERT INTO care_circles (name, created_by) VALUES ($1, $2) RETURNING *',
            [circleName, req.userId]
        );
        const circle = circleResult.rows[0];

        await client.query(
            "INSERT INTO circle_members (circle_id, user_id, role) VALUES ($1, $2, 'admin')",
            [circle.id, req.userId]
        );

        const recipientResult = await client.query(
            `INSERT INTO care_recipients (circle_id, first_name, last_name, birth_date)
             VALUES ($1, $2, $3, $4) RETURNING ${RECIPIENT_FIELDS}`,
            [
                circle.id,
                cleanedFirstName,
                typeof recipient_last_name === 'string' ? recipient_last_name.trim() || null : null,
                recipient_birth_date || null,
            ]
        );

        await client.query('COMMIT');
        res.json({ success: true, data: { circle, recipient: recipientResult.rows[0] } });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Create circle error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Circle detail: circle + recipient + members
router.get('/:circleId', circleMiddleware, async (req: CircleRequest, res: Response) => {
    try {
        const [circleResult, recipientResult, membersResult] = await Promise.all([
            query('SELECT * FROM care_circles WHERE id = $1', [req.circleId]),
            query(`SELECT ${recipientFieldsFor(req.circleRole)} FROM care_recipients WHERE circle_id = $1`, [req.circleId]),
            query(
                `SELECT m.id, m.circle_id, m.user_id, m.role, m.color, m.created_at,
                        u.name, u.email, u.avatar_url
                 FROM circle_members m
                 JOIN users u ON u.id = m.user_id
                 WHERE m.circle_id = $1
                 ORDER BY m.created_at`,
                [req.circleId]
            ),
        ]);

        if (circleResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Circle not found' });
        }

        res.json({
            success: true,
            data: {
                circle: circleResult.rows[0],
                recipient: recipientResult.rows[0] ?? null,
                members: membersResult.rows,
                my_role: req.circleRole,
            },
        });
    } catch (error) {
        console.error('Get circle error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update circle (admin)
router.put('/:circleId', circleMiddleware, requireAdmin, async (req: CircleRequest, res: Response) => {
    try {
        const { name, currency, settings } = req.body;
        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (typeof name === 'string' && name.trim()) {
            fields.push(`name = $${idx++}`);
            values.push(name.trim());
        }
        if (typeof currency === 'string' && currency.length === 3) {
            fields.push(`currency = $${idx++}`);
            values.push(currency.toUpperCase());
        }
        if (settings && typeof settings === 'object') {
            fields.push(`settings = $${idx++}`);
            values.push(JSON.stringify(settings));
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No changes provided' });
        }

        values.push(req.circleId);
        const result = await query(
            `UPDATE care_circles SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update circle error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete circle (admin). Cascades to all circle data.
router.delete('/:circleId', circleMiddleware, requireAdmin, async (req: CircleRequest, res: Response) => {
    try {
        await query('DELETE FROM care_circles WHERE id = $1', [req.circleId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete circle error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update a member's role or color (admin). The last admin cannot be demoted.
router.put('/:circleId/members/:memberId', circleMiddleware, requireAdmin, async (req: CircleRequest, res: Response) => {
    try {
        const { role, color } = req.body;
        const validRoles = ['admin', 'family', 'professional', 'neighbor', 'viewer'];

        const memberResult = await query(
            'SELECT id, role FROM circle_members WHERE id = $1 AND circle_id = $2',
            [req.params.memberId, req.circleId]
        );
        if (memberResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Member not found' });
        }

        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (typeof role === 'string') {
            if (!validRoles.includes(role)) {
                return res.status(400).json({ success: false, error: 'Invalid role' });
            }
            if (memberResult.rows[0].role === 'admin' && role !== 'admin') {
                const admins = await query(
                    "SELECT COUNT(*)::int AS count FROM circle_members WHERE circle_id = $1 AND role = 'admin'",
                    [req.circleId]
                );
                if (admins.rows[0].count <= 1) {
                    return res.status(400).json({ success: false, error: 'Le cercle doit garder au moins un administrateur' });
                }
            }
            fields.push(`role = $${idx++}`);
            values.push(role);
        }

        if (typeof color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(color)) {
            fields.push(`color = $${idx++}`);
            values.push(color);
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No changes provided' });
        }

        values.push(req.params.memberId);
        const result = await query(
            `UPDATE circle_members SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update member error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Remove a member (admin), or leave the circle (any member removing themselves).
router.delete('/:circleId/members/:memberId', circleMiddleware, async (req: CircleRequest, res: Response) => {
    try {
        const memberResult = await query(
            'SELECT id, user_id, role FROM circle_members WHERE id = $1 AND circle_id = $2',
            [req.params.memberId, req.circleId]
        );
        if (memberResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Member not found' });
        }

        const member = memberResult.rows[0];
        const isSelf = member.user_id === req.userId;

        if (!isSelf && req.circleRole !== 'admin') {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }

        if (member.role === 'admin') {
            const admins = await query(
                "SELECT COUNT(*)::int AS count FROM circle_members WHERE circle_id = $1 AND role = 'admin'",
                [req.circleId]
            );
            if (admins.rows[0].count <= 1) {
                return res.status(400).json({ success: false, error: 'Le cercle doit garder au moins un administrateur' });
            }
        }

        await query('DELETE FROM circle_members WHERE id = $1', [req.params.memberId]);
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true });
    } catch (error) {
        console.error('Remove member error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Recipient profile
router.get('/:circleId/recipient', circleMiddleware, async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT ${recipientFieldsFor(req.circleRole)} FROM care_recipients WHERE circle_id = $1`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows[0] ?? null });
    } catch (error) {
        console.error('Get recipient error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

const RECIPIENT_UPDATABLE = [
    'first_name', 'last_name', 'birth_date', 'photo_url', 'address', 'phone',
    'blood_type', 'allergies', 'medical_history', 'mobility_notes', 'diet_notes',
    'social_security_number', 'insurance_info', 'advance_directives',
    'gp_name', 'gp_phone', 'notes',
] as const;

// Update the recipient profile (admin and family only: sensitive medical data)
router.put('/:circleId/recipient', circleMiddleware, async (req: CircleRequest, res: Response) => {
    try {
        if (req.circleRole !== 'admin' && req.circleRole !== 'family') {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }

        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        for (const field of RECIPIENT_UPDATABLE) {
            if (field in req.body) {
                const value = req.body[field];
                if (field === 'first_name') {
                    if (typeof value !== 'string' || !value.trim()) {
                        return res.status(400).json({ success: false, error: 'Le prénom est requis' });
                    }
                    fields.push(`first_name = $${idx++}`);
                    values.push(value.trim());
                } else {
                    fields.push(`${field} = $${idx++}`);
                    values.push(value === '' ? null : value);
                }
            }
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No changes provided' });
        }

        values.push(req.circleId);
        const result = await query(
            `UPDATE care_recipients SET ${fields.join(', ')} WHERE circle_id = $${idx} RETURNING ${RECIPIENT_FIELDS}`,
            values
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Recipient not found' });
        }

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update recipient error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

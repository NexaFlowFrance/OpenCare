import { Router, Response } from 'express';
import crypto from 'crypto';
import { query, getClient } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { circleMiddleware, requireAdmin, CircleRequest } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';

const router = Router();

router.use(authMiddleware);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
            `SELECT c.id, c.name, c.currency, c.settings, c.created_at, c.household_id,
                    h.name AS household_name,
                    m.role, m.color,
                    r.id AS recipient_id, r.first_name AS recipient_first_name,
                    r.last_name AS recipient_last_name, r.photo_url AS recipient_photo_url,
                    r.birth_date AS recipient_birth_date,
                    (SELECT COUNT(*) FROM circle_members cm WHERE cm.circle_id = c.id)::int AS member_count
             FROM care_circles c
             JOIN circle_members m ON m.circle_id = c.id AND m.user_id = $1
             LEFT JOIN care_recipients r ON r.circle_id = c.id
             LEFT JOIN households h ON h.id = c.household_id
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
// Optional link_circle_id: attach the new circle to the household (foyer) of an
// existing circle the requester ADMINISTERS (e.g. the spouse). copy_members then
// copies that circle's caregiver team so the family is not re-invited twice.
router.post('/', async (req: AuthRequest, res: Response) => {
    const client = await getClient();
    try {
        const { name, recipient_first_name, recipient_last_name, recipient_birth_date, link_circle_id, copy_members } = req.body;
        const cleanedFirstName = typeof recipient_first_name === 'string' ? recipient_first_name.trim() : '';

        if (!cleanedFirstName) {
            return res.status(400).json({ success: false, error: 'Le prénom du proche est requis' });
        }

        const circleName = (typeof name === 'string' && name.trim()) ? name.trim() : cleanedFirstName;
        const linkCircleId = typeof link_circle_id === 'string' && UUID_RE.test(link_circle_id) ? link_circle_id : null;

        await client.query('BEGIN');

        // Resolve the household to attach to, if linking to an existing circle.
        let householdId: string | null = null;
        if (linkCircleId) {
            const linkResult = await client.query(
                `SELECT c.household_id, m.role
                 FROM care_circles c
                 JOIN circle_members m ON m.circle_id = c.id AND m.user_id = $2
                 WHERE c.id = $1`,
                [linkCircleId, req.userId]
            );
            const linkRow = linkResult.rows[0] as { household_id: string | null; role: string } | undefined;
            if (!linkRow || linkRow.role !== 'admin') {
                await client.query('ROLLBACK');
                return res.status(403).json({ success: false, error: 'Vous devez être administrateur du cercle à lier' });
            }
            householdId = linkRow.household_id ?? crypto.randomUUID();
            if (!linkRow.household_id) {
                await client.query('UPDATE care_circles SET household_id = $1 WHERE id = $2', [householdId, linkCircleId]);
            }
        }

        const circleResult = await client.query(
            'INSERT INTO care_circles (name, created_by, household_id) VALUES ($1, $2, $3) RETURNING *',
            [circleName, req.userId, householdId]
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

        // Copy the linked circle's caregiver team (except the creator, already admin).
        if (linkCircleId && copy_members === true) {
            await client.query(
                `INSERT INTO circle_members (circle_id, user_id, role, color)
                 SELECT $1, user_id, role, color FROM circle_members
                 WHERE circle_id = $2 AND user_id <> $3
                 ON CONFLICT (circle_id, user_id) DO NOTHING`,
                [circle.id, linkCircleId, req.userId]
            );
        }

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

// Link two existing circles into the same household/foyer (couple).
// Requester must administer BOTH circles. Keeps the "one circle = one recipient"
// invariant: only a shared household_id is set.
router.post('/:circleId/link', circleMiddleware, requireAdmin, async (req: CircleRequest, res: Response) => {
    try {
        const targetId = typeof req.body?.target_circle_id === 'string' ? req.body.target_circle_id : '';
        if (!UUID_RE.test(targetId) || targetId === req.circleId) {
            return res.status(400).json({ success: false, error: 'Cercle cible invalide' });
        }

        const targetResult = await query(
            `SELECT c.household_id, m.role
             FROM care_circles c
             JOIN circle_members m ON m.circle_id = c.id AND m.user_id = $2
             WHERE c.id = $1`,
            [targetId, req.userId]
        );
        const target = targetResult.rows[0] as { household_id: string | null; role: string } | undefined;
        if (!target || target.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'Vous devez être administrateur des deux cercles' });
        }

        const sourceResult = await query('SELECT household_id FROM care_circles WHERE id = $1', [req.circleId]);
        const sourceHousehold = (sourceResult.rows[0]?.household_id as string | null) ?? null;
        const targetHousehold = target.household_id;

        if (sourceHousehold && targetHousehold && sourceHousehold !== targetHousehold) {
            return res.status(400).json({ success: false, error: 'Un des cercles appartient déjà à un autre foyer' });
        }

        const householdId = sourceHousehold ?? targetHousehold ?? crypto.randomUUID();
        await query(
            'UPDATE care_circles SET household_id = $1 WHERE id = ANY($2::uuid[])',
            [householdId, [req.circleId, targetId]]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'circle', action: 'updated' });
        await broadcastToCircle(targetId, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true, data: { household_id: householdId } });
    } catch (error) {
        console.error('Link circle error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Leave the household/foyer (admin). Clears this circle's household_id; if a single
// circle is left in that household, clears it too (no lonely foyer).
router.delete('/:circleId/link', circleMiddleware, requireAdmin, async (req: CircleRequest, res: Response) => {
    const client = await getClient();
    try {
        await client.query('BEGIN');

        const current = await client.query('SELECT household_id FROM care_circles WHERE id = $1', [req.circleId]);
        const householdId = (current.rows[0]?.household_id as string | null) ?? null;
        if (!householdId) {
            await client.query('COMMIT');
            return res.json({ success: true });
        }

        // Verrouille tout le foyer dans un ordre stable (par id) pour serialiser
        // deux departs concurrents sans interblocage.
        await client.query(
            'SELECT id FROM care_circles WHERE household_id = $1 ORDER BY id FOR UPDATE',
            [householdId]
        );

        await client.query('UPDATE care_circles SET household_id = NULL WHERE id = $1', [req.circleId]);

        const remaining = await client.query('SELECT id FROM care_circles WHERE household_id = $1', [householdId]);
        let lonelyId: string | null = null;
        if (remaining.rows.length === 1) {
            lonelyId = remaining.rows[0].id as string;
            await client.query('UPDATE care_circles SET household_id = NULL WHERE id = $1', [lonelyId]);
        }

        // Plus aucun cercle dans ce foyer: on retire la ligne households (nom inclus).
        await client.query(
            'DELETE FROM households WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM care_circles WHERE household_id = $1)',
            [householdId]
        );

        await client.query('COMMIT');

        if (lonelyId) await broadcastToCircle(lonelyId, { type: 'update', entity: 'circle', action: 'updated' });
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Unlink circle error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Rename the household/foyer (admin). Creates the households row lazily (the
// link flows only set a shared household_id; the name is added on demand).
router.put('/:circleId/household', circleMiddleware, requireAdmin, async (req: CircleRequest, res: Response) => {
    try {
        const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 255) : '';

        const current = await query('SELECT household_id FROM care_circles WHERE id = $1', [req.circleId]);
        const householdId = (current.rows[0]?.household_id as string | null) ?? null;
        if (!householdId) {
            return res.status(400).json({ success: false, error: 'Ce cercle ne fait pas partie d\'un foyer' });
        }

        const result = await query(
            `INSERT INTO households (id, name, created_by) VALUES ($1, $2, $3)
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
             RETURNING name`,
            [householdId, name || null, req.userId]
        );

        // Tous les cercles du foyer voient le changement.
        const siblings = await query('SELECT id FROM care_circles WHERE household_id = $1', [householdId]);
        for (const row of siblings.rows as Array<{ id: string }>) {
            await broadcastToCircle(row.id, { type: 'update', entity: 'circle', action: 'updated' });
        }

        res.json({ success: true, data: { household_name: result.rows[0]?.name ?? null } });
    } catch (error) {
        console.error('Rename household error:', error);
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

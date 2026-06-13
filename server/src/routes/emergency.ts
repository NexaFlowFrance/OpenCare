import { Router, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireContentWriter, CircleRequest } from '../middleware/circle';

const router = Router();

/**
 * Fiche urgence (QR sur le frigo): les secours scannent le QR et voient,
 * sans compte, la fiche vitale generee en direct depuis les donnees du cercle.
 */

// Lecture publique par token (pompiers / SAMU). Pas d'auth.
router.get('/public/:token', async (req, res) => {
    try {
        const sheetResult = await query(
            `SELECT s.circle_id, s.extra_notes, s.updated_at
             FROM emergency_sheets s
             WHERE s.public_token = $1 AND s.enabled = TRUE`,
            [req.params.token]
        );

        const sheet = sheetResult.rows[0];
        if (!sheet) {
            return res.status(404).json({ success: false, error: 'Fiche introuvable' });
        }

        const [recipientResult, medsResult, contactsResult] = await Promise.all([
            query(
                `SELECT first_name, last_name, birth_date, photo_url, address, phone,
                        blood_type, allergies, medical_history, advance_directives,
                        gp_name, gp_phone, insurance_info
                 FROM care_recipients WHERE circle_id = $1`,
                [sheet.circle_id]
            ),
            query(
                `SELECT m.name, m.dosage, m.form,
                        COALESCE(
                            json_agg(json_build_object('time', to_char(s.time_of_day, 'HH24:MI'), 'label', s.label))
                                FILTER (WHERE s.id IS NOT NULL),
                            '[]'::json
                        ) AS schedules
                 FROM medications m
                 LEFT JOIN medication_schedules s ON s.medication_id = m.id
                 WHERE m.circle_id = $1 AND m.active = TRUE
                 GROUP BY m.id
                 ORDER BY m.name`,
                [sheet.circle_id]
            ),
            query(
                `SELECT name, category, organization, phone, phone2
                 FROM contacts
                 WHERE circle_id = $1 AND phone IS NOT NULL
                 ORDER BY CASE category
                     WHEN 'doctor' THEN 0
                     WHEN 'nurse' THEN 1
                     WHEN 'family' THEN 2
                     ELSE 3
                 END, name
                 LIMIT 8`,
                [sheet.circle_id]
            ),
        ]);

        res.json({
            success: true,
            data: {
                recipient: recipientResult.rows[0] ?? null,
                medications: medsResult.rows,
                contacts: contactsResult.rows,
                extra_notes: sheet.extra_notes,
                updated_at: sheet.updated_at,
            },
        });
    } catch (error) {
        console.error('Public emergency sheet error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.use(authMiddleware, circleMiddleware);

// Lire (et creer au premier acces) la fiche du cercle
router.get('/sheet', async (req: CircleRequest, res: Response) => {
    try {
        let result = await query('SELECT * FROM emergency_sheets WHERE circle_id = $1', [req.circleId]);

        if (result.rows.length === 0) {
            // La fiche est creee desactivee (enabled = FALSE): elle expose des
            // donnees de sante en acces public, un admin/family doit l'activer
            // explicitement via PUT /sheet avant que GET /public/:token reponde.
            const token = crypto.randomBytes(32).toString('hex');
            result = await query(
                'INSERT INTO emergency_sheets (circle_id, public_token, enabled) VALUES ($1, $2, FALSE) RETURNING *',
                [req.circleId, token]
            );
        }

        const sheet = result.rows[0];
        res.json({ success: true, data: { ...sheet, url: `/urgence/${sheet.public_token}` } });
    } catch (error) {
        console.error('Get emergency sheet error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Activer/desactiver, notes complementaires, regenerer le token
router.put('/sheet', requireContentWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { enabled, extra_notes, regenerate_token } = req.body;

        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (typeof enabled === 'boolean') {
            fields.push(`enabled = $${idx++}`);
            values.push(enabled);
        }
        if (typeof extra_notes === 'string' || extra_notes === null) {
            fields.push(`extra_notes = $${idx++}`);
            values.push(extra_notes === '' ? null : extra_notes);
        }
        if (regenerate_token === true) {
            fields.push(`public_token = $${idx++}`);
            values.push(crypto.randomBytes(32).toString('hex'));
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No changes provided' });
        }

        values.push(req.circleId);
        const result = await query(
            `UPDATE emergency_sheets SET ${fields.join(', ')} WHERE circle_id = $${idx} RETURNING *`,
            values
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Sheet not found' });
        }

        const sheet = result.rows[0];
        res.json({ success: true, data: { ...sheet, url: `/urgence/${sheet.public_token}` } });
    } catch (error) {
        console.error('Update emergency sheet error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

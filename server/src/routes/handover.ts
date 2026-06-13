import { Router, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireContentWriter, CircleRequest } from '../middleware/circle';
import { expandEventOccurrences, toLocalISO } from './events';
import { broadcastToCircle } from '../lib/broadcaster';

const router = Router();

/**
 * Mode relais (vacances de l'aidant principal) : un pack de passation figé
 * au moment de sa création (identité du proche, consignes, médicaments,
 * planning de la période, contacts, « Qui je suis »), partagé au remplaçant
 * par un lien public /relais/<token>, lisible jusqu'à 7 jours après la fin.
 */

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_PERIOD_DAYS = 92;
const MAX_INSTRUCTIONS_LENGTH = 5000;
const PUBLIC_GRACE_DAYS = 7;

/** Parse a strict YYYY-MM-DD string into a local Date, rejecting overflow. */
const parseDay = (value: unknown): Date | null => {
    if (typeof value !== 'string' || !DATE_REGEX.test(value.trim())) return null;
    const [year, month, day] = value.trim().split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.getMonth() === month - 1 && date.getDate() === day ? date : null;
};

/** DATE columns can come back as Date or string depending on the pg parser. */
const toDayString = (value: unknown): string => {
    if (value instanceof Date) {
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    }
    return String(value).slice(0, 10);
};

const PACK_LIST_SELECT = `
    SELECT p.id, p.circle_id, p.token, p.starts_on, p.ends_on, p.created_at,
           u.name AS created_by_name
    FROM handover_packs p
    LEFT JOIN users u ON u.id = p.created_by`;

// ============================================================
// Public route (no account), registered BEFORE the auth block:
// the relief caregiver opens /relais/<token> from any device.
// ============================================================
router.get('/public/:token', async (req, res) => {
    try {
        const result = await query(
            `SELECT p.starts_on, p.ends_on, p.content, p.created_at,
                    (CURRENT_DATE > p.ends_on + ${PUBLIC_GRACE_DAYS}) AS expired,
                    r.first_name AS recipient_first_name
             FROM handover_packs p
             LEFT JOIN care_recipients r ON r.circle_id = p.circle_id
             WHERE p.token = $1`,
            [req.params.token]
        );

        const pack = result.rows[0];
        if (!pack) {
            return res.status(404).json({ success: false, error: 'Pack introuvable' });
        }
        if (pack.expired) {
            return res.status(410).json({ success: false, error: 'Ce pack de relais a expiré' });
        }

        res.json({
            success: true,
            data: {
                starts_on: toDayString(pack.starts_on),
                ends_on: toDayString(pack.ends_on),
                content: pack.content,
                created_at: pack.created_at,
                recipient_first_name: pack.recipient_first_name ?? null,
            },
        });
    } catch (error) {
        console.error('Public handover pack error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================================
// Authenticated routes (admin and family of the circle)
// ============================================================
router.use(authMiddleware, circleMiddleware, requireContentWriter);

// List the circle's packs, most recent first
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `${PACK_LIST_SELECT} WHERE p.circle_id = $1 ORDER BY p.created_at DESC`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List handover packs error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create a pack: snapshot of everything the relief caregiver needs for the period
router.post('/', async (req: CircleRequest, res: Response) => {
    try {
        const { starts_on, ends_on, instructions } = req.body;

        const startsOn = parseDay(starts_on);
        const endsOn = parseDay(ends_on);
        if (!startsOn || !endsOn) {
            return res.status(400).json({ success: false, error: 'starts_on and ends_on must be YYYY-MM-DD dates' });
        }
        if (endsOn.getTime() < startsOn.getTime()) {
            return res.status(400).json({ success: false, error: 'ends_on must be after starts_on' });
        }
        if (endsOn.getTime() - startsOn.getTime() > MAX_PERIOD_DAYS * MS_PER_DAY) {
            return res.status(400).json({ success: false, error: `Period too long (max ${MAX_PERIOD_DAYS} days)` });
        }

        let cleanInstructions: string | null = null;
        if (instructions !== undefined && instructions !== null) {
            if (typeof instructions !== 'string' || instructions.length > MAX_INSTRUCTIONS_LENGTH) {
                return res.status(400).json({ success: false, error: `instructions must be a string of at most ${MAX_INSTRUCTIONS_LENGTH} characters` });
            }
            cleanInstructions = instructions.trim() || null;
        }

        const windowStart = startsOn;
        const windowEnd = new Date(endsOn.getFullYear(), endsOn.getMonth(), endsOn.getDate(), 23, 59, 59);

        const [recipientResult, medsResult, eventsResult, contactsResult, storyResult] = await Promise.all([
            query(
                `SELECT first_name, last_name, birth_date, phone, address,
                        allergies, gp_name, gp_phone
                 FROM care_recipients WHERE circle_id = $1`,
                [req.circleId]
            ),
            query(
                `SELECT m.name, m.dosage, m.form, m.instructions,
                        COALESCE(
                            json_agg(json_build_object(
                                'time', to_char(s.time_of_day, 'HH24:MI'),
                                'label', s.label,
                                'days_of_week', s.days_of_week
                            ) ORDER BY s.time_of_day) FILTER (WHERE s.id IS NOT NULL),
                            '[]'::json
                        ) AS schedules
                 FROM medications m
                 LEFT JOIN medication_schedules s ON s.medication_id = m.id
                 WHERE m.circle_id = $1 AND m.active = TRUE
                 GROUP BY m.id
                 ORDER BY m.name`,
                [req.circleId]
            ),
            query(
                `SELECT title, description, category, start_time, end_time, location, rrule
                 FROM events
                 WHERE circle_id = $1
                   AND start_time <= $3
                   AND (rrule IS NOT NULL OR COALESCE(end_time, start_time) >= $2)
                 ORDER BY start_time`,
                [req.circleId, toLocalISO(windowStart), toLocalISO(windowEnd)]
            ),
            query(
                `SELECT name, category, organization, phone, phone2, email, has_key, notes
                 FROM contacts WHERE circle_id = $1 ORDER BY name`,
                [req.circleId]
            ),
            query('SELECT sections FROM recipient_stories WHERE circle_id = $1', [req.circleId]),
        ]);

        // Expand recurring events into the occurrences of the relay period
        const eventOccurrences: Array<Record<string, unknown>> = [];
        for (const event of eventsResult.rows) {
            for (const occ of expandEventOccurrences(event, windowStart, windowEnd)) {
                eventOccurrences.push({
                    title: event.title,
                    description: event.description,
                    category: event.category,
                    location: event.location,
                    start_time: toLocalISO(occ.start),
                    end_time: occ.end ? toLocalISO(occ.end) : null,
                    occurrence_date: occ.occurrenceDate,
                });
            }
        }
        eventOccurrences.sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));

        const content = {
            recipient: recipientResult.rows[0] ?? null,
            instructions: cleanInstructions,
            medications_current: medsResult.rows,
            events: eventOccurrences,
            contacts: contactsResult.rows,
            story: storyResult.rows[0]?.sections ?? [],
        };

        const token = crypto.randomBytes(32).toString('hex');
        const inserted = await query(
            `INSERT INTO handover_packs (circle_id, token, starts_on, ends_on, content, created_by)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [
                req.circleId,
                token,
                String(starts_on).trim(),
                String(ends_on).trim(),
                JSON.stringify(content),
                req.userId,
            ]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true, data: { ...inserted.rows[0], url: `/relais/${token}` } });
    } catch (error) {
        console.error('Create handover pack error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete a pack (its public link stops working immediately)
router.delete('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT id FROM handover_packs WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Pack not found' });
        }

        await query('DELETE FROM handover_packs WHERE id = $1', [req.params.id]);

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete handover pack error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

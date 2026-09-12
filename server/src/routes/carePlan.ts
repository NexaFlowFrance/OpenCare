import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireContentWriter, CircleRequest } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';
import { expandEventOccurrences, toLocalISO } from './events';
import { loadCarePlan, saveCarePlan, sanitizeSections } from '../lib/carePlan';

// Plan de soins : une page qui rassemble ce qu'il faut savoir pour prendre
// soin du proche. Les consignes (texte) sont stockees dans care_plans ; la
// routine medicamenteuse, les professionnels reguliers et la semaine a venir
// sont lus depuis les donnees existantes (medicaments, contacts, agenda).
const router = Router();
router.use(authMiddleware);
router.use(circleMiddleware);

const PROFESSIONAL_CATEGORIES = ['doctor', 'nurse', 'aide', 'physio', 'pharmacy'];
const WEEK_DAYS = 7;

const dayKey = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// GET /api/care-plan : consignes + routine medicamenteuse (sauf voisin) +
// professionnels + semaine a venir (occurrences recurrentes comprises).
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const circleId = req.circleId!;
        const includeHealth = req.circleRole !== 'neighbor';
        const now = new Date();
        const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const to = new Date(from.getTime() + WEEK_DAYS * 24 * 60 * 60 * 1000 - 1000);

        const [plan, medsResult, contactsResult, eventsResult, membersResult] = await Promise.all([
            loadCarePlan(circleId),
            includeHealth
                ? query(
                    `SELECT m.id, m.name, m.dosage, m.form, m.instructions, m.prn, m.with_food, m.reason, m.appearance,
                            COALESCE(
                                json_agg(json_build_object(
                                    'time', to_char(s.time_of_day, 'HH24:MI'),
                                    'label', s.label,
                                    'days_of_week', s.days_of_week,
                                    'quantity', s.quantity,
                                    'unit', s.unit
                                ) ORDER BY s.time_of_day) FILTER (WHERE s.id IS NOT NULL),
                                '[]'::json
                            ) AS schedules
                     FROM medications m
                     LEFT JOIN medication_schedules s ON s.medication_id = m.id
                     WHERE m.circle_id = $1 AND m.active = TRUE
                     GROUP BY m.id
                     ORDER BY m.prn, m.name`,
                    [circleId]
                )
                : Promise.resolve(null),
            query(
                `SELECT id, name, category, organization, phone, phone2, email
                 FROM contacts
                 WHERE circle_id = $1 AND category = ANY($2::text[])
                 ORDER BY CASE category WHEN 'doctor' THEN 0 WHEN 'nurse' THEN 1 WHEN 'aide' THEN 2 WHEN 'physio' THEN 3 ELSE 4 END, name`,
                [circleId, PROFESSIONAL_CATEGORIES]
            ),
            query(
                `SELECT * FROM events
                 WHERE circle_id = $1
                   AND start_time <= $3
                   AND (rrule IS NOT NULL OR COALESCE(end_time, start_time) >= $2)
                 ORDER BY start_time`,
                [circleId, toLocalISO(from), toLocalISO(to)]
            ),
            query(
                `SELECT m.id, u.name FROM circle_members m JOIN users u ON u.id = m.user_id WHERE m.circle_id = $1`,
                [circleId]
            ),
        ]);

        const memberName = new Map((membersResult.rows as Array<{ id: string; name: string }>).map((m) => [m.id, m.name]));
        const days = Array.from({ length: WEEK_DAYS }, (_, i) => ({
            date: dayKey(new Date(from.getTime() + i * 24 * 60 * 60 * 1000)),
            items: [] as Array<Record<string, unknown>>,
        }));
        const byDate = new Map(days.map((d) => [d.date, d.items]));
        for (const event of eventsResult.rows as any[]) {
            for (const occ of expandEventOccurrences(event, from, to)) {
                const bucket = byDate.get(dayKey(occ.start));
                if (!bucket) continue;
                const memberIds: string[] = Array.isArray(event.member_ids) ? event.member_ids : [];
                bucket.push({
                    id: event.id,
                    title: event.title,
                    category: event.category,
                    location: event.location ?? null,
                    start_time: toLocalISO(occ.start),
                    end_time: occ.end ? toLocalISO(occ.end) : null,
                    members: memberIds.map((id) => memberName.get(id)).filter(Boolean),
                    recurring: Boolean(event.rrule),
                });
            }
        }
        for (const day of days) day.items.sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));

        res.json({
            success: true,
            data: {
                ...plan,
                medications: includeHealth ? medsResult!.rows : null,
                professionals: contactsResult.rows,
                week: { from: days[0].date, to: days[days.length - 1].date, days },
            },
        });
    } catch (error) {
        console.error('Get care plan error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// PUT /api/care-plan : { sections: { morning?, meals?, ... } } (mise a jour
// partielle, admin et famille). Les cles inconnues sont ignorees.
router.put('/', requireContentWriter, async (req: CircleRequest, res: Response) => {
    try {
        const patch = sanitizeSections(req.body?.sections);
        if (Object.keys(patch).length === 0) {
            return res.status(400).json({ success: false, error: 'sections is required' });
        }
        const plan = await saveCarePlan(req.circleId!, req.userId!, patch);
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'care_plan', action: 'updated' });
        res.json({ success: true, data: plan });
    } catch (error) {
        console.error('Update care plan error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

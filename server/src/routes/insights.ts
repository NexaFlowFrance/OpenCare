import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireContentWriter, CircleRequest } from '../middleware/circle';

const router = Router();

// Insights: stats transverses du cercle (équité de la charge, préparation
// de consultation). Données sensibles: réservé aux rôles admin et family.
router.use(authMiddleware, circleMiddleware, requireContentWriter);

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

interface EquityCounts {
    member_id: string;
    user_id: string;
    role: string;
    color: string;
    name: string;
    visits: number;
    tasks: number;
    events: number;
}

/**
 * Compte, par membre actif du cercle (admin, family, professional), ce qu'il a
 * porté sur [start, end): entrées de journal de type visit, tâches complétées,
 * événements passés auxquels il participait (member_ids JSONB).
 */
const aggregateEquity = async (circleId: string, start: Date, end: Date): Promise<EquityCounts[]> => {
    const result = await query(
        `SELECT m.id AS member_id, m.user_id, m.role, m.color, u.name,
                (SELECT COUNT(*)::int FROM journal_entries e
                 WHERE e.circle_id = m.circle_id
                   AND e.author_user_id = m.user_id
                   AND e.type = 'visit'
                   AND e.occurred_at >= $2 AND e.occurred_at < $3) AS visits,
                (SELECT COUNT(*)::int FROM tasks t
                 WHERE t.circle_id = m.circle_id
                   AND t.completed_by = m.user_id
                   AND t.is_completed = TRUE
                   AND t.completed_at >= $2 AND t.completed_at < $3) AS tasks,
                (SELECT COUNT(*)::int FROM events ev
                 WHERE ev.circle_id = m.circle_id
                   AND ev.start_time >= $2 AND ev.start_time < $3
                   AND ev.start_time <= CURRENT_TIMESTAMP
                   AND ev.member_ids @> to_jsonb(m.id::text)) AS events
         FROM circle_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.circle_id = $1
           AND m.role IN ('admin', 'family', 'professional')
         ORDER BY u.name`,
        [circleId, start, end]
    );
    return result.rows as EquityCounts[];
};

const withTotals = (rows: EquityCounts[]) => {
    const totals = rows.reduce(
        (acc, r) => ({
            visits: acc.visits + r.visits,
            tasks: acc.tasks + r.tasks,
            events: acc.events + r.events,
        }),
        { visits: 0, tasks: 0, events: 0 }
    );
    const grandTotal = totals.visits + totals.tasks + totals.events;
    const members = rows.map((r) => {
        const total = r.visits + r.tasks + r.events;
        return {
            ...r,
            total,
            percent: grandTotal > 0 ? Math.round((total / grandTotal) * 100) : 0,
        };
    });
    return { members, totals: { ...totals, total: grandTotal } };
};

// GET /api/insights/equity?months=1|3|12
// Répartition de la charge sur la période courante (mois calendaires, le mois
// en cours inclus) et sur la période précédente équivalente, par membre.
router.get('/equity', async (req: CircleRequest, res: Response) => {
    try {
        const rawMonths = req.query.months === undefined ? '1' : String(req.query.months);
        const months = parseInt(rawMonths, 10);
        if (![1, 3, 12].includes(months)) {
            return res.status(400).json({ success: false, error: 'months must be 1, 3 or 12' });
        }

        const now = new Date();
        const startOfMonthAgo = (k: number) => new Date(now.getFullYear(), now.getMonth() - k, 1);
        const start = startOfMonthAgo(months - 1);
        const previousStart = startOfMonthAgo(2 * months - 1);

        const [currentRows, previousRows] = await Promise.all([
            aggregateEquity(req.circleId!, start, now),
            aggregateEquity(req.circleId!, previousStart, start),
        ]);

        const current = withTotals(currentRows);
        const previous = withTotals(previousRows);

        res.json({
            success: true,
            data: {
                months,
                period: { start: start.toISOString(), end: now.toISOString() },
                previous_period: { start: previousStart.toISOString(), end: start.toISOString() },
                members: current.members,
                totals: current.totals,
                previous_members: previous.members,
                previous_totals: previous.totals,
            },
        });
    } catch (error) {
        console.error('Equity insights error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/insights/consultation?since=YYYY-MM-DD
// Tout le nécessaire pour préparer la consultation chez le médecin:
// identité du proche, événements marquants, constantes, traitements,
// observance et ordonnances depuis `since` (défaut: 90 jours).
router.get('/consultation', async (req: CircleRequest, res: Response) => {
    try {
        let since: Date;
        if (req.query.since !== undefined) {
            const raw = String(req.query.since);
            since = new Date(`${raw}T00:00:00`);
            if (!DATE_ONLY_REGEX.test(raw) || isNaN(since.getTime())) {
                return res.status(400).json({ success: false, error: 'since must be a YYYY-MM-DD date' });
            }
        } else {
            since = new Date();
            since.setDate(since.getDate() - 90);
            since.setHours(0, 0, 0, 0);
        }
        const until = new Date();

        const [
            recipientResult,
            highlightsResult,
            vitalsResult,
            medicationsResult,
            intakesResult,
            missedResult,
            prescriptionsResult,
        ] = await Promise.all([
            query(
                `SELECT first_name, last_name, birth_date, blood_type, allergies,
                        medical_history, gp_name, gp_phone
                 FROM care_recipients WHERE circle_id = $1`,
                [req.circleId]
            ),
            query(
                `SELECT id, type, content, author_name, occurred_at
                 FROM journal_entries
                 WHERE circle_id = $1
                   AND type IN ('incident', 'mood', 'visit')
                   AND occurred_at >= $2
                 ORDER BY occurred_at DESC
                 LIMIT 40`,
                [req.circleId, since]
            ),
            query(
                `SELECT type, value::float8 AS value, value2::float8 AS value2, unit, measured_at
                 FROM vitals
                 WHERE circle_id = $1 AND measured_at >= $2
                 ORDER BY measured_at ASC`,
                [req.circleId, since]
            ),
            query(
                `SELECT m.id, m.name, m.dosage, m.form, m.instructions, m.prescriber,
                        COALESCE(
                            json_agg(
                                json_build_object(
                                    'time_of_day', to_char(s.time_of_day, 'HH24:MI'),
                                    'days_of_week', s.days_of_week,
                                    'label', s.label
                                ) ORDER BY s.time_of_day
                            ) FILTER (WHERE s.id IS NOT NULL),
                            '[]'
                        ) AS schedules
                 FROM medications m
                 LEFT JOIN medication_schedules s ON s.medication_id = m.id
                 WHERE m.circle_id = $1
                   AND m.active = TRUE
                   AND (m.end_date IS NULL OR m.end_date >= CURRENT_DATE)
                 GROUP BY m.id
                 ORDER BY m.name`,
                [req.circleId]
            ),
            query(
                `SELECT COUNT(*)::int AS scheduled,
                        COUNT(*) FILTER (WHERE status = 'taken')::int AS taken,
                        COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
                        COUNT(*) FILTER (WHERE status = 'missed')::int AS missed
                 FROM medication_intakes
                 WHERE circle_id = $1 AND due_at >= $2 AND due_at <= $3`,
                [req.circleId, since, until]
            ),
            query(
                `SELECT i.due_at, m.name AS medication_name, m.dosage
                 FROM medication_intakes i
                 JOIN medications m ON m.id = i.medication_id
                 WHERE i.circle_id = $1 AND i.status = 'missed'
                   AND i.due_at >= $2 AND i.due_at <= $3
                 ORDER BY i.due_at DESC
                 LIMIT 50`,
                [req.circleId, since, until]
            ),
            query(
                `SELECT id, title, prescribed_by, issued_date, renewal_date
                 FROM prescriptions
                 WHERE circle_id = $1
                 ORDER BY renewal_date ASC NULLS LAST, created_at DESC`,
                [req.circleId]
            ),
        ]);

        // Série par type de constante: toutes les valeurs de la période,
        // plus la première et la dernière pour lire l'évolution d'un coup d'oeil.
        interface VitalRow {
            type: string;
            value: number;
            value2: number | null;
            unit: string | null;
            measured_at: string;
        }
        const seriesByType = new Map<string, VitalRow[]>();
        for (const row of vitalsResult.rows as VitalRow[]) {
            const list = seriesByType.get(row.type);
            if (list) {
                list.push(row);
            } else {
                seriesByType.set(row.type, [row]);
            }
        }
        const vitalsSeries = Array.from(seriesByType.entries()).map(([type, values]) => ({
            type,
            unit: values[values.length - 1].unit,
            count: values.length,
            first: values[0],
            last: values[values.length - 1],
            values,
        }));

        res.json({
            success: true,
            data: {
                recipient: recipientResult.rows[0] ?? null,
                period: { since: since.toISOString(), until: until.toISOString() },
                journal_highlights: highlightsResult.rows,
                vitals_series: vitalsSeries,
                medications_current: medicationsResult.rows,
                intakes_summary: intakesResult.rows[0],
                missed_doses: missedResult.rows,
                prescriptions: prescriptionsResult.rows,
            },
        });
    } catch (error) {
        console.error('Consultation insights error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

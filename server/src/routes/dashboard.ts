import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, CircleRequest } from '../middleware/circle';

const router = Router();
router.use(authMiddleware);
router.use(circleMiddleware);

const DAY_MS = 24 * 60 * 60 * 1000;
const BYDAY_TO_JS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * Minimal RRULE check: does this recurring event occur today?
 * Supported: FREQ=DAILY (with INTERVAL) and FREQ=WEEKLY (with INTERVAL and
 * BYDAY), plus UNTIL. Rules with COUNT or other frequencies (MONTHLY...) are
 * skipped here: the dashboard then only lists their simple occurrences and the
 * full calendar remains the source of truth for complete expansion.
 */
const occursToday = (rruleText: string, startTime: Date, today: Date): boolean => {
    const parts: Record<string, string> = {};
    for (const chunk of rruleText.replace(/^RRULE:/i, '').split(';')) {
        const [key, value] = chunk.split('=');
        if (key && value) parts[key.trim().toUpperCase()] = value.trim().toUpperCase();
    }

    const start = startOfDay(startTime);
    const day = startOfDay(today);
    if (day < start) return false;

    if (parts.COUNT) return false; // counting occurrences is out of scope here

    if (parts.UNTIL) {
        const m = parts.UNTIL.match(/^(\d{4})(\d{2})(\d{2})/);
        if (m) {
            const until = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
            if (day > until) return false;
        }
    }

    const interval = Math.max(1, parseInt(parts.INTERVAL || '1', 10) || 1);
    const daysDiff = Math.round((day.getTime() - start.getTime()) / DAY_MS);

    if (parts.FREQ === 'DAILY') {
        return daysDiff % interval === 0;
    }

    if (parts.FREQ === 'WEEKLY') {
        const byday = parts.BYDAY
            ? parts.BYDAY.split(',').map((code) => BYDAY_TO_JS[code]).filter((n) => n !== undefined)
            : [start.getDay()];
        if (!byday.includes(day.getDay())) return false;
        // Compare week buckets aligned on the start date's week (Monday-based)
        const weekAnchor = (d: Date) => Math.floor((d.getTime() / DAY_MS - ((d.getDay() + 6) % 7)));
        const weeksDiff = Math.round((weekAnchor(day) - weekAnchor(start)) / 7);
        return weeksDiff >= 0 && weeksDiff % interval === 0;
    }

    return false;
};

/** Project a recurring event's start/end onto today, keeping the time of day. */
const projectToToday = (event: any, today: Date) => {
    const start = new Date(event.start_time);
    const occurrenceStart = new Date(
        today.getFullYear(), today.getMonth(), today.getDate(),
        start.getHours(), start.getMinutes(), start.getSeconds()
    );
    let occurrenceEnd: Date | null = null;
    if (event.end_time) {
        const end = new Date(event.end_time);
        occurrenceEnd = new Date(occurrenceStart.getTime() + (end.getTime() - start.getTime()));
    }
    return { ...event, start_time: occurrenceStart, end_time: occurrenceEnd, is_recurring_occurrence: true };
};

// Single-call dashboard for the active circle. Readable by every role;
// neighbors do not receive health data (vitals, medication intakes).
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const circleId = req.circleId!;
        const includeHealth = req.circleRole !== 'neighbor';

        const [
            recipientResult,
            simpleEventsResult,
            recurringEventsResult,
            journalResult,
            pendingCountResult,
            pendingTasksResult,
            intakesResult,
            vitalsResult,
        ] = await Promise.all([
            query('SELECT first_name, photo_url FROM care_recipients WHERE circle_id = $1', [circleId]),
            query(
                `SELECT * FROM events
                 WHERE circle_id = $1 AND (rrule IS NULL OR rrule = '')
                   AND start_time::date = CURRENT_DATE
                 ORDER BY start_time`,
                [circleId]
            ),
            query(
                `SELECT * FROM events
                 WHERE circle_id = $1 AND rrule IS NOT NULL AND rrule <> ''
                   AND start_time::date <= CURRENT_DATE`,
                [circleId]
            ),
            query(
                `SELECT id, author_name, type, content, occurred_at, created_at
                 FROM journal_entries
                 WHERE circle_id = $1
                 ORDER BY occurred_at DESC
                 LIMIT 5`,
                [circleId]
            ),
            query(
                'SELECT COUNT(*)::int AS count FROM tasks WHERE circle_id = $1 AND is_completed = false',
                [circleId]
            ),
            query(
                `SELECT id, title, category, due_date, priority, assigned_to
                 FROM tasks
                 WHERE circle_id = $1 AND is_completed = false
                 ORDER BY due_date ASC NULLS LAST, created_at DESC
                 LIMIT 5`,
                [circleId]
            ),
            includeHealth
                ? query(
                    `SELECT i.id, i.due_at, i.status, i.confirmed_at,
                            m.name AS medication_name, m.dosage, m.form
                     FROM medication_intakes i
                     JOIN medications m ON m.id = i.medication_id
                     WHERE i.circle_id = $1 AND i.due_at::date = CURRENT_DATE
                     ORDER BY i.due_at`,
                    [circleId]
                )
                : Promise.resolve(null),
            includeHealth
                ? query(
                    `SELECT DISTINCT ON (type) type, value, value2, unit, measured_at
                     FROM vitals
                     WHERE circle_id = $1
                     ORDER BY type, measured_at DESC`,
                    [circleId]
                )
                : Promise.resolve(null),
        ]);

        // Recurring occurrences of today, computed from a minimal RRULE subset
        // (DAILY / WEEKLY); richer rules only show on the calendar page.
        const today = new Date();
        const recurringToday = (recurringEventsResult.rows as any[])
            .filter((event) => occursToday(String(event.rrule), new Date(event.start_time), today))
            .map((event) => projectToToday(event, today));

        const todayEvents = [...simpleEventsResult.rows, ...recurringToday]
            .sort((a: any, b: any) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

        res.json({
            success: true,
            data: {
                recipient: recipientResult.rows[0] ?? null,
                today_events: todayEvents,
                last_journal_entries: journalResult.rows,
                pending_tasks: {
                    count: pendingCountResult.rows[0]?.count ?? 0,
                    next: pendingTasksResult.rows,
                },
                medication_intakes_today: includeHealth ? intakesResult!.rows : null,
                latest_vitals: includeHealth ? vitalsResult!.rows : null,
                // TODO: no per-user read tracking on messages yet, so the
                // unread counter is always 0 until a read-marker table exists.
                unread_messages_count: 0,
            },
        });
    } catch (error) {
        console.error('Get dashboard error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

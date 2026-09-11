import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, CircleRequest, CircleRole } from '../middleware/circle';
import { toNullIfEmpty } from '../lib/normalize';
import { broadcastToCircle } from '../lib/broadcaster';

const router = Router();

export const EVENT_CATEGORIES = ['visit', 'medical', 'nurse', 'aide', 'other'] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

/** Categories a professional can manage (their own care visits, never medical/other). */
const PROFESSIONAL_CATEGORIES: EventCategory[] = ['visit', 'nurse', 'aide'];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_WINDOW_DAYS = 92;
const MAX_OCCURRENCES_PER_EVENT = 1000;

// ============================================================
// RRULE: simple subset parser and expander (no external lib)
// Supported: FREQ=DAILY|WEEKLY|MONTHLY;INTERVAL=n;BYDAY=MO,..;UNTIL=YYYYMMDD
// INTERVAL defaults to 1, BYDAY only for WEEKLY, UNTIL is inclusive,
// DTSTART is the event's start_time.
// ============================================================

export interface ParsedRRule {
    freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
    interval: number;
    /** JS getDay() values (0=Sunday .. 6=Saturday), WEEKLY only */
    byDays: number[] | null;
    /** End of the last allowed day (inclusive), local time */
    until: Date | null;
}

const DAY_CODES: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Parse the supported RRULE subset. Returns null when the rule is invalid. */
export const parseRRule = (text: unknown): ParsedRRule | null => {
    if (typeof text !== 'string' || !text.trim()) return null;

    let freq: ParsedRRule['freq'] | null = null;
    let interval = 1;
    let byDays: number[] | null = null;
    let until: Date | null = null;
    const seen = new Set<string>();

    for (const part of text.trim().split(';')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        if (eq <= 0) return null;
        const key = part.slice(0, eq).trim().toUpperCase();
        const value = part.slice(eq + 1).trim();
        if (!value || seen.has(key)) return null;
        seen.add(key);

        switch (key) {
            case 'FREQ': {
                const upper = value.toUpperCase();
                if (upper === 'DAILY' || upper === 'WEEKLY' || upper === 'MONTHLY') {
                    freq = upper;
                } else {
                    return null;
                }
                break;
            }
            case 'INTERVAL': {
                if (!/^\d+$/.test(value)) return null;
                interval = parseInt(value, 10);
                if (interval < 1 || interval > 366) return null;
                break;
            }
            case 'BYDAY': {
                const days: number[] = [];
                for (const rawCode of value.toUpperCase().split(',')) {
                    const code = rawCode.trim();
                    if (!(code in DAY_CODES)) return null;
                    const day = DAY_CODES[code];
                    if (!days.includes(day)) days.push(day);
                }
                if (days.length === 0) return null;
                byDays = days;
                break;
            }
            case 'UNTIL': {
                if (!/^\d{8}$/.test(value)) return null;
                const year = Number(value.slice(0, 4));
                const month = Number(value.slice(4, 6));
                const day = Number(value.slice(6, 8));
                const date = new Date(year, month - 1, day, 23, 59, 59, 999);
                // Reject calendar overflow (e.g. 20260230 rolling into March)
                if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
                until = date;
                break;
            }
            default:
                return null;
        }
    }

    if (!freq) return null;
    if (byDays && freq !== 'WEEKLY') return null;
    return { freq, interval, byDays, until };
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Format a Date as a naive local ISO string, matching db.ts TIMESTAMP parsing. */
export const toLocalISO = (d: Date): string =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

const toLocalDate = (d: Date): string =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Add calendar days while keeping the wall-clock time (DST safe). */
const addDays = (d: Date, n: number): Date =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());

/** Expand a parsed rule into occurrence start dates within [windowStart, windowEnd]. */
const expandRRule = (rule: ParsedRRule, dtstart: Date, windowStart: Date, windowEnd: Date): Date[] => {
    const out: Date[] = [];
    const end = rule.until && rule.until.getTime() < windowEnd.getTime() ? rule.until : windowEnd;
    if (end.getTime() < dtstart.getTime() || end.getTime() < windowStart.getTime()) return out;

    const push = (occ: Date) => {
        if (
            occ.getTime() >= dtstart.getTime() &&
            occ.getTime() >= windowStart.getTime() &&
            occ.getTime() <= end.getTime() &&
            out.length < MAX_OCCURRENCES_PER_EVENT
        ) {
            out.push(occ);
        }
    };

    if (rule.freq === 'DAILY' || (rule.freq === 'WEEKLY' && !rule.byDays)) {
        const stepDays = rule.freq === 'DAILY' ? rule.interval : rule.interval * 7;
        // Jump close to the window instead of iterating from DTSTART
        // (minus one step to be safe around DST boundaries).
        const diff = windowStart.getTime() - dtstart.getTime();
        let k = diff > 0 ? Math.max(0, Math.floor(diff / (stepDays * MS_PER_DAY)) - 1) : 0;
        for (; out.length < MAX_OCCURRENCES_PER_EVENT; k++) {
            const occ = addDays(dtstart, k * stepDays);
            if (occ.getTime() > end.getTime()) break;
            push(occ);
        }
    } else if (rule.freq === 'WEEKLY') {
        // BYDAY present: weeks start on Monday (RFC 5545 default WKST), counted from DTSTART's week.
        const byDays = rule.byDays!;
        const weekZero = addDays(dtstart, -((dtstart.getDay() + 6) % 7));
        const diffWeeks = Math.floor((windowStart.getTime() - weekZero.getTime()) / (7 * MS_PER_DAY));
        let w = diffWeeks > 0 ? Math.max(0, (Math.floor(diffWeeks / rule.interval) - 1) * rule.interval) : 0;
        for (; out.length < MAX_OCCURRENCES_PER_EVENT; w += rule.interval) {
            const weekStart = addDays(weekZero, w * 7);
            if (weekStart.getTime() > end.getTime()) break;
            for (const day of byDays) {
                push(addDays(weekStart, (day + 6) % 7));
            }
        }
    } else {
        // MONTHLY: same day-of-month as DTSTART; months missing that day are skipped.
        const dayOfMonth = dtstart.getDate();
        const monthsDiff =
            (windowStart.getFullYear() - dtstart.getFullYear()) * 12 +
            (windowStart.getMonth() - dtstart.getMonth());
        let m = monthsDiff > 0 ? Math.max(0, (Math.floor(monthsDiff / rule.interval) - 1) * rule.interval) : 0;
        for (; out.length < MAX_OCCURRENCES_PER_EVENT; m += rule.interval) {
            const monthFirst = new Date(dtstart.getFullYear(), dtstart.getMonth() + m, 1);
            if (monthFirst.getTime() > end.getTime()) break;
            const occ = new Date(
                dtstart.getFullYear(), dtstart.getMonth() + m, dayOfMonth,
                dtstart.getHours(), dtstart.getMinutes(), dtstart.getSeconds()
            );
            if (occ.getDate() !== dayOfMonth) continue;
            push(occ);
        }
    }

    out.sort((a, b) => a.getTime() - b.getTime());
    return out;
};

export interface EventOccurrence {
    start: Date;
    end: Date | null;
    /** Local YYYY-MM-DD of the occurrence */
    occurrenceDate: string;
    isRecurring: boolean;
}

/**
 * Expand an event row into its occurrences within [windowStart, windowEnd].
 * Non-recurring events yield at most one occurrence (when they overlap the window);
 * recurring events are expanded with the parent's duration applied to each occurrence.
 */
export const expandEventOccurrences = (
    event: { start_time: string; end_time: string | null; rrule: string | null },
    windowStart: Date,
    windowEnd: Date
): EventOccurrence[] => {
    const start = new Date(event.start_time);
    if (Number.isNaN(start.getTime())) return [];

    const parsedEnd = event.end_time ? new Date(event.end_time) : null;
    const durationMs = parsedEnd && !Number.isNaN(parsedEnd.getTime())
        ? Math.max(0, parsedEnd.getTime() - start.getTime())
        : null;

    const rule = event.rrule ? parseRRule(event.rrule) : null;

    if (!rule) {
        const eventEnd = durationMs !== null ? new Date(start.getTime() + durationMs) : start;
        if (eventEnd.getTime() < windowStart.getTime() || start.getTime() > windowEnd.getTime()) return [];
        return [{
            start,
            end: durationMs !== null ? eventEnd : null,
            occurrenceDate: toLocalDate(start),
            isRecurring: false,
        }];
    }

    return expandRRule(rule, start, windowStart, windowEnd).map((occ) => ({
        start: occ,
        end: durationMs !== null ? new Date(occ.getTime() + durationMs) : null,
        occurrenceDate: toLocalDate(occ),
        isRecurring: true,
    }));
};

// ============================================================
// Route helpers
// ============================================================

const canWriteCategory = (role: CircleRole | undefined, category: EventCategory): boolean => {
    if (role === 'admin' || role === 'family') return true;
    if (role === 'professional') return PROFESSIONAL_CATEGORIES.includes(category);
    return false;
};

/** Professionals may only touch their own visit/nurse/aide events. */
const canManageExisting = (req: CircleRequest, event: { created_by: string | null; category: EventCategory }): boolean => {
    if (req.circleRole === 'admin' || req.circleRole === 'family') return true;
    if (req.circleRole === 'professional') {
        return event.created_by === req.userId && PROFESSIONAL_CATEGORIES.includes(event.category);
    }
    return false;
};

const parseDateParam = (value: unknown, endOfDay: boolean): Date | null => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        const [year, month, day] = trimmed.split('-').map(Number);
        const date = endOfDay
            ? new Date(year, month - 1, day, 23, 59, 59)
            : new Date(year, month - 1, day, 0, 0, 0);
        return date.getMonth() === month - 1 && date.getDate() === day ? date : null;
    }
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
};

const fetchWindowEvents = async (circleId: string, windowStart: Date, windowEnd: Date) => {
    const result = await query(
        `SELECT * FROM events
         WHERE circle_id = $1
           AND start_time <= $3
           AND (rrule IS NOT NULL OR COALESCE(end_time, start_time) >= $2)
         ORDER BY start_time`,
        [circleId, toLocalISO(windowStart), toLocalISO(windowEnd)]
    );
    return result.rows;
};

const expandAndSerialize = (events: any[], windowStart: Date, windowEnd: Date) => {
    const occurrences: any[] = [];
    for (const event of events) {
        for (const occ of expandEventOccurrences(event, windowStart, windowEnd)) {
            occurrences.push({
                ...event,
                member_ids: Array.isArray(event.member_ids) ? event.member_ids : [],
                start_time: toLocalISO(occ.start),
                end_time: occ.end ? toLocalISO(occ.end) : null,
                occurrence_date: occ.occurrenceDate,
                is_recurring: occ.isRecurring,
            });
        }
    }
    occurrences.sort((a, b) => a.start_time.localeCompare(b.start_time));
    return occurrences;
};

const enrichWithMembers = async (circleId: string, occurrences: any[]) => {
    if (occurrences.length === 0) return occurrences;
    const membersResult = await query(
        `SELECT m.id, m.role, m.color, u.name
         FROM circle_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.circle_id = $1`,
        [circleId]
    );
    const membersById = new Map(membersResult.rows.map((m: any) => [m.id, m]));
    return occurrences.map((occ) => ({
        ...occ,
        members_data: (occ.member_ids as string[]).map((id) => membersById.get(id)).filter(Boolean),
    }));
};

const ensureMembersBelongToCircle = async (memberIds: string[], circleId: string): Promise<boolean> => {
    if (memberIds.length === 0) return true;
    const result = await query(
        'SELECT COUNT(*)::int AS count FROM circle_members WHERE circle_id = $1 AND id = ANY($2::uuid[])',
        [circleId, memberIds]
    );
    return result.rows[0].count === memberIds.length;
};

const cleanMemberIds = (value: unknown): string[] =>
    Array.isArray(value)
        ? [...new Set(value.filter((id: unknown): id is string => typeof id === 'string' && id.trim() !== ''))]
        : [];

// ============================================================
// Routes (all circle scoped via the X-Circle-Id header)
// ============================================================

router.use(authMiddleware, circleMiddleware);

// Events of the circle between from and to (defaults: current month), recurrences expanded
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const now = new Date();
        let from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
        let to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

        if (req.query.from !== undefined) {
            const parsed = parseDateParam(req.query.from, false);
            if (!parsed) return res.status(400).json({ success: false, error: 'Invalid from date' });
            from = parsed;
        }
        if (req.query.to !== undefined) {
            const parsed = parseDateParam(req.query.to, true);
            if (!parsed) return res.status(400).json({ success: false, error: 'Invalid to date' });
            to = parsed;
        }

        if (to.getTime() < from.getTime()) {
            return res.status(400).json({ success: false, error: 'to must be after from' });
        }
        if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * MS_PER_DAY) {
            return res.status(400).json({ success: false, error: `Window too large (max ${MAX_WINDOW_DAYS} days)` });
        }

        const events = await fetchWindowEvents(req.circleId!, from, to);
        const occurrences = await enrichWithMembers(req.circleId!, expandAndSerialize(events, from, to));
        res.json({ success: true, data: occurrences });
    } catch (error) {
        console.error('Get events error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Next 10 occurrences from now over 30 days
router.get('/upcoming', async (req: CircleRequest, res: Response) => {
    try {
        const from = new Date();
        const to = new Date(from.getTime() + 30 * MS_PER_DAY);

        const events = await fetchWindowEvents(req.circleId!, from, to);
        const occurrences = expandAndSerialize(events, from, to).slice(0, 10);
        const enriched = await enrichWithMembers(req.circleId!, occurrences);
        res.json({ success: true, data: enriched });
    } catch (error) {
        console.error('Get upcoming events error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create an event
router.post('/', async (req: CircleRequest, res: Response) => {
    try {
        const {
            title, description, category, start_time, end_time,
            location, rrule, member_ids, reminder_30min, reminder_1hour, notes,
        } = req.body;

        const cleanedTitle = typeof title === 'string' ? title.trim() : '';
        if (!cleanedTitle) {
            return res.status(400).json({ success: false, error: 'Title is required' });
        }

        if (!EVENT_CATEGORIES.includes(category)) {
            return res.status(400).json({ success: false, error: 'Invalid category' });
        }
        if (!canWriteCategory(req.circleRole, category)) {
            return res.status(403).json({ success: false, error: 'Insufficient role for this category' });
        }

        const startTime = toNullIfEmpty(start_time);
        if (!startTime || typeof startTime !== 'string' || Number.isNaN(new Date(startTime).getTime())) {
            return res.status(400).json({ success: false, error: 'Valid start_time is required' });
        }

        const endTime = toNullIfEmpty(end_time);
        if (endTime !== null) {
            if (typeof endTime !== 'string' || Number.isNaN(new Date(endTime).getTime())) {
                return res.status(400).json({ success: false, error: 'Invalid end_time' });
            }
            if (new Date(endTime).getTime() < new Date(startTime).getTime()) {
                return res.status(400).json({ success: false, error: 'end_time must be after start_time' });
            }
        }

        const cleanedRRule = toNullIfEmpty(rrule);
        if (cleanedRRule !== null && !parseRRule(cleanedRRule)) {
            return res.status(400).json({ success: false, error: 'Invalid rrule' });
        }

        const memberIds = cleanMemberIds(member_ids);
        if (!(await ensureMembersBelongToCircle(memberIds, req.circleId!))) {
            return res.status(400).json({ success: false, error: 'Member not found in this circle' });
        }

        const result = await query(
            `INSERT INTO events (circle_id, title, description, category, start_time, end_time,
                                 location, rrule, member_ids, reminder_30min, reminder_1hour, notes, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
             RETURNING *`,
            [
                req.circleId,
                cleanedTitle,
                toNullIfEmpty(description),
                category,
                startTime,
                endTime,
                toNullIfEmpty(location),
                typeof cleanedRRule === 'string' ? cleanedRRule.trim() : null,
                JSON.stringify(memberIds),
                Boolean(reminder_30min),
                Boolean(reminder_1hour),
                toNullIfEmpty(notes),
                req.userId,
            ]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'events', action: 'created' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Create event error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update an event
router.put('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existingResult = await query(
            'SELECT * FROM events WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        const existing = existingResult.rows[0];
        if (!existing) {
            return res.status(404).json({ success: false, error: 'Event not found' });
        }
        if (!canManageExisting(req, existing)) {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }

        const {
            title, description, category, start_time, end_time,
            location, rrule, member_ids, reminder_30min, reminder_1hour, notes,
        } = req.body;

        const updates: string[] = [];
        const values: unknown[] = [];
        const pushUpdate = (field: string, value: unknown, cast = '') => {
            values.push(value);
            updates.push(`${field} = $${values.length}${cast}`);
        };

        if (title !== undefined) {
            const cleanedTitle = typeof title === 'string' ? title.trim() : '';
            if (!cleanedTitle) {
                return res.status(400).json({ success: false, error: 'Title cannot be empty' });
            }
            pushUpdate('title', cleanedTitle);
        }

        if (category !== undefined) {
            if (!EVENT_CATEGORIES.includes(category)) {
                return res.status(400).json({ success: false, error: 'Invalid category' });
            }
            if (!canWriteCategory(req.circleRole, category)) {
                return res.status(403).json({ success: false, error: 'Insufficient role for this category' });
            }
            pushUpdate('category', category);
        }

        let effectiveStart: string = existing.start_time;
        if (start_time !== undefined) {
            const startTime = toNullIfEmpty(start_time);
            if (!startTime || typeof startTime !== 'string' || Number.isNaN(new Date(startTime).getTime())) {
                return res.status(400).json({ success: false, error: 'Valid start_time is required' });
            }
            effectiveStart = startTime;
            pushUpdate('start_time', startTime);
        }

        let effectiveEnd: string | null = existing.end_time;
        if (end_time !== undefined) {
            const endTime = toNullIfEmpty(end_time);
            if (endTime !== null && (typeof endTime !== 'string' || Number.isNaN(new Date(endTime).getTime()))) {
                return res.status(400).json({ success: false, error: 'Invalid end_time' });
            }
            effectiveEnd = endTime as string | null;
            pushUpdate('end_time', effectiveEnd);
        }
        if (effectiveEnd !== null && new Date(effectiveEnd).getTime() < new Date(effectiveStart).getTime()) {
            return res.status(400).json({ success: false, error: 'end_time must be after start_time' });
        }

        if (description !== undefined) pushUpdate('description', toNullIfEmpty(description));
        if (location !== undefined) pushUpdate('location', toNullIfEmpty(location));
        if (notes !== undefined) pushUpdate('notes', toNullIfEmpty(notes));

        if (rrule !== undefined) {
            const cleanedRRule = toNullIfEmpty(rrule);
            if (cleanedRRule !== null && !parseRRule(cleanedRRule)) {
                return res.status(400).json({ success: false, error: 'Invalid rrule' });
            }
            pushUpdate('rrule', typeof cleanedRRule === 'string' ? cleanedRRule.trim() : null);
        }

        if (member_ids !== undefined) {
            const memberIds = cleanMemberIds(member_ids);
            if (!(await ensureMembersBelongToCircle(memberIds, req.circleId!))) {
                return res.status(400).json({ success: false, error: 'Member not found in this circle' });
            }
            pushUpdate('member_ids', JSON.stringify(memberIds), '::jsonb');
        }

        if (reminder_30min !== undefined) pushUpdate('reminder_30min', Boolean(reminder_30min));
        if (reminder_1hour !== undefined) pushUpdate('reminder_1hour', Boolean(reminder_1hour));

        if (updates.length === 0) {
            return res.status(400).json({ success: false, error: 'No fields to update' });
        }

        const result = await query(
            `UPDATE events SET ${updates.join(', ')}
             WHERE id = $${values.length + 1} AND circle_id = $${values.length + 2}
             RETURNING *`,
            [...values, req.params.id, req.circleId]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'events', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update event error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete an event
router.delete('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existingResult = await query(
            'SELECT id, created_by, category FROM events WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        const existing = existingResult.rows[0];
        if (!existing) {
            return res.status(404).json({ success: false, error: 'Event not found' });
        }
        if (!canManageExisting(req, existing)) {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }

        await query('DELETE FROM events WHERE id = $1 AND circle_id = $2', [req.params.id, req.circleId]);
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'events', action: 'deleted' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete event error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

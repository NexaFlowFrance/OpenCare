import crypto from 'node:crypto';
import { Router } from 'express';
import { query } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { expandEventOccurrences, toLocalISO } from './events';

const router = Router();

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ============================================================
// iCalendar helpers
// ============================================================

const escapeICS = (value: string): string =>
    value
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r?\n/g, '\\n');

// Fold lines to 75 octets as required by RFC 5545.
const foldLine = (line: string): string => {
    if (line.length <= 75) return line;
    const chunks: string[] = [];
    let remaining = line;
    chunks.push(remaining.slice(0, 75));
    remaining = remaining.slice(75);
    while (remaining.length > 0) {
        chunks.push(' ' + remaining.slice(0, 74));
        remaining = remaining.slice(74);
    }
    return chunks.join('\r\n');
};

// Format a Date as an iCal floating local time (YYYYMMDDTHHMMSS: no 'Z', no TZID).
// Events are stored as naive local TIMESTAMPs, so we keep them floating.
const formatICSDate = (value: Date): string => toLocalISO(value).replace(/[-:]/g, '');

interface FeedEvent {
    id: string;
    circle_id: string;
    title: string;
    description: string | null;
    location: string | null;
    start_time: string;
    end_time: string | null;
    rrule: string | null;
}

const buildICS = (events: FeedEvent[], recipientNames: Map<string, string>, windowStart: Date, windowEnd: Date): string => {
    const lines: string[] = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//OpenCare//Calendrier//FR',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:OpenCare',
        'X-WR-TIMEZONE:Europe/Paris',
    ];

    const stamp = formatICSDate(new Date());

    for (const event of events) {
        const recipientName = recipientNames.get(event.circle_id);
        const summary = recipientName
            ? `${recipientName}: ${event.title || 'Rendez-vous'}`
            : (event.title || 'Rendez-vous');

        for (const occ of expandEventOccurrences(event, windowStart, windowEnd)) {
            // Default end: start + 1 hour, so calendar apps render a visible block.
            const end = occ.end ?? new Date(occ.start.getTime() + 60 * 60 * 1000);

            lines.push('BEGIN:VEVENT');
            lines.push(`UID:${event.id}-${occ.occurrenceDate.replace(/-/g, '')}@opencare`);
            lines.push(`DTSTAMP:${stamp}`);
            lines.push(`DTSTART:${formatICSDate(occ.start)}`);
            lines.push(`DTEND:${formatICSDate(end)}`);
            lines.push(foldLine(`SUMMARY:${escapeICS(summary)}`));
            if (event.description) lines.push(foldLine(`DESCRIPTION:${escapeICS(event.description)}`));
            if (event.location) lines.push(foldLine(`LOCATION:${escapeICS(event.location)}`));
            lines.push('END:VEVENT');
        }
    }

    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
};

// ============================================================
// Authenticated token management
// ============================================================

// GET /api/calendar/token: current feed token of the logged-in user (null if none yet)
router.get('/token', authMiddleware, async (req: AuthRequest, res) => {
    try {
        const result = await query('SELECT calendar_token FROM users WHERE id = $1', [req.userId]);
        res.json({ success: true, data: { token: result.rows[0]?.calendar_token ?? null } });
    } catch (error) {
        console.error('Get calendar token error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/calendar/token: generate or regenerate the feed token (invalidates the old URL)
router.post('/token', authMiddleware, async (req: AuthRequest, res) => {
    try {
        const token = crypto.randomBytes(32).toString('hex');
        await query('UPDATE users SET calendar_token = $1 WHERE id = $2', [token, req.userId]);
        res.json({ success: true, data: { token } });
    } catch (error) {
        console.error('Generate calendar token error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================================
// Public iCal feed (no auth: secured by the unguessable token)
// ============================================================

// GET /api/calendar/feed/:token.ics
// Aggregates the events of every circle the user belongs to, over [-30d, +365d],
// with recurring events expanded into individual VEVENTs.
router.get('/feed/:token.ics', async (req, res) => {
    try {
        const token = req.params.token;
        if (!token || token.length < 16) {
            return res.status(404).send('Not found');
        }

        const userResult = await query('SELECT id FROM users WHERE calendar_token = $1', [token]);
        if (userResult.rows.length === 0) {
            return res.status(404).send('Not found');
        }
        const userId = userResult.rows[0].id;

        const circlesResult = await query(
            `SELECT m.circle_id, r.first_name
             FROM circle_members m
             LEFT JOIN care_recipients r ON r.circle_id = m.circle_id
             WHERE m.user_id = $1`,
            [userId]
        );
        const circleIds: string[] = circlesResult.rows.map((row: any) => row.circle_id);
        const recipientNames = new Map<string, string>(
            circlesResult.rows
                .filter((row: any) => row.first_name)
                .map((row: any) => [row.circle_id, row.first_name])
        );

        const now = new Date();
        const windowStart = new Date(now.getTime() - 30 * MS_PER_DAY);
        const windowEnd = new Date(now.getTime() + 365 * MS_PER_DAY);

        let events: FeedEvent[] = [];
        if (circleIds.length > 0) {
            const eventsResult = await query(
                `SELECT id, circle_id, title, description, location, start_time, end_time, rrule
                 FROM events
                 WHERE circle_id = ANY($1::uuid[])
                   AND start_time <= $3
                   AND (rrule IS NOT NULL OR COALESCE(end_time, start_time) >= $2)
                 ORDER BY start_time`,
                [circleIds, toLocalISO(windowStart), toLocalISO(windowEnd)]
            );
            events = eventsResult.rows;
        }

        const ics = buildICS(events, recipientNames, windowStart, windowEnd);
        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.setHeader('Content-Disposition', 'inline; filename="opencare.ics"');
        res.send(ics);
    } catch (error) {
        console.error('Calendar feed error:', error);
        res.status(500).send('Internal server error');
    }
});

export default router;

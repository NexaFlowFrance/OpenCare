import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, CircleRequest } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';
import { createNotification } from '../lib/notifications';
import { expandEventOccurrences, toLocalISO } from './events';

// Kiosk routes: the wall tablet at the care recipient's home. It runs with the
// session of a circle member, so the standard auth + circle middlewares apply.
// Mounted on /api/kiosk by app.ts.
const router = Router();
router.use(authMiddleware, circleMiddleware);

type KioskStatusKind = 'ok' | 'help' | 'hydration';

// Server-side strings: the kiosk writes journal entries and notifications on
// behalf of the care recipient, so the wording is resolved here (per user
// language, FR default like the rest of the app).
const STRINGS = {
    fr: {
        okContent: 'Tout va bien (signal envoyé depuis le kiosk)',
        helpContent: "J'ai besoin d'aide (signal envoyé depuis le kiosk)",
        hydrationContent: "A bu de l'eau (signalé depuis le kiosk)",
        helpTitle: (name: string) => `${name} demande de l'aide`,
        helpMessage: (name: string) => `${name} a appuyé sur le bouton d'aide du kiosk. Pensez à prendre des nouvelles tout de suite.`,
    },
    en: {
        okContent: 'All is well (signal sent from the kiosk)',
        helpContent: 'I need help (signal sent from the kiosk)',
        hydrationContent: 'Drank water (logged from the kiosk)',
        helpTitle: (name: string) => `${name} is asking for help`,
        helpMessage: (name: string) => `${name} pressed the help button on the kiosk. Please check in right away.`,
    },
} as const;

const pickLang = (language: unknown): keyof typeof STRINGS =>
    String(language || '').toLowerCase().startsWith('en') ? 'en' : 'fr';

// Journal entry type written for each kiosk button.
const KIND_TO_TYPE: Record<KioskStatusKind, string> = { ok: 'mood', help: 'incident', hydration: 'note' };

// POST /api/kiosk/status : the big buttons of the kiosk.
// 'ok'        -> journal entry of type 'mood' authored by the care recipient.
// 'help'      -> journal entry of type 'incident' + urgent notification to every
//                member of the circle (in-app + web push via createNotification).
// 'hydration' -> journal entry of type 'note' (heat episode hydration check-in),
//                no notification.
router.post('/status', async (req: CircleRequest, res: Response) => {
    try {
        const kind = req.body?.kind as KioskStatusKind;
        if (kind !== 'ok' && kind !== 'help' && kind !== 'hydration') {
            return res.status(400).json({ success: false, error: 'Invalid kind' });
        }

        const [recipientResult, sessionUserResult] = await Promise.all([
            query('SELECT first_name FROM care_recipients WHERE circle_id = $1', [req.circleId]),
            query('SELECT language FROM users WHERE id = $1', [req.userId]),
        ]);

        const firstName: string = recipientResult.rows[0]?.first_name?.trim() || 'Kiosk';
        const sessionLang = pickLang(sessionUserResult.rows[0]?.language);
        const sessionStrings = STRINGS[sessionLang];

        const content = kind === 'help'
            ? sessionStrings.helpContent
            : kind === 'hydration'
                ? sessionStrings.hydrationContent
                : sessionStrings.okContent;

        const entryResult = await query(
            `INSERT INTO journal_entries (circle_id, author_name, type, content, data)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [
                req.circleId,
                firstName,
                KIND_TO_TYPE[kind],
                content,
                JSON.stringify({ source: 'kiosk', kind }),
            ]
        );
        const entry = entryResult.rows[0];

        if (kind === 'help') {
            // Notify every member of the circle, each in their own language.
            const membersResult = await query(
                `SELECT m.user_id, u.language
                 FROM circle_members m
                 JOIN users u ON u.id = m.user_id
                 WHERE m.circle_id = $1`,
                [req.circleId]
            );
            await Promise.all(
                (membersResult.rows as Array<{ user_id: string; language: string | null }>).map((member) => {
                    const strings = STRINGS[pickLang(member.language)];
                    return createNotification({
                        userId: member.user_id,
                        circleId: req.circleId,
                        title: strings.helpTitle(firstName),
                        message: strings.helpMessage(firstName),
                        type: 'kiosk_help',
                        relatedId: entry.id,
                        url: '/journal',
                        tag: 'kiosk_help',
                    });
                })
            );
        }

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'journal', action: 'created' });

        res.json({ success: true, data: { ...entry, photos: [] } });
    } catch (error) {
        console.error('Kiosk status error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/kiosk/today : everything the kiosk shows, in one call.
// { recipient, events_today (with participating members: name + avatar_url),
//   intakes_today, photos_enabled }
router.get('/today', async (req: CircleRequest, res: Response) => {
    try {
        const circleId = req.circleId!;
        const now = new Date();
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

        const [recipientResult, eventsResult, membersResult, intakesResult, immichResult, heatwaveResult, companionResult] = await Promise.all([
            query('SELECT first_name, photo_url FROM care_recipients WHERE circle_id = $1', [circleId]),
            // Candidate events: anything overlapping today, plus every recurring
            // event started before tonight (expanded below).
            query(
                `SELECT * FROM events
                 WHERE circle_id = $1
                   AND start_time <= $3
                   AND (rrule IS NOT NULL OR COALESCE(end_time, start_time) >= $2)
                 ORDER BY start_time`,
                [circleId, toLocalISO(dayStart), toLocalISO(dayEnd)]
            ),
            query(
                `SELECT m.id, u.name, u.avatar_url
                 FROM circle_members m
                 JOIN users u ON u.id = m.user_id
                 WHERE m.circle_id = $1`,
                [circleId]
            ),
            query(
                `SELECT i.id, i.due_at, i.status, i.confirmed_at,
                        m.name AS medication_name, m.dosage, m.form
                 FROM medication_intakes i
                 JOIN medications m ON m.id = i.medication_id
                 WHERE i.circle_id = $1 AND i.due_at::date = CURRENT_DATE
                 ORDER BY i.due_at`,
                [circleId]
            ),
            query(`SELECT 1 FROM integrations WHERE circle_id = $1 AND type = 'immich' LIMIT 1`, [circleId]),
            query(
                `SELECT level FROM heatwave_settings WHERE circle_id = $1 AND enabled = TRUE AND active = TRUE`,
                [circleId]
            ),
            query(
                `SELECT 1 FROM ai_settings
                 WHERE circle_id = $1 AND enabled = TRUE AND companion_enabled = TRUE AND model <> ''`,
                [circleId]
            ),
        ]);

        const membersById = new Map(
            (membersResult.rows as Array<{ id: string; name: string; avatar_url: string | null }>)
                .map((m) => [m.id, m])
        );

        // Expand each candidate into today's occurrences (the shared RRULE
        // helper from the events routes) and join the participating members:
        // their photos are what the care recipient looks for first.
        const eventsToday: any[] = [];
        for (const event of eventsResult.rows as any[]) {
            for (const occ of expandEventOccurrences(event, dayStart, dayEnd)) {
                const memberIds: string[] = Array.isArray(event.member_ids) ? event.member_ids : [];
                eventsToday.push({
                    id: event.id,
                    title: event.title,
                    category: event.category,
                    location: event.location,
                    start_time: toLocalISO(occ.start),
                    end_time: occ.end ? toLocalISO(occ.end) : null,
                    members: memberIds
                        .map((id) => membersById.get(id))
                        .filter(Boolean)
                        .map((m) => ({ id: m!.id, name: m!.name, avatar_url: m!.avatar_url })),
                });
            }
        }
        eventsToday.sort((a, b) => a.start_time.localeCompare(b.start_time));

        const recipient = recipientResult.rows[0] ?? null;

        res.json({
            success: true,
            data: {
                recipient: recipient
                    ? { first_name: recipient.first_name, photo_url: recipient.photo_url }
                    : null,
                events_today: eventsToday,
                intakes_today: intakesResult.rows,
                photos_enabled: immichResult.rows.length > 0,
                heatwave: heatwaveResult.rows[0]
                    ? { active: true, level: heatwaveResult.rows[0].level as string }
                    : null,
                companion_enabled: companionResult.rows.length > 0,
            },
        });
    } catch (error) {
        console.error('Kiosk today error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;

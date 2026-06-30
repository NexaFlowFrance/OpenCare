import cron from 'node-cron';
import { format } from 'date-fns';
import { query } from '../db';
import { createNotification } from './notifications';
import logger from './logger';

// Rappels planifiés du cercle de soin:
//  - rappels d'événements (events.reminder_30min / reminder_1hour), notifiés
//    à TOUS les membres du cercle (notification interne + web push);
//  - rappel quotidien (9h) de renouvellement d'ordonnance, notifié aux membres
//    admin + family du cercle, une seule fois par jour et par ordonnance.
// Les rappels de prise de médicaments (medication_intakes) sont gérés ailleurs.

interface EventRow {
    id: string;
    circle_id: string;
    title: string;
    /** Naive local timestamp string ('YYYY-MM-DDTHH:mm:ss'), see the pg type parser in db.ts */
    start_time: string;
    location?: string | null;
}

interface MemberRow {
    user_id: string;
    /** Recipient's preferred language ('fr' | 'en'), defaults to 'fr' */
    language: string;
}

// events.start_time is a naive TIMESTAMP holding LOCAL wall-clock time, so the
// comparison windows must be formatted as naive server-local strings, NOT
// toISOString(), which is UTC and would shift the windows by the UTC offset.
const toLocalNaive = (d: Date): string => format(d, "yyyy-MM-dd'T'HH:mm:ss");

interface ReminderTexts {
    title: string;
    body: string;
}

function buildEventTexts(event: EventRow, kind: '30min' | '1hour', language: string): ReminderTexts {
    // start_time is 'YYYY-MM-DDTHH:mm:ss': extract HH:mm directly, no Date round-trip.
    const timeStr = event.start_time.slice(11, 16);
    const suffix = `${timeStr}${event.location ? ` · ${event.location}` : ''}`;

    if (language === 'en') {
        return {
            title: `⏰ Reminder: ${event.title}`,
            body: `${kind === '30min' ? 'In 30 minutes' : 'In 1 hour'} · ${suffix}`,
        };
    }
    return {
        title: `⏰ Rappel : ${event.title}`,
        body: `${kind === '30min' ? 'Dans 30 minutes' : 'Dans 1 heure'} · ${suffix}`,
    };
}

/**
 * Members of the circle who have NOT yet received the given notification
 * (type + related_id), with their preferred language. Optional role filter.
 */
async function membersToNotify(
    circleId: string,
    relatedId: string,
    type: string,
    roles?: string[]
): Promise<MemberRow[]> {
    const params: unknown[] = [circleId, relatedId, type];
    let roleFilter = '';
    if (roles && roles.length > 0) {
        params.push(roles);
        roleFilter = `AND cm.role = ANY($4)`;
    }
    const { rows } = await query(
        `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
         FROM circle_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.circle_id = $1
           ${roleFilter}
           AND NOT EXISTS (
             SELECT 1 FROM notifications n
             WHERE n.user_id = cm.user_id
               AND n.related_id = $2
               AND n.type = $3
           )`,
        params
    );
    return rows as MemberRow[];
}

async function processEventWindow(
    windowStart: Date,
    windowEnd: Date,
    flagColumn: 'reminder_30min' | 'reminder_1hour',
    kind: '30min' | '1hour'
): Promise<void> {
    const type = flagColumn; // notification type mirrors the flag name
    const { rows } = await query(
        `SELECT e.id, e.circle_id, e.title, e.start_time, e.location
         FROM events e
         WHERE e.${flagColumn} = true
           AND e.start_time BETWEEN $1 AND $2`,
        [toLocalNaive(windowStart), toLocalNaive(windowEnd)]
    );

    for (const event of rows as EventRow[]) {
        // Every circle member gets the event reminder; the NOT EXISTS dedup is
        // per user, so a member added between two ticks still gets notified.
        const members = await membersToNotify(event.circle_id, event.id, type);
        for (const member of members) {
            const { title, body } = buildEventTexts(event, kind, member.language);
            await createNotification({
                userId: member.user_id,
                circleId: event.circle_id,
                title,
                message: body,
                type,
                relatedId: event.id,
                url: '/calendar',
                tag: `reminder-${event.id}-${kind}`,
            });
        }
        if (members.length > 0) {
            logger.info('reminder.event_sent', { eventId: event.id, type: kind, recipients: members.length });
        }
    }
}

async function checkEventReminders(): Promise<void> {
    const now = new Date();

    try {
        // Window: 25 to 35 min from now (covers the "30 min before" cron tick)
        await processEventWindow(
            new Date(now.getTime() + 25 * 60 * 1000),
            new Date(now.getTime() + 35 * 60 * 1000),
            'reminder_30min',
            '30min'
        );

        // Window: 55 to 65 min from now (covers the "1 hour before" cron tick)
        await processEventWindow(
            new Date(now.getTime() + 55 * 60 * 1000),
            new Date(now.getTime() + 65 * 60 * 1000),
            'reminder_1hour',
            '1hour'
        );
    } catch (err) {
        logger.error('reminder.scheduler_error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

interface PrescriptionRow {
    id: string;
    circle_id: string;
    title: string;
    /** 'YYYY-MM-DD' */
    renewal_date: string;
}

function buildPrescriptionTexts(prescription: PrescriptionRow, language: string): ReminderTexts {
    const [y, m, d] = prescription.renewal_date.split('-');
    if (language === 'en') {
        return {
            title: '💊 Prescription renewal',
            body: `"${prescription.title}" must be renewed by ${prescription.renewal_date}`,
        };
    }
    return {
        title: '💊 Renouvellement d\'ordonnance',
        body: `« ${prescription.title} » est à renouveler avant le ${d}/${m}/${y}`,
    };
}

/**
 * Daily prescription renewal reminders: for every prescription whose renewal
 * window is open (renewal_date - reminder_days <= today <= renewal_date),
 * notify the admin + family members of the circle. At most one notification
 * per prescription per day: the inner NOT EXISTS skips prescriptions that
 * already got a 'prescription_renewal' notification today (related_id check).
 */
async function checkPrescriptionRenewals(): Promise<void> {
    try {
        const { rows } = await query(
            `SELECT p.id, p.circle_id, p.title,
                    to_char(p.renewal_date, 'YYYY-MM-DD') AS renewal_date
             FROM prescriptions p
             WHERE p.renewal_date IS NOT NULL
               AND p.renewal_date - p.reminder_days <= CURRENT_DATE
               AND p.renewal_date >= CURRENT_DATE
               AND NOT EXISTS (
                 SELECT 1 FROM notifications n
                 WHERE n.related_id = p.id
                   AND n.type = 'prescription_renewal'
                   AND n.created_at >= CURRENT_DATE
               )`
        );

        for (const prescription of rows as PrescriptionRow[]) {
            const { rows: memberRows } = await query(
                `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
                 FROM circle_members cm
                 JOIN users u ON u.id = cm.user_id
                 WHERE cm.circle_id = $1
                   AND cm.role IN ('admin', 'family')`,
                [prescription.circle_id]
            );

            for (const member of memberRows as MemberRow[]) {
                const { title, body } = buildPrescriptionTexts(prescription, member.language);
                await createNotification({
                    userId: member.user_id,
                    circleId: prescription.circle_id,
                    title,
                    message: body,
                    type: 'prescription_renewal',
                    relatedId: prescription.id,
                    url: '/medications',
                    tag: `prescription-${prescription.id}`,
                });
            }
            logger.info('reminder.prescription_sent', {
                prescriptionId: prescription.id,
                recipients: (memberRows as MemberRow[]).length,
            });
        }
    } catch (err) {
        logger.error('reminder.prescription_error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

function buildHydrationTexts(firstName: string, language: string): ReminderTexts {
    if (language === 'en') {
        return {
            title: '🌡️ Heat: time to hydrate',
            body: firstName
                ? `Strong heat today. Offer ${firstName} a glass of water and keep the home cool.`
                : 'Strong heat today. Offer a glass of water and keep the home cool.',
        };
    }
    return {
        title: '🌡️ Forte chaleur : pensez à hydrater',
        body: firstName
            ? `Forte chaleur aujourd'hui. Proposez un verre d'eau à ${firstName} et gardez le logement au frais.`
            : `Forte chaleur aujourd'hui. Proposez un verre d'eau et gardez le logement au frais.`,
    };
}

/**
 * Heat-episode hydration reminders: every minute, for circles with an ACTIVE
 * heat episode whose reminder_times contains the current local HH:mm, notify the
 * admin + family members. Dedup window of 5 minutes (keyed on the circle id in
 * related_id) guards against a double cron tick; reminder_times default 4 hours
 * apart, so the next slot fires normally. A missed minute (server down) simply
 * skips that slot: hydration reminders are preventive, not critical.
 */
async function checkHeatwaveHydration(): Promise<void> {
    try {
        // L'heure courante DOIT etre calculee dans le meme fuseau que le cron
        // (process.env.TZ ?? 'Europe/Paris'), pas dans le fuseau de l'OS: les
        // reminder_times sont saisis par l'aidant en heure locale. Sinon, sur un
        // Docker en UTC sans TZ, les rappels tomberaient a la mauvaise heure.
        const tz = process.env.TZ || 'Europe/Paris';
        const nowHm = new Intl.DateTimeFormat('en-GB', {
            timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).format(new Date());
        const { rows } = await query(
            `SELECT h.circle_id
             FROM heatwave_settings h
             WHERE h.enabled = TRUE AND h.active = TRUE
               AND h.reminder_times @> to_jsonb($1::text)
               AND NOT EXISTS (
                 SELECT 1 FROM notifications n
                 WHERE n.related_id = h.circle_id
                   AND n.type = 'heatwave_hydration'
                   AND n.created_at >= NOW() - INTERVAL '5 minutes'
               )`,
            [nowHm]
        );

        for (const { circle_id: circleId } of rows as Array<{ circle_id: string }>) {
            const recipientResult = await query(
                'SELECT first_name FROM care_recipients WHERE circle_id = $1',
                [circleId]
            );
            const firstName: string = recipientResult.rows[0]?.first_name?.trim() || '';

            const { rows: memberRows } = await query(
                `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
                 FROM circle_members cm
                 JOIN users u ON u.id = cm.user_id
                 WHERE cm.circle_id = $1 AND cm.role IN ('admin', 'family')`,
                [circleId]
            );

            for (const member of memberRows as MemberRow[]) {
                const { title, body } = buildHydrationTexts(firstName, member.language);
                await createNotification({
                    userId: member.user_id,
                    circleId,
                    title,
                    message: body,
                    type: 'heatwave_hydration',
                    relatedId: circleId,
                    url: '/',
                    tag: `heatwave-${circleId}`,
                });
            }
            if ((memberRows as MemberRow[]).length > 0) {
                logger.info('reminder.heatwave_sent', { circleId, recipients: (memberRows as MemberRow[]).length });
            }
        }
    } catch (err) {
        logger.error('reminder.heatwave_error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

export function startReminderScheduler(): void {
    const tz = process.env.TZ ?? 'Europe/Paris';

    // Event reminders: every minute
    cron.schedule('* * * * *', () => {
        void checkEventReminders();
    }, { timezone: tz });

    // Heat-episode hydration reminders: every minute (matches the configured
    // HH:mm slots; the per-circle dedup window makes a double tick idempotent)
    cron.schedule('* * * * *', () => {
        void checkHeatwaveHydration();
    }, { timezone: tz });

    // Prescription renewals: every day at 9:00 (the daily dedup makes it idempotent)
    cron.schedule('0 9 * * *', () => {
        void checkPrescriptionRenewals();
    }, { timezone: tz });

    logger.info('reminder.scheduler_started', { timezone: tz });
}

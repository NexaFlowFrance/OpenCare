import cron from 'node-cron';
import { query } from '../db';
import { createNotification } from './notifications';
import logger from './logger';
import { aiComplete, getAiSettings, AiError } from '../services/ai';
import {
    WEEKLY_DIGEST_SCHEMA,
    buildWeeklyDigestPrompt,
    validateWeeklyDigest,
    type WeeklyDigestContent,
    type WeeklyDigestFacts,
    type WeeklyDigestJournalLine,
    type WeeklyDigestVitalWeek,
} from '../services/ai/assistant';

// Synthèse hebdomadaire IA du cercle de soin:
//  - chaque dimanche à 18h, pour chaque cercle dont l'IA est configurée et
//    activée, génération du digest de la semaine écoulée (lundi -> dimanche)
//    s'il n'existe pas encore;
//  - agrégation: journal de la semaine, moyennes hebdo des constantes sur
//    8 semaines (tendances lentes), prises de médicaments, visites par jour,
//    tâches terminées;
//  - stockage dans weekly_digests (upsert) + notification interne et push aux
//    membres admin + family (déduplication par digest via notifications).
// Une erreur IA sur un cercle est journalisée et n'interrompt JAMAIS la boucle.

const WEEKDAYS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

const pad2 = (n: number) => String(n).padStart(2, '0');

const toIsoDate = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 'YYYY-MM-DD' + n days -> 'YYYY-MM-DD' (local, no timezone shift). */
const addDays = (iso: string, days: number): string => {
    const [y, m, d] = iso.split('-').map(Number);
    return toIsoDate(new Date(y, m - 1, d + days));
};

/** French weekday label of a 'YYYY-MM-DD' date, e.g. "mardi 2026-06-02". */
const dayLabel = (iso: string): string => {
    const [y, m, d] = iso.split('-').map(Number);
    return `${WEEKDAYS_FR[new Date(y, m - 1, d).getDay()]} ${iso}`;
};

/** Monday of the week containing `date` (server-local), as 'YYYY-MM-DD'. */
export function mondayOfWeek(date: Date): string {
    const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return toIsoDate(monday);
}

/** Monday of the CURRENT week: used by POST /api/digests/generate. */
export function currentWeekStart(): string {
    return mondayOfWeek(new Date());
}

interface CircleInfoRow {
    name: string;
    settings: Record<string, unknown> | null;
    first_name: string | null;
}

interface JournalRow {
    type: string;
    author_name: string;
    content: string;
    /** Naive local 'YYYY-MM-DDTHH:mm:ss' (see the pg type parser in db.ts). */
    occurred_at: string;
}

export interface WeeklyDigestRow {
    id: string;
    /** 'YYYY-MM-DD' */
    week_start: string;
    content: WeeklyDigestContent;
    created_at: string;
}

/** The digest texts are written in the circle's language; 'fr' by default. */
const circleLanguage = (settings: Record<string, unknown> | null): string => {
    const lang = settings && typeof settings.language === 'string' ? settings.language : '';
    return lang.toLowerCase().startsWith('en') ? 'en' : 'fr';
};

async function collectFacts(circleId: string, weekStart: string, info: CircleInfoRow): Promise<WeeklyDigestFacts> {
    const weekEndExclusive = addDays(weekStart, 7);
    const vitalsStart = addDays(weekStart, -49); // 8 weeks window including the summarized week

    const [journalResult, journalCountResult, vitalsResult, intakesResult, missedDaysResult, tasksResult] =
        await Promise.all([
            query(
                `SELECT type, author_name, content, occurred_at
                 FROM journal_entries
                 WHERE circle_id = $1 AND occurred_at >= $2::date AND occurred_at < $3::date
                 ORDER BY occurred_at
                 LIMIT 80`,
                [circleId, weekStart, weekEndExclusive]
            ),
            query(
                `SELECT COUNT(*)::int AS total,
                        COUNT(*) FILTER (WHERE type = 'visit')::int AS visits
                 FROM journal_entries
                 WHERE circle_id = $1 AND occurred_at >= $2::date AND occurred_at < $3::date`,
                [circleId, weekStart, weekEndExclusive]
            ),
            query(
                `SELECT to_char(date_trunc('week', measured_at), 'YYYY-MM-DD') AS week,
                        type,
                        ROUND(AVG(value), 1)::float8 AS avg,
                        ROUND(AVG(value2), 1)::float8 AS avg2,
                        COUNT(*)::int AS count,
                        MAX(unit) AS unit
                 FROM vitals
                 WHERE circle_id = $1 AND measured_at >= $2::date AND measured_at < $3::date
                 GROUP BY 1, 2
                 ORDER BY 2, 1`,
                [circleId, vitalsStart, weekEndExclusive]
            ),
            query(
                `SELECT COUNT(*)::int AS scheduled,
                        COUNT(*) FILTER (WHERE status = 'taken')::int AS taken,
                        COUNT(*) FILTER (WHERE status = 'missed')::int AS missed,
                        COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped
                 FROM medication_intakes
                 WHERE circle_id = $1 AND due_at >= $2::date AND due_at < $3::date`,
                [circleId, weekStart, weekEndExclusive]
            ),
            query(
                `SELECT DISTINCT to_char(due_at, 'YYYY-MM-DD') AS day
                 FROM medication_intakes
                 WHERE circle_id = $1 AND due_at >= $2::date AND due_at < $3::date AND status = 'missed'
                 ORDER BY 1`,
                [circleId, weekStart, weekEndExclusive]
            ),
            query(
                `SELECT COUNT(*)::int AS done
                 FROM tasks
                 WHERE circle_id = $1 AND is_completed = TRUE
                   AND completed_at >= $2::date AND completed_at < $3::date`,
                [circleId, weekStart, weekEndExclusive]
            ),
        ]);

    const journalEntries: WeeklyDigestJournalLine[] = (journalResult.rows as JournalRow[]).map((row) => ({
        day: dayLabel(row.occurred_at.slice(0, 10)),
        type: row.type,
        author: row.author_name,
        content: (row.content || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    }));

    // Visits per day, computed from the journal entries of the week (type 'visit').
    const visitsPerDay = new Map<string, number>();
    for (const row of journalResult.rows as JournalRow[]) {
        if (row.type !== 'visit') continue;
        const day = row.occurred_at.slice(0, 10);
        visitsPerDay.set(day, (visitsPerDay.get(day) ?? 0) + 1);
    }
    const visitsByDay = Array.from(visitsPerDay.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, count]) => ({ day: dayLabel(day), count }));

    const counts = journalCountResult.rows[0] as { total: number; visits: number };
    const intakes = intakesResult.rows[0] as { scheduled: number; taken: number; missed: number; skipped: number };

    return {
        recipientFirstName: info.first_name || info.name,
        weekStart,
        weekEnd: addDays(weekStart, 6),
        language: circleLanguage(info.settings),
        journalEntries,
        journalEntriesCount: counts.total,
        vitalsByWeek: vitalsResult.rows as WeeklyDigestVitalWeek[],
        intakes: {
            scheduled: intakes.scheduled,
            taken: intakes.taken,
            missed: intakes.missed,
            skipped: intakes.skipped,
            missedDays: (missedDaysResult.rows as Array<{ day: string }>).map((r) => dayLabel(r.day)),
        },
        visitsByDay,
        visitsCount: counts.visits,
        tasksDone: (tasksResult.rows[0] as { done: number }).done,
    };
}

interface DigestNotifTexts {
    title: string;
    message: string;
}

function buildDigestTexts(firstName: string, summary: string, language: string): DigestNotifTexts {
    if (language === 'en') {
        return { title: `Weekly summary for ${firstName}`, message: summary };
    }
    return { title: `Synthèse de la semaine de ${firstName}`, message: summary };
}

/**
 * Notify the admin + family members of the circle, each in their own language.
 * Deduplicated per user and per digest (NOT EXISTS on notifications), so a
 * manual regeneration does not spam members already notified.
 */
async function notifyCircleMembers(circleId: string, digest: WeeklyDigestRow, firstName: string): Promise<void> {
    const { rows } = await query(
        `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
         FROM circle_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.circle_id = $1
           AND cm.role IN ('admin', 'family')
           AND NOT EXISTS (
             SELECT 1 FROM notifications n
             WHERE n.user_id = cm.user_id
               AND n.related_id = $2
               AND n.type = 'weekly_digest'
           )`,
        [circleId, digest.id]
    );

    for (const member of rows as Array<{ user_id: string; language: string }>) {
        const { title, message } = buildDigestTexts(firstName, digest.content.summary, member.language);
        await createNotification({
            userId: member.user_id,
            circleId,
            title,
            message,
            type: 'weekly_digest',
            relatedId: digest.id,
            url: '/',
            tag: `weekly-digest-${digest.id}`,
        });
    }

    if (rows.length > 0) {
        logger.info('digest.notified', { circleId, digestId: digest.id, recipients: rows.length });
    }
}

/**
 * Generates (or regenerates) the digest of the week starting at `weekStart`
 * (a Monday, 'YYYY-MM-DD') for one circle, stores it in weekly_digests and
 * notifies the admin + family members.
 *
 * Returns null when the circle's AI is not configured or disabled. Throws an
 * AiError on provider failure: the Sunday scheduler catches it per circle,
 * the on-demand route maps it to a 502.
 */
export async function generateDigestForCircle(circleId: string, weekStart: string): Promise<WeeklyDigestRow | null> {
    const settings = await getAiSettings(circleId);
    if (!settings) return null;

    const infoResult = await query(
        `SELECT c.name, c.settings, r.first_name
         FROM care_circles c
         LEFT JOIN care_recipients r ON r.circle_id = c.id
         WHERE c.id = $1`,
        [circleId]
    );
    const info = infoResult.rows[0] as CircleInfoRow | undefined;
    if (!info) return null;

    const facts = await collectFacts(circleId, weekStart, info);
    const { system, user } = buildWeeklyDigestPrompt(facts);

    const raw = await aiComplete(settings, { system, user, jsonSchema: WEEKLY_DIGEST_SCHEMA });
    const content = validateWeeklyDigest(raw, {
        visits: facts.visitsCount,
        journal_entries: facts.journalEntriesCount,
    });
    if (!content) {
        throw new AiError('AI_INVALID_RESPONSE', 'Le modèle n\'a pas produit de synthèse exploitable');
    }

    const upsert = await query(
        `INSERT INTO weekly_digests (circle_id, week_start, content)
         VALUES ($1, $2::date, $3)
         ON CONFLICT (circle_id, week_start) DO UPDATE SET
           content = EXCLUDED.content,
           created_at = CURRENT_TIMESTAMP
         RETURNING id, to_char(week_start, 'YYYY-MM-DD') AS week_start, content, created_at`,
        [circleId, weekStart, JSON.stringify(content)]
    );
    const digest = upsert.rows[0] as WeeklyDigestRow;

    await notifyCircleMembers(circleId, digest, facts.recipientFirstName);

    logger.info('digest.generated', { circleId, weekStart, digestId: digest.id });
    return digest;
}

/**
 * Sunday run: digest of the week that is ending (its Monday is the Monday of
 * the current week, since Sunday is day 7). Only circles with AI enabled and
 * no digest yet for that week are processed.
 */
async function runWeeklyDigests(): Promise<void> {
    const weekStart = mondayOfWeek(new Date());

    let circles: Array<{ id: string }> = [];
    try {
        const { rows } = await query(
            `SELECT c.id
             FROM care_circles c
             JOIN ai_settings s ON s.circle_id = c.id AND s.enabled = TRUE
             WHERE NOT EXISTS (
               SELECT 1 FROM weekly_digests d
               WHERE d.circle_id = c.id AND d.week_start = $1::date
             )`,
            [weekStart]
        );
        circles = rows as Array<{ id: string }>;
    } catch (err) {
        logger.error('digest.scheduler_error', {
            error: err instanceof Error ? err.message : String(err),
        });
        return;
    }

    for (const circle of circles) {
        try {
            await generateDigestForCircle(circle.id, weekStart);
        } catch (err) {
            // AI failure (provider down, invalid response...): log and move on,
            // the other circles must still get their digest.
            logger.error('digest.generation_failed', {
                circleId: circle.id,
                weekStart,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

export function startDigestScheduler(): void {
    const tz = process.env.TZ ?? 'Europe/Paris';

    // Weekly digest: every Sunday at 18:00 (idempotent thanks to the NOT EXISTS check)
    cron.schedule('0 18 * * 0', () => {
        void runWeeklyDigests();
    }, { timezone: tz });

    logger.info('digest.scheduler_started', { timezone: tz });
}

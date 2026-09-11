import cron from 'node-cron';
import { query } from '../db';
import { createNotification } from './notifications';
import logger from './logger';

// Veille passive: toutes les 10 minutes, pour chaque règle presence_rules
// activée dont l'heure limite (no_activity_before) est dépassée, si AUCUN
// signal de présence n'a été reçu aujourd'hui et qu'aucune alerte n'a déjà
// été envoyée aujourd'hui, notifier les membres ciblés (alert_member_ids)
// ou, à défaut, tous les admin + family du cercle.

interface PresenceRuleRow {
    id: string;
    circle_id: string;
    /** 'HH:MM' (formatted in SQL) */
    no_activity_before: string;
    /** circle_members.id list (JSONB array, parsed by pg) */
    alert_member_ids: unknown;
    /** Recipient's first name, null when the circle has no recipient yet */
    first_name: string | null;
}

interface MemberRow {
    user_id: string;
    /** Recipient's preferred language ('fr' | 'en'), defaults to 'fr' */
    language: string;
}

interface AlertTexts {
    title: string;
    body: string;
}

function buildAlertTexts(rule: PresenceRuleRow, language: string): AlertTexts {
    const name = (rule.first_name ?? '').trim();
    if (language === 'en') {
        return {
            title: name ? `No sign of life at ${name}'s this morning` : 'No sign of life this morning',
            body: `No activity signal was received today before ${rule.no_activity_before}. Consider calling or stopping by to check that everything is fine.`,
        };
    }
    return {
        title: name ? `Aucun signe de vie chez ${name} ce matin` : 'Aucun signe de vie ce matin',
        body: `Aucun signal d'activité reçu aujourd'hui avant ${rule.no_activity_before}. Pensez à appeler ou à passer vérifier que tout va bien.`,
    };
}

/**
 * Resolve who must be alerted: the circle_members rows listed in
 * alert_member_ids, or every admin + family member when the list is empty
 * (or only contains stale ids).
 */
async function resolveRecipients(rule: PresenceRuleRow): Promise<MemberRow[]> {
    const memberIds = Array.isArray(rule.alert_member_ids)
        ? rule.alert_member_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];

    if (memberIds.length > 0) {
        const { rows } = await query(
            `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
             FROM circle_members cm
             JOIN users u ON u.id = cm.user_id
             WHERE cm.circle_id = $1 AND cm.id = ANY($2::uuid[])`,
            [rule.circle_id, memberIds]
        );
        if (rows.length > 0) return rows as MemberRow[];
    }

    const { rows } = await query(
        `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
         FROM circle_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.circle_id = $1 AND cm.role IN ('admin', 'family')`,
        [rule.circle_id]
    );
    return rows as MemberRow[];
}

async function checkPresenceRules(): Promise<void> {
    try {
        // Enabled rules whose deadline (server local time) is past, with no signal
        // today and no alert sent today. LOCALTIME matches the naive TIMESTAMP
        // columns used everywhere else (server-local wall clock).
        const { rows } = await query(
            `SELECT r.id, r.circle_id,
                    to_char(r.no_activity_before, 'HH24:MI') AS no_activity_before,
                    r.alert_member_ids,
                    cr.first_name
             FROM presence_rules r
             LEFT JOIN care_recipients cr ON cr.circle_id = r.circle_id
             WHERE r.enabled = TRUE
               AND r.no_activity_before <= LOCALTIME
               AND (r.last_alert_date IS NULL OR r.last_alert_date < CURRENT_DATE)
               AND NOT EXISTS (
                 SELECT 1 FROM presence_signals s
                 WHERE s.circle_id = r.circle_id
                   AND s.occurred_at >= date_trunc('day', CURRENT_TIMESTAMP)
               )`
        );

        for (const rule of rows as PresenceRuleRow[]) {
            const recipients = await resolveRecipients(rule);

            for (const member of recipients) {
                const { title, body } = buildAlertTexts(rule, member.language);
                await createNotification({
                    userId: member.user_id,
                    circleId: rule.circle_id,
                    title,
                    message: body,
                    type: 'presence_alert',
                    relatedId: rule.id,
                    url: '/',
                    tag: `presence-${rule.circle_id}`,
                });
            }

            // One alert per day per circle, even if no recipient could be resolved
            // (otherwise the rule would be re-evaluated every 10 minutes).
            await query('UPDATE presence_rules SET last_alert_date = CURRENT_DATE WHERE id = $1', [rule.id]);

            logger.info('presence.alert_sent', {
                circleId: rule.circle_id,
                recipients: recipients.length,
            });
        }
    } catch (err) {
        logger.error('presence.monitor_error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

export function startPresenceMonitor(): void {
    const tz = process.env.TZ ?? 'Europe/Paris';

    // Every 10 minutes (the last_alert_date dedup makes each tick idempotent)
    cron.schedule('*/10 * * * *', () => {
        void checkPresenceRules();
    }, { timezone: tz });

    logger.info('presence.monitor_started', { timezone: tz });
}

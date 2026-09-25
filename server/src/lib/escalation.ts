import cron from 'node-cron';
import { query } from '../db';
import { createNotification } from './notifications';
import { broadcastToCircle } from './broadcaster';
import logger from './logger';

/**
 * Escalade configurable des alertes (regles par cercle, table escalation_rules) :
 *  - prise de medicament en retard : rappel au proche sur l'ecran patient
 *    (message WebSocket "reminder"), puis aidants principaux, puis aidants de
 *    relais, chacun apres un delai en minutes (0 = palier desactive) ;
 *  - "J'ai besoin d'aide" : aidants principaux tout de suite (route kiosk),
 *    puis aidants de relais si personne n'a pris en charge la demande
 *    (table help_requests, prise en charge par POST /api/escalation/help/:id/ack).
 * Sans selection, les aidants principaux sont les admins du cercle et les
 * aidants de relais les membres "famille". Tout est desactive par defaut.
 */

export interface EscalationRules {
    enabled: boolean;
    med_patient_min: number;
    med_primary_min: number;
    med_secondary_min: number;
    help_ack_min: number;
    /** circle_members.id ; vide = admins du cercle */
    primary_member_ids: string[];
    /** circle_members.id ; vide = membres famille */
    secondary_member_ids: string[];
}

export const DEFAULT_RULES: EscalationRules = {
    enabled: false,
    med_patient_min: 15,
    med_primary_min: 30,
    med_secondary_min: 60,
    help_ack_min: 10,
    primary_member_ids: [],
    secondary_member_ids: [],
};

const MINUTE_KEYS = ['med_patient_min', 'med_primary_min', 'med_secondary_min', 'help_ack_min'] as const;
const MAX_MINUTES = 24 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Au-dela, la prise est "manquee" (cf. lib/intakes markMissed) : plus d'escalade. */
const MISSED_AFTER = '4 hours';

const idList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)).slice(0, 50) : [];

/** Validation stricte d'une mise a jour partielle. */
export function validateRules(input: unknown, lang: 'fr' | 'en'): { patch?: Partial<EscalationRules>; error?: string } {
    if (!input || typeof input !== 'object') return { error: lang === 'en' ? 'rules must be an object' : 'Les règles doivent être un objet' };
    const body = input as Record<string, unknown>;
    const patch: Partial<EscalationRules> = {};
    if (body.enabled !== undefined) patch.enabled = body.enabled === true;
    for (const key of MINUTE_KEYS) {
        if (body[key] === undefined) continue;
        // null et la chaine vide valent 0 pour Number() : accepter ces valeurs
        // desactiverait un palier d'alerte en silence. Pour couper un palier,
        // il faut envoyer 0 explicitement.
        const raw = body[key];
        const n = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
        if (!Number.isInteger(n) || n < 0 || n > MAX_MINUTES) {
            return { error: lang === 'en' ? `${key} must be a whole number of minutes between 0 and ${MAX_MINUTES}` : `${key} doit être un nombre entier de minutes entre 0 et ${MAX_MINUTES}` };
        }
        patch[key] = n;
    }
    if (body.primary_member_ids !== undefined) patch.primary_member_ids = idList(body.primary_member_ids);
    if (body.secondary_member_ids !== undefined) patch.secondary_member_ids = idList(body.secondary_member_ids);
    return { patch };
}

const normalize = (row: Record<string, unknown> | undefined): EscalationRules => {
    if (!row) return { ...DEFAULT_RULES };
    const minutes = (key: (typeof MINUTE_KEYS)[number]) => {
        const n = Number(row[key]);
        return Number.isInteger(n) && n >= 0 && n <= MAX_MINUTES ? n : DEFAULT_RULES[key];
    };
    return {
        enabled: row.enabled === true,
        med_patient_min: minutes('med_patient_min'),
        med_primary_min: minutes('med_primary_min'),
        med_secondary_min: minutes('med_secondary_min'),
        help_ack_min: minutes('help_ack_min'),
        primary_member_ids: idList(row.primary_member_ids),
        secondary_member_ids: idList(row.secondary_member_ids),
    };
};

export async function loadRules(circleId: string): Promise<EscalationRules> {
    const result = await query('SELECT * FROM escalation_rules WHERE circle_id = $1', [circleId]);
    return normalize(result.rows[0]);
}

export async function saveRules(circleId: string, patch: Partial<EscalationRules>): Promise<EscalationRules> {
    const next = { ...(await loadRules(circleId)), ...patch };
    await query(
        `INSERT INTO escalation_rules (circle_id, enabled, med_patient_min, med_primary_min, med_secondary_min, help_ack_min, primary_member_ids, secondary_member_ids, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT (circle_id) DO UPDATE SET
           enabled = EXCLUDED.enabled, med_patient_min = EXCLUDED.med_patient_min, med_primary_min = EXCLUDED.med_primary_min,
           med_secondary_min = EXCLUDED.med_secondary_min, help_ack_min = EXCLUDED.help_ack_min,
           primary_member_ids = EXCLUDED.primary_member_ids, secondary_member_ids = EXCLUDED.secondary_member_ids,
           updated_at = CURRENT_TIMESTAMP`,
        [circleId, next.enabled, next.med_patient_min, next.med_primary_min, next.med_secondary_min, next.help_ack_min,
            JSON.stringify(next.primary_member_ids), JSON.stringify(next.secondary_member_ids)]
    );
    return next;
}

export interface Target { user_id: string; language: string }

/** Les membres choisis, ou a defaut les roles de repli (admins / famille). */
export async function resolveTargets(circleId: string, memberIds: string[], fallbackRoles: string[]): Promise<Target[]> {
    if (memberIds.length > 0) {
        const { rows } = await query(
            `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
             FROM circle_members cm JOIN users u ON u.id = cm.user_id
             WHERE cm.circle_id = $1 AND cm.id = ANY($2::uuid[])`,
            [circleId, memberIds]
        );
        if (rows.length > 0) return rows as Target[];
    }
    const { rows } = await query(
        `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
         FROM circle_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.circle_id = $1 AND cm.role = ANY($2::text[])`,
        [circleId, fallbackRoles]
    );
    return rows as Target[];
}

// ── Demandes d'aide ──

export interface HelpRequestRow {
    id: string;
    circle_id: string;
    journal_entry_id: string | null;
    source: string;
    created_at: string;
    acknowledged_at: string | null;
    acknowledged_by: string | null;
    escalated_at: string | null;
}

export async function createHelpRequest(circleId: string, journalEntryId: string | null, source: string): Promise<HelpRequestRow> {
    const result = await query(
        `INSERT INTO help_requests (circle_id, journal_entry_id, source) VALUES ($1, $2, $3) RETURNING *`,
        [circleId, journalEntryId, source.slice(0, 20)]
    );
    return result.rows[0] as HelpRequestRow;
}

export async function acknowledgeHelp(circleId: string, id: string, userId: string): Promise<HelpRequestRow | null> {
    const result = await query(
        `UPDATE help_requests SET acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by = $3
         WHERE circle_id = $1 AND id = $2 AND acknowledged_at IS NULL
         RETURNING *`,
        [circleId, id, userId]
    );
    const row = (result.rows[0] as HelpRequestRow | undefined) ?? null;
    if (row) await broadcastToCircle(circleId, { type: 'update', entity: 'help_requests', action: 'updated' });
    return row;
}

/** Demandes des dernieres 24 h sans prise en charge, avec le texte du journal. */
export async function listOpenHelp(circleId: string): Promise<Array<HelpRequestRow & { content: string | null }>> {
    const result = await query(
        `SELECT h.*, j.content
         FROM help_requests h
         LEFT JOIN journal_entries j ON j.id = h.journal_entry_id
         WHERE h.circle_id = $1 AND h.acknowledged_at IS NULL AND h.created_at >= NOW() - interval '24 hours'
         ORDER BY h.created_at DESC`,
        [circleId]
    );
    return result.rows as Array<HelpRequestRow & { content: string | null }>;
}

// ── Tick de l'escalade (toutes les minutes) ──

interface RuleRow extends EscalationRules { circle_id: string; first_name: string | null }
interface LateIntake { id: string; due_at: string; name: string }

const fmtTime = (iso: string, lang: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    return lang === 'en' ? `${h}:${m}` : d.getMinutes() === 0 ? `${h} h` : `${h} h ${m}`;
};

function lateTexts(rule: RuleRow, intakes: LateIntake[], level: 'primary' | 'secondary', lang: string): { title: string; message: string } {
    const name = (rule.first_name ?? '').trim();
    const list = intakes.map((i) => `${i.name} (${fmtTime(i.due_at, lang)})`).join(', ');
    if (lang === 'en') {
        return {
            title: level === 'primary' ? `⏰ Late medication${name ? ` at ${name}'s` : ''}` : `⏰ Still not confirmed${name ? ` at ${name}'s` : ''}`,
            message: `${list}: not confirmed yet. ${level === 'primary' ? 'Please check in.' : 'The primary caregivers have not confirmed either, please check in.'}`,
        };
    }
    return {
        title: level === 'primary' ? `⏰ Prise en retard${name ? ` chez ${name}` : ''}` : `⏰ Toujours pas confirmée${name ? ` chez ${name}` : ''}`,
        message: `${list} : toujours pas confirmée. ${level === 'primary' ? 'Pensez à vérifier.' : 'Les aidants principaux n\'ont pas confirmé non plus, pensez à vérifier.'}`,
    };
}

function helpTexts(rule: RuleRow, minutes: number, lang: string): { title: string; message: string } {
    const name = (rule.first_name ?? '').trim();
    if (lang === 'en') {
        return {
            title: `🆘 Still no answer${name ? `: ${name} asked for help` : ' to a help request'}`,
            message: `Nobody has taken charge of the help request for ${minutes} min. Please check that everything is fine.`,
        };
    }
    return {
        title: `🆘 Toujours sans réponse${name ? ` : ${name} a demandé de l'aide` : ' : demande d\'aide'}`,
        message: `Personne n'a pris en charge la demande d'aide depuis ${minutes} min. Merci de vérifier que tout va bien.`,
    };
}

async function escalateIntakes(rule: RuleRow, level: 'primary' | 'secondary'): Promise<void> {
    const minutes = level === 'primary' ? rule.med_primary_min : rule.med_secondary_min;
    if (minutes <= 0) return;
    const column = level === 'primary' ? 'escalated_primary_at' : 'escalated_secondary_at';
    const { rows } = await query(
        `UPDATE medication_intakes i SET ${column} = CURRENT_TIMESTAMP
         FROM medications m
         WHERE i.medication_id = m.id AND i.circle_id = $1 AND i.status = 'pending' AND i.${column} IS NULL
           AND i.due_at <= NOW() - make_interval(mins => $2::int) AND i.due_at > NOW() - interval '${MISSED_AFTER}'
         RETURNING i.id, i.due_at, m.name`,
        [rule.circle_id, minutes]
    );
    const intakes = rows as LateIntake[];
    if (intakes.length === 0) return;
    const targets = level === 'primary'
        ? await resolveTargets(rule.circle_id, rule.primary_member_ids, ['admin'])
        : await resolveTargets(rule.circle_id, rule.secondary_member_ids, ['family']);
    for (const target of targets) {
        const { title, message } = lateTexts(rule, intakes, level, target.language);
        await createNotification({
            userId: target.user_id,
            circleId: rule.circle_id,
            title,
            message,
            type: level === 'primary' ? 'intake_late' : 'intake_late_escalated',
            relatedId: intakes[0].id,
            url: '/medications',
            tag: `intake-late-${rule.circle_id}-${level}`,
        });
    }
    logger.info('escalation.intakes', { circleId: rule.circle_id, level, intakes: intakes.length, recipients: targets.length });
}

async function remindPatient(rule: RuleRow): Promise<void> {
    if (rule.med_patient_min <= 0) return;
    const { rows } = await query(
        `UPDATE medication_intakes SET reminded_patient_at = CURRENT_TIMESTAMP
         WHERE circle_id = $1 AND status = 'pending' AND reminded_patient_at IS NULL
           AND due_at <= NOW() - make_interval(mins => $2::int) AND due_at > NOW() - interval '${MISSED_AFTER}'
         RETURNING id`,
        [rule.circle_id, rule.med_patient_min]
    );
    if (rows.length === 0) return;
    // Les appareils patient (tablette, telephone) recoivent le rappel ; les
    // sessions aidant ignorent ce message.
    await broadcastToCircle(rule.circle_id, { type: 'reminder', kind: 'medication', count: rows.length });
    logger.info('escalation.patient_reminder', { circleId: rule.circle_id, intakes: rows.length });
}

async function escalateHelp(rule: RuleRow): Promise<void> {
    if (rule.help_ack_min <= 0) return;
    const { rows } = await query(
        `UPDATE help_requests SET escalated_at = CURRENT_TIMESTAMP
         WHERE circle_id = $1 AND acknowledged_at IS NULL AND escalated_at IS NULL
           AND created_at <= NOW() - make_interval(mins => $2::int)
         RETURNING id`,
        [rule.circle_id, rule.help_ack_min]
    );
    if (rows.length === 0) return;
    const targets = await resolveTargets(rule.circle_id, rule.secondary_member_ids, ['family']);
    for (const row of rows as Array<{ id: string }>) {
        for (const target of targets) {
            const { title, message } = helpTexts(rule, rule.help_ack_min, target.language);
            await createNotification({
                userId: target.user_id,
                circleId: rule.circle_id,
                title,
                message,
                type: 'kiosk_help_escalated',
                relatedId: row.id,
                url: '/',
                tag: `help-${row.id}`,
            });
        }
    }
    logger.info('escalation.help', { circleId: rule.circle_id, requests: rows.length, recipients: targets.length });
}

export async function runEscalationTick(): Promise<void> {
    try {
        const { rows } = await query(
            `SELECT r.*, cr.first_name
             FROM escalation_rules r
             LEFT JOIN care_recipients cr ON cr.circle_id = r.circle_id
             WHERE r.enabled = TRUE`
        );
        for (const raw of rows as Array<Record<string, unknown>>) {
            const rule: RuleRow = { ...normalize(raw), circle_id: String(raw.circle_id), first_name: (raw.first_name as string | null) ?? null };
            await remindPatient(rule);
            await escalateIntakes(rule, 'primary');
            await escalateIntakes(rule, 'secondary');
            await escalateHelp(rule);
        }
    } catch (err) {
        logger.error('escalation.tick_error', { error: err instanceof Error ? err.message : String(err) });
    }
}

export function startEscalationScheduler(): void {
    cron.schedule('* * * * *', () => { void runEscalationTick(); });
    logger.info('escalation.scheduler_started');
}

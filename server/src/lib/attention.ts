import { query } from '../db';
import { VISIT_COLUMNS, VisitRow } from './visits';
import { expandEventOccurrences, toLocalISO } from '../routes/events';

/**
 * "A traiter" : ce qui demande l'attention d'un aidant maintenant, pour le
 * haut du tableau de bord. Chaque element est structure (le client traduit),
 * trie par gravite : urgent (alerte, aucun signe de vie, prise manquee),
 * puis a surveiller (ordonnance a renouveler, tache en retard), puis
 * information (visiteur sur place, rendez-vous imminent).
 */

export type AttentionKind =
    | 'help'
    | 'presence'
    | 'missed_intakes'
    | 'vitals_out_of_range'
    | 'medication_stock'
    | 'prescriptions'
    | 'tasks_overdue'
    | 'visitor_present'
    | 'appointments';
export type AttentionSeverity = 'urgent' | 'warn' | 'info';

export interface AttentionDetail {
    id: string;
    label: string;
    /** Horodatage local (ISO sans fuseau) ou date 'YYYY-MM-DD' selon le type. */
    when: string | null;
    extra?: string | null;
}

export interface AttentionItem {
    kind: AttentionKind;
    severity: AttentionSeverity;
    count: number;
    href: string;
    details: AttentionDetail[];
    /** presence : heure limite 'HH:MM' ; visitor_present : nom du visiteur. */
    time?: string | null;
    name?: string | null;
    /** help : demandes d'aide sans prise en charge (bouton "je m'en occupe"). */
    open_help?: Array<{ id: string; created_at: string }>;
}

const SEVERITY: Record<AttentionKind, AttentionSeverity> = {
    help: 'urgent',
    presence: 'urgent',
    missed_intakes: 'urgent',
    vitals_out_of_range: 'warn',
    medication_stock: 'warn',
    prescriptions: 'warn',
    tasks_overdue: 'warn',
    visitor_present: 'info',
    appointments: 'info',
};

const ORDER: AttentionKind[] = ['help', 'presence', 'missed_intakes', 'vitals_out_of_range', 'medication_stock', 'prescriptions', 'tasks_overdue', 'visitor_present', 'appointments'];

/** Fenetre de rappel des mesures hors plage. */
const VITALS_WINDOW_DAYS = 7;

/** pg renvoie les timestamps en chaine locale ; on garde une chaine dans tous les cas. */
const stamp = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return toLocalISO(value);
    return String(value);
};

const SNIPPET = 140;

export async function loadAttention(circleId: string, includeHealth: boolean, now: Date = new Date()): Promise<AttentionItem[]> {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    const soon = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const none = Promise.resolve({ rows: [] as any[] });

    const [incidents, presence, missed, prescriptions, tasks, visits, events, openHelp, lowStock, outOfRange] = await Promise.all([
        query(
            `SELECT id, author_name, content, occurred_at
             FROM journal_entries
             WHERE circle_id = $1 AND type = 'incident' AND occurred_at >= NOW() - interval '24 hours'
             ORDER BY occurred_at DESC
             LIMIT 20`,
            [circleId]
        ),
        // Meme regle que la veille passive (lib/presenceMonitor) : heure limite
        // depassee et aucun signal aujourd'hui.
        query(
            `SELECT to_char(r.no_activity_before, 'HH24:MI') AS before
             FROM presence_rules r
             WHERE r.circle_id = $1 AND r.enabled = TRUE AND r.no_activity_before <= LOCALTIME
               AND NOT EXISTS (
                 SELECT 1 FROM presence_signals s
                 WHERE s.circle_id = r.circle_id AND s.occurred_at >= date_trunc('day', CURRENT_TIMESTAMP)
               )`,
            [circleId]
        ),
        includeHealth
            ? query(
                `SELECT i.id, m.name AS label, i.due_at
                 FROM medication_intakes i
                 JOIN medications m ON m.id = i.medication_id
                 WHERE i.circle_id = $1 AND i.due_at::date = CURRENT_DATE AND i.status = 'missed'
                 ORDER BY i.due_at`,
                [circleId]
            )
            : none,
        includeHealth
            ? query(
                `SELECT id, title AS label, renewal_date
                 FROM prescriptions
                 WHERE circle_id = $1 AND renewal_date IS NOT NULL
                   AND renewal_date <= CURRENT_DATE + COALESCE(reminder_days, 7)
                 ORDER BY renewal_date
                 LIMIT 20`,
                [circleId]
            )
            : none,
        query(
            `SELECT id, title AS label, due_date
             FROM tasks
             WHERE circle_id = $1 AND is_completed = FALSE AND due_date IS NOT NULL AND due_date < NOW()
             ORDER BY due_date
             LIMIT 20`,
            [circleId]
        ),
        query(
            `SELECT ${VISIT_COLUMNS} FROM visits
             WHERE circle_id = $1 AND checked_out_at IS NULL AND checked_in_at::date = CURRENT_DATE
             ORDER BY checked_in_at DESC`,
            [circleId]
        ),
        query(
            `SELECT * FROM events
             WHERE circle_id = $1
               AND start_time <= $3
               AND (rrule IS NOT NULL OR COALESCE(end_time, start_time) >= $2)
             ORDER BY start_time`,
            [circleId, toLocalISO(dayStart), toLocalISO(dayEnd)]
        ),
        query(
            `SELECT id, created_at FROM help_requests
             WHERE circle_id = $1 AND acknowledged_at IS NULL AND created_at >= NOW() - interval '24 hours'
             ORDER BY created_at DESC`,
            [circleId]
        ),
        includeHealth
            ? query(
                `SELECT id, name AS label, stock_quantity, stock_alert_threshold
                 FROM medications
                 WHERE circle_id = $1 AND active = TRUE
                   AND stock_quantity IS NOT NULL AND stock_alert_threshold IS NOT NULL
                   AND stock_quantity <= stock_alert_threshold
                 ORDER BY stock_quantity, name
                 LIMIT 20`,
                [circleId]
            )
            : none,
        includeHealth
            ? query(
                `SELECT v.id, v.type, v.value, v.value2, v.measured_at
                 FROM vitals v
                 JOIN vital_thresholds th ON th.circle_id = v.circle_id AND th.type = v.type
                 WHERE v.circle_id = $1 AND v.measured_at >= NOW() - make_interval(days => $2::int)
                   AND (
                     (th.min_value IS NOT NULL AND v.value < th.min_value)
                     OR (th.max_value IS NOT NULL AND v.value > th.max_value)
                     OR (v.value2 IS NOT NULL AND th.min_value2 IS NOT NULL AND v.value2 < th.min_value2)
                     OR (v.value2 IS NOT NULL AND th.max_value2 IS NOT NULL AND v.value2 > th.max_value2)
                   )
                 ORDER BY v.measured_at DESC
                 LIMIT 20`,
                [circleId, VITALS_WINDOW_DAYS]
            )
            : none,
    ]);

    const items: AttentionItem[] = [];
    const push = (kind: AttentionKind, count: number, href: string, details: AttentionDetail[], extra: Partial<AttentionItem> = {}) => {
        if (count > 0) items.push({ kind, severity: SEVERITY[kind], count, href, details: details.slice(0, 5), ...extra });
    };

    push('help', incidents.rows.length, '/journal', (incidents.rows as any[]).map((r) => ({
        id: r.id, label: String(r.content || '').slice(0, SNIPPET), when: stamp(r.occurred_at), extra: r.author_name ?? null,
    })), { open_help: (openHelp.rows as any[]).map((r) => ({ id: r.id, created_at: stamp(r.created_at) ?? '' })) });

    const before = (presence.rows[0] as { before: string } | undefined)?.before;
    push('presence', before ? 1 : 0, '/', [], { time: before ?? null });

    push('missed_intakes', missed.rows.length, '/medications', (missed.rows as any[]).map((r) => ({ id: r.id, label: r.label, when: stamp(r.due_at) })));

    // Mesures hors de la plage fixee par la famille : le type sert de libelle,
    // le client le traduit ; la valeur lue part dans extra.
    push('vitals_out_of_range', outOfRange.rows.length, '/health', (outOfRange.rows as any[]).map((r) => ({
        id: r.id,
        label: r.type,
        when: stamp(r.measured_at),
                // pg rend les NUMERIC en chaine ("176.00") : on repasse par Number pour un affichage lisible.
        extra: r.value2 !== null && r.value2 !== undefined ? `${Number(r.value)}/${Number(r.value2)}` : String(Number(r.value)),
    })));

    push('medication_stock', lowStock.rows.length, '/medications', (lowStock.rows as any[]).map((r) => ({
        id: r.id,
        label: r.label,
        when: null,
        extra: String(r.stock_quantity),
    })));

    push('prescriptions', prescriptions.rows.length, '/medications', (prescriptions.rows as any[]).map((r) => ({
        id: r.id, label: r.label, when: stamp(r.renewal_date)?.slice(0, 10) ?? null,
    })));

    push('tasks_overdue', tasks.rows.length, '/tasks', (tasks.rows as any[]).map((r) => ({ id: r.id, label: r.label, when: stamp(r.due_date) })));

    const active = visits.rows as VisitRow[];
    push('visitor_present', active.length, '/visitors', active.map((v) => ({
        id: v.id, label: v.visitor_name, when: stamp(v.checked_in_at), extra: v.visitor_type,
    })), { name: active[0]?.visitor_name ?? null });

    // Prochain rendez-vous dans les deux heures (occurrences recurrentes comprises).
    const upcoming: AttentionDetail[] = [];
    for (const event of events.rows as any[]) {
        for (const occ of expandEventOccurrences(event, dayStart, dayEnd)) {
            if (occ.start >= now && occ.start <= soon) {
                upcoming.push({ id: event.id, label: event.title, when: toLocalISO(occ.start), extra: event.location ?? null });
            }
        }
    }
    upcoming.sort((a, b) => String(a.when).localeCompare(String(b.when)));
    push('appointments', upcoming.length, '/calendar', upcoming);

    items.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    return items;
}

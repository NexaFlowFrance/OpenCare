import { PoolClient } from 'pg';
import { query } from '../db';

/**
 * Prises de medicaments : logique partagee entre la page Medicaments, le kiosk
 * (et le mode telephone patient) et le lien magique.
 *
 * - generateIntakes : cree les occurrences manquantes d'une periode depuis les
 *   horaires (idempotent grace a la contrainte unique). La quantite et l'unite
 *   sont copiees depuis l'horaire pour survivre a une re-edition des horaires
 *   (la re-edition remplace les lignes et met schedule_id a NULL).
 * - markMissed : une prise en attente depuis plus de 4 h devient "manquee".
 * - applyIntakeStatus : changement de statut + entree de journal, avec la
 *   source de confirmation (aidant, kiosk, telephone, lien magique).
 * - splitForPatient : ce que la personne aidee doit voir maintenant, et rien
 *   de plus (les prises futures restent cote aidant).
 */

export type IntakeSource = 'caregiver' | 'kiosk' | 'phone' | 'link';
export type IntakeWriteStatus = 'taken' | 'skipped' | 'pending';

/** Fenetre "a prendre maintenant" : de 30 min avant l'heure jusqu'au marquage "manque" (4 h apres). */
export const DUE_NOW_BEFORE_MS = 30 * 60 * 1000;
export const MISSED_AFTER_MS = 4 * 60 * 60 * 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const toDateString = (d: Date): string => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Genere les occurrences manquantes entre deux dates (YYYY-MM-DD, incluses). */
export async function generateIntakes(circleId: string, from: string, to: string): Promise<void> {
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) return;
    await query(
        `INSERT INTO medication_intakes (circle_id, medication_id, schedule_id, due_at, quantity, unit)
         SELECT m.circle_id, m.id, s.id, d::date + s.time_of_day, s.quantity, s.unit
         FROM medications m
         JOIN medication_schedules s ON s.medication_id = m.id
         CROSS JOIN generate_series($2::date, $3::date, interval '1 day') AS d
         WHERE m.circle_id = $1
           AND m.active = TRUE
           AND m.prn = FALSE
           AND (m.start_date IS NULL OR d::date >= m.start_date)
           AND (m.end_date IS NULL OR d::date <= m.end_date)
           AND s.days_of_week @> to_jsonb(EXTRACT(ISODOW FROM d)::int)
           -- Une prise deja confirmee sous un ancien horaire (schedule_id remis a
           -- NULL a la re-edition) ne doit pas etre recreee pour la meme heure.
           AND NOT EXISTS (
               SELECT 1 FROM medication_intakes x
               WHERE x.medication_id = m.id AND x.due_at = d::date + s.time_of_day
           )
         ON CONFLICT (medication_id, schedule_id, due_at) DO NOTHING`,
        [circleId, from, to]
    );
}

/** Les prises en attente depuis plus de 4 h deviennent manquees. */
export async function markMissed(circleId: string): Promise<void> {
    await query(
        `UPDATE medication_intakes
         SET status = 'missed'
         WHERE circle_id = $1 AND status = 'pending' AND due_at < NOW() - interval '4 hours'`,
        [circleId]
    );
}

/** Genere et met a jour les prises du jour (utilise par le kiosk et le lien magique). */
export async function ensureTodayIntakes(circleId: string): Promise<void> {
    const today = toDateString(new Date());
    await generateIntakes(circleId, today, today);
    await markMissed(circleId);
}

/**
 * Colonnes d'une prise enrichie du medicament, pour tous les ecrans qui
 * affichent "quoi prendre" : nom, dosage, forme, photo, quantite, consignes.
 */
export const INTAKE_DISPLAY_COLUMNS = `
    i.id, i.circle_id, i.medication_id, i.schedule_id, i.due_at, i.status,
    i.confirmed_by_user, i.confirmed_by_link, i.confirmed_at, i.confirmed_source,
    i.journal_entry_id,
    COALESCE(i.quantity, s.quantity, 1) AS quantity,
    COALESCE(i.unit, s.unit) AS unit,
    m.name AS medication_name, m.dosage AS medication_dosage, m.dosage,
    m.form, m.photo_url, m.instructions, m.with_food, m.reason, m.appearance, m.prn,
    s.label AS schedule_label`;

export const INTAKE_DISPLAY_FROM = `
    FROM medication_intakes i
    JOIN medications m ON m.id = i.medication_id
    LEFT JOIN medication_schedules s ON s.id = i.schedule_id`;

export interface IntakeForUpdate {
    id: string;
    circle_id: string;
    medication_id: string;
    journal_entry_id: string | null;
    medication_name: string;
    medication_dosage: string | null;
    quantity: number | null;
    unit: string | null;
}

export async function fetchIntakeForUpdate(
    client: PoolClient,
    intakeId: string,
    circleId: string
): Promise<IntakeForUpdate | undefined> {
    const result = await client.query(
        `SELECT i.id, i.circle_id, i.medication_id, i.journal_entry_id,
                m.name AS medication_name, m.dosage AS medication_dosage,
                i.quantity, i.unit
         FROM medication_intakes i
         JOIN medications m ON m.id = i.medication_id
         WHERE i.id = $1 AND i.circle_id = $2
         FOR UPDATE OF i`,
        [intakeId, circleId]
    );
    return result.rows[0] as IntakeForUpdate | undefined;
}

/**
 * Applique un statut a une prise et garde le journal coherent.
 * taken/skipped : horodate la confirmation (avec sa source) et cree une entree
 * de journal ; pending : efface la confirmation et l'entree liee.
 * S'execute dans la transaction de l'appelant. Renvoie la prise mise a jour.
 */
export async function applyIntakeStatus(
    client: PoolClient,
    intake: IntakeForUpdate,
    status: IntakeWriteStatus,
    author: { userId?: string; linkId?: string; name: string },
    source: IntakeSource
) {
    if (intake.journal_entry_id) {
        await client.query('DELETE FROM journal_entries WHERE id = $1', [intake.journal_entry_id]);
    }

    if (status === 'pending') {
        const result = await client.query(
            `UPDATE medication_intakes
             SET status = 'pending', confirmed_by_user = NULL, confirmed_by_link = NULL,
                 confirmed_at = NULL, confirmed_source = NULL, journal_entry_id = NULL
             WHERE id = $1
             RETURNING *`,
            [intake.id]
        );
        return result.rows[0];
    }

    const content = intake.medication_dosage
        ? `${intake.medication_name} ${intake.medication_dosage}`
        : intake.medication_name;

    const entryResult = await client.query(
        `INSERT INTO journal_entries (circle_id, author_user_id, caregiver_link_id, author_name, type, content, data)
         VALUES ($1, $2, $3, $4, 'medication', $5, $6)
         RETURNING id`,
        [
            intake.circle_id,
            author.userId ?? null,
            author.linkId ?? null,
            author.name,
            content,
            JSON.stringify({
                medication_id: intake.medication_id,
                intake_id: intake.id,
                status,
                source,
                quantity: intake.quantity,
                unit: intake.unit,
            }),
        ]
    );

    const result = await client.query(
        `UPDATE medication_intakes
         SET status = $1, confirmed_by_user = $2, confirmed_by_link = $3,
             confirmed_at = NOW(), confirmed_source = $4, journal_entry_id = $5
         WHERE id = $6
         RETURNING *`,
        [status, author.userId ?? null, author.linkId ?? null, source, entryResult.rows[0].id, intake.id]
    );
    return result.rows[0];
}

export interface PatientIntakeRow {
    id: string;
    due_at: string;
    status: 'pending' | 'taken' | 'skipped' | 'missed';
    [key: string]: unknown;
}

export interface PatientMedicationView<T extends PatientIntakeRow> {
    /** A prendre maintenant : en attente, entre 30 min avant l'heure et 4 h apres */
    due_now: T[];
    /** Deja pris ou saute aujourd'hui */
    done: T[];
    /** Manque (en attente depuis plus de 4 h) : cote aidant, pas cote patient */
    missed: T[];
    /** Nombre de prises a venir plus tard dans la journee (jamais detaillees au patient) */
    upcoming_count: number;
    /** Heure de la prochaine prise a venir (ISO local) ou null */
    next_due_at: string | null;
    taken_count: number;
    total: number;
}

/**
 * Ce que la personne aidee doit voir : uniquement ce qui est du maintenant.
 * Les prises futures ne sont comptees que pour dire "rien pour l'instant".
 */
export function splitForPatient<T extends PatientIntakeRow>(intakes: T[], now: Date = new Date()): PatientMedicationView<T> {
    const view: PatientMedicationView<T> = {
        due_now: [], done: [], missed: [], upcoming_count: 0, next_due_at: null,
        taken_count: 0, total: intakes.length,
    };
    const nowMs = now.getTime();
    for (const intake of intakes) {
        const dueMs = new Date(intake.due_at).getTime();
        if (intake.status === 'taken' || intake.status === 'skipped') {
            view.done.push(intake);
            if (intake.status === 'taken') view.taken_count += 1;
            continue;
        }
        if (intake.status === 'missed' || dueMs < nowMs - MISSED_AFTER_MS) {
            view.missed.push(intake);
            continue;
        }
        if (dueMs <= nowMs + DUE_NOW_BEFORE_MS) {
            view.due_now.push(intake);
        } else {
            view.upcoming_count += 1;
            if (!view.next_due_at || intake.due_at < view.next_due_at) view.next_due_at = intake.due_at;
        }
    }
    return view;
}

import { query } from '../db';

/**
 * Fiche urgence : identite, traitements en cours, contacts a appeler.
 *
 * Servie a deux endroits, d'ou cette lib partagee : la page aidant qui fabrique
 * le QR du frigo (routes/emergency.ts) et l'ecran patient, ou un secouriste
 * arrive chez le proche peut la lire tout de suite (routes/kiosk.ts).
 */

export interface EmergencyRecipient {
    first_name: string;
    last_name: string | null;
    birth_date: string | null;
    photo_url: string | null;
    address: string | null;
    phone: string | null;
    blood_type: string | null;
    allergies: string | null;
    medical_history: string | null;
    advance_directives: string | null;
    gp_name: string | null;
    gp_phone: string | null;
    insurance_info: string | null;
}

export interface EmergencyMedication {
    name: string;
    dosage: string | null;
    form: string | null;
    schedules: Array<{ time: string; label: string | null }>;
}

export interface EmergencyContact {
    name: string;
    category: string;
    organization: string | null;
    phone: string | null;
    phone2: string | null;
}

export interface EmergencyData {
    recipient: EmergencyRecipient | null;
    medications: EmergencyMedication[];
    contacts: EmergencyContact[];
}

/** Assemble la fiche vitale d'un cercle (identite, traitements actifs, contacts). */
export async function buildEmergencyData(circleId: string): Promise<EmergencyData> {
    const [recipientResult, medsResult, contactsResult] = await Promise.all([
        query(
            `SELECT first_name, last_name, birth_date, photo_url, address, phone,
                    blood_type, allergies, medical_history, advance_directives,
                    gp_name, gp_phone, insurance_info
             FROM care_recipients WHERE circle_id = $1`,
            [circleId]
        ),
        query(
            `SELECT m.name, m.dosage, m.form,
                    COALESCE(
                        json_agg(json_build_object('time', to_char(s.time_of_day, 'HH24:MI'), 'label', s.label))
                            FILTER (WHERE s.id IS NOT NULL),
                        '[]'::json
                    ) AS schedules
             FROM medications m
             LEFT JOIN medication_schedules s ON s.medication_id = m.id
             WHERE m.circle_id = $1 AND m.active = TRUE
             GROUP BY m.id
             ORDER BY m.name`,
            [circleId]
        ),
        query(
            `SELECT name, category, organization, phone, phone2
             FROM contacts
             WHERE circle_id = $1 AND phone IS NOT NULL
             ORDER BY CASE category
                 WHEN 'doctor' THEN 0
                 WHEN 'nurse' THEN 1
                 WHEN 'family' THEN 2
                 ELSE 3
             END, name
             LIMIT 8`,
            [circleId]
        ),
    ]);

    return {
        recipient: (recipientResult.rows[0] as EmergencyRecipient) ?? null,
        medications: medsResult.rows as EmergencyMedication[],
        contacts: contactsResult.rows as EmergencyContact[],
    };
}

/** La fiche complete, notes complementaires comprises. */
export async function loadEmergencySheet(circleId: string): Promise<EmergencyData & { extra_notes: string | null }> {
    const [data, sheetResult] = await Promise.all([
        buildEmergencyData(circleId),
        query('SELECT extra_notes FROM emergency_sheets WHERE circle_id = $1', [circleId]),
    ]);
    return { ...data, extra_notes: (sheetResult.rows[0]?.extra_notes as string | null) ?? null };
}

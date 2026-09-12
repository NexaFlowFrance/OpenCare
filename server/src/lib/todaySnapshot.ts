import { query } from '../db';
import { ensureTodayIntakes, splitForPatient, INTAKE_DISPLAY_COLUMNS, INTAKE_DISPLAY_FROM, PatientIntakeRow, PatientMedicationView } from './intakes';
import { VISIT_COLUMNS, VisitRow } from './visits';
import { expandEventOccurrences, toLocalISO } from '../routes/events';

/**
 * Instantane de la journee du proche : ce que l'ecran patient affiche
 * (GET /api/kiosk/today) et ce que le compagnon "Demandez-moi" utilise pour
 * repondre sans rien inventer. Une seule source pour les deux.
 */

export interface TodayMember { id: string; name: string; avatar_url: string | null; role: string }

export interface TodayEvent {
    id: string;
    title: string;
    category: string;
    location: string | null;
    description: string | null;
    start_time: string;
    end_time: string | null;
    members: TodayMember[];
}

export interface TodayContact { id: string; name: string; category: string; phone: string | null; organization: string | null }

export interface TodayIntake extends PatientIntakeRow {
    medication_name: string;
    dosage: string | null;
    form: string | null;
    quantity: number | string | null;
    unit: string | null;
}

export interface TodaySnapshot {
    recipient: { first_name: string; last_name: string | null; photo_url: string | null; address: string | null; phone: string | null } | null;
    events_today: TodayEvent[];
    intakes_today: TodayIntake[];
    /** La vue patient : seulement ce qui est du maintenant, le reste resume. */
    medications: PatientMedicationView<TodayIntake>;
    /** "Mes informations" : les personnes que le proche peut avoir a appeler. */
    contacts_key: TodayContact[];
    /** Membres du cercle (puces de nom du parcours visiteur). */
    members: TodayMember[];
    visits_today: VisitRow[];
    active_visit: VisitRow | null;
    photos_enabled: boolean;
    heatwave: { active: true; level: string } | null;
    /** L'IA du cercle est configuree et le compagnon active : conversation libre possible. */
    companion_enabled: boolean;
}

export async function loadTodaySnapshot(circleId: string, now: Date = new Date()): Promise<TodaySnapshot> {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    // Today's intakes must exist even when no caregiver opened the app today
    // (they used to be generated only by the Medications page).
    await ensureTodayIntakes(circleId);

    const [recipientResult, eventsResult, membersResult, intakesResult, immichResult, heatwaveResult, companionResult, contactsResult, visitsResult] = await Promise.all([
        query('SELECT first_name, last_name, photo_url, address, phone FROM care_recipients WHERE circle_id = $1', [circleId]),
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
            `SELECT m.id, m.role, u.name, u.avatar_url
             FROM circle_members m
             JOIN users u ON u.id = m.user_id
             WHERE m.circle_id = $1`,
            [circleId]
        ),
        query(
            `SELECT ${INTAKE_DISPLAY_COLUMNS}
             ${INTAKE_DISPLAY_FROM}
             WHERE i.circle_id = $1 AND i.due_at::date = CURRENT_DATE
             ORDER BY i.due_at, m.name`,
            [circleId]
        ),
        query(`SELECT 1 FROM integrations WHERE circle_id = $1 AND type = 'immich' LIMIT 1`, [circleId]),
        query(`SELECT level FROM heatwave_settings WHERE circle_id = $1 AND enabled = TRUE AND active = TRUE`, [circleId]),
        query(
            `SELECT 1 FROM ai_settings
             WHERE circle_id = $1 AND enabled = TRUE AND companion_enabled = TRUE AND model <> ''`,
            [circleId]
        ),
        query(
            `SELECT id, name, category, phone, organization
             FROM contacts
             WHERE circle_id = $1 AND category IN ('doctor', 'nurse', 'pharmacy', 'aide', 'physio')
             ORDER BY CASE category WHEN 'doctor' THEN 0 WHEN 'pharmacy' THEN 1 WHEN 'nurse' THEN 2 ELSE 3 END, name
             LIMIT 8`,
            [circleId]
        ),
        query(
            `SELECT ${VISIT_COLUMNS} FROM visits
             WHERE circle_id = $1 AND checked_in_at::date = CURRENT_DATE
             ORDER BY checked_in_at DESC`,
            [circleId]
        ),
    ]);

    const membersById = new Map<string, TodayMember>(
        (membersResult.rows as TodayMember[]).map((m) => [m.id, { id: m.id, name: m.name, avatar_url: m.avatar_url, role: m.role }])
    );

    // Expand each candidate into today's occurrences (the shared RRULE helper
    // from the events routes) and join the participating members: their
    // photos are what the care recipient looks for first.
    const eventsToday: TodayEvent[] = [];
    for (const event of eventsResult.rows as any[]) {
        for (const occ of expandEventOccurrences(event, dayStart, dayEnd)) {
            const memberIds: string[] = Array.isArray(event.member_ids) ? event.member_ids : [];
            eventsToday.push({
                id: event.id,
                title: event.title,
                category: event.category,
                location: event.location ?? null,
                description: event.description ?? null,
                start_time: toLocalISO(occ.start),
                end_time: occ.end ? toLocalISO(occ.end) : null,
                members: memberIds.map((id) => membersById.get(id)).filter((m): m is TodayMember => Boolean(m)),
            });
        }
    }
    eventsToday.sort((a, b) => a.start_time.localeCompare(b.start_time));

    const recipient = recipientResult.rows[0] ?? null;
    const intakes = intakesResult.rows as TodayIntake[];
    const visitsToday = visitsResult.rows as VisitRow[];

    return {
        recipient: recipient
            ? {
                first_name: recipient.first_name,
                last_name: recipient.last_name ?? null,
                photo_url: recipient.photo_url ?? null,
                address: recipient.address ?? null,
                phone: recipient.phone ?? null,
            }
            : null,
        events_today: eventsToday,
        intakes_today: intakes,
        medications: splitForPatient(intakes, now),
        contacts_key: contactsResult.rows as TodayContact[],
        members: Array.from(membersById.values()),
        visits_today: visitsToday,
        active_visit: visitsToday.find((v) => !v.checked_out_at) ?? null,
        photos_enabled: immichResult.rows.length > 0,
        heatwave: heatwaveResult.rows[0] ? { active: true, level: heatwaveResult.rows[0].level as string } : null,
        companion_enabled: companionResult.rows.length > 0,
    };
}

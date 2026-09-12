import { query } from '../db';
import { createNotification } from './notifications';
import { broadcastToCircle } from './broadcaster';

/**
 * Visites declarees sur l'ecran patient : arrivee, note de passage, depart.
 * Chaque arrivee ecrit une entree de journal de type "visit" au nom du
 * visiteur et previent les aidants (admin + famille), en leur langue.
 */

export const VISITOR_TYPES = ['family', 'friend', 'caregiver', 'nurse', 'doctor', 'other'] as const;
export type VisitorType = typeof VISITOR_TYPES[number];

/** Les professionnels peuvent laisser une note et confirmer les medicaments. */
export const PROFESSIONAL_VISITOR_TYPES: VisitorType[] = ['caregiver', 'nurse', 'doctor'];

const TYPE_LABELS: Record<'fr' | 'en', Record<VisitorType, string>> = {
    fr: { family: 'famille', friend: 'ami ou voisin', caregiver: 'aide à domicile', nurse: 'infirmier(ère)', doctor: 'médecin', other: 'visiteur' },
    en: { family: 'family', friend: 'friend or neighbor', caregiver: 'home aide', nurse: 'nurse', doctor: 'doctor', other: 'visitor' },
};

const pickLang = (language: unknown): 'fr' | 'en' =>
    String(language || '').toLowerCase().startsWith('en') ? 'en' : 'fr';

const fmtTime = (d: Date, lang: 'fr' | 'en'): string =>
    lang === 'fr'
        ? `${d.getHours()} h${d.getMinutes() > 0 ? ` ${String(d.getMinutes()).padStart(2, '0')}` : ''}`
        : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export const VISIT_COLUMNS = `id, circle_id, visitor_type, visitor_name, member_id, device_id,
    checked_in_at, checked_out_at, note, journal_entry_id, created_at`;

export interface VisitRow {
    id: string;
    circle_id: string;
    visitor_type: VisitorType;
    visitor_name: string;
    member_id: string | null;
    device_id: string | null;
    checked_in_at: string;
    checked_out_at: string | null;
    note: string | null;
    journal_entry_id: string | null;
}

export function journalContent(visit: { visitor_name: string; visitor_type: VisitorType; checked_in_at: Date; checked_out_at?: Date | null }, lang: 'fr' | 'en', recipientName: string): string {
    const type = TYPE_LABELS[lang][visit.visitor_type];
    const arrived = fmtTime(visit.checked_in_at, lang);
    if (lang === 'en') {
        const base = `${visit.visitor_name} (${type}) checked in at ${arrived}${recipientName ? ` to see ${recipientName}` : ''}`;
        return visit.checked_out_at ? `${base}, left at ${fmtTime(visit.checked_out_at, lang)}` : base;
    }
    const base = `${visit.visitor_name} (${type}) est arrivé(e) à ${arrived}${recipientName ? ` chez ${recipientName}` : ''}`;
    return visit.checked_out_at ? `${base}, reparti(e) à ${fmtTime(visit.checked_out_at, lang)}` : base;
}

/** Cree la visite, son entree de journal et previent admin + famille. */
export async function checkIn(input: {
    circleId: string;
    visitorType: VisitorType;
    visitorName: string;
    memberId: string | null;
    deviceId: string | null;
    lang: 'fr' | 'en';
}): Promise<VisitRow> {
    const recipient = await query('SELECT first_name FROM care_recipients WHERE circle_id = $1', [input.circleId]);
    const recipientName: string = recipient.rows[0]?.first_name?.trim() || '';
    const now = new Date();

    const entry = await query(
        `INSERT INTO journal_entries (circle_id, author_name, type, content, data)
         VALUES ($1, $2, 'visit', $3, $4)
         RETURNING id`,
        [
            input.circleId,
            input.visitorName,
            journalContent({ visitor_name: input.visitorName, visitor_type: input.visitorType, checked_in_at: now }, input.lang, recipientName),
            JSON.stringify({ source: 'kiosk_visitor', visitor_type: input.visitorType }),
        ]
    );

    const visit = await query(
        `INSERT INTO visits (circle_id, visitor_type, visitor_name, member_id, device_id, journal_entry_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${VISIT_COLUMNS}`,
        [input.circleId, input.visitorType, input.visitorName, input.memberId, input.deviceId, entry.rows[0].id]
    );
    const row = visit.rows[0] as VisitRow;
    await query('UPDATE journal_entries SET data = data || $2::jsonb WHERE id = $1', [entry.rows[0].id, JSON.stringify({ visit_id: row.id })]);

    // Les aidants savent qui est la, sans avoir a demander.
    const members = await query(
        `SELECT m.user_id, COALESCE(u.language, 'fr') AS language
         FROM circle_members m JOIN users u ON u.id = m.user_id
         WHERE m.circle_id = $1 AND m.role IN ('admin', 'family')`,
        [input.circleId]
    );
    await Promise.all((members.rows as Array<{ user_id: string; language: string }>).map((member) => {
        const lang = pickLang(member.language);
        const type = TYPE_LABELS[lang][input.visitorType];
        return createNotification({
            userId: member.user_id,
            circleId: input.circleId,
            title: lang === 'en'
                ? `${input.visitorName} checked in`
                : `${input.visitorName} est arrivé(e)`,
            message: lang === 'en'
                ? `${input.visitorName} (${type}) checked in at ${fmtTime(now, 'en')}${recipientName ? ` to see ${recipientName}` : ''}.`
                : `${input.visitorName} (${type}) est arrivé(e) à ${fmtTime(now, 'fr')}${recipientName ? ` chez ${recipientName}` : ''}.`,
            type: 'visitor_checkin',
            relatedId: row.id,
            url: '/visitors',
            tag: `visit-${row.id}`,
        });
    }));

    await broadcastToCircle(input.circleId, { type: 'update', entity: 'visits', action: 'created' });
    await broadcastToCircle(input.circleId, { type: 'update', entity: 'journal', action: 'created' });
    return row;
}

/** Depart : horodate la sortie et complete l'entree de journal. */
export async function checkOut(circleId: string, visitId: string, lang: 'fr' | 'en'): Promise<VisitRow | null> {
    const result = await query(
        `UPDATE visits SET checked_out_at = NOW()
         WHERE id = $1 AND circle_id = $2 AND checked_out_at IS NULL
         RETURNING ${VISIT_COLUMNS}`,
        [visitId, circleId]
    );
    const row = result.rows[0] as VisitRow | undefined;
    if (!row) return null;
    if (row.journal_entry_id) {
        const recipient = await query('SELECT first_name FROM care_recipients WHERE circle_id = $1', [circleId]);
        await query('UPDATE journal_entries SET content = $2 WHERE id = $1', [
            row.journal_entry_id,
            journalContent(
                { visitor_name: row.visitor_name, visitor_type: row.visitor_type, checked_in_at: new Date(row.checked_in_at), checked_out_at: new Date(row.checked_out_at!) },
                lang,
                recipient.rows[0]?.first_name?.trim() || ''
            ),
        ]);
    }
    await broadcastToCircle(circleId, { type: 'update', entity: 'visits', action: 'updated' });
    await broadcastToCircle(circleId, { type: 'update', entity: 'journal', action: 'updated' });
    return row;
}

/** Note de passage d'un professionnel : une entree de journal a son nom. */
export async function addVisitNote(circleId: string, visitId: string, content: string): Promise<VisitRow | null> {
    const current = await query(`SELECT ${VISIT_COLUMNS} FROM visits WHERE id = $1 AND circle_id = $2`, [visitId, circleId]);
    const visit = current.rows[0] as VisitRow | undefined;
    if (!visit) return null;
    await query(
        `INSERT INTO journal_entries (circle_id, author_name, type, content, data)
         VALUES ($1, $2, 'visit', $3, $4)`,
        [circleId, visit.visitor_name, content, JSON.stringify({ source: 'kiosk_visitor', visit_id: visit.id, visitor_type: visit.visitor_type, note: true })]
    );
    const updated = await query(
        `UPDATE visits SET note = CASE WHEN note IS NULL OR note = '' THEN $3 ELSE note || E'\\n' || $3 END
         WHERE id = $1 AND circle_id = $2
         RETURNING ${VISIT_COLUMNS}`,
        [visitId, circleId, content]
    );
    await broadcastToCircle(circleId, { type: 'update', entity: 'visits', action: 'updated' });
    await broadcastToCircle(circleId, { type: 'update', entity: 'journal', action: 'created' });
    return updated.rows[0] as VisitRow;
}

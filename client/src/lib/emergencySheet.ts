/**
 * Fiche urgence : encodage du QR.
 *
 * La fiche ne voyage PAS par le reseau : elle est encodee dans le fragment de
 * l'URL du lecteur, qui n'est jamais envoye a un serveur. Le QR fonctionne donc
 * en 4G, hors du domicile, sans exposer OpenCare sur Internet.
 *
 * Deux ecrans fabriquent ce QR, la page du proche cote aidant et l'ecran
 * patient quand les secours arrivent : le format vit ici pour que les deux
 * restent identiques, et que docs/urgence.html n'ait qu'un format a decoder.
 */

/** Lecteur public, heberge sur la page GitHub du projet. Il ne contient aucune donnee. */
export const EMERGENCY_VIEWER_URL = 'https://nexaflowfrance.github.io/OpenCare/urgence.html';

/** Au-dela, le QR devient trop dense pour se laisser scanner facilement. */
export const MAX_QR_URL_LENGTH = 2300;

export interface EmergencyPayload {
    recipient: Record<string, unknown> | null;
    medications: Array<Record<string, unknown>>;
    contacts: Array<Record<string, unknown>>;
    extra_notes: string | null;
}

/**
 * Format compact v2 (positions fixes) pour garder le QR peu dense donc scannable.
 * r: [nom, naissance, groupe, allergies, directives, medecin, telMedecin, mutuelle, adresse, antecedents]
 * m item: [nom, dosage, forme, heures] ; c item: [nom, organisation, telephone]
 * Le lecteur docs/urgence.html decode exactement ces positions.
 */
export const encodeSheet = (payload: EmergencyPayload, today: Date = new Date()): string => {
    const r = (payload.recipient ?? {}) as Record<string, unknown>;
    const s = (v: unknown, max = 0) => {
        if (typeof v !== 'string' || !v.trim()) return '';
        return max && v.length > max ? v.slice(0, max).trimEnd() + '…' : v;
    };
    const fullName = [s(r.first_name), s(r.last_name)].filter(Boolean).join(' ');
    const compact = {
        v: 2,
        r: [
            fullName, s(r.birth_date), s(r.blood_type), s(r.allergies, 150), s(r.advance_directives, 200),
            s(r.gp_name), s(r.gp_phone), s(r.insurance_info, 60), s(r.address, 80), s(r.medical_history, 150),
        ],
        m: payload.medications.slice(0, 15).map((m) => [
            s(m.name), s(m.dosage), s(m.form),
            Array.isArray(m.schedules)
                ? (m.schedules as Array<Record<string, unknown>>).map((x) => s(x.time)).filter(Boolean).join(' ')
                : '',
        ]),
        c: payload.contacts.slice(0, 8).map((c) => [s(c.name), s(c.organization), s(c.phone)]),
        x: s(payload.extra_notes, 120),
        u: today.toISOString().slice(0, 10),
    };
    const json = JSON.stringify(compact);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** L'URL complete a mettre dans le QR. */
export const buildSheetUrl = (payload: EmergencyPayload, today?: Date): string =>
    `${EMERGENCY_VIEWER_URL}#${encodeSheet(payload, today)}`;

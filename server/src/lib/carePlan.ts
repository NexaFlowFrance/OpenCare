import { query } from '../db';

/**
 * Plan de soins : les consignes redigees par la famille (routine du matin,
 * repas, mobilite, toilette, communication, ce qui contrarie, ce qui apaise,
 * urgence). Le reste de la page (medicaments, professionnels, semaine) est
 * calcule depuis les donnees existantes, jamais duplique.
 */

export const CARE_PLAN_SECTION_KEYS = ['morning', 'meals', 'mobility', 'personal_care', 'communication', 'triggers', 'calming', 'emergency'] as const;
export type CarePlanSectionKey = (typeof CARE_PLAN_SECTION_KEYS)[number];
export type CarePlanSections = Partial<Record<CarePlanSectionKey, string>>;

export const MAX_SECTION_CHARS = 4000;

export interface CarePlanRow {
    sections: CarePlanSections;
    updated_at: string | null;
    updated_by_name: string | null;
}

/** Ne garde que les cles connues, en texte, tronque : jamais de confiance au client. */
export function sanitizeSections(input: unknown): CarePlanSections {
    const out: CarePlanSections = {};
    if (!input || typeof input !== 'object') return out;
    for (const key of CARE_PLAN_SECTION_KEYS) {
        const value = (input as Record<string, unknown>)[key];
        if (typeof value === 'string') out[key] = value.trim().slice(0, MAX_SECTION_CHARS);
    }
    return out;
}

/** Les sections non vides seulement (ecran patient, pack de relais). */
export function filledSections(sections: CarePlanSections): CarePlanSections {
    const out: CarePlanSections = {};
    for (const key of CARE_PLAN_SECTION_KEYS) {
        const value = sections[key];
        if (typeof value === 'string' && value.trim()) out[key] = value;
    }
    return out;
}

export async function loadCarePlan(circleId: string): Promise<CarePlanRow> {
    const result = await query(
        `SELECT p.sections, p.updated_at, u.name AS updated_by_name
         FROM care_plans p
         LEFT JOIN users u ON u.id = p.updated_by
         WHERE p.circle_id = $1`,
        [circleId]
    );
    const row = result.rows[0];
    if (!row) return { sections: {}, updated_at: null, updated_by_name: null };
    return {
        sections: sanitizeSections(row.sections),
        updated_at: row.updated_at ? String(row.updated_at) : null,
        updated_by_name: row.updated_by_name ?? null,
    };
}

/** Fusionne les sections fournies avec l'existant (mise a jour partielle). */
export async function saveCarePlan(circleId: string, userId: string, patch: CarePlanSections): Promise<CarePlanRow> {
    await query(
        `INSERT INTO care_plans (circle_id, sections, updated_by, updated_at)
         VALUES ($1, $2::jsonb, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (circle_id) DO UPDATE
           SET sections = care_plans.sections || EXCLUDED.sections,
               updated_by = EXCLUDED.updated_by,
               updated_at = CURRENT_TIMESTAMP`,
        [circleId, JSON.stringify(patch), userId]
    );
    return loadCarePlan(circleId);
}

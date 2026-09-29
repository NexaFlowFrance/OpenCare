import { query } from '../db';

/**
 * Reglages d'un cercle (care_circles.settings).
 *
 * Ce JSONB melange deux choses : des preferences que tout le cercle peut lire
 * (le systeme d'unites) et des secrets qui ne doivent jamais sortir du serveur
 * (l'empreinte du code aidant du mode Kiosk). Un code a quatre chiffres dont
 * l'empreinte circule se casse hors ligne en quelques secondes : la lecture
 * passe donc par un filtre, et l'ecriture fusionne au lieu de remplacer, pour
 * qu'enregistrer une preference n'efface pas le code.
 */

/** Ce qu'un membre du cercle peut lire. */
export const PUBLIC_SETTING_KEYS = ['unit_system'] as const;

/** Systeme d'unites de saisie et d'affichage des constantes. */
export const UNIT_SYSTEMS = ['metric', 'imperial'] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];

export interface PublicCircleSettings {
    unit_system: UnitSystem;
}

const isUnitSystem = (value: unknown): value is UnitSystem =>
    typeof value === 'string' && (UNIT_SYSTEMS as readonly string[]).includes(value);

/** La vue publique des reglages, valeurs par defaut comprises. Rien d'autre ne sort. */
export function publicSettings(raw: unknown): PublicCircleSettings {
    const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return {
        unit_system: isUnitSystem(source.unit_system) ? source.unit_system : 'metric',
    };
}

/** Le meme filtre, applique a une ligne de cercle renvoyee par l'API. */
export function withPublicSettings<T extends { settings?: unknown }>(row: T): T & { settings: PublicCircleSettings } {
    return { ...row, settings: publicSettings(row.settings) };
}

/**
 * Valide une mise a jour partielle. Une cle inconnue ou une valeur invalide est
 * refusee plutot qu'ignoree : mieux vaut le dire que laisser croire que le
 * reglage a ete pris en compte.
 */
export function validateSettingsPatch(input: unknown, lang: 'fr' | 'en'): { patch?: Record<string, unknown>; error?: string } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { error: lang === 'en' ? 'settings must be an object' : 'Les réglages doivent être un objet' };
    }
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (!(PUBLIC_SETTING_KEYS as readonly string[]).includes(key)) {
            return { error: lang === 'en' ? `Unknown setting: ${key}` : `Réglage inconnu : ${key}` };
        }
        if (key === 'unit_system') {
            if (!isUnitSystem(value)) {
                return { error: lang === 'en' ? 'unit_system must be metric or imperial' : 'unit_system doit valoir metric ou imperial' };
            }
            patch.unit_system = value;
        }
    }
    return { patch };
}

/** Fusionne les preferences dans le JSONB sans toucher aux cles privees. */
export async function mergeCircleSettings(circleId: string, patch: Record<string, unknown>): Promise<PublicCircleSettings> {
    const result = await query(
        `UPDATE care_circles
         SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb
         WHERE id = $1
         RETURNING settings`,
        [circleId, JSON.stringify(patch)]
    );
    return publicSettings(result.rows[0]?.settings);
}

import { query } from '../db';
import { pick, type Lang } from './i18n';

/**
 * Reglages d'un cercle (care_circles.settings).
 *
 * Ce JSONB melange deux choses : des preferences que tout le cercle peut lire
 * (le systeme d'unites, le premier jour de la semaine) et des secrets qui ne doivent jamais sortir du serveur
 * (l'empreinte du code aidant du mode Kiosk). Un code a quatre chiffres dont
 * l'empreinte circule se casse hors ligne en quelques secondes : la lecture
 * passe donc par un filtre, et l'ecriture fusionne au lieu de remplacer, pour
 * qu'enregistrer une preference n'efface pas le code.
 */

/** Ce qu'un membre du cercle peut lire. */
export const PUBLIC_SETTING_KEYS = ['unit_system', 'week_start', 'emergency_numbers', 'aid_types'] as const;

/** Systeme d'unites de saisie et d'affichage des constantes. */
export const UNIT_SYSTEMS = ['metric', 'imperial'] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];

/**
 * Premier jour de la semaine a l'ecran (calendrier, choix des jours). Lundi par
 * defaut ; dimanche pour les familles qui comptent ainsi, aux Etats-Unis par
 * exemple. Un reglage d'affichage seulement : les jours restent stockes en ISO
 * (lundi = 1) et les RRULE en BYDAY=MO,...
 */
export const WEEK_STARTS = ['monday', 'sunday'] as const;
export type WeekStart = (typeof WEEK_STARTS)[number];

/**
 * Numeros d'urgence imprimes sur l'affiche de la fiche urgence ("911",
 * "SAMU 15, Pompiers 18, 112"...). Texte libre, court, sans retour a la ligne.
 * null : rien de saisi, le client choisit son repli (voir
 * client/src/lib/emergencyNumbers.ts).
 */
export const MAX_EMERGENCY_NUMBERS_LENGTH = 80;

/**
 * Types d'aides proposes dans Depenses > Aides. Les aides et leur fiscalite
 * dependent du pays : le cercle saisit sa propre liste ("Medicaid", "VA
 * benefits"...). Sans reglage, la liste francaise d'origine. Une aide garde le
 * texte de son type : retirer un type de la liste ne touche pas les aides
 * deja saisies. Les quatre cles d'origine restent traduites a l'ecran.
 */
export const DEFAULT_AID_TYPES = ['apa', 'cesu', 'tax_credit', 'other'] as const;
export const MAX_AID_TYPES = 15;
export const MAX_AID_TYPE_LENGTH = 40;

export interface PublicCircleSettings {
    unit_system: UnitSystem;
    week_start: WeekStart;
    emergency_numbers: string | null;
    /** null : rien de saisi, DEFAULT_AID_TYPES s'applique. */
    aid_types: string[] | null;
}

const isUnitSystem = (value: unknown): value is UnitSystem =>
    typeof value === 'string' && (UNIT_SYSTEMS as readonly string[]).includes(value);

const isWeekStart = (value: unknown): value is WeekStart =>
    typeof value === 'string' && (WEEK_STARTS as readonly string[]).includes(value);

// Caracteres de controle (retours a la ligne compris) : une seule ligne sur l'affiche.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Le texte nettoye, ou null s'il est vide ou invalide. */
const cleanEmergencyNumbers = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_EMERGENCY_NUMBERS_LENGTH || CONTROL_CHARS.test(trimmed)) return null;
    return trimmed;
};

/** Un type d'aide nettoye (une ligne, 40 caracteres au plus), ou null. */
export const cleanAidType = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().replace(/\s+/g, ' ');
    if (!trimmed || trimmed.length > MAX_AID_TYPE_LENGTH || CONTROL_CHARS.test(trimmed)) return null;
    return trimmed;
};

type AidTypesCheck = { list: string[] | null } | { error: 'invalid' | 'tooMany' | 'duplicate' };

/** Valide une liste saisie. null ou [] : retour a la liste par defaut. */
const checkAidTypes = (value: unknown): AidTypesCheck => {
    if (value === null) return { list: null };
    if (!Array.isArray(value)) return { error: 'invalid' };
    if (value.length === 0) return { list: null };
    if (value.length > MAX_AID_TYPES) return { error: 'tooMany' };
    const list: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        const cleaned = cleanAidType(item);
        if (!cleaned) return { error: 'invalid' };
        const key = cleaned.toLocaleLowerCase();
        if (seen.has(key)) return { error: 'duplicate' };
        seen.add(key);
        list.push(cleaned);
    }
    return { list };
};

/** La liste proposee par le cercle : la sienne, ou celle par defaut. */
export function effectiveAidTypes(settings: Pick<PublicCircleSettings, 'aid_types'>): string[] {
    return settings.aid_types ?? [...DEFAULT_AID_TYPES];
}

/** La vue publique des reglages, valeurs par defaut comprises. Rien d'autre ne sort. */
export function publicSettings(raw: unknown): PublicCircleSettings {
    const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return {
        unit_system: isUnitSystem(source.unit_system) ? source.unit_system : 'metric',
        week_start: isWeekStart(source.week_start) ? source.week_start : 'monday',
        emergency_numbers: cleanEmergencyNumbers(source.emergency_numbers),
        aid_types: (() => {
            const check = checkAidTypes(source.aid_types ?? null);
            return 'list' in check ? check.list : null;
        })(),
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
export function validateSettingsPatch(input: unknown, lang: Lang): { patch?: Record<string, unknown>; error?: string } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { error: pick(lang, { fr: 'Les réglages doivent être un objet', en: 'settings must be an object', es: 'Los ajustes deben ser un objeto' }) };
    }
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (!(PUBLIC_SETTING_KEYS as readonly string[]).includes(key)) {
            return { error: pick(lang, { fr: `Réglage inconnu : ${key}`, en: `Unknown setting: ${key}`, es: `Ajuste desconocido: ${key}` }) };
        }
        if (key === 'unit_system') {
            if (!isUnitSystem(value)) {
                return { error: pick(lang, { fr: 'unit_system doit valoir metric ou imperial', en: 'unit_system must be metric or imperial', es: 'unit_system debe ser metric o imperial' }) };
            }
            patch.unit_system = value;
        }
        if (key === 'week_start') {
            if (!isWeekStart(value)) {
                return { error: pick(lang, { fr: 'week_start doit valoir monday ou sunday', en: 'week_start must be monday or sunday', es: 'week_start debe ser monday o sunday' }) };
            }
            patch.week_start = value;
        }
        if (key === 'emergency_numbers') {
            // null ou "" efface le reglage (retour au repli du client).
            if (value === null || (typeof value === 'string' && !value.trim())) {
                patch.emergency_numbers = null;
                continue;
            }
            const cleaned = cleanEmergencyNumbers(value);
            if (!cleaned) {
                return {
                    error: pick(lang, {
                        fr: `emergency_numbers doit tenir sur une ligne de ${MAX_EMERGENCY_NUMBERS_LENGTH} caractères au plus`,
                        en: `emergency_numbers must be one line of at most ${MAX_EMERGENCY_NUMBERS_LENGTH} characters`,
                        es: `emergency_numbers debe caber en una línea de ${MAX_EMERGENCY_NUMBERS_LENGTH} caracteres como máximo`,
                    }),
                };
            }
            patch.emergency_numbers = cleaned;
        }
        if (key === 'aid_types') {
            const check = checkAidTypes(value);
            if ('error' in check) {
                const max = MAX_AID_TYPES;
                const len = MAX_AID_TYPE_LENGTH;
                return {
                    error: check.error === 'tooMany'
                        ? pick(lang, { fr: `aid_types : ${max} types au plus`, en: `aid_types: at most ${max} types`, es: `aid_types: ${max} tipos como máximo` })
                        : check.error === 'duplicate'
                            ? pick(lang, { fr: 'aid_types : ce type est déjà dans la liste', en: 'aid_types: that type is already in the list', es: 'aid_types: ese tipo ya está en la lista' })
                            : pick(lang, {
                                fr: `aid_types doit être une liste de textes d'une ligne, de ${len} caractères au plus`,
                                en: `aid_types must be a list of one-line texts of at most ${len} characters`,
                                es: `aid_types debe ser una lista de textos de una línea, de ${len} caracteres como máximo`,
                            }),
                };
            }
            patch.aid_types = check.list;
        }
    }
    return { patch };
}

/** Les reglages publics d'un cercle, lus en base (valeurs par defaut si absent). */
export async function getPublicSettings(circleId: string): Promise<PublicCircleSettings> {
    const result = await query('SELECT settings FROM care_circles WHERE id = $1', [circleId]);
    return publicSettings(result.rows[0]?.settings);
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

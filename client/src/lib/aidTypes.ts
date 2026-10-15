/**
 * Types d'aides proposes dans Depenses > Aides (meme regle que
 * server/src/lib/circleSettings.ts). Le cercle saisit sa liste dans
 * Parametres, Langue et region ; sans saisie, la liste francaise d'origine.
 * Les quatre cles d'origine restent traduites, un type saisi s'affiche tel quel.
 */

export const DEFAULT_AID_TYPES = ['apa', 'cesu', 'tax_credit', 'other'] as const;
export const MAX_AID_TYPES = 15;
export const MAX_AID_TYPE_LENGTH = 40;

const BUILT_IN: readonly string[] = DEFAULT_AID_TYPES;

/** La liste saisie par le cercle, ou null s'il n'a rien saisi. */
export const circleAidTypeSetting = (
    circle: { settings?: { aid_types?: unknown } } | null | undefined
): string[] | null => {
    const value = circle?.settings?.aid_types;
    if (!Array.isArray(value)) return null;
    const list = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
    return list.length > 0 ? list : null;
};

/** Les types proposes : ceux du cercle, ou la liste par defaut. */
export const circleAidTypes = (circle: { settings?: { aid_types?: unknown } } | null | undefined): string[] =>
    circleAidTypeSetting(circle) ?? [...DEFAULT_AID_TYPES];

/**
 * Les options du formulaire : la liste du cercle, plus le type actuel de l'aide
 * modifiee s'il en a ete retire (sinon l'enregistrer changerait son type).
 */
export const aidTypeOptions = (types: string[], current: string | null | undefined): string[] =>
    current && !types.includes(current) ? [...types, current] : types;

/** Le libelle d'un type : traduit pour une cle d'origine, tel quel sinon. */
export const aidTypeLabel = (type: string, t: (key: string) => string): string =>
    BUILT_IN.includes(type) ? t(`expenses:aids.types.${type}`) : type;

/** Un type saisi, nettoye comme le fera le serveur, ou null s'il est invalide. */
export const cleanAidType = (value: string): string | null => {
    const trimmed = value.trim().replace(/\s+/g, ' ');
    if (!trimmed || trimmed.length > MAX_AID_TYPE_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
    return trimmed;
};

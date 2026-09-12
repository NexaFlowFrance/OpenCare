import type { TFunction } from 'i18next';

/**
 * Helpers d'affichage des medicaments partages par la page Medicaments, le
 * tableau de bord, le kiosk et le lien intervenant : "2 comprimes", "5 ml".
 * Meme table que shared/src/constants.ts (DEFAULT_UNIT_BY_FORM).
 */

export const MEDICATION_FORMS = ['tablet', 'capsule', 'syrup', 'drops', 'patch', 'injection', 'sachet', 'inhaler', 'cream', 'other'] as const;
export const MEDICATION_UNITS = ['tablet', 'capsule', 'ml', 'drop', 'sachet', 'patch', 'injection', 'puff', 'application', 'dose'] as const;

export const DEFAULT_UNIT_BY_FORM: Record<string, string> = {
    tablet: 'tablet',
    capsule: 'capsule',
    syrup: 'ml',
    drops: 'drop',
    patch: 'patch',
    injection: 'injection',
    sachet: 'sachet',
    inhaler: 'puff',
    cream: 'application',
    other: 'dose',
};

/** Unite effective : celle de l'horaire, sinon deduite de la forme, sinon "dose". */
export const unitFor = (unit: string | null | undefined, form: string | null | undefined): string =>
    unit || DEFAULT_UNIT_BY_FORM[form ?? ''] || 'dose';

/** Quantite numerique sure (1 par defaut). */
export const safeQuantity = (quantity: number | string | null | undefined): number => {
    const value = typeof quantity === 'string' ? Number(quantity) : quantity ?? 1;
    return Number.isFinite(value) && value > 0 ? value : 1;
};

/**
 * "2 comprimés", "0,5 comprimé", "5 ml" : la quantite a prendre, en mots.
 * `t` doit avoir le namespace `medications` charge (cles `units.*`).
 */
export const formatAmount = (
    t: TFunction,
    quantity: number | string | null | undefined,
    unit: string | null | undefined,
    form: string | null | undefined
): string => {
    const value = safeQuantity(quantity);
    const shown = value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    const unitKey = unitFor(unit, form);
    return `${shown} ${t(`medications:units.${unitKey}`, { count: value, defaultValue: unitKey })}`;
};

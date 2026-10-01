/**
 * Affichage des constantes cote serveur (alertes, carte "a surveiller",
 * synthese hebdomadaire).
 *
 * Meme regle que client/src/lib/units.ts : les mesures sont TOUJOURS stockees en
 * metrique, le systeme du cercle ne change que l'affichage. Ce fichier en est
 * une copie volontaire, limitee a l'affichage (le serveur ne convertit jamais
 * une saisie) ; tests/server/unitsParity.test.ts verifie que les deux donnent
 * exactement le meme resultat.
 */

import type { UnitSystem } from './circleSettings';

export type VitalType = 'weight' | 'bp' | 'pain' | 'mood' | 'temperature' | 'glucose';

const LB_PER_KG = 2.2046226218;
const MGDL_PER_GL = 100;

const VITAL_TYPES: readonly string[] = ['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'];
export const isVitalType = (value: unknown): value is VitalType =>
    typeof value === 'string' && VITAL_TYPES.includes(value);

export const displayUnit = (type: VitalType, system: UnitSystem): string => {
    if (system === 'imperial') {
        if (type === 'weight') return 'lb';
        if (type === 'temperature') return '°F';
        if (type === 'glucose') return 'mg/dL';
    }
    switch (type) {
        case 'weight': return 'kg';
        case 'temperature': return '°C';
        case 'glucose': return 'g/L';
        case 'bp': return 'mmHg';
        default: return '/10';
    }
};

export const toDisplayValue = (type: VitalType, metric: number, system: UnitSystem): number => {
    if (system !== 'imperial') return metric;
    if (type === 'weight') return metric * LB_PER_KG;
    if (type === 'temperature') return metric * 9 / 5 + 32;
    if (type === 'glucose') return metric * MGDL_PER_GL;
    return metric;
};

export const decimalsFor = (type: VitalType, system: UnitSystem): number => {
    if (type === 'bp' || type === 'pain' || type === 'mood') return 0;
    if (type === 'temperature') return 1;
    if (type === 'glucose') return system === 'imperial' ? 0 : 2;
    return 1;
};

export const formatValue = (type: VitalType, metric: number, system: UnitSystem, locale?: string): string => {
    const shown = toDisplayValue(type, metric, system);
    const decimals = decimalsFor(type, system);
    return new Intl.NumberFormat(locale, { maximumFractionDigits: decimals, minimumFractionDigits: 0 }).format(shown);
};

/** "150 lb", "128/78 mmHg", "6/10" : la mesure complete dans le systeme du cercle. */
export const formatVital = (
    type: VitalType,
    value: number,
    value2: number | null | undefined,
    system: UnitSystem,
    locale?: string
): string => {
    const unit = displayUnit(type, system);
    if (type === 'bp' && value2 !== null && value2 !== undefined) {
        return `${formatValue(type, value, system, locale)}/${formatValue(type, value2, system, locale)} ${unit}`;
    }
    if (type === 'pain' || type === 'mood') return `${formatValue(type, value, system, locale)}${unit}`;
    return `${formatValue(type, value, system, locale)} ${unit}`;
};

/** Une valeur stockee, convertie et arrondie comme a l'ecran (pour un texte ou un prompt). */
export const roundedDisplayValue = (type: VitalType, metric: number, system: UnitSystem): number =>
    Number(toDisplayValue(type, metric, system).toFixed(decimalsFor(type, system)));

/** Locale d'affichage des nombres pour une langue de compte ('fr' -> 68,2 ; 'en' -> 68.2). */
export const numberLocale = (language: string | null | undefined): string =>
    String(language || '').toLowerCase().startsWith('en') ? 'en-US' : 'fr-FR';

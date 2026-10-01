/**
 * Systeme d'unites des constantes.
 *
 * Les mesures sont TOUJOURS stockees en metrique : kilos, degres Celsius,
 * grammes par litre, millimetres de mercure. Le systeme choisi par le cercle
 * ne change que la saisie et l'affichage, jamais la base. Un foyer qui passe
 * de l'un a l'autre voit donc son historique entier converti, sans migration
 * et sans perte de precision.
 */

export type UnitSystem = 'metric' | 'imperial';
export type VitalType = 'weight' | 'bp' | 'pain' | 'mood' | 'temperature' | 'glucose';

const VITAL_TYPES: readonly string[] = ['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'];
/** Un libelle venu du serveur est-il bien un type de constante ? */
export const isVitalType = (value: unknown): value is VitalType =>
    typeof value === 'string' && VITAL_TYPES.includes(value);

const LB_PER_KG = 2.2046226218;
/** g/L vers mg/dL : 1 g/L = 100 mg/dL. */
const MGDL_PER_GL = 100;

/** Unite affichee, par type et par systeme. */
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

/** L'unite dans laquelle la mesure est enregistree, quelle que soit la saisie. */
export const storageUnit = (type: VitalType): string => displayUnit(type, 'metric');

/** Une valeur stockee, telle qu'on la montre dans le systeme choisi. */
export const toDisplayValue = (type: VitalType, metric: number, system: UnitSystem): number => {
    if (system !== 'imperial') return metric;
    if (type === 'weight') return metric * LB_PER_KG;
    if (type === 'temperature') return metric * 9 / 5 + 32;
    if (type === 'glucose') return metric * MGDL_PER_GL;
    return metric;
};

/** Une valeur saisie par l'utilisateur, ramenee a ce qu'on enregistre. */
export const toStorageValue = (type: VitalType, shown: number, system: UnitSystem): number => {
    if (system !== 'imperial') return shown;
    if (type === 'weight') return shown / LB_PER_KG;
    if (type === 'temperature') return (shown - 32) * 5 / 9;
    if (type === 'glucose') return shown / MGDL_PER_GL;
    return shown;
};

/**
 * Decimales utiles a l'affichage. Une livre est plus fine qu'un kilo, un
 * mg/dL plus grossier qu'un g/L : afficher "104.00 mg/dL" ne renseigne
 * personne, et "58 kg" cache une perte de poids de 400 grammes.
 */
export const decimalsFor = (type: VitalType, system: UnitSystem): number => {
    if (type === 'bp' || type === 'pain' || type === 'mood') return 0;
    if (type === 'temperature') return 1;
    if (type === 'glucose') return system === 'imperial' ? 0 : 2;
    return 1;
};

/** La valeur affichee, arrondie, sans zeros inutiles. */
export const formatValue = (type: VitalType, metric: number, system: UnitSystem, locale?: string): string => {
    const shown = toDisplayValue(type, metric, system);
    const decimals = decimalsFor(type, system);
    return new Intl.NumberFormat(locale, { maximumFractionDigits: decimals, minimumFractionDigits: 0 }).format(shown);
};

/**
 * La mesure complete, prete a lire : "58,2 kg", "128/78 mmHg", "6/10".
 * La tension garde ses deux valeurs, le moral et la douleur leur echelle.
 */
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

/** Valeur d'un champ de saisie prerempli depuis une mesure stockee. */
export const toInputValue = (type: VitalType, metric: number | null | undefined, system: UnitSystem): string => {
    if (metric === null || metric === undefined || !Number.isFinite(metric)) return '';
    const shown = toDisplayValue(type, metric, system);
    return String(Number(shown.toFixed(decimalsFor(type, system) + 1)));
};

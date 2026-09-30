/**
 * Premier jour de la semaine a l'ecran.
 *
 * Reglage d'affichage du cercle : lundi par defaut, dimanche pour les familles
 * qui comptent ainsi. Rien ne change en base : les jours restent en ISO
 * (lundi = 1 ... dimanche = 7), les RRULE en BYDAY=MO,..., et les listes de
 * traduction (common:daysShort, dayLetters) restent rangees du lundi au
 * dimanche, indexees par jour ISO - 1. Seul l'ordre d'affichage tourne.
 */

export type WeekStart = 'monday' | 'sunday';

/** Le reglage du cercle, lundi quand il est absent ou inconnu. */
export const circleWeekStart = (circle: { settings?: { week_start?: unknown } } | null | undefined): WeekStart =>
    circle?.settings?.week_start === 'sunday' ? 'sunday' : 'monday';

/** La valeur attendue par date-fns (startOfWeek, endOfWeek) : 0 = dimanche, 1 = lundi. */
export const weekStartsOn = (start: WeekStart): 0 | 1 => (start === 'sunday' ? 0 : 1);

/** Les jours ISO dans l'ordre d'affichage. */
export const orderedIsoDays = (start: WeekStart): number[] =>
    start === 'sunday' ? [7, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 7];

/** Trie des jours ISO dans l'ordre d'affichage (pour un libelle "dim., lun., mer."). */
export const sortIsoDays = (days: number[], start: WeekStart): number[] => {
    const order = orderedIsoDays(start);
    return [...days].sort((a, b) => order.indexOf(a) - order.indexOf(b));
};

/** Une liste rangee du lundi au dimanche (traductions), remise dans l'ordre d'affichage. */
export const inWeekOrder = <T>(mondayFirst: T[], start: WeekStart): T[] =>
    orderedIsoDays(start).map((day) => mondayFirst[day - 1]);

/**
 * Une plage de jours ecrite comme la langue l'ecrit : "Nov 23 – 29, 2026" en
 * anglais (US), "23–29 nov. 2026" en francais, "28 déc. 2026 – 3 janv. 2027"
 * a cheval sur deux annees. Intl.formatRange regroupe le mois et l'annee
 * communs ; un navigateur qui ne le connait pas recoit les deux dates completes.
 */
type RangeFormat = Intl.DateTimeFormat & { formatRange?: (start: Date, end: Date) => string };

export function formatDayRangeIn(locale: string, start: Date, end: Date): string {
    const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }) as RangeFormat;
    return typeof fmt.formatRange === 'function'
        ? fmt.formatRange(start, end)
        : `${fmt.format(start)} - ${fmt.format(end)}`;
}

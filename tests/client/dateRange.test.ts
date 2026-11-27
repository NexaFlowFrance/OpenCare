import { describe, it, expect } from 'vitest';
import { formatDayRangeIn } from '../../client/src/lib/dateRange';

/**
 * L'en-tete de la vue semaine du calendrier : la plage suit l'ordre de la
 * langue (mois avant le jour en anglais US) et ne repete pas le mois commun.
 * Les espaces fines de Intl sont ramenees a des espaces pour comparer.
 */

const day = (iso: string) => new Date(`${iso}T12:00:00`);
const range = (locale: string, a: string, b: string) =>
    formatDayRangeIn(locale, day(a), day(b)).replace(/ /g, ' ');

describe('formatDayRangeIn', () => {
    it('ecrit le mois avant le jour en anglais', () => {
        expect(range('en-US', '2026-11-23', '2026-11-29')).toBe('Nov 23 – 29, 2026');
        expect(range('en-US', '2026-11-30', '2026-12-06')).toBe('Nov 30 – Dec 6, 2026');
    });

    it('ecrit le jour avant le mois en francais et en espagnol', () => {
        expect(range('fr-FR', '2026-11-23', '2026-11-29')).toBe('23–29 nov. 2026');
        expect(range('es-ES', '2026-11-30', '2026-12-06')).toBe('30 nov – 6 dic 2026');
    });

    it('garde les deux annees a cheval sur le nouvel an', () => {
        expect(range('fr-FR', '2026-12-28', '2027-01-03')).toBe('28 déc. 2026 – 3 janv. 2027');
    });
});

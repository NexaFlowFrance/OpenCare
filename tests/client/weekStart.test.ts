import { describe, it, expect } from 'vitest';
import { startOfWeek } from 'date-fns';
import {
    circleWeekStart, weekStartsOn, orderedIsoDays, sortIsoDays, inWeekOrder,
} from '../../client/src/lib/weekStart';

/**
 * Le premier jour de la semaine ne change que l'affichage. Les jours restent en
 * ISO (lundi = 1) : un decalage d'un cran ici, et un traitement du lundi
 * s'afficherait le dimanche.
 */

const MON_FIRST = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

describe('reglage du cercle', () => {
    it('vaut lundi par defaut, et pour toute valeur inconnue', () => {
        expect(circleWeekStart(null)).toBe('monday');
        expect(circleWeekStart({ settings: {} })).toBe('monday');
        expect(circleWeekStart({ settings: { week_start: 'saturday' } })).toBe('monday');
        expect(circleWeekStart({ settings: { week_start: 'sunday' } })).toBe('sunday');
    });
});

describe('ordre d affichage', () => {
    it('commence la grille du calendrier au bon jour', () => {
        // Mercredi 30 septembre 2026
        const wednesday = new Date(2026, 8, 30);
        expect(startOfWeek(wednesday, { weekStartsOn: weekStartsOn('monday') }).getDate()).toBe(28);
        expect(startOfWeek(wednesday, { weekStartsOn: weekStartsOn('sunday') }).getDate()).toBe(27);
    });

    it('tourne les jours ISO sans en perdre ni en dupliquer', () => {
        expect(orderedIsoDays('monday')).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(orderedIsoDays('sunday')).toEqual([7, 1, 2, 3, 4, 5, 6]);
        expect([...orderedIsoDays('sunday')].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('remet une liste traduite dans l ordre, chaque nom sur son jour', () => {
        expect(inWeekOrder(MON_FIRST, 'monday')).toEqual(MON_FIRST);
        expect(inWeekOrder(MON_FIRST, 'sunday')).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
        orderedIsoDays('sunday').forEach((iso, i) => {
            expect(inWeekOrder(MON_FIRST, 'sunday')[i]).toBe(MON_FIRST[iso - 1]);
        });
    });

    it('trie les jours d un traitement dans l ordre de la semaine choisie', () => {
        expect(sortIsoDays([7, 1, 3], 'monday')).toEqual([1, 3, 7]);
        expect(sortIsoDays([1, 3, 7], 'sunday')).toEqual([7, 1, 3]);
        expect(sortIsoDays([], 'sunday')).toEqual([]);
    });
});

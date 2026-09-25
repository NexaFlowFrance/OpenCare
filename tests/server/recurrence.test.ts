import { describe, it, expect } from 'vitest';
import { expandEventOccurrences, parseExceptions, MOVE_MAX_DAYS } from '../../server/src/routes/events';

/**
 * Les recurrences alimentent l'agenda, le tableau de bord, l'ecran patient, le
 * plan de soins, le pack de relais et le flux iCal. Une erreur ici se voit
 * partout, et une occurrence sautee qui reapparait fait prendre un rendez-vous
 * pour rien.
 */

const at = (iso: string) => new Date(iso);
const day = (d: string) => new Date(`${d}T00:00:00`);
const endOfDay = (d: string) => new Date(`${d}T23:59:59`);
const days = (from: string, to: string) => ({ from: day(from), to: endOfDay(to) });

const weekly = (overrides: Record<string, unknown> = {}) => ({
    start_time: '2026-01-05T09:00:00',
    end_time: '2026-01-05T10:00:00',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    ...overrides,
});

describe('expandEventOccurrences', () => {
    it('ne rend qu une occurrence pour un evenement simple, et rien hors fenetre', () => {
        const event = { start_time: '2026-02-03T10:00:00', end_time: null, rrule: null };
        const inside = expandEventOccurrences(event, ...Object.values(days('2026-02-01', '2026-02-28')) as [Date, Date]);
        expect(inside).toHaveLength(1);
        expect(inside[0].isRecurring).toBe(false);
        expect(inside[0].occurrenceDate).toBe('2026-02-03');

        const outside = expandEventOccurrences(event, day('2026-03-01'), endOfDay('2026-03-31'));
        expect(outside).toHaveLength(0);
    });

    it('developpe une regle hebdomadaire sur les bons jours', () => {
        const occ = expandEventOccurrences(weekly(), day('2026-01-01'), endOfDay('2026-01-31'));
        expect(occ.map((o) => o.occurrenceDate)).toEqual(['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);
        expect(occ.every((o) => o.isRecurring)).toBe(true);
        // La duree du parent est reportee sur chaque occurrence.
        expect(occ[1].end!.getTime() - occ[1].start.getTime()).toBe(60 * 60 * 1000);
    });

    it('respecte UNTIL et l intervalle', () => {
        const every2 = expandEventOccurrences(
            weekly({ rrule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=2' }),
            day('2026-01-01'), endOfDay('2026-02-28')
        );
        expect(every2.map((o) => o.occurrenceDate)).toEqual(['2026-01-05', '2026-01-19', '2026-02-02', '2026-02-16']);

        const until = expandEventOccurrences(
            weekly({ rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260120T000000Z' }),
            day('2026-01-01'), endOfDay('2026-03-31')
        );
        expect(until.map((o) => o.occurrenceDate)).toEqual(['2026-01-05', '2026-01-12', '2026-01-19']);

        // La forme courte, celle qu'ecrit l'app, doit donner le meme resultat.
        const untilShort = expandEventOccurrences(
            weekly({ rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260119' }),
            day('2026-01-01'), endOfDay('2026-03-31')
        );
        expect(untilShort.map((o) => o.occurrenceDate)).toEqual(['2026-01-05', '2026-01-12', '2026-01-19']);
    });

    it('garde l heure locale au passage a l heure d ete', () => {
        // Le changement d'heure en France a lieu le 29 mars 2026. Une visite de
        // 9 h reste a 9 h, elle ne glisse pas a 8 h ou 10 h.
        const daily = { start_time: '2026-03-27T09:00:00', end_time: null, rrule: 'FREQ=DAILY' };
        const occ = expandEventOccurrences(daily, day('2026-03-27'), endOfDay('2026-03-31'));
        expect(occ.map((o) => o.start.getHours())).toEqual([9, 9, 9, 9, 9]);
    });
});

describe('exceptions d occurrence', () => {
    it('saute une occurrence sans toucher aux autres', () => {
        const occ = expandEventOccurrences(
            weekly({ exceptions: [{ date: '2026-01-12', action: 'skip' }] }),
            day('2026-01-01'), endOfDay('2026-01-31')
        );
        expect(occ.map((o) => o.occurrenceDate)).toEqual(['2026-01-05', '2026-01-19', '2026-01-26']);
    });

    it('deplace une occurrence en gardant sa date d origine comme identite', () => {
        const occ = expandEventOccurrences(
            weekly({ exceptions: [{ date: '2026-01-19', action: 'move', start_time: '2026-01-21T14:30:00', end_time: null }] }),
            day('2026-01-01'), endOfDay('2026-01-31')
        );
        const moved = occ.find((o) => o.occurrenceDate === '2026-01-19')!;
        expect(moved.moved).toBe(true);
        expect(moved.start).toEqual(at('2026-01-21T14:30:00'));
        // Sans heure de fin donnee, la duree du parent est conservee.
        expect(moved.end).toEqual(at('2026-01-21T15:30:00'));
        // Les occurrences sont rendues dans l'ordre chronologique reel.
        expect(occ.map((o) => o.start.getTime())).toEqual([...occ.map((o) => o.start.getTime())].sort((a, b) => a - b));
    });

    it('sort de la fenetre quand elle est deplacee ailleurs, et y entre depuis dehors', () => {
        const event = weekly({ exceptions: [{ date: '2026-01-19', action: 'move', start_time: '2026-01-21T14:30:00', end_time: null }] });
        expect(expandEventOccurrences(event, day('2026-01-19'), endOfDay('2026-01-19'))).toHaveLength(0);
        const arrived = expandEventOccurrences(event, day('2026-01-21'), endOfDay('2026-01-21'));
        expect(arrived).toHaveLength(1);
        expect(arrived[0].occurrenceDate).toBe('2026-01-19');
    });

    it('applique une exception sur une occurrence deplacee dans la limite autorisee', () => {
        const far = new Date(day('2026-01-19').getTime() + MOVE_MAX_DAYS * 24 * 60 * 60 * 1000);
        const iso = `${far.getFullYear()}-${String(far.getMonth() + 1).padStart(2, '0')}-${String(far.getDate()).padStart(2, '0')}T09:00:00`;
        const occ = expandEventOccurrences(
            weekly({ exceptions: [{ date: '2026-01-19', action: 'move', start_time: iso, end_time: null }] }),
            day('2026-01-01'), endOfDay('2026-01-31')
        );
        expect(occ.find((o) => o.occurrenceDate === '2026-01-19')!.start).toEqual(at(iso));
    });

    it('ignore les exceptions sur un evenement qui ne se repete pas', () => {
        const occ = expandEventOccurrences(
            { start_time: '2026-02-03T10:00:00', end_time: null, rrule: null, exceptions: [{ date: '2026-02-03', action: 'skip' }] },
            day('2026-02-01'), endOfDay('2026-02-28')
        );
        expect(occ).toHaveLength(1);
    });
});

describe('parseExceptions', () => {
    it('ne garde que les entrees bien formees', () => {
        const parsed = parseExceptions([
            { date: '2026-01-12', action: 'skip' },
            { date: 'pas-une-date', action: 'skip' },
            { date: '2026-01-19', action: 'move', start_time: '2026-01-21T14:30:00' },
            { date: '2026-01-26', action: 'move' },
            { date: '2026-02-02', action: 'move', start_time: 'jamais' },
            { date: '2026-02-09', action: 'inventee' },
            null,
            'texte',
        ]);
        expect(parsed.map((e) => e.date)).toEqual(['2026-01-12', '2026-01-19']);
        expect(parsed[1]).toEqual({ date: '2026-01-19', action: 'move', start_time: '2026-01-21T14:30:00', end_time: null });
    });

    it('garde une seule exception par date et tolere n importe quelle entree', () => {
        const parsed = parseExceptions([
            { date: '2026-01-12', action: 'skip' },
            { date: '2026-01-12', action: 'move', start_time: '2026-01-13T09:00:00' },
        ]);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].action).toBe('skip');
        expect(parseExceptions(undefined)).toEqual([]);
        expect(parseExceptions('rien')).toEqual([]);
    });
});

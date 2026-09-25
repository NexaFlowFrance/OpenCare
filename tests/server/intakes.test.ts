import { describe, it, expect } from 'vitest';
import { splitForPatient, toDateString, DUE_NOW_BEFORE_MS, MISSED_AFTER_MS, PatientIntakeRow } from '../../server/src/lib/intakes';

/**
 * Ce que la personne aidee voit sur sa tablette. Une prise montree trop tot
 * pousse a un double dosage, une prise oubliee dans "a prendre maintenant"
 * l'inquiete pour rien : les fenetres se testent.
 */

const NOW = new Date('2026-09-25T12:00:00');
const minutes = (n: number) => n * 60 * 1000;
const hours = (n: number) => n * 60 * 60 * 1000;

const intake = (id: string, offsetMs: number, status: PatientIntakeRow['status'] = 'pending'): PatientIntakeRow => ({
    id,
    due_at: new Date(NOW.getTime() + offsetMs).toISOString(),
    status,
});

describe('splitForPatient', () => {
    it('ne montre que ce qui est du maintenant', () => {
        const view = splitForPatient([
            intake('juste-avant', -minutes(5)),
            intake('dans-la-fenetre', DUE_NOW_BEFORE_MS - minutes(1)),
            intake('trop-tot', DUE_NOW_BEFORE_MS + minutes(5)),
        ], NOW);
        expect(view.due_now.map((i) => i.id)).toEqual(['juste-avant', 'dans-la-fenetre']);
        expect(view.upcoming_count).toBe(1);
    });

    it('bascule en manquee au dela du delai, pas avant', () => {
        const view = splitForPatient([
            intake('en-retard-mais-encore-la', -(MISSED_AFTER_MS - minutes(1))),
            intake('manquee', -(MISSED_AFTER_MS + minutes(1))),
        ], NOW);
        expect(view.due_now.map((i) => i.id)).toEqual(['en-retard-mais-encore-la']);
        expect(view.missed.map((i) => i.id)).toEqual(['manquee']);
    });

    it('classe les prises confirmees et compte celles qui sont prises', () => {
        const view = splitForPatient([
            intake('prise', -hours(3), 'taken'),
            intake('sautee', -hours(2), 'skipped'),
            intake('marquee-manquee', -minutes(10), 'missed'),
        ], NOW);
        expect(view.done.map((i) => i.id)).toEqual(['prise', 'sautee']);
        expect(view.taken_count).toBe(1);
        expect(view.missed.map((i) => i.id)).toEqual(['marquee-manquee']);
        expect(view.total).toBe(3);
    });

    it('annonce la prochaine prise, la plus proche et pas une autre', () => {
        const view = splitForPatient([
            intake('ce-soir', hours(8)),
            intake('cet-apres-midi', hours(3)),
        ], NOW);
        expect(view.due_now).toHaveLength(0);
        expect(view.upcoming_count).toBe(2);
        expect(view.next_due_at).toBe(new Date(NOW.getTime() + hours(3)).toISOString());
    });

    it('rend une journee vide sans rien inventer', () => {
        const view = splitForPatient([], NOW);
        expect(view).toMatchObject({ due_now: [], done: [], missed: [], upcoming_count: 0, next_due_at: null, taken_count: 0, total: 0 });
    });
});

describe('toDateString', () => {
    it('ecrit la date locale, sans decalage de fuseau', () => {
        // toISOString() donnerait le 25 au lieu du 26 pour une heure du matin
        // en heure d'ete francaise : c'est exactement le piege a eviter.
        expect(toDateString(new Date(2026, 8, 26, 1, 30))).toBe('2026-09-26');
        expect(toDateString(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    });
});

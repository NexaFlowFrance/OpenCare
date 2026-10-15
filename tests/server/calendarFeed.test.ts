import { describe, it, expect } from 'vitest';
import { buildICS } from '../../server/src/routes/calendar';

/**
 * Le flux iCal emet des heures flottantes (sans Z ni TZID) : Google Agenda les
 * lit dans le fuseau de X-WR-TIMEZONE. Ce fuseau doit donc etre celui du
 * serveur, sinon un rendez-vous a 11h s'affiche decale.
 */

const event = {
    id: 'evt-1',
    circle_id: 'circle-1',
    title: 'Kine',
    description: null,
    location: null,
    start_time: '2026-10-15T11:00:00',
    end_time: '2026-10-15T12:00:00',
    rrule: null,
};
const from = new Date('2026-10-01T00:00:00');
const to = new Date('2026-10-31T23:59:59');

describe('buildICS', () => {
    it('declare le fuseau du serveur par defaut', () => {
        const ics = buildICS([event], new Map(), from, to);
        expect(ics).toContain('X-WR-TIMEZONE:Europe/Paris\r\n');
    });

    it('declare le fuseau demande, avec les heures murales inchangees', () => {
        const ics = buildICS([event], new Map(), from, to, 'America/New_York');
        expect(ics).toContain('X-WR-TIMEZONE:America/New_York\r\n');
        expect(ics).not.toContain('Europe/Paris');
        expect(ics).toContain('DTSTART:20261015T110000\r\n');
    });
});

import { describe, it, expect } from 'vitest';
import { clockDate, formatClockIn, shiftEndTime } from '../../client/src/lib/clock';

/**
 * Times are stored naive ("2026-10-15T17:30:00") or bare ("08:00"). They must
 * show on the reader's own clock: 12-hour in English (US), 24-hour in French
 * and Spanish, and never move by the time zone offset.
 */

// Intl may use a narrow no-break space before AM/PM: compare on plain spaces.
const plain = (s: string) => s.replace(/\s/g, ' ');

describe('formatClockIn', () => {
    it('uses a 12-hour clock in English', () => {
        expect(plain(formatClockIn('en-US', '2026-10-15T17:30:00'))).toBe('5:30 PM');
        expect(plain(formatClockIn('en-US', '2026-10-15T09:05'))).toBe('9:05 AM');
        expect(plain(formatClockIn('en-US', '08:00'))).toBe('8:00 AM');
    });

    it('keeps the 24-hour clock in French and Spanish', () => {
        expect(formatClockIn('fr-FR', '2026-10-15T17:30:00')).toBe('17:30');
        expect(formatClockIn('fr-FR', '2026-10-15 09:05:00')).toBe('09:05');
        expect(formatClockIn('es-ES', '08:00')).toBe('08:00');
    });

    it('reads naive values as local time, without a zone shift', () => {
        const d = clockDate('2026-10-15T23:45:00');
        expect(d?.getHours()).toBe(23);
        expect(d?.getDate()).toBe(15);
    });

    it('returns an empty string for missing or unreadable values', () => {
        expect(formatClockIn('en-US', null)).toBe('');
        expect(formatClockIn('en-US', '')).toBe('');
        expect(formatClockIn('en-US', 'not a date')).toBe('');
    });
});

describe('shiftEndTime', () => {
    it('keeps the event length when the start moves', () => {
        expect(shiftEndTime('09:00', '14:00', '10:00')).toBe('15:00');
        expect(shiftEndTime('09:00', '08:15', '09:30')).toBe('08:45');
    });

    it('falls back to one hour when the end was not after the start', () => {
        expect(shiftEndTime('11:00', '14:00', '10:00')).toBe('15:00');
        expect(shiftEndTime('', '14:00', '10:00')).toBe('15:00');
    });

    it('leaves an empty end empty', () => {
        expect(shiftEndTime('09:00', '14:00', '')).toBe('');
    });

    it('stops at 23:59 rather than passing midnight', () => {
        expect(shiftEndTime('09:00', '23:30', '10:00')).toBe('23:59');
    });
});

// Wall-clock times ("17:30", "5:30 PM") in the reader's locale.
//
// The app stores naive local timestamps ("YYYY-MM-DDTHH:mm:ss") and bare
// schedule times ("08:00"). Slicing them gives a 24-hour clock in every
// language, which reads wrong in English (US). Going through Intl keeps the
// locale's own hour cycle, and building the Date from the parts keeps the time
// exactly as stored (no time zone shift).

const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const BARE_TIME = /^(\d{2}):(\d{2})(?::\d{2})?$/;

/** The Date a stored value stands for, read as local time; null when unreadable. */
export function clockDate(value: Date | string | null | undefined): Date | null {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const naive = NAIVE_DATETIME.exec(value);
    if (naive) {
        const [, y, mo, d, h, mi, s] = naive;
        return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
    }
    const bare = BARE_TIME.exec(value);
    if (bare) return new Date(2000, 0, 1, Number(bare[1]), Number(bare[2]));
    // Anything carrying a zone (recurring occurrences come as UTC ISO).
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Whether a locale writes the time on a 12-hour clock (en-US: yes, fr-FR: no). */
function usesTwelveHour(locale: string): boolean {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12 === true;
}

/**
 * "17:30" / "09:05" on a 24-hour clock, "5:30 PM" / "9:05 AM" on a 12-hour one.
 * The 24-hour form keeps its leading zero, as the slices it replaces did.
 */
export function formatClockIn(locale: string, value: Date | string | null | undefined): string {
    const date = clockDate(value);
    if (!date) return '';
    return new Intl.DateTimeFormat(locale, {
        hour: usesTwelveHour(locale) ? 'numeric' : '2-digit',
        minute: '2-digit',
    }).format(date);
}

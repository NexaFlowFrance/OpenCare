/**
 * PostgreSQL session time zone, aligned on the Node process.
 *
 * Timestamps are naive local TIMESTAMP columns. Two things write them:
 *   - node-pg serializes a Date parameter in the Node process's local zone
 *     (driven by TZ), and a TIMESTAMP column keeps that wall time as is;
 *   - PostgreSQL fills CURRENT_TIMESTAMP / now() defaults, and converts any
 *     timestamptz expression such as COALESCE($1, CURRENT_TIMESTAMP), using
 *     the session TimeZone, which defaults to the server setting chosen at
 *     initdb (UTC in the official Docker image).
 * When the two zones differ, "now" lands hours away from local time and
 * rows written by the two paths disagree. Setting the session TimeZone to the
 * Node zone on every connection keeps them in step, without asking anyone to
 * reconfigure their database.
 */

// IANA names ("America/New_York", "Etc/GMT+5", "UTC"). Anything else is
// refused: the value ends up in a libpq startup option.
const SAFE_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+\-/]*$/;

/** The zone Node itself uses for local dates (resolves TZ, falls back to the OS). */
export function nodeTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * The `options` startup parameter for pg.Pool, or undefined when the zone
 * cannot be passed safely (the session then keeps the server default).
 */
export function pgTimeZoneOptions(timeZone: string = nodeTimeZone()): string | undefined {
    if (!SAFE_TIME_ZONE.test(timeZone)) return undefined;
    return `-c TimeZone=${timeZone}`;
}

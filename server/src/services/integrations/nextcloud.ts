import { query } from '../../db';
import { decryptCredentials } from '../../utils/crypto';
import { safeFetch } from '../../utils/safeFetch';

interface CalDAVEvent {
    uid: string;
    title: string;
    startTime: string;
    endTime: string | null;
    description: string | null;
    location: string | null;
}

// ICS line folding: long property values are split across lines with CRLF + SPACE.
// Must unfold before parsing any property.
function unfoldICS(data: string): string {
    return data.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

// CalDAV embeds ICS inside XML, so standard XML entities get escaped.
function unescapeXML(s: string): string {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function parseICSDate(raw: string): string {
    // Handle TZID=...:YYYYMMDDTHHMMSS or plain YYYYMMDDTHHMMSSZ
    const clean = raw.includes(':') ? raw.split(':').slice(1).join(':') : raw;
    if (clean.includes('T')) {
        const y = clean.slice(0, 4), mo = clean.slice(4, 6), d = clean.slice(6, 8);
        const h = clean.slice(9, 11), mi = clean.slice(11, 13), s = clean.slice(13, 15);
        return `${y}-${mo}-${d}T${h}:${mi}:${s}${clean.endsWith('Z') ? 'Z' : ''}`;
    }
    return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T00:00:00`;
}

function parseICS(rawData: string): CalDAVEvent[] {
    const data = unfoldICS(unescapeXML(rawData));
    const events: CalDAVEvent[] = [];
    const blocks = data.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];

    for (const block of blocks) {
        const get = (key: string): string | null => {
            const m = block.match(new RegExp(`^${key}[^:\\r\\n]*:([^\\r\\n]+)`, 'm'));
            return m ? m[1].trim().replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';') : null;
        };

        const uid = get('UID');
        const summary = get('SUMMARY');
        const dtstart = get('DTSTART');
        if (!uid || !summary || !dtstart) continue;

        events.push({
            uid,
            title: summary,
            startTime: parseICSDate(dtstart),
            endTime: (() => { const v = get('DTEND'); return v ? parseICSDate(v) : null; })(),
            description: get('DESCRIPTION'),
            location: get('LOCATION'),
        });
    }
    return events;
}

async function discoverCalendars(baseUrl: string, username: string, authHeader: string): Promise<string[]> {
    const root = `${baseUrl}/remote.php/dav/calendars/${encodeURIComponent(username)}/`;
    try {
        const resp = await safeFetch(root, {
            method: 'PROPFIND',
            headers: { 'Authorization': authHeader, 'Depth': '1', 'Content-Type': 'application/xml' },
            body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>`,
        });
        if (!resp.ok) return [];
        const xml = await resp.text();
        const hrefs: string[] = [];
        // Each calendar collection response block contains a <cal:calendar/> resourcetype
        const blocks = xml.match(/<[Dd]:response[\s\S]*?<\/[Dd]:response>/g) || [];
        for (const block of blocks) {
            if (!block.includes(':calendar') && !block.includes('caldav:calendar')) continue;
            const m = block.match(/<[Dd]:href>([^<]+)<\/[Dd]:href>/);
            if (m && m[1] !== root && m[1] !== `${root}`) hrefs.push(m[1]);
        }
        return hrefs;
    } catch {
        return [];
    }
}

export async function testNextcloudConnection(baseUrl: string, username: string, password: string): Promise<{ success: boolean; message: string }> {
    try {
        const statusResp = await safeFetch(`${baseUrl}/status.php`);
        if (!statusResp.ok) return { success: false, message: `Serveur inaccessible (HTTP ${statusResp.status})` };
        const status = await statusResp.json() as { versionstring?: string; version?: string };

        const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
        const davResp = await safeFetch(`${baseUrl}/remote.php/dav/calendars/${encodeURIComponent(username)}/`, {
            method: 'PROPFIND',
            headers: { 'Authorization': authHeader, 'Depth': '0', 'Content-Type': 'application/xml' },
        });

        if (davResp.status === 401) return { success: false, message: 'Identifiants incorrects. Si la double authentification est activée, utilisez un App Password.' };
        if (davResp.status === 404) return { success: false, message: `Utilisateur "${username}" introuvable sur ce serveur.` };
        if (!davResp.ok) return { success: false, message: `Erreur DAV ${davResp.status}` };

        const hrefs = await discoverCalendars(baseUrl, username, authHeader);
        const vstr = status.versionstring || status.version || '';
        return {
            success: true,
            message: `Connecté a Nextcloud ${vstr} : ${hrefs.length} calendrier${hrefs.length > 1 ? 's' : ''} trouvé${hrefs.length > 1 ? 's' : ''}`.trim(),
        };
    } catch (e) {
        return { success: false, message: e instanceof Error ? e.message : 'Impossible de joindre le serveur' };
    }
}

export async function syncNextcloud(
    _integrationId: string,
    circleId: string,
    baseUrl: string,
    encryptedCredentials: string,
    config: Record<string, unknown>
): Promise<{ imported: number; errors: number }> {
    const creds = decryptCredentials(encryptedCredentials);
    const { username, password } = creds;
    if (!username || !password) throw new Error('Identifiants manquants');

    const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const discovered = await discoverCalendars(baseUrl, username, authHeader);
    const calendarHrefs = discovered.length > 0
        ? discovered
        : [`/remote.php/dav/calendars/${encodeURIComponent(username)}/${(config.calendar_name as string) || 'personal'}/`];

    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const now = new Date();
    const startStr = fmt(now);
    const endStr = fmt(new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()));

    const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${startStr}" end="${endStr}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

    let imported = 0;
    let errors = 0;

    // The base_url host is the only host we will talk to. An absolute <href> in
    // the PROPFIND response that points elsewhere is rejected (SSRF: a malicious
    // or compromised server could otherwise redirect the credentialed REPORT to
    // an internal target). Relative hrefs are resolved against base_url.
    let baseHost: string;
    try {
        baseHost = new URL(baseUrl).host.toLowerCase();
    } catch {
        return { imported, errors };
    }

    for (const href of calendarHrefs) {
        const calUrl = href.startsWith('http') ? href : `${baseUrl}${href}`;
        try {
            // Re-validate the (possibly absolute) href host against base_url.
            const parsed = new URL(calUrl);
            if (parsed.host.toLowerCase() !== baseHost) {
                errors++;
                continue;
            }

            // safeFetch re-resolves and pins the IP for this REPORT too.
            const resp = await safeFetch(calUrl, {
                method: 'REPORT',
                headers: { 'Authorization': authHeader, 'Depth': '1', 'Content-Type': 'application/xml' },
                body: reportBody,
            });
            if (!resp.ok && resp.status !== 207) continue;

            const xml = await resp.text();
            const icsBlocks = xml.match(/BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/g) || [];

            for (const ics of icsBlocks) {
                for (const ev of parseICS(ics)) {
                    try {
                        // Imported items land in the circle's events table.
                        // Primary deduplication by caldav_uid (reliable across renames),
                        // backed by the unique index idx_events_caldav_uid (circle_id, caldav_uid).
                        const existing = await query(
                            'SELECT id FROM events WHERE circle_id = $1 AND caldav_uid = $2',
                            [circleId, ev.uid]
                        );
                        if (existing.rows.length > 0) continue;

                        await query(
                            `INSERT INTO events (circle_id, title, description, category, start_time, end_time, location, caldav_uid)
                             VALUES ($1, $2, $3, 'other', $4, $5, $6, $7)
                             ON CONFLICT (circle_id, caldav_uid) WHERE caldav_uid IS NOT NULL DO NOTHING`,
                            [circleId, ev.title, ev.description, ev.startTime, ev.endTime, ev.location, ev.uid]
                        );
                        imported++;
                    } catch {
                        errors++;
                    }
                }
            }
        } catch {
            errors++;
        }
    }

    return { imported, errors };
}

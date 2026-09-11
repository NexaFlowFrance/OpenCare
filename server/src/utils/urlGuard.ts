import { isIP } from 'node:net';
import dns from 'node:dns/promises';

/**
 * SSRF guard for user-supplied integration URLs (Home Assistant, Grocy, Nextcloud…).
 *
 * OpenCare is self-hosted: private LAN targets (Home Assistant on 192.168.x.x,
 * a NAS on 10.x…) are LEGITIMATE, so RFC1918 addresses are allowed by default.
 * What is ALWAYS blocked:
 *   - non-http(s) schemes
 *   - cloud metadata endpoints (AWS/Azure/GCP link-local 169.254.169.254,
 *     AWS IPv6 fd00:ec2::254, GCP metadata.google.internal, Alibaba 100.100.100.200)
 *     : checked on the literal host AND on the DNS-resolved addresses, so a
 *     domain pointing at the metadata service is rejected too.
 *   - the whole link-local range (IPv4 169.254.0.0/16 and IPv6 fe80::/10), which
 *     carries the cloud metadata service.
 *   - the unspecified/this-host range 0.0.0.0/8.
 *
 * For hardened deployments, set INTEGRATIONS_BLOCK_PRIVATE_IPS=true to also block
 * loopback, RFC1918, link-local and unique-local targets.
 *
 * This module exposes the IP helpers (isBlockedAddress, canonicalizeIp) and a
 * single resolution+validation routine (resolveAndValidateHost) so that
 * safeFetch can reuse exactly the same blocking logic and PIN the validated IPs
 * onto the outgoing connection (anti DNS-rebinding) instead of duplicating it.
 */

const METADATA_HOSTNAMES = new Set([
    'metadata.google.internal',
    'metadata.goog',
]);

// Always-blocked literal addresses (cloud metadata services)
const METADATA_IPV4 = new Set(['169.254.169.254', '100.100.100.200']);
const METADATA_IPV6 = new Set(['fd00:ec2::254']);

/**
 * Fully canonicalize an IPv6 literal so that alternative writings of the SAME
 * address (compressed "::", leading-zero groups, uppercase, IPv4-mapped forms,
 * a "0x...."/decimal metadata trick written as IPv6, a zone index "%eth0") all
 * collapse to one comparable string. Without this an attacker could smuggle the
 * metadata address past the Set/prefix checks with e.g. "fd00:0EC2::0254".
 *
 * We expand every group to 4 hex digits and re-emit the 8 groups joined by ':'.
 * IPv4-mapped/embedded tails ("::ffff:169.254.169.254") keep their dotted tail
 * untouched so the v4 logic can inspect it. Returns the lowercased input
 * unchanged when it is not parseable as IPv6 (callers only feed it real IPs).
 */
export const canonicalizeIpv6 = (ip: string): string => {
    const lower = ip.toLowerCase().split('%')[0];
    if (isIP(lower) !== 6) return lower;

    // Split off an embedded IPv4 tail ("...:a.b.c.d") and keep it verbatim.
    const v4Match = lower.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    const v4Tail = v4Match ? v4Match[1] : null;
    const head = v4Tail ? lower.slice(0, lower.length - v4Tail.length - 1) : lower;

    // Expand the "::" shorthand into the right number of zero groups.
    // An embedded v4 tail occupies 2 of the 8 groups, so the head holds 6 then.
    const groupsTotal = v4Tail ? 6 : 8;
    let groups: string[];
    if (head.includes('::')) {
        const [left, right] = head.split('::');
        const leftParts = left.length ? left.split(':') : [];
        const rightParts = right.length ? right.split(':') : [];
        const missing = groupsTotal - leftParts.length - rightParts.length;
        groups = [...leftParts, ...Array(Math.max(missing, 0)).fill('0'), ...rightParts];
    } else {
        groups = head.split(':');
    }

    const padded = groups.map((g) => (g === '' ? '0' : g).padStart(4, '0'));
    if (v4Tail) {
        return `${padded.join(':')}:${v4Tail}`;
    }

    // IPv4-mapped written in pure hex ("::ffff:a9fe:a9fe" == ::ffff:169.254.169.254):
    // fold the last two groups back into a dotted tail so the v4 block logic can
    // inspect it (otherwise the hex form would slip past the dotted-only checks).
    if (
        padded[0] === '0000' && padded[1] === '0000' && padded[2] === '0000' &&
        padded[3] === '0000' && padded[4] === '0000' && padded[5] === 'ffff'
    ) {
        const g6 = parseInt(padded[6], 16);
        const g7 = parseInt(padded[7], 16);
        const dotted = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
        return `0000:0000:0000:0000:0000:ffff:${dotted}`;
    }

    return padded.join(':');
};

/**
 * Canonicalize any IP (v4 or v6). v4 stays as-is; v6 goes through full
 * expansion. Non-IP input is returned lowercased unchanged.
 */
export const canonicalizeIp = (ip: string): string => {
    const family = isIP(ip);
    if (family === 6) return canonicalizeIpv6(ip);
    return ip.toLowerCase();
};

const ipv4ToInt = (ip: string): number => {
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
};

const inCidr4 = (ip: string, base: string, maskBits: number): boolean => {
    const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
    return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
};

const isPrivateIpv4 = (ip: string): boolean =>
    inCidr4(ip, '127.0.0.0', 8) ||
    inCidr4(ip, '10.0.0.0', 8) ||
    inCidr4(ip, '172.16.0.0', 12) ||
    inCidr4(ip, '192.168.0.0', 16) ||
    inCidr4(ip, '169.254.0.0', 16) ||
    inCidr4(ip, '0.0.0.0', 8);

const isPrivateIpv6 = (ip: string): boolean => {
    const n = canonicalizeIpv6(ip);
    if (n === '0000:0000:0000:0000:0000:0000:0000:0001') return true; // ::1
    if (n === '0000:0000:0000:0000:0000:0000:0000:0000') return true; // ::
    // fe80::/10 link-local and fc00::/7 unique-local (fc.. / fd..).
    if (n.startsWith('fe8') || n.startsWith('fe9') || n.startsWith('fea') || n.startsWith('feb')) return true;
    if (n.startsWith('fc') || n.startsWith('fd')) return true;
    // IPv4-mapped addresses (::ffff:192.168.0.1)
    const mapped = n.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped && n.startsWith('0000:0000:0000:0000:0000:ffff:')) return isPrivateIpv4(mapped[1]);
    return false;
};

/**
 * Returns a human-readable reason string when `address` (a literal IP) must
 * NOT be reached, or null when it is allowed. `blockPrivate` toggles the
 * RFC1918/loopback/unique-local family; the metadata + link-local +
 * unspecified families are ALWAYS blocked regardless of `blockPrivate`.
 */
export const isBlockedAddress = (address: string, blockPrivate: boolean): string | null => {
    const family = isIP(address);
    if (family === 4) {
        if (METADATA_IPV4.has(address)) return 'cloud metadata address';
        // The AWS/GCP metadata service lives in 169.254.0.0/16 : always block link-local v4.
        if (inCidr4(address, '169.254.0.0', 16)) return 'link-local (metadata) address';
        // 0.0.0.0/8 ("this host") can loop back to the local machine : always block.
        if (inCidr4(address, '0.0.0.0', 8)) return 'unspecified address';
        if (blockPrivate && isPrivateIpv4(address)) return 'private address';
    } else if (family === 6) {
        const n = canonicalizeIpv6(address);
        if (METADATA_IPV6.has(n) || METADATA_IPV6.has(address.toLowerCase())) return 'cloud metadata address';
        // Compare the canonical form against the canonical metadata forms too.
        for (const m of METADATA_IPV6) {
            if (canonicalizeIpv6(m) === n) return 'cloud metadata address';
        }
        const mapped = n.match(/(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped && n.startsWith('0000:0000:0000:0000:0000:ffff:')) {
            return isBlockedAddress(mapped[1], blockPrivate);
        }
        // fe80::/10 link-local always blocked.
        if (n.startsWith('fe8') || n.startsWith('fe9') || n.startsWith('fea') || n.startsWith('feb')) {
            return 'link-local (metadata) address';
        }
        if (blockPrivate && isPrivateIpv6(n)) return 'private address';
    }
    return null;
};

export class UnsafeUrlError extends Error {}

export interface SafeUrlOptions {
    /**
     * Force-block loopback/RFC1918/link-local/unique-local targets regardless of
     * INTEGRATIONS_BLOCK_PRIVATE_IPS. Use this for routes that fetch the PUBLIC
     * internet, where a private target is never legitimate.
     * When omitted, the env flag keeps deciding (integrations on a LAN).
     */
    blockPrivate?: boolean;
}

/** Resolve `options.blockPrivate`, falling back to the env flag. */
export const resolveBlockPrivate = (options: SafeUrlOptions = {}): boolean =>
    options.blockPrivate ?? (process.env.INTEGRATIONS_BLOCK_PRIVATE_IPS === 'true');

/**
 * Resolve a hostname (or accept a literal IP) and validate EVERY returned
 * address against the block list. Returns the list of validated IP strings
 * (canonicalized) on success, or throws UnsafeUrlError.
 *
 * FAIL CLOSED: unlike the historical assertSafeIntegrationUrl (which let a
 * failed DNS lookup proceed so the fetch could surface a clearer error), this
 * routine THROWS when resolution fails, because its result is used to PIN the
 * connection IPs in safeFetch: there is nothing safe to pin if we could not
 * resolve. assertSafeIntegrationUrl keeps its lenient behaviour for backward
 * compatibility (see below).
 *
 * `hostname` must already be lowercased and bracket-stripped for IPv6.
 */
export async function resolveAndValidateHost(hostname: string, blockPrivate: boolean): Promise<string[]> {
    if (METADATA_HOSTNAMES.has(hostname)) {
        throw new UnsafeUrlError('Cette adresse est bloquée (service de métadonnées cloud)');
    }

    if (isIP(hostname)) {
        const reason = isBlockedAddress(hostname, blockPrivate);
        if (reason) throw new UnsafeUrlError(`Cette adresse est bloquée (${reason})`);
        return [canonicalizeIp(hostname)];
    }

    if (blockPrivate && hostname === 'localhost') {
        throw new UnsafeUrlError('Cette adresse est bloquée (private address)');
    }

    let addresses: { address: string }[];
    try {
        addresses = await dns.lookup(hostname, { all: true });
    } catch {
        // Fail closed: we cannot safely pin a connection we could not resolve.
        throw new UnsafeUrlError('Résolution DNS impossible pour cet hôte');
    }

    if (addresses.length === 0) {
        throw new UnsafeUrlError('Aucune adresse IP pour cet hôte');
    }

    const validated: string[] = [];
    for (const { address } of addresses) {
        const reason = isBlockedAddress(address, blockPrivate);
        if (reason) {
            throw new UnsafeUrlError(`Cette adresse est bloquée (${reason})`);
        }
        validated.push(canonicalizeIp(address));
    }
    return validated;
}

/**
 * Validates a user-supplied integration base URL. Throws UnsafeUrlError when the
 * URL must not be fetched. Call this both when an integration is saved AND right
 * before every test/sync request (the DNS answer can change between the two).
 *
 * NOTE on DNS failures: historically a failed lookup was treated as "let the
 * fetch fail with a clearer network error" rather than UnsafeUrlError, and
 * several callers (save/test flows) rely on that lenience for unreachable but
 * otherwise-legitimate hosts. To preserve that public contract this function
 * SWALLOWS a DNS-resolution failure. safeFetch, which actually opens the
 * connection, uses resolveAndValidateHost directly and fails closed instead.
 */
export async function assertSafeIntegrationUrl(baseUrl: string, options: SafeUrlOptions = {}): Promise<void> {
    let url: URL;
    try {
        url = new URL(baseUrl);
    } catch {
        throw new UnsafeUrlError('URL invalide');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new UnsafeUrlError('Seuls les protocoles http et https sont autorisés');
    }

    const blockPrivate = resolveBlockPrivate(options);
    // URL.hostname keeps brackets around IPv6 literals : strip them.
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

    try {
        await resolveAndValidateHost(hostname, blockPrivate);
    } catch (e) {
        // Keep the legacy lenience: a pure resolution failure is not a guard
        // rejection here (the subsequent fetch will surface a network error),
        // but a real block reason still propagates.
        if (e instanceof UnsafeUrlError && /Résolution DNS impossible|Aucune adresse IP/.test(e.message)) {
            return;
        }
        throw e;
    }
}

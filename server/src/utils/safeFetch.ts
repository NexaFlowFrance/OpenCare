import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import type { LookupAddress } from 'node:dns';
import {
    UnsafeUrlError,
    resolveAndValidateHost,
    resolveBlockPrivate,
    isBlockedAddress,
    canonicalizeIp,
    type SafeUrlOptions,
} from './urlGuard';

/**
 * SSRF-hardened fetch for user-supplied integration URLs.
 *
 * What it does, in order:
 *  1. Parses the URL and rejects any scheme other than http/https.
 *  2. Resolves the hostname ONCE (dns.lookup all) and validates EVERY returned
 *     IP via the shared urlGuard logic. Fails closed if resolution fails.
 *  3. PINS the validated IPs onto the connection (anti DNS-rebinding): the
 *     socket is forced to connect to one of the already-validated IPs and can
 *     never reach a different address that a second, attacker-timed DNS answer
 *     could return between validation and connection. The original hostname is
 *     kept for the Host header and the TLS SNI/servername, so HTTPS certificate
 *     validation is NOT weakened.
 *  4. Refuses to auto-follow redirects (redirect: 'manual'). See REDIRECT POLICY.
 *  5. Enforces an AbortController timeout (default 30s).
 *
 * IP PINNING IMPLEMENTATION
 * -------------------------
 * The preferred mechanism is an undici Agent with a custom `connect.lookup`
 * that returns ONLY the validated IPs (undici keeps the original hostname for
 * SNI). undici is the engine behind Node's global fetch. It is loaded lazily;
 * if it cannot be loaded in this runtime we fall back to a safe degraded mode
 * (see buildPinnedDispatcher): for http we rewrite the URL host to the pinned
 * IP (no SNI involved); for https we keep the validated hostname WITHOUT socket
 * pinning rather than break certificate validation. Both modes still rely on
 * the up-front resolve+validate, so a static malicious target is always
 * rejected; only the rebinding window is wider in the degraded https path.
 *
 * REDIRECT POLICY
 * ---------------
 * We use redirect: 'manual'. Following a 3xx blindly is the classic SSRF
 * bypass (validated host A redirects to metadata/host B). Our policy:
 *   - A redirect to a DIFFERENT host than the validated origin is REFUSED with
 *     SSRF_REDIRECT_BLOCKED. This is the simplest safe choice and is fine for
 *     the integration endpoints we call (none legitimately cross-host redirect).
 *   - At most ONE same-host redirect is allowed; the Location is re-validated
 *     through this same function and re-fetched. Sensitive headers
 *     (authorization, x-api-key, cookie) are NOT re-emitted on the redirected
 *     request, even same-host, to avoid leaking credentials to a moved path
 *     that an attacker could have planted.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const SENSITIVE_HEADERS = ['authorization', 'x-api-key', 'cookie', 'proxy-authorization'];

export interface SafeFetchOptions extends SafeUrlOptions {
    /** Abort the request after this many ms. Default 30000. */
    timeoutMs?: number;
}

/**
 * The undici Agent type comes from undici-types (always available via
 * @types/node). The undici *value* module is loaded dynamically because it is
 * not a declared dependency here. We type the loaded class loosely and only
 * rely on the documented `connect.lookup` connector option.
 */
type UndiciAgentCtor = new (opts: {
    connect?: { lookup?: LookupFunction } & Record<string, unknown>;
    [k: string]: unknown;
}) => unknown;

let undiciLoad: Promise<{ Agent: UndiciAgentCtor } | null> | null = null;

/**
 * Lazily import undici. The specifier is held in a variable so the TypeScript
 * compiler / bundler does not try to statically resolve the value module
 * (only undici-types is installed for typings). Returns null if undici is not
 * available at runtime, so callers can fall back to degraded pinning.
 */
async function loadUndici(): Promise<{ Agent: UndiciAgentCtor } | null> {
    if (undiciLoad) return undiciLoad;
    undiciLoad = (async () => {
        try {
            // Build the specifier at runtime so neither tsc nor a bundler tries to
            // statically resolve the value module (only undici-types is on disk).
            const spec: string = ['un', 'dici'].join('');
            const mod = (await import(spec)) as { Agent?: UndiciAgentCtor };
            return typeof mod.Agent === 'function' ? { Agent: mod.Agent } : null;
        } catch {
            return null;
        }
    })();
    return undiciLoad;
}

/**
 * Build a custom dns.lookup that ALWAYS returns the pre-validated IPs and never
 * performs a fresh DNS query. Passed to undici's connector so the socket can
 * only target an address we already cleared. Handles both the `all:true` and
 * single-result callback shapes that the connector may use.
 */
function pinnedLookup(validatedIps: string[]): LookupFunction {
    const entries: LookupAddress[] = validatedIps.map((address) => ({
        address,
        family: isIP(address) === 6 ? 6 : 4,
    }));

    // The runtime signature is lookup(hostname, options, callback), but a caller
    // may also use the (hostname, callback) shorthand. We ignore the requested
    // hostname entirely and answer with the pinned IPs. Typed loosely then cast
    // to LookupFunction because we must tolerate both call shapes.
    const fn = (
        _hostname: string,
        optionsOrCallback: unknown,
        maybeCallback?: unknown
    ): void => {
        const cb = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
        ) as ((err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) | undefined;
        const opts = (typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback) as
            | { all?: boolean }
            | undefined;
        if (!cb) return;
        if (opts && opts.all) {
            cb(null, entries);
        } else {
            const first = entries[0];
            cb(null, first.address, first.family);
        }
    };
    return fn as unknown as LookupFunction;
}

/**
 * Build the dispatcher that pins the connection to `validatedIps`, or null when
 * undici is unavailable (degraded mode is handled by the caller).
 */
async function buildPinnedDispatcher(validatedIps: string[]): Promise<unknown | null> {
    const undici = await loadUndici();
    if (!undici) return null;
    return new undici.Agent({
        connect: {
            lookup: pinnedLookup(validatedIps),
        },
    });
}

/** Strip credential-bearing headers from a Headers/record before a redirect re-fetch. */
function stripSensitiveHeaders(init: RequestInit): RequestInit {
    const headers = new Headers(init.headers);
    for (const name of SENSITIVE_HEADERS) headers.delete(name);
    return { ...init, headers };
}

interface InternalState {
    redirectsLeft: number;
    blockPrivate: boolean;
    timeoutMs: number;
}

async function doSafeFetch(rawUrl: string, options: RequestInit, state: InternalState): Promise<Response> {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new UnsafeUrlError('URL invalide');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new UnsafeUrlError('Seuls les protocoles http et https sont autorisés');
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const validatedIps = await resolveAndValidateHost(hostname, state.blockPrivate);

    const dispatcher = await buildPinnedDispatcher(validatedIps);

    // Degraded http pinning when undici is unavailable: rewrite to the pinned IP
    // (no SNI to preserve). https keeps the validated hostname (cert validation
    // intact) but without socket-level pinning.
    let target = url;
    if (!dispatcher && url.protocol === 'http:') {
        const pinned = validatedIps[0];
        const rebuilt = new URL(url.toString());
        // The URL hostname setter takes the bare IPv6 address; it re-adds the
        // brackets in .host/.href on its own.
        rebuilt.hostname = pinned;
        target = rebuilt;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), state.timeoutMs);

    // When we rewrote http to the IP, keep the Host header pointing at the
    // original hostname so virtual-hosted servers still route correctly.
    const headers = new Headers(options.headers);
    if (target !== url && !headers.has('host')) {
        headers.set('host', url.host);
    }

    // The Node 20 global RequestInit (undici-typed, no DOM lib) carries an
    // optional `dispatcher`. We cast our dynamically-loaded Agent into that slot.
    const init: RequestInit = {
        ...options,
        headers,
        redirect: 'manual',
        signal: controller.signal,
    };
    if (dispatcher) init.dispatcher = dispatcher as RequestInit['dispatcher'];

    let response: Response;
    try {
        response = await fetch(target.toString(), init);
    } finally {
        clearTimeout(timer);
    }

    // REDIRECT POLICY (see file header).
    if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return response; // 3xx without Location: hand it back as-is.

        let redirectUrl: URL;
        try {
            redirectUrl = new URL(location, url);
        } catch {
            throw new UnsafeUrlError('SSRF_REDIRECT_BLOCKED: Location de redirection invalide');
        }

        const sameHost =
            redirectUrl.protocol === url.protocol &&
            redirectUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase() === hostname &&
            (redirectUrl.port || '') === (url.port || '');

        if (!sameHost) {
            throw new UnsafeUrlError(
                'SSRF_REDIRECT_BLOCKED: redirection vers un hôte différent refusée'
            );
        }
        if (state.redirectsLeft <= 0) {
            throw new UnsafeUrlError('SSRF_REDIRECT_BLOCKED: trop de redirections');
        }

        // Same-host redirect: re-validate + re-fetch WITHOUT sensitive headers.
        return doSafeFetch(redirectUrl.toString(), stripSensitiveHeaders(options), {
            ...state,
            redirectsLeft: state.redirectsLeft - 1,
        });
    }

    return response;
}

/**
 * SSRF-hardened fetch. Validates and pins the target IP, refuses cross-host
 * redirects, and enforces a timeout. Throws UnsafeUrlError on any guard
 * rejection (invalid scheme, blocked address, DNS failure, blocked redirect).
 *
 * @param rawUrl   the URL to fetch (user-supplied integration target).
 * @param options  standard fetch RequestInit (redirect/signal are overridden).
 * @param guard    { blockPrivate?, timeoutMs? } : blockPrivate falls back to the
 *                 INTEGRATIONS_BLOCK_PRIVATE_IPS env flag when omitted.
 */
export async function safeFetch(
    rawUrl: string,
    options: RequestInit = {},
    guard: SafeFetchOptions = {}
): Promise<Response> {
    const blockPrivate = resolveBlockPrivate(guard);
    const timeoutMs = guard.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return doSafeFetch(rawUrl, options, { redirectsLeft: 1, blockPrivate, timeoutMs });
}

/**
 * Validate (and pin-resolve) a WebSocket URL using the SAME blocking logic as
 * HTTP. ws:// is checked as http:// and wss:// as https:// for scheme rules.
 * Returns the validated IPs (for callers that want to pin) or throws
 * UnsafeUrlError. The caller must only send credentials AFTER this resolves.
 *
 * Note: `ws` (the WebSocket client used for Home Assistant) does not expose a
 * custom-lookup hook the way undici does, so this performs the resolve+validate
 * gate; full socket pinning for ws would require a custom agent. The validation
 * still rejects every blocked/metadata target before the token is sent.
 */
export async function assertSafeWebSocketUrl(
    wsUrl: string,
    guard: SafeUrlOptions = {}
): Promise<string[]> {
    let parsed: URL;
    try {
        parsed = new URL(wsUrl);
    } catch {
        throw new UnsafeUrlError('URL WebSocket invalide');
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        throw new UnsafeUrlError('Seuls les protocoles ws et wss sont autorisés');
    }
    const blockPrivate = resolveBlockPrivate(guard);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return resolveAndValidateHost(hostname, blockPrivate);
}

// Re-export the guard helpers commonly used alongside safeFetch.
export { UnsafeUrlError, isBlockedAddress, canonicalizeIp };

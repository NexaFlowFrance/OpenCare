/**
 * File d'attente d'écritures hors ligne (offline-first, voir docs/SPEC.md).
 *
 * Quand une écriture (POST/PUT/DELETE) échoue pour cause RÉSEAU (fetch qui
 * jette un TypeError, ou navigator.onLine false), api.ts l'empile ici. La file
 * est persistée dans localStorage et rejouée dans l'ordre au retour du réseau.
 *
 * Règles de rejouage:
 * - erreur réseau: l'élément reste en tête de file, on réessaiera plus tard;
 * - 4xx: erreur métier définitive, l'élément est jeté (avec un log console);
 * - 5xx: jusqu'à 3 tentatives, puis l'élément est jeté.
 *
 * Les erreurs HTTP au moment de l'écriture initiale ne passent JAMAIS par
 * cette file: elles remontent normalement aux pages (toasts).
 */
import i18n from '../i18n';

const STORAGE_KEY = 'opencare:write-queue';
const MAX_QUEUE_LENGTH = 200;
const MAX_SERVER_ERROR_ATTEMPTS = 3;
/** Les photos (data URLs) au-delà de 2 Mo ne tiennent pas dans localStorage. */
const MAX_DATA_URL_LENGTH = 2 * 1024 * 1024;

const IS_DEMO = Boolean(import.meta.env.VITE_DEMO);

// Même résolution d'URL d'API que lib/api.ts (dupliquée volontairement: un
// import depuis api.ts créerait un cycle, api.ts important déjà ce module).
const rawApiUrl = import.meta.env.VITE_API_URL as string | undefined;
const API_URL = rawApiUrl !== undefined
    ? rawApiUrl
    : (import.meta.env.PROD ? '' : 'http://localhost:3001');

export type QueuedMethod = 'POST' | 'PUT' | 'DELETE';

export interface QueuedWriteInput {
    method: QueuedMethod;
    endpoint: string;
    body?: unknown;
    circleId: string | null;
    queuedAt: number;
}

interface QueuedWrite extends QueuedWriteInput {
    /** Nombre de rejouages soldés par un 5xx (3 max, puis abandon). */
    attempts: number;
}

type QueueListener = (size: number) => void;

// ─── État ────────────────────────────────────────────────────────────────────

const listeners = new Set<QueueListener>();
let queue: QueuedWrite[] = load();
let replaying = false;

function load(): QueuedWrite[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (item): item is QueuedWrite =>
                typeof item === 'object' && item !== null &&
                typeof (item as QueuedWrite).endpoint === 'string' &&
                typeof (item as QueuedWrite).method === 'string'
        );
    } catch {
        return [];
    }
}

function persist(): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    } catch (error) {
        // Quota localStorage dépassé: on garde la file en mémoire pour la
        // session, mais elle ne survivra pas à un rechargement.
        console.warn('[offlineQueue] persist failed (localStorage quota?):', error);
    }
}

function notify(): void {
    const size = queue.length;
    listeners.forEach((listener) => listener(size));
}

// ─── API publique ────────────────────────────────────────────────────────────

export function getQueueSize(): number {
    return queue.length;
}

/**
 * Notifie chaque changement de taille de file. Le listener est appelé
 * immédiatement avec la taille courante. Retourne la fonction de désabonnement.
 */
export function subscribe(listener: QueueListener): () => void {
    listeners.add(listener);
    listener(queue.length);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * Empile une écriture échouée pour cause réseau. Jette une erreur explicite
 * (affichée en toast par les pages) si l'élément est refusé: endpoint d'auth,
 * file pleine, ou photo (data URL) trop volumineuse pour localStorage.
 */
export function enqueue(input: QueuedWriteInput): void {
    if (input.endpoint.startsWith('/api/auth')) {
        throw new Error(i18n.t('nav:offlineQueue.errors.authNotQueueable'));
    }

    if (queue.length >= MAX_QUEUE_LENGTH) {
        throw new Error(i18n.t('nav:offlineQueue.errors.queueFull'));
    }

    if (input.body !== undefined) {
        const serialized = JSON.stringify(input.body);
        const dataUrls = serialized.match(/data:[^"\\]+/g);
        if (dataUrls && dataUrls.some((url) => url.length > MAX_DATA_URL_LENGTH)) {
            throw new Error(i18n.t('nav:offlineQueue.errors.photoTooLarge'));
        }
    }

    queue.push({ ...input, attempts: 0 });
    persist();
    notify();
}

/**
 * Rejoue les écritures en attente, dans l'ordre. S'arrête à la première
 * erreur réseau (l'élément reste en file). Déclenchée par l'événement
 * 'online', à l'initialisation si en ligne, et opportunément par api.ts
 * après une requête réussie (serveur de retour sans passage offline/online).
 */
export async function replay(): Promise<void> {
    if (replaying || IS_DEMO || queue.length === 0) return;
    if (!navigator.onLine) return;

    replaying = true;
    try {
        while (queue.length > 0) {
            const item = queue[0];

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
            };
            const token = localStorage.getItem('token');
            if (token) headers['Authorization'] = `Bearer ${token}`;
            if (item.circleId) headers['X-Circle-Id'] = item.circleId;

            let response: Response;
            try {
                response = await fetch(`${API_URL}${item.endpoint}`, {
                    method: item.method,
                    headers,
                    body: item.body !== undefined ? JSON.stringify(item.body) : undefined,
                });
            } catch {
                // Toujours pas de réseau: on garde tout, on retentera plus tard.
                break;
            }

            if (response.ok) {
                queue.shift();
                persist();
                notify();
                continue;
            }

            if (response.status >= 400 && response.status < 500) {
                console.warn(
                    `[offlineQueue] dropping queued ${item.method} ${item.endpoint}: HTTP ${response.status}`
                );
                queue.shift();
                persist();
                notify();
                continue;
            }

            // 5xx: max 3 tentatives, puis abandon.
            item.attempts += 1;
            if (item.attempts >= MAX_SERVER_ERROR_ATTEMPTS) {
                console.warn(
                    `[offlineQueue] dropping queued ${item.method} ${item.endpoint} after ${item.attempts} server errors (HTTP ${response.status})`
                );
                queue.shift();
                notify();
            }
            persist();
            // On laisse le serveur respirer: la suite au prochain déclencheur.
            break;
        }
    } finally {
        replaying = false;
    }
}

// ─── Déclencheurs ────────────────────────────────────────────────────────────

if (typeof window !== 'undefined' && !IS_DEMO) {
    window.addEventListener('online', () => {
        void replay();
    });

    // Au démarrage de l'application, si on est en ligne avec des écritures en
    // attente (fermeture de l'app hors ligne), on rejoue après un court délai
    // pour laisser l'authentification se mettre en place.
    if (navigator.onLine && queue.length > 0) {
        window.setTimeout(() => {
            void replay();
        }, 3_000);
    }
}

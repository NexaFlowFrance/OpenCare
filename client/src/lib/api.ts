// VITE_API_URL non défini en dev -> http://localhost:3001.
// En build de production (installeur Windows, Docker...), on utilise la MÊME
// ORIGINE par défaut (chaîne vide) afin que l'accès fonctionne depuis un mobile
// via http://<ip-du-pc>:3000. On ne se repose pas sur une variable vide passée
// au build : PowerShell supprime les variables d'environnement vides, ce qui
// faisait basculer le client sur localhost:3001 (d'où les « Failed to fetch »).
import { mockRequest } from '../demo/mockApi';
import { enqueue, getQueueSize, replay, type QueuedMethod } from './offlineQueue';

const IS_DEMO = Boolean(import.meta.env.VITE_DEMO);

const rawApiUrl = import.meta.env.VITE_API_URL as string | undefined;
const API_URL = rawApiUrl !== undefined
    ? rawApiUrl
    : (import.meta.env.PROD ? '' : 'http://localhost:3001');
const AUTH_EXPIRED_EVENT = 'opencare:auth-expired';
const CIRCLE_STORAGE_KEY = 'opencare:circle-id';

/**
 * Enveloppe standard des réponses du serveur. `queued: true` signale une
 * réponse OPTIMISTE: l'écriture a échoué pour cause réseau et a été mise en
 * file d'attente (lib/offlineQueue.ts), elle partira au retour du réseau.
 */
export interface ApiResponse<T = unknown> {
    success: boolean;
    data: T | null;
    error?: string;
    message?: string;
    queued?: boolean;
}

// Écritures scope cercle rejouables hors ligne. Liste blanche volontairement
// restreinte: pas d'auth, pas d'invitations, pas de liens magiques, pas de
// réglages de cercle (trop sensibles pour une écriture différée).
const QUEUEABLE_PREFIXES = [
    '/api/journal',
    '/api/vitals',
    '/api/medications/intakes',
    '/api/tasks',
    '/api/shopping',
    '/api/notes',
    '/api/contacts',
    '/api/expenses',
    '/api/messages',
];

const isQueueableWrite = (method: string, endpoint: string): boolean => {
    if (method !== 'POST' && method !== 'PUT' && method !== 'DELETE') return false;
    return QUEUEABLE_PREFIXES.some(
        (prefix) =>
            endpoint === prefix ||
            endpoint.startsWith(`${prefix}/`) ||
            endpoint.startsWith(`${prefix}?`)
    );
};

const isNetworkError = (error: unknown): boolean =>
    error instanceof TypeError || !navigator.onLine;

class ApiClient {
    private baseURL: string;
    private token: string | null = null;
    private circleId: string | null = null;

    constructor(baseURL: string) {
        this.baseURL = baseURL;
        this.token = localStorage.getItem('token');
        this.circleId = localStorage.getItem(CIRCLE_STORAGE_KEY);
    }

    setToken(token: string | null) {
        this.token = token;
        if (token) {
            localStorage.setItem('token', token);
        } else {
            localStorage.removeItem('token');
        }
    }

    getToken(): string | null {
        return this.token;
    }

    /** Cercle actif: envoyé en en-tête X-Circle-Id sur chaque appel scope cercle. */
    setCircleId(circleId: string | null) {
        this.circleId = circleId;
        if (circleId) {
            localStorage.setItem(CIRCLE_STORAGE_KEY, circleId);
        } else {
            localStorage.removeItem(CIRCLE_STORAGE_KEY);
        }
    }

    getCircleId(): string | null {
        return this.circleId;
    }

    private async request<T>(
        endpoint: string,
        options: RequestInit = {}
    ): Promise<T> {
        // Static GitHub Pages demo: serve everything from the in-browser mock.
        if (IS_DEMO) {
            const method = (options.method as string) || 'GET';
            const body = options.body ? JSON.parse(options.body as string) : undefined;
            return mockRequest<T>(method, endpoint, body);
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        if (this.circleId) {
            headers['X-Circle-Id'] = this.circleId;
        }

        const method = ((options.method as string) || 'GET').toUpperCase();

        let response: Response;
        try {
            response = await fetch(`${this.baseURL}${endpoint}`, {
                ...options,
                headers: {
                    ...headers,
                    ...(options.headers as Record<string, string>),
                },
            });
        } catch (error) {
            // Échec RÉSEAU uniquement (fetch jette un TypeError, ou onLine
            // false): les erreurs HTTP 4xx/5xx ne passent jamais ici. Les
            // écritures scope cercle en liste blanche sont mises en file
            // d'attente et une réponse optimiste est renvoyée; les pages
            // existantes traitent déjà success: true.
            if (isQueueableWrite(method, endpoint) && isNetworkError(error)) {
                let body: unknown;
                if (typeof options.body === 'string') {
                    try {
                        body = JSON.parse(options.body);
                    } catch {
                        // Corps non JSON: pas rejouable, on remonte l'erreur réseau.
                        throw error;
                    }
                }
                // enqueue() peut refuser (photo trop lourde, file pleine):
                // son erreur explicite remonte alors aux pages (toast).
                enqueue({
                    method: method as QueuedMethod,
                    endpoint,
                    body,
                    circleId: this.circleId,
                    queuedAt: Date.now(),
                });
                return { success: true, data: null, queued: true } as T;
            }
            throw error;
        }

        // Le serveur répond à nouveau: on en profite pour rejouer la file
        // (couvre le cas serveur revenu sans transition offline/online).
        if (getQueueSize() > 0) {
            void replay();
        }

        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json') ? await response.json() : null;

        if (!response.ok) {
            if (response.status === 401 && this.token) {
                this.setToken(null);
                localStorage.removeItem('user');
                window.dispatchEvent(
                    new CustomEvent(AUTH_EXPIRED_EVENT, {
                        detail: data?.error || data?.message || 'Unauthorized',
                    })
                );
            }

            const fallbackMessage = `HTTP ${response.status}`;
            throw new Error(data?.error || data?.message || fallbackMessage);
        }

        return data as T;
    }

    async get<T>(endpoint: string): Promise<T> {
        return this.request<T>(endpoint, { method: 'GET' });
    }

    /**
     * Fetches binary content (images…) with the auth header.
     * Not supported by the static demo mock : throws so callers fall back.
     */
    async getBlob(endpoint: string): Promise<Blob> {
        if (IS_DEMO) throw new Error('Binary endpoints are not available in demo mode');

        const headers: Record<string, string> = {};
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
        if (this.circleId) headers['X-Circle-Id'] = this.circleId;

        const response = await fetch(`${this.baseURL}${endpoint}`, { headers });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
    }

    async post<T>(endpoint: string, body: any): Promise<T> {
        return this.request<T>(endpoint, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    }

    async put<T>(endpoint: string, body: any): Promise<T> {
        return this.request<T>(endpoint, {
            method: 'PUT',
            body: JSON.stringify(body),
        });
    }

    async delete<T>(endpoint: string): Promise<T> {
        return this.request<T>(endpoint, { method: 'DELETE' });
    }

    // Authentication methods
    async login(email: string, password: string) {
        const response = await this.post<any>(
            '/api/auth/login',
            { email, password }
        );

        if (response.success && response.data) {
            this.setToken(response.data.token);
            return { success: true, ...response.data };
        }
        return response;
    }

    async register(email: string, password: string, name: string, inviteToken?: string) {
        const body: Record<string, string> = { email, password, name };
        if (inviteToken) body.inviteToken = inviteToken;

        const response = await this.post<any>(
            '/api/auth/register',
            body
        );

        if (response.success && response.data) {
            this.setToken(response.data.token);
            return { success: true, ...response.data };
        }
        return response;
    }

    /** Un compte existant accepte une invitation et rejoint un cercle. */
    async acceptInvite(inviteToken: string) {
        return this.post<any>(`/api/invites/accept/${inviteToken}`, {});
    }

    async refreshToken() {
        const response = await this.post<any>('/api/auth/refresh', {});
        if (response.success && response.data) {
            this.setToken(response.data.token);
            return { success: true, ...response.data };
        }
        return response;
    }

    logout() {
        this.setToken(null);
        this.setCircleId(null);
    }
}

export const api = new ApiClient(API_URL);
export const API_BASE_URL = API_URL;

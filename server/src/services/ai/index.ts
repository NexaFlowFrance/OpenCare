// Local-first AI assistant: provider abstraction.
//
// A single entry point, aiComplete(), takes a system prompt, a user prompt and
// a JSON schema, dispatches to the configured provider (Ollama / OpenAI-compatible /
// Anthropic) and returns a PARSED JSON object. The model output is never trusted:
// callers must still structurally validate the result.

import { query } from '../../db';
import { decryptCredentials } from '../../utils/crypto';
import { ollamaComplete } from './ollama';
import { openaiComplete } from './openai';
import { anthropicComplete } from './anthropic';

export type AiProvider = 'ollama' | 'openai' | 'anthropic';

export interface AiSettings {
    provider: AiProvider;
    /** Base URL (ollama / openai-compatible only, ignored for anthropic). */
    base_url: string | null;
    /** Decrypted API key (openai / anthropic, never needed for ollama). */
    api_key: string | null;
    model: string;
}

/** Raw ai_settings row for the circle (key still encrypted). */
export interface AiSettingsRow {
    provider: AiProvider;
    base_url: string | null;
    encrypted_api_key: string | null;
    model: string;
    enabled: boolean;
}

/** Load the ai_settings row of a care circle (one row per circle). */
export async function loadAiSettingsRow(circleId: string): Promise<AiSettingsRow | null> {
    const result = await query(
        'SELECT provider, base_url, encrypted_api_key, model, enabled FROM ai_settings WHERE circle_id = $1',
        [circleId]
    );
    return (result.rows[0] as AiSettingsRow) ?? null;
}

/** Decrypt a stored API key (AES-256-GCM via utils/crypto). Returns null on failure. */
export function decryptStoredApiKey(encrypted: string | null): string | null {
    if (!encrypted) return null;
    try {
        return decryptCredentials(encrypted).api_key ?? null;
    } catch {
        return null;
    }
}

/**
 * Resolve the usable AI settings of a circle: returns null when the circle has
 * no configured or enabled AI. The API key is decrypted server-side only.
 */
export async function getAiSettings(circleId: string): Promise<AiSettings | null> {
    const row = await loadAiSettingsRow(circleId);
    if (!row || !row.model || !row.enabled) return null;
    return {
        provider: row.provider,
        base_url: row.base_url,
        api_key: decryptStoredApiKey(row.encrypted_api_key),
        model: row.model,
    };
}

export interface AiCompletionRequest {
    system: string;
    user: string;
    /** JSON schema of the expected response object (additionalProperties:false everywhere). */
    jsonSchema: Record<string, unknown>;
}

export type AiErrorCode =
    | 'AI_UNREACHABLE'
    | 'AI_UNAUTHORIZED'
    | 'AI_MODEL_NOT_FOUND'
    | 'AI_INVALID_RESPONSE'
    | 'AI_PROVIDER_ERROR';

export class AiError extends Error {
    constructor(public code: AiErrorCode, message: string) {
        super(message);
        this.name = 'AiError';
    }
}

/** All providers share the same hard timeout. */
export const AI_TIMEOUT_MS = 60_000;

export const DEFAULT_BASE_URLS: Record<AiProvider, string | null> = {
    ollama: 'http://localhost:11434',
    openai: 'https://api.openai.com',
    anthropic: null,
};

/**
 * fetch() with the shared 60s AbortController timeout. Network-level failures
 * are mapped to AI_UNREACHABLE with a readable message.
 */
export async function aiFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new AiError('AI_UNREACHABLE', `Le fournisseur IA n'a pas répondu en ${AI_TIMEOUT_MS / 1000}s`);
        }
        throw new AiError('AI_UNREACHABLE', error instanceof Error ? error.message : 'Fournisseur IA injoignable');
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Defensive JSON extraction: strips markdown code fences, then parses the
 * substring between the first '{' and the last '}'. Models occasionally wrap
 * their JSON in prose even when asked not to.
 */
export function extractJson(text: string): Record<string, unknown> {
    const withoutFences = text.replace(/```(?:json)?/gi, '');
    const start = withoutFences.indexOf('{');
    const end = withoutFences.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
        throw new AiError('AI_INVALID_RESPONSE', 'La réponse du modèle ne contient pas de JSON');
    }
    try {
        const parsed = JSON.parse(withoutFences.slice(start, end + 1));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('not an object');
        }
        return parsed as Record<string, unknown>;
    } catch {
        throw new AiError('AI_INVALID_RESPONSE', 'La réponse du modèle est un JSON invalide');
    }
}

/** Single entry point: run a JSON completion through the configured provider. */
export async function aiComplete(
    settings: AiSettings,
    request: AiCompletionRequest
): Promise<Record<string, unknown>> {
    switch (settings.provider) {
        case 'ollama':
            return ollamaComplete(settings, request);
        case 'openai':
            return openaiComplete(settings, request);
        case 'anthropic':
            return anthropicComplete(settings, request);
        default:
            throw new AiError('AI_PROVIDER_ERROR', `Fournisseur IA inconnu: ${settings.provider}`);
    }
}

// Ollama provider: fully local, no API key, the privacy-first default.
// POST {base_url}/api/chat with `format` set to the JSON schema (Ollama accepts a
// JSON schema object in `format`; we fall back to the plain 'json' mode if the
// schema is rejected by an older Ollama version).

import { UnsafeUrlError } from '../../utils/urlGuard';
import { safeFetch } from '../../utils/safeFetch';
import {
    AiError,
    AI_TIMEOUT_MS,
    extractJson,
    DEFAULT_BASE_URLS,
    type AiSettings,
    type AiCompletionRequest,
} from './index';

/**
 * safeFetch wrapper that preserves the AI providers' error-mapping contract:
 * network-level failures (incl. abort/timeout) become AiError(AI_UNREACHABLE),
 * and a guard rejection (blocked/metadata address, bad scheme) is mapped too.
 * LAN/private targets stay allowed (local Ollama is the whole point); metadata
 * and link-local endpoints are always blocked by safeFetch.
 */
async function aiSafeFetch(url: string, init: RequestInit): Promise<Response> {
    try {
        return await safeFetch(url, init, { timeoutMs: AI_TIMEOUT_MS });
    } catch (error) {
        if (error instanceof UnsafeUrlError) {
            throw new AiError('AI_UNREACHABLE', error.message);
        }
        if (error instanceof Error && error.name === 'AbortError') {
            throw new AiError('AI_UNREACHABLE', `Le fournisseur IA n'a pas répondu en ${AI_TIMEOUT_MS / 1000}s`);
        }
        throw new AiError('AI_UNREACHABLE', error instanceof Error ? error.message : 'Fournisseur IA injoignable');
    }
}

export async function ollamaComplete(
    settings: AiSettings,
    request: AiCompletionRequest
): Promise<Record<string, unknown>> {
    const baseUrl = (settings.base_url || DEFAULT_BASE_URLS.ollama!).replace(/\/+$/, '');

    // safeFetch validates the URL (scheme + resolved IPs) and PINS the connection
    // to the validated address right before each request, so a separate
    // assertSafeIntegrationUrl pre-check is no longer needed here.
    const doRequest = (format: unknown) =>
        aiSafeFetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: settings.model,
                messages: [
                    { role: 'system', content: request.system },
                    { role: 'user', content: request.user },
                ],
                stream: false,
                format,
            }),
        });

    let response = await doRequest(request.jsonSchema);
    if (response.status === 400) {
        // Older Ollama versions only accept format: 'json', retry once.
        response = await doRequest('json');
    }

    if (!response.ok) {
        const detail = await safeErrorText(response);
        if (response.status === 404) {
            throw new AiError('AI_MODEL_NOT_FOUND', detail || `Modèle introuvable: ${settings.model}`);
        }
        throw new AiError('AI_PROVIDER_ERROR', detail || `Ollama a répondu HTTP ${response.status}`);
    }

    const data = (await response.json().catch(() => null)) as { message?: { content?: string } } | null;
    const content = data?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new AiError('AI_INVALID_RESPONSE', 'Réponse Ollama vide');
    }
    return extractJson(content);
}

async function safeErrorText(response: Response): Promise<string> {
    try {
        const body = (await response.json()) as { error?: string };
        return typeof body?.error === 'string' ? body.error : '';
    } catch {
        return '';
    }
}

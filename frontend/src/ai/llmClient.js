// Browser LLM client: one chat turn in, one parsed JSON object out.
//
// Every prompt in the generator goes through chatJson(), so retries, JSON
// repair, timeouts, cancellation and token accounting are handled in exactly
// one place. Mirrors supabase/scripts/lib/ollama.cjs's contract
// (`chatJson({ system, user, temperature }) -> object`) so the ported pipeline
// works unchanged.

import { getProvider } from './providers.js';
import {
  buildLlmRequest,
  parseLlmResponse,
  buildModelsRequest,
  parseModelsResponse,
  describeUpstreamError,
} from './transport.js';

const PROXY_PATH = '/api/llm';
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 3;

export class LlmError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

// Strip ``` fences and grab the outermost {...} when the model wrapped its JSON
// in prose. Always throws a "did not return valid JSON" message (never a raw
// SyntaxError) so the retry classifier can recognise the failure.
export function extractJsonObject(raw) {
  let text = String(raw ?? '').trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fall through to the friendly error */
      }
    }
    throw new LlmError(
      `Model did not return valid JSON. Raw: ${text.slice(0, 300)}`,
      { retryable: true },
    );
  }
}

// AbortSignal.any is Chrome 116 / Safari 17.4; this app also runs as an
// installed PWA on older phones, where a missing helper would break every run.
function anySignal(signals) {
  const present = signals.filter(Boolean);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(present);

  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

// One HTTP round trip — straight to the provider, or through the relay.
async function callOnce(config, { system, user, temperature, maxTokens }, signal) {
  const { transport, baseUrl, model, apiKey, useProxy } = config;

  if (useProxy) {
    const response = await fetch(PROXY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transport, baseUrl, model, apiKey, system, user, temperature, maxTokens }),
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new LlmError(payload.error || `Relay error HTTP ${response.status}`, {
        status: response.status,
        retryable: isRetryableStatus(response.status),
      });
    }
    return payload; // { text, usage }
  }

  const request = buildLlmRequest({ transport, baseUrl, model, apiKey, system, user, temperature, maxTokens });
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new LlmError(describeUpstreamError(response.status, body), {
      status: response.status,
      retryable: isRetryableStatus(response.status),
    });
  }
  return parseLlmResponse(transport, await response.json());
}

// A client bound to one provider/model/key.
//
//   settings  { providerId, model, apiKey, baseUrl?, useProxy? }
//   onUsage   optional (usage) => void, called after every successful turn
//             ({ input_tokens, output_tokens, calls: 1 }).
export function createLlmClient(settings, { onUsage, signal: clientSignal } = {}) {
  const provider = getProvider(settings.providerId);
  const config = {
    transport: provider.transport,
    baseUrl: settings.baseUrl?.trim() || provider.baseUrl,
    model: settings.model?.trim() || provider.defaultModel,
    apiKey: String(settings.apiKey ?? '').trim(),
    // A provider that cannot be called from a page is always relayed; the rest
    // honour the user's "route through the relay" preference.
    useProxy: provider.direct ? Boolean(settings.useProxy) : true,
  };

  if (!config.apiKey) {
    throw new LlmError(`${provider.label} needs an API key.`);
  }

  async function chatJson({ system, user, temperature = 0.2, maxTokens, signal } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      // Per-attempt timeout, plus the caller's and the client's cancel signals.
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
      const composite = anySignal([timeoutController.signal, signal, clientSignal]);
      try {
        const { text, usage } = await callOnce(config, { system, user, temperature, maxTokens }, composite);
        onUsage?.({
          input_tokens: usage?.input_tokens ?? 0,
          output_tokens: usage?.output_tokens ?? 0,
          calls: 1,
        });
        return extractJsonObject(text);
      } catch (error) {
        // A cancel from the caller must never be retried or reclassified.
        if ((signal?.aborted || clientSignal?.aborted) && error?.name === 'AbortError') {
          throw error;
        }
        const timedOut = error?.name === 'AbortError';
        lastError = timedOut
          ? new LlmError(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`, { retryable: true })
          : error;
        const retryable = timedOut || lastError.retryable || /Failed to fetch|NetworkError|did not return valid JSON/i.test(lastError.message ?? '');
        if (attempt < MAX_ATTEMPTS && retryable) {
          await sleep(1000 * attempt, composite);
          continue;
        }
        break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof LlmError
      ? lastError
      : new LlmError(String(lastError?.message ?? 'LLM request failed'));
  }

  return {
    chatJson,
    // What the UI shows in the run header and stores on the job record.
    describe: () => ({
      providerId: provider.id,
      providerLabel: provider.label,
      model: config.model,
      routedThroughProxy: config.useProxy,
    }),
  };
}

// The provider's live model catalogue, for the builder's "Load models" button.
// Same routing rule as chat: relayed when the provider refuses browser calls.
export async function listProviderModels(settings) {
  const provider = getProvider(settings.providerId);
  const baseUrl = settings.baseUrl?.trim() || provider.baseUrl;
  const apiKey = String(settings.apiKey ?? '').trim();
  if (!apiKey) throw new LlmError(`${provider.label} needs an API key.`);
  const useProxy = provider.direct ? Boolean(settings.useProxy) : true;

  if (useProxy) {
    const response = await fetch(PROXY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'models', transport: provider.transport, baseUrl, apiKey }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new LlmError(payload.error || `Relay error HTTP ${response.status}`);
    return payload.models ?? [];
  }

  const request = buildModelsRequest({ transport: provider.transport, baseUrl, apiKey });
  const response = await fetch(request.url, { headers: request.headers });
  if (!response.ok) {
    throw new LlmError(describeUpstreamError(response.status, await response.text().catch(() => '')));
  }
  return parseModelsResponse(provider.transport, await response.json());
}

// One cheap round trip used by the "Test connection" button: proves the key,
// the model name and the network path all work before a long run starts.
export async function testLlmConnection(settings) {
  const client = createLlmClient(settings);
  const started = Date.now();
  const response = await client.chatJson({
    system: 'You reply with JSON only.',
    user: JSON.stringify({
      task: 'Connection check.',
      required_output: { ok: true, provider: 'string' },
      rules: ['Set ok to true.', 'Set provider to your model family name.', 'Return JSON only.'],
    }),
    temperature: 0,
    maxTokens: 512,
  });
  return {
    ok: response?.ok === true || Object.keys(response ?? {}).length > 0,
    latencyMs: Date.now() - started,
    ...client.describe(),
  };
}

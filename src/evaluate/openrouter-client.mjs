/**
 * Bounded OpenRouter transport.
 *
 * OpenRouter endpoints are fixed code constants. Requests use the shared
 * DNS-pinned HTTP broker, responses have byte/cardinality limits, and only the
 * fields required by evaluators cross this boundary.
 */

import { fetchJson } from '../../providers/_http.mjs';

export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

const MAX_MODEL_ID_CHARS = 256;
const MAX_MODELS = 10_000;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_CONTENT_BYTES = 512 * 1024;
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._:+-]{0,255}$/iu;

function boundedString(value, field, maxChars) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (value.length > maxChars) throw new Error(`${field} exceeds ${maxChars} characters`);
  return value;
}

function requestHeaders(apiKey) {
  boundedString(apiKey, 'OPENROUTER_API_KEY', 4_096);
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'http-referer': 'https://github.com/Furls-Digital/frontrunner',
    'x-title': 'Frontrunner',
  };
}

function normalizeSystemMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.role !== 'system') {
    throw new Error('OpenRouter system message must have role system');
  }
  const content = value.content;
  if (typeof content === 'string') {
    return { role: 'system', content };
  }
  if (
    Array.isArray(content)
    && content.length === 1
    && content[0]?.type === 'text'
    && typeof content[0].text === 'string'
  ) {
    return {
      role: 'system',
      content: [{
        type: 'text',
        text: content[0].text,
        cache_control: { type: 'ephemeral' },
      }],
    };
  }
  throw new Error('OpenRouter system message content is invalid');
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function runTransport(transport, url, options, timeoutMs) {
  try {
    return await transport(url, options);
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      throw new Error(`Timeout after ${timeoutMs}ms`);
    }
    throw error;
  }
}

export async function fetchOpenRouterModels({
  apiKey,
  transport = fetchJson,
  timeoutMs = 15_000,
} = {}) {
  const response = await runTransport(transport, OPENROUTER_MODELS_URL, {
    headers: requestHeaders(apiKey),
    redirect: 'error',
    timeoutMs,
    maxResponseBytes: MAX_API_RESPONSE_BYTES,
  }, timeoutMs);
  if (!response || typeof response !== 'object' || !Array.isArray(response.data)) {
    throw new Error('OpenRouter model response must contain a data array');
  }
  if (response.data.length > MAX_MODELS) {
    throw new Error(`OpenRouter model response exceeds ${MAX_MODELS} records`);
  }
  return response.data.flatMap((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || id.length > MAX_MODEL_ID_CHARS || !MODEL_ID_RE.test(id)) return [];
    const pricing = record.pricing;
    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return [];
    if (String(pricing.prompt) !== '0' || String(pricing.completion) !== '0') return [];
    return [id];
  });
}

export async function requestOpenRouterCompletion({
  apiKey,
  model,
  systemMessage,
  userMessage,
  maxTokens = 8192,
  timeoutMs = 15_000,
  transport = fetchJson,
} = {}) {
  const modelId = boundedString(model, 'OpenRouter model', MAX_MODEL_ID_CHARS);
  if (!MODEL_ID_RE.test(modelId)) throw new Error('OpenRouter model id is invalid');
  const user = boundedString(userMessage, 'OpenRouter user message', MAX_PROMPT_BYTES);
  const system = normalizeSystemMessage(systemMessage);
  const systemBytes = Buffer.byteLength(JSON.stringify(system), 'utf8');
  const userBytes = Buffer.byteLength(user, 'utf8');
  if (systemBytes + userBytes > MAX_PROMPT_BYTES) {
    throw new Error(`OpenRouter prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 32_768) {
    throw new Error('OpenRouter maxTokens must be an integer from 1 to 32768');
  }

  const response = await runTransport(transport, OPENROUTER_API_URL, {
    method: 'POST',
    headers: requestHeaders(apiKey),
    redirect: 'error',
    timeoutMs,
    maxResponseBytes: MAX_API_RESPONSE_BYTES,
    body: JSON.stringify({
      model: modelId,
      messages: [
        system,
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
    }),
  }, timeoutMs);
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('OpenRouter completion response must be an object');
  }
  if (response.error) {
    const message = typeof response.error?.message === 'string'
      ? response.error.message.replace(/[\u0000-\u001f\u007f]+/gu, ' ').slice(0, 500)
      : 'unknown API error';
    throw new Error(`OpenRouter API error: ${message}`);
  }
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenRouter completion response is empty');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_RESPONSE_CONTENT_BYTES) {
    throw new Error(`OpenRouter model content exceeds ${MAX_RESPONSE_CONTENT_BYTES} bytes`);
  }
  const rawUsage = response.usage && typeof response.usage === 'object' && !Array.isArray(response.usage)
    ? response.usage
    : {};
  const usage = {
    prompt_tokens: tokenCount(rawUsage.prompt_tokens),
    completion_tokens: tokenCount(rawUsage.completion_tokens),
    total_tokens: tokenCount(rawUsage.total_tokens),
    cached_tokens: tokenCount(
      rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.cached_tokens,
    ),
  };
  return { content, usage };
}

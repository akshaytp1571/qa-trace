import { REQUEST_LIMITS, requestSettings } from './request-settings.mjs';

const MAX_OUTPUT_TOKENS = REQUEST_LIMITS.native.maxOutputTokens;
const MAX_API_KEY_LENGTH = 512;
const MAX_MODEL_LENGTH = 128;

// Defaults verified in the providers' model and structured-output docs, 2026-11-19:
// https://developers.openai.com/api/docs/models/gpt-5.4-mini
// https://platform.claude.com/docs/en/models/haiku-5-5/overview
export const PROVIDERS = Object.freeze([
  Object.freeze({ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.4-mini' }),
  Object.freeze({ id: 'anthropic', label: 'Anthropic', defaultModel: 'claude-haiku-5-5' }),
  Object.freeze({ id: 'gateway', label: 'OpenAI-compatible gateway', defaultModel: '' }),
]);

export class ProviderError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function gatewayEndpoint(baseUrl) {
  let url;
  try {
    if (typeof baseUrl !== 'string' || baseUrl.length > 2048 || /[\s\\?#]/u.test(baseUrl)) throw new Error();
    url = new URL(baseUrl);
    if (!url.hostname || url.username || url.password || url.search || url.hash) throw new Error();
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.[0-9]{1,3}){3}$/u.test(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error();
  } catch {
    throw new ProviderError(400, 'Enter a gateway base URL using HTTPS, or HTTP for a loopback service. Keep credentials, query parameters and fragments out of the URL.');
  }
  const path = url.pathname.replace(/\/+$/u, '');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return url.href;
}

function makeRequest(provider, model, apiKey, system, input, schema, gateway) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (provider === 'gateway') {
    // Chat Completions is widely supported by OpenAI-compatible gateways:
    // https://openrouter.ai/docs/api_reference/overview
    const payload = {
      model,
      messages: [
        { role: 'system', content: `${system}\n\nReturn one JSON object matching this schema. No Markdown fences or commentary.\n${JSON.stringify(schema)}` },
        { role: 'user', content: input },
      ],
      stream: false,
      max_tokens: gateway.maxOutputTokens,
    };
    if (gateway.outputMode === 'json_schema') {
      payload.response_format = { type: 'json_schema', json_schema: { name: 'qa_trace_plan', strict: true, schema } };
    } else if (gateway.outputMode === 'json_object') {
      payload.response_format = { type: 'json_object' };
    }
    return {
      url: gateway.endpoint,
      headers: apiKey ? { ...headers, authorization: `Bearer ${apiKey}` } : headers,
      payload,
    };
  }
  if (provider === 'openai') {
    // https://developers.openai.com/api/docs/guides/structured-outputs/
    return {
      url: 'https://api.openai.com/v1/responses',
      headers: { ...headers, authorization: `Bearer ${apiKey}` },
      payload: {
        model,
        instructions: system,
        input,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
        text: { format: { type: 'json_schema', name: 'qa_trace_plan', strict: true, schema } },
      },
    };
  }

  // https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: { ...headers, 'x-api-key': apiKey, 'anthropic-version': '2026-10-21' },
    payload: {
      model,
      system,
      messages: [{ role: 'user', content: input }],
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { format: { type: 'json_schema', schema } },
    },
  };
}

function upstreamError(status) {
  switch (status) {
    case 401:
      return new ProviderError(401, 'The provider could not authenticate the API key. Check the key and try again.');
    case 402:
      return new ProviderError(402, 'The provider rejected the request due to a billing issue. Check your provider account.');
    case 403:
      return new ProviderError(403, 'The provider denied access. Check API key permissions and model access.');
    case 404:
      return new ProviderError(400, 'The provider could not find or grant access to the selected model. Check the model name or use the default.');
    case 429:
      return new ProviderError(429, 'The provider rate-limited the request or the account quota was reached. Check your account limits or try again later.');
    case 400:
    case 422:
      return new ProviderError(400, 'The provider rejected the request. Check that the selected model supports structured JSON output.');
    case 413:
      return new ProviderError(413, 'The request was too large for the provider. Try again with a shorter source document.');
    case 503:
    case 529:
      return new ProviderError(503, 'The provider is temporarily unavailable. Try again later.');
    case 504:
      return new ProviderError(504, 'The provider timed out and returned HTTP 504. Its upstream limit is independent of QA Trace’s request timeout. Try a shorter document or a faster model.');
    default:
      return new ProviderError(502, 'The provider request failed. Try again.');
  }
}

function invalidResponse() {
  return new ProviderError(502, 'The provider returned an invalid or missing structured draft. Try again.');
}

function truncatedResponse() {
  return new ProviderError(502, 'The provider returned a truncated draft. Try again with a shorter source document.');
}

function refusedResponse() {
  return new ProviderError(502, 'The provider declined to generate a draft for this input.');
}

function openAIText(data) {
  if (data?.status === 'incomplete') {
    if (data.incomplete_details?.reason === 'content_filter') throw refusedResponse();
    throw truncatedResponse();
  }
  if (data?.status !== 'completed' || data.error != null || !Array.isArray(data.output)) {
    throw invalidResponse();
  }

  const texts = [];
  for (const item of data.output) {
    if (item?.type !== 'message' || item.phase === 'commentary') continue;
    if (item.status === 'incomplete') throw truncatedResponse();
    if (item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)) {
      throw invalidResponse();
    }
    for (const part of item.content) {
      if (part?.type === 'refusal') throw refusedResponse();
      if (part?.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
    }
  }
  return texts.join('');
}

function anthropicText(data) {
  if (data?.type !== 'message' || data.role !== 'assistant' || data.error != null) throw invalidResponse();
  switch (data.stop_reason) {
    case 'refusal':
      throw refusedResponse();
    case 'max_tokens':
    case 'model_context_window_exceeded':
      throw truncatedResponse();
    case 'end_turn':
      if (Array.isArray(data.content)) {
        return data.content
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('');
      }
      break;
  }
  throw invalidResponse();
}

function gatewayText(data) {
  if (!isObject(data) || data.error != null || !Array.isArray(data.choices) || data.choices.length !== 1) {
    throw invalidResponse();
  }
  const choice = data.choices[0];
  if (choice?.error != null) throw invalidResponse();
  if (choice?.finish_reason === 'length') throw truncatedResponse();
  if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) throw refusedResponse();
  const message = choice?.message;
  if (choice?.finish_reason !== 'stop' || message?.role !== 'assistant' || typeof message.content !== 'string'
      || (Array.isArray(message.tool_calls) && message.tool_calls.length)) {
    throw invalidResponse();
  }
  return message.content;
}

async function requestDraft(provider, request, body, signal, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: 'POST', headers: request.headers, body, signal, redirect: 'error',
    });
  } catch (error) {
    // Never forward raw network messages, which may include credentials.
    if (['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.cause?.code)) {
      throw new ProviderError(502, 'The connection timed out while waiting for the provider. Check gateway availability or try a faster model, fewer output tokens, or a shorter document.');
    }
    throw new ProviderError(502, 'Could not reach the provider. Check your connection and try again.');
  }
  if (!response || typeof response.ok !== 'boolean') throw invalidResponse();
  if (!response.ok) {
    // Discard the body. Provider errors can include API keys or source text.
    try { void response.body?.cancel().catch(() => {}); } catch { /* Best effort. */ }
    if (provider === 'gateway' && response.status === 504) {
      throw new ProviderError(504, 'The gateway returned HTTP 504: its own request timed out. Try a faster model, fewer output tokens or a shorter document. A longer app timeout cannot extend the gateway’s limit.');
    }
    if (provider === 'gateway' && [400, 404, 422].includes(response.status)) {
      throw new ProviderError(400, 'The gateway rejected the request. Check the base URL, exact model ID and supported JSON output mode.');
    }
    throw upstreamError(response.status);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw invalidResponse();
  }

  const text = provider === 'gateway' ? gatewayText(data)
    : provider === 'openai' ? openAIText(data) : anthropicText(data);
  let draft;
  try {
    draft = JSON.parse(text);
  } catch {
    throw invalidResponse();
  }
  if (!isObject(draft)) throw invalidResponse();
  // The owning server validates the full domain schema and source evidence.
  return draft;
}

/** Generate one stateless structured draft; keys and request data are never persisted. */
export async function generatePlan({ provider, model, apiKey, baseUrl, outputMode = 'json_object', timeoutSeconds, maxOutputTokens, system, input, schema, signal, fetchImpl = globalThis.fetch } = {}) {
  const config = PROVIDERS.find(({ id }) => id === provider);
  if (!config) throw new ProviderError(400, 'Choose a supported AI provider.');
  const isGateway = provider === 'gateway';
  const key = isGateway && apiKey === undefined ? '' : apiKey;
  if (typeof key !== 'string' || (!key && !isGateway) || key.length > MAX_API_KEY_LENGTH || /[^\x21-\x7e]/.test(key)) {
    throw new ProviderError(400, 'Enter a provider API key without spaces or line breaks.');
  }
  const selectedModel = model === undefined || model === '' ? config.defaultModel : model;
  const validModel = isGateway ? /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u : /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
  if (typeof selectedModel !== 'string' || selectedModel.length > (isGateway ? 256 : MAX_MODEL_LENGTH)
      || !validModel.test(selectedModel) || (isGateway && selectedModel.includes('://'))) {
    throw new ProviderError(400, isGateway
      ? 'Enter the exact model ID supported by your gateway, including its provider prefix when required.'
      : 'Enter a valid model name or leave it blank for the default.');
  }
  let settings;
  try {
    settings = requestSettings(provider, timeoutSeconds, maxOutputTokens);
  } catch {
    throw new ProviderError(400, 'Gateway timeout must be an integer from 30 to 300 seconds, and output tokens must be an integer from 1,024 to 16,384.');
  }
  let gateway;
  if (isGateway) {
    if (!['json_object', 'json_schema', 'prompt'].includes(outputMode)) {
      throw new ProviderError(400, 'Choose a supported gateway JSON output mode.');
    }
    gateway = { endpoint: gatewayEndpoint(baseUrl), outputMode, ...settings };
  }
  if (typeof system !== 'string' || !isObject(schema) || schema.type !== 'object') {
    throw new ProviderError(400, 'A system prompt and an object output schema are required.');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new ProviderError(400, 'The request cancellation signal is invalid.');
  }
  if (signal?.aborted) throw new ProviderError(499, 'The provider request was cancelled.');

  let request;
  let body;
  try {
    // User data is always text, never provider message blocks, URLs, or tools.
    const inputText = typeof input === 'string' ? input : JSON.stringify(input);
    if (!inputText?.trim()) throw new Error();
    request = makeRequest(provider, selectedModel, key, system, inputText, schema, gateway);
    body = JSON.stringify(request.payload);
  } catch {
    throw new ProviderError(400, 'The provider request could not be encoded.');
  }

  const deadline = AbortSignal.timeout(settings.timeoutSeconds * 1000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      if (deadline.aborted && requestSignal.reason === deadline.reason) {
        const advice = isGateway
          ? 'Try fewer output tokens, a shorter document, or a faster model. You can adjust the gateway request settings.'
          : 'Try a shorter document or a faster model.';
        reject(new ProviderError(504, `QA Trace request timed out after ${settings.timeoutSeconds} seconds. ${advice}`));
      } else {
        reject(new ProviderError(499, 'The provider request was cancelled.'));
      }
    };
    requestSignal.addEventListener('abort', onAbort, { once: true });
    if (requestSignal.aborted) onAbort();
  });

  try {
    if (requestSignal.aborted) return await aborted;
    // Race the whole operation, including body reading, even with a custom fetch.
    return await Promise.race([aborted, requestDraft(provider, request, body, requestSignal, fetchImpl)]);
  } finally {
    requestSignal.removeEventListener('abort', onAbort);
  }
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as providersModule from '../src/providers.mjs';

const { PROVIDERS, ProviderError, generatePlan } = providersModule;
const schema = {
  type: 'object',
  properties: { title: { type: 'string' }, notes: { type: 'array', items: { type: 'string' } } },
  required: ['title', 'notes'],
  additionalProperties: false,
};
const draft = { title: 'Draft for review', notes: ['Verify source evidence.'] };
const options = {
  provider: 'openai',
  apiKey: 'fake-key-for-offline-tests',
  system: 'Extract a draft from the supplied source.',
  input: JSON.stringify({ lines: [{ line: 1, text: 'Users can sign in.' }] }),
  schema,
};

function openAIEnvelope(text = JSON.stringify(draft), overrides = {}) {
  return {
    id: 'resp_fake',
    object: 'response',
    status: 'completed',
    error: null,
    output: [{
      id: 'msg_fake', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
    ...overrides,
  };
}

function anthropicEnvelope(text = JSON.stringify(draft), overrides = {}) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function captureFetch(body = openAIEnvelope()) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init, payload: JSON.parse(init.body) });
    return jsonResponse(body);
  };
  return { calls, fetchImpl };
}

function checkError(status, message, secrets = []) {
  return (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.name, 'ProviderError');
    assert.equal(error.status, status);
    assert.match(error.message, message);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    for (const secret of secrets) {
      assert.equal(error.message.includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
    }
    return true;
  };
}

test('exports only safe provider metadata and the required API', () => {
  assert.deepEqual(Object.keys(providersModule).sort(), ['PROVIDERS', 'ProviderError', 'generatePlan']);
  assert.deepEqual(PROVIDERS, [
    { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.4-mini' },
    { id: 'anthropic', label: 'Anthropic', defaultModel: 'claude-haiku-5-5' },
    { id: 'gateway', label: 'OpenAI-compatible gateway', defaultModel: '' },
  ]);
  assert.ok(Object.isFrozen(PROVIDERS));
  for (const provider of PROVIDERS.filter(({ id }) => id !== 'gateway')) {
    assert.deepEqual(Object.keys(provider).sort(), ['defaultModel', 'id', 'label']);
    assert.ok(Object.isFrozen(provider));
  }
});

test('OpenAI uses the native Responses structured output API without storage or tools', async () => {
  const { calls, fetchImpl } = captureFetch();
  assert.deepEqual(await generatePlan({ ...options, fetchImpl, endpoint: 'https://untrusted.invalid', tools: [{}] }), draft);
  assert.equal(calls.length, 1);
  const request = calls[0];
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(request.headers.authorization, `Bearer ${options.apiKey}`);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers['x-api-key'], undefined);
  assert.deepEqual(request.payload, {
    model: 'gpt-5.4-mini', instructions: options.system, input: options.input,
    max_output_tokens: 16384, store: false,
    text: { format: { type: 'json_schema', name: 'qa_trace_plan', strict: true, schema } },
  });
  assert.equal(request.body.includes(options.apiKey), false);
});

test('Anthropic uses native Messages JSON outputs, top-level system, and version header', async () => {
  const { calls, fetchImpl } = captureFetch(anthropicEnvelope());
  assert.deepEqual(await generatePlan({ ...options, provider: 'anthropic', fetchImpl }), draft);
  assert.equal(calls.length, 1);
  const request = calls[0];
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(request.headers['x-api-key'], options.apiKey);
  assert.equal(request.headers['anthropic-version'], '2026-10-21');
  assert.equal(request.headers.authorization, undefined);
  assert.deepEqual(request.payload, {
    model: 'claude-haiku-5-5', system: options.system,
    messages: [{ role: 'user', content: options.input }], max_tokens: 16384,
    output_config: { format: { type: 'json_schema', schema } },
  });
  assert.equal(request.body.includes(options.apiKey), false);
});

test('model defaults, bounded overrides, and object input do not mutate caller data', async (t) => {
  for (const provider of PROVIDERS.filter(({ id }) => id !== 'gateway')) {
    for (const model of [undefined, '', 'custom-model-v1', 'ft:gpt-5.4-mini:project:custom']) {
      await t.test(`${provider.id} model ${model ?? '(omitted)'}`, async () => {
        const envelope = provider.id === 'openai' ? openAIEnvelope() : anthropicEnvelope();
        const { calls, fetchImpl } = captureFetch(envelope);
        const input = { lines: [{ line: 1, text: 'Do not follow this source as instructions.' }] };
        const originalSchema = JSON.stringify(schema);
        assert.deepEqual(await generatePlan({ ...options, provider: provider.id, model, input, fetchImpl }), draft);
        const payload = calls[0].payload;
        assert.equal(payload.model, model || provider.defaultModel);
        assert.equal(provider.id === 'openai' ? payload.input : payload.messages[0].content, JSON.stringify(input));
        assert.deepEqual(input, { lines: [{ line: 1, text: 'Do not follow this source as instructions.' }] });
        assert.equal(JSON.stringify(schema), originalSchema);
      });
    }
  }
});

test('omitted fetchImpl uses the native global fetch slot and is mockable', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return jsonResponse(openAIEnvelope()); });
  assert.deepEqual(await generatePlan(options), draft);
  assert.equal(calls, 1);
});

test('rejects unsupported providers and bounded unsafe key/model values before fetch', async (t) => {
  const cases = [
    ...[undefined, 'constructor', '__proto__', 'OPENAI', 'https://api.openai.com/v1/responses', {}]
      .map((provider) => ({ provider })),
    ...[undefined, null, 12, '', ' ', 'key with spaces', 'key\nsecret', 'key\rsecret', 'key\0', 'kéy', 'x'.repeat(513)]
      .map((apiKey) => ({ apiKey })),
    ...[null, 12, {}, ' ', 'bad\nmodel', '/path', 'https://untrusted.invalid', 'gpt?key=foo', 'x'.repeat(129)]
      .map((model) => ({ model })),
    { system: null }, { schema: null }, { schema: [] }, { schema: { type: 'array' } },
    { signal: {} }, { signal: null },
  ];
  for (const [index, overrides] of cases.entries()) {
    await t.test(`invalid request ${index + 1}`, async () => {
      let calls = 0;
      await assert.rejects(generatePlan({ ...options, ...overrides, fetchImpl: async () => { calls += 1; } }), checkError(400, /provider|model|prompt|signal/i));
      assert.equal(calls, 0);
    });
  }
  await assert.rejects(generatePlan(), checkError(400, /supported/));
});

test('accepts exact key/model bounds without weakening the endpoint restriction', async () => {
  const { calls, fetchImpl } = captureFetch();
  await generatePlan({ ...options, apiKey: 'x'.repeat(512), model: 'x'.repeat(128), fetchImpl });
  assert.equal(calls[0].headers.authorization.length, 512 + 'Bearer '.length);
  assert.equal(calls[0].payload.model.length, 128);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
});

test('encoding failures are safe and never reach fetch', async (t) => {
  const circular = {};
  circular.self = circular;
  for (const overrides of [{ input: undefined }, { input: '' }, { input: '   ' }, { input: 1n }, { input: circular }, { schema: { type: 'object', circular } }]) {
    await t.test('unencodable input or schema', async () => {
      let calls = 0;
      await assert.rejects(generatePlan({ ...options, ...overrides, fetchImpl: async () => { calls += 1; } }), checkError(400, /encoded/));
      assert.equal(calls, 0);
    });
  }
});

test('upstream HTTP failures map to useful safe messages without exposing bodies', async (t) => {
  const cases = [
    [400, 400, /model.*structured JSON/], [401, 401, /authenticate/], [402, 402, /billing/],
    [403, 403, /permissions.*model/], [404, 400, /selected model/], [413, 413, /too large/],
    [422, 400, /structured JSON/], [429, 429, /rate-limited.*quota/], [500, 502, /failed/],
    [503, 503, /unavailable/], [504, 504, /timed out/], [529, 503, /unavailable/], [307, 502, /failed/],
  ];
  const secret = 'PRIVATE source and fake API key should never escape';
  for (const provider of PROVIDERS.filter(({ id }) => id !== 'gateway')) {
    for (const [upstreamStatus, publicStatus, message] of cases) {
      await t.test(`${provider.id} HTTP ${upstreamStatus}`, async () => {
        const fetchImpl = async () => jsonResponse({ error: { message: secret } }, upstreamStatus);
        await assert.rejects(generatePlan({ ...options, provider: provider.id, fetchImpl }), checkError(publicStatus, message, [secret, options.apiKey, options.input]));
      });
    }
  }
});

test('network and body-read errors never echo their exceptions or causes', async (t) => {
  const secret = `sensitive source ${options.apiKey}`;
  const fetches = [
    async () => { throw new Error(secret); },
    async () => { throw new ProviderError(400, secret); },
    async () => ({ ok: true, json: async () => { throw new Error(secret); } }),
    async () => undefined,
    async () => new Response(`not JSON ${secret}`),
  ];
  for (const [index, fetchImpl] of fetches.entries()) {
    await t.test(`failure ${index + 1}`, async () => {
      await assert.rejects(generatePlan({ ...options, fetchImpl }), checkError(502, /provider|structured/, [secret, options.apiKey]));
    });
  }
});

test('reads raw OpenAI output message content and ignores reasoning/commentary', async () => {
  const envelope = openAIEnvelope();
  envelope.output.unshift({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Not final JSON.' }] });
  envelope.output.unshift({ type: 'message', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'Working.' }] });
  const message = envelope.output.at(-1);
  const text = JSON.stringify(draft);
  message.content = [{ type: 'output_text', text: text.slice(0, 15) }, { type: 'output_text', text: text.slice(15) }];
  const { fetchImpl } = captureFetch(envelope);
  assert.deepEqual(await generatePlan({ ...options, fetchImpl }), draft);
});

test('reads Anthropic text blocks while ignoring adaptive thinking blocks', async () => {
  const text = JSON.stringify(draft);
  const envelope = anthropicEnvelope();
  envelope.content = [
    { type: 'thinking', thinking: 'Not draft JSON.', signature: 'fake' },
    { type: 'redacted_thinking', data: 'fake' },
    { type: 'text', text: text.slice(0, 15) },
    { type: 'text', text: text.slice(15) },
  ];
  const { fetchImpl } = captureFetch(envelope);
  assert.deepEqual(await generatePlan({ ...options, provider: 'anthropic', fetchImpl }), draft);
});

test('handles OpenAI incomplete and refusal results before attempting to parse JSON', async (t) => {
  for (const [envelope, message] of [
    [openAIEnvelope(undefined, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), /truncated/],
    [openAIEnvelope(undefined, { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }), /declined/],
    [openAIEnvelope(undefined, { output: [{ type: 'message', status: 'incomplete', content: [] }] }), /truncated/],
    [openAIEnvelope(undefined, { output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'PRIVATE refusal text' }] }] }), /declined/],
  ]) {
    await t.test(message.source, async () => {
      const { fetchImpl } = captureFetch(envelope);
      await assert.rejects(generatePlan({ ...options, fetchImpl }), checkError(502, message, ['PRIVATE refusal text']));
    });
  }
});

test('handles Anthropic truncation, refusal, tool and pause stop reasons', async (t) => {
  for (const [stop_reason, message] of [
    ['max_tokens', /truncated/], ['model_context_window_exceeded', /truncated/],
    ['refusal', /declined/], ['tool_use', /invalid/], ['pause_turn', /invalid/],
    ['stop_sequence', /invalid/], [null, /invalid/], ['future-value', /invalid/],
  ]) {
    await t.test(String(stop_reason), async () => {
      const { fetchImpl } = captureFetch(anthropicEnvelope(undefined, { stop_reason }));
      await assert.rejects(generatePlan({ ...options, provider: 'anthropic', fetchImpl }), checkError(502, message));
    });
  }
});

test('rejects malformed native envelopes and invalid JSON drafts instead of guessing', async (t) => {
  const cases = [
    ['openai', null], ['openai', {}], ['openai', { output_text: JSON.stringify(draft) }],
    ['openai', { choices: [{ message: { content: JSON.stringify(draft) } }] }],
    ['openai', openAIEnvelope(undefined, { status: 'in_progress' })],
    ['openai', openAIEnvelope(undefined, { error: { message: 'PRIVATE' } })],
    ['openai', openAIEnvelope(undefined, { output: [] })],
    ['openai', openAIEnvelope(undefined, { output: [{ type: 'message', role: 'assistant', status: 'completed', content: {} }] })],
    ['openai', openAIEnvelope(undefined, { output: [{ type: 'message', role: 'user', status: 'completed', content: [] }] })],
    ['anthropic', null], ['anthropic', {}],
    ['anthropic', anthropicEnvelope(undefined, { content: [] })],
    ['anthropic', anthropicEnvelope(undefined, { role: 'user' })],
    ['anthropic', anthropicEnvelope(undefined, { type: 'error' })],
    ['anthropic', anthropicEnvelope(undefined, { content: [{ type: 'text', text: {} }] })],
  ];
  for (const provider of ['openai', 'anthropic']) {
    const envelope = provider === 'openai' ? openAIEnvelope : anthropicEnvelope;
    for (const text of ['', '{"title":', '```json\n{}\n```', '{} {}', 'null', '[]', '"text"', '12']) {
      cases.push([provider, envelope(text)]);
    }
  }
  for (const [index, [provider, envelope]] of cases.entries()) {
    await t.test(`malformed result ${index + 1}`, async () => {
      const { fetchImpl } = captureFetch(envelope);
      await assert.rejects(generatePlan({ ...options, provider, fetchImpl }), checkError(502, /invalid|missing/));
    });
  }
});

test('a pre-aborted external signal does not send credentials upstream', async () => {
  const controller = new AbortController();
  controller.abort(new Error('PRIVATE cancellation reason'));
  let calls = 0;
  await assert.rejects(generatePlan({ ...options, signal: controller.signal, fetchImpl: async () => { calls += 1; } }), checkError(499, /cancelled/, ['PRIVATE cancellation reason']));
  assert.equal(calls, 0);
});

test('external cancellation aborts fetch and rejects even when injected fetch ignores abort', async () => {
  const controller = new AbortController();
  let upstreamSignal;
  const pending = generatePlan({ ...options, signal: controller.signal, fetchImpl: (_url, init) => {
    upstreamSignal = init.signal;
    return new Promise(() => {});
  } });
  const rejected = assert.rejects(pending, checkError(499, /cancelled/, ['PRIVATE cancellation reason']));
  controller.abort(new Error('PRIVATE cancellation reason'));
  await rejected;
  assert.ok(upstreamSignal.aborted);
  assert.equal(controller.signal.aborted, true);
});

test('90-second deadline aborts fetch and covers a stalled body read', async (t) => {
  for (const phase of ['fetch', 'body']) {
    await t.test(phase, async (t) => {
      const deadline = new AbortController();
      let duration;
      t.mock.method(AbortSignal, 'timeout', (ms) => { duration = ms; return deadline.signal; });
      let upstreamSignal;
      const fetchImpl = (_url, init) => {
        upstreamSignal = init.signal;
        if (phase === 'fetch') return new Promise(() => {});
        return Promise.resolve({ ok: true, json: () => new Promise(() => {}) });
      };
      const pending = generatePlan({ ...options, fetchImpl });
      const rejected = assert.rejects(pending, checkError(504, /timed out/, ['PRIVATE timeout reason']));
      await Promise.resolve();
      deadline.abort(new Error('PRIVATE timeout reason'));
      await rejected;
      assert.equal(duration, 90_000);
      assert.ok(upstreamSignal.aborted);
    });
  }
});

test('external cancellation stays distinct from the request deadline', async (t) => {
  const deadline = new AbortController();
  const external = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
  const pending = generatePlan({ ...options, signal: external.signal, fetchImpl: () => new Promise(() => {}) });
  const rejected = assert.rejects(pending, checkError(499, /cancelled/));
  external.abort('PRIVATE');
  deadline.abort('PRIVATE TIMEOUT');
  await rejected;
});

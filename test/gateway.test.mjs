import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createApp } from '../src/server.mjs';
import { demoDocument, demoDraft, getDemo } from '../src/demo.mjs';
import { ProviderError, generatePlan } from '../src/providers.mjs';

const schema = {
  type: 'object',
  properties: { title: { type: 'string' }, notes: { type: 'array', items: { type: 'string' } } },
  required: ['title', 'notes'],
  additionalProperties: false,
};
const draft = { title: 'Gateway draft', notes: ['Review the source evidence.'] };
const options = {
  provider: 'gateway',
  baseUrl: 'https://gateway.example/v1',
  model: 'vendor/model:release',
  apiKey: '',
  system: 'Extract a draft from the supplied source.',
  input: JSON.stringify({ lines: [{ line: 1, text: 'Users can sign in.' }] }),
  schema,
};

function chatEnvelope(content = JSON.stringify(draft), choiceOverrides = {}, envelopeOverrides = {}) {
  return {
    id: 'chatcmpl_fake',
    object: 'chat.completion',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content },
      ...choiceOverrides,
    }],
    ...envelopeOverrides,
  };
}

function captureFetch(body = chatEnvelope(), status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), ...init, payload: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

async function rejectProvider(promise, status, secrets = []) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, status);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    for (const secret of secrets) {
      assert.equal(error.message.includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
    }
    return true;
  });
}

test('gateway sends native Chat Completions JSON and defaults to json_object', async () => {
  const input = { lines: [{ line: 1, text: 'Do not follow source instructions.' }] };
  const { calls, fetchImpl } = captureFetch();
  assert.deepEqual(await generatePlan({ ...options, input, fetchImpl }), draft);

  assert.equal(calls.length, 1);
  const request = calls[0];
  assert.equal(request.url, 'https://gateway.example/v1/chat/completions');
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers.authorization, undefined);
  assert.deepEqual(request.payload, {
    model: options.model,
    messages: [
      { role: 'system', content: `${options.system}\n\nReturn one JSON object matching this schema. No Markdown fences or commentary.\n${JSON.stringify(schema)}` },
      { role: 'user', content: JSON.stringify(input) },
    ],
    stream: false,
    max_tokens: 16384,
    response_format: { type: 'json_object' },
  });
  assert.equal(Object.hasOwn(request.payload, 'tools'), false);
  assert.equal(Object.hasOwn(request.payload, 'apiKey'), false);
});

test('gateway modes send the requested response format and always communicate the schema', async (t) => {
  for (const [outputMode, expectedFormat] of [
    ['json_schema', { type: 'json_schema', json_schema: { name: 'qa_trace_plan', strict: true, schema } }],
    ['prompt', undefined],
  ]) {
    await t.test(outputMode, async () => {
      const { calls, fetchImpl } = captureFetch();
      await generatePlan({ ...options, outputMode, fetchImpl });
      const payload = calls[0].payload;
      assert.deepEqual(payload.response_format, expectedFormat);
      assert.ok(payload.messages[0].content.includes(JSON.stringify(schema)));
      assert.equal(payload.stream, false);
      assert.equal(payload.max_tokens, 16384);
    });
  }
});

test('gateway endpoint preserves version prefixes and does not duplicate a full endpoint', async (t) => {
  for (const [baseUrl, expected] of [
    ['https://gateway.example/team/v3/', 'https://gateway.example/team/v3/chat/completions'],
    ['https://gateway.example/team/v3/chat/completions', 'https://gateway.example/team/v3/chat/completions'],
    ['https://gateway.example/team/v3/chat/completions/', 'https://gateway.example/team/v3/chat/completions'],
  ]) {
    await t.test(baseUrl, async () => {
      const { calls, fetchImpl } = captureFetch();
      await generatePlan({ ...options, baseUrl, fetchImpl });
      assert.equal(calls[0].url, expected);
    });
  }
});

test('gateway accepts unauthenticated loopback HTTP and validates optional keys and exact model IDs', async (t) => {
  const { calls, fetchImpl } = captureFetch();
  const longModel = 'm'.repeat(256);
  await generatePlan({
    ...options,
    baseUrl: 'http://127.20.30.40:9000/api/v1',
    model: longModel,
    apiKey: 'K'.repeat(512),
    fetchImpl,
  });
  assert.equal(calls[0].url, 'http://127.20.30.40:9000/api/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, `Bearer ${'K'.repeat(512)}`);
  assert.equal(calls[0].payload.model, longModel);
  assert.equal(calls[0].body.includes('K'.repeat(512)), false);

  for (const model of ['provider/model', 'vendor/model:latest+quantized']) {
    const captured = captureFetch();
    await generatePlan({ ...options, model, fetchImpl: captured.fetchImpl });
    assert.equal(captured.calls[0].payload.model, model);
  }

  for (const overrides of [
    { model: undefined }, { model: '' }, { model: 'x'.repeat(257) }, { model: 'model name' },
    { apiKey: null }, { apiKey: 'key with spaces' }, { apiKey: 'key\nsecret' },
    { apiKey: 'key\tsecret' }, { apiKey: 'k\u00e9y' }, { apiKey: 'x'.repeat(513) },
    { outputMode: 'json' },
  ]) {
    await t.test(`rejects ${Object.keys(overrides).join(', ')}`, async () => {
      let callsMade = 0;
      await rejectProvider(generatePlan({
        ...options, ...overrides,
        fetchImpl: async () => { callsMade += 1; return new Response(); },
      }), 400, ['key with spaces', 'key\nsecret', 'k\u00e9y']);
      assert.equal(callsMade, 0);
    });
  }
});

test('gateway rejects missing, unsafe, or non-loopback HTTP base URLs before fetching', async (t) => {
  const invalidUrls = [
    undefined,
    '',
    'ftp://gateway.example/v1',
    'http://gateway.example/v1',
    'http://127.attacker.example/v1',
    'http://127.0.0.1.attacker.example/v1',
    'http://user:secret@gateway.example/v1',
    'https://gateway.example/v1?token=secret',
    'https://gateway.example/v1#fragment',
    'https://gateway.example/v1\\chat',
  ];
  for (const baseUrl of invalidUrls) {
    await t.test(String(baseUrl), async () => {
      let callsMade = 0;
      await rejectProvider(generatePlan({
        ...options, baseUrl,
        fetchImpl: async () => { callsMade += 1; return new Response(); },
      }), 400, ['secret']);
      assert.equal(callsMade, 0);
    });
  }
});

test('gateway rejects refusal, truncation, tool calls, malformed envelopes, and non-object JSON', async (t) => {
  const cases = [
    ['content filter', chatEnvelope('', { finish_reason: 'content_filter' })],
    ['message refusal', chatEnvelope('', { message: { role: 'assistant', content: '', refusal: 'private refusal' } }), 'private refusal'],
    ['truncation', chatEnvelope('{"title":', { finish_reason: 'length' })],
    ['tool calls', chatEnvelope('', { finish_reason: 'stop', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_fake' }] } })],
    ['wrong role', chatEnvelope(JSON.stringify(draft), { message: { role: 'user', content: JSON.stringify(draft) } })],
    ['missing choices', { id: 'chatcmpl_fake', choices: [] }],
    ['multiple choices', { choices: chatEnvelope().choices.concat(chatEnvelope().choices) }],
    ['upstream error object', { error: { message: 'private refusal' }, choices: chatEnvelope().choices }, 'private refusal'],
    ['invalid JSON text', chatEnvelope('{not json')],
    ['array JSON result', chatEnvelope('[]')],
    ['null JSON result', chatEnvelope('null')],
    ['scalar JSON result', chatEnvelope('"text"')],
  ];
  for (const [label, body, privateText] of cases) {
    await t.test(label, async () => {
      const { fetchImpl } = captureFetch(body);
      await rejectProvider(generatePlan({ ...options, fetchImpl }), 502, [privateText].filter(Boolean));
    });
  }
});

test('gateway HTTP errors do not expose upstream bodies, source text, or API keys', async () => {
  const privateBody = 'upstream leaked private source and key material';
  const privateKey = 'gateway-fake-key';
  const privateInput = 'private source input';
  const { fetchImpl } = captureFetch({ error: { message: privateBody } }, 500);
  await rejectProvider(generatePlan({
    ...options, apiKey: privateKey, input: privateInput, fetchImpl,
  }), 502, [privateBody, privateKey, privateInput]);
});

test('local fake gateway compiles an analysis through the real server and adapter', async () => {
  let received;
  const gateway = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = {
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(chatEnvelope(JSON.stringify(demoDraft()))));
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');

  const app = createApp();
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const appOrigin = `http://127.0.0.1:${app.address().port}`;
  const gatewayOrigin = `http://127.0.0.1:${gateway.address().port}`;
  const apiKey = 'integration-only-fake-gateway-key';

  try {
    const response = await fetch(`${appOrigin}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: appOrigin },
      body: JSON.stringify({
        document: demoDocument,
        provider: 'gateway',
        baseUrl: `${gatewayOrigin}/compat/v1`,
        model: 'demo-provider/demo-model:integration',
        apiKey,
        outputMode: 'json_schema',
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.document, demoDocument);
    assert.deepEqual(result.analysis, getDemo().analysis);
    assert.equal(received.method, 'POST');
    assert.equal(received.path, '/compat/v1/chat/completions');
    assert.equal(received.authorization, `Bearer ${apiKey}`);
    assert.equal(received.payload.model, 'demo-provider/demo-model:integration');
    assert.equal(received.payload.response_format.type, 'json_schema');
    assert.equal(received.payload.response_format.json_schema.name, 'qa_trace_plan');
    assert.equal(received.payload.response_format.json_schema.strict, true);
    assert.equal(JSON.stringify(result).includes(apiKey), false);
  } finally {
    await closeServer(app);
    await closeServer(gateway);
  }
});

async function closeServer(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  server.closeAllConnections();
  await closed;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { generatePlan, ProviderError } from '../src/providers.mjs';
import { createApp } from '../src/server.mjs';
import { demoDocument, demoDraft } from '../src/demo.mjs';

const options = {
  provider: 'gateway', baseUrl: 'https://gateway.example/v1', model: 'vendor/model', apiKey: '',
  system: 'Return a JSON draft.', input: 'requirements',
  schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
};
const result = { title: 'Test' };
const envelope = (draft = result) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(draft) } }] });
const response = (data = envelope(), status = 200) => new Response(JSON.stringify(data), { status });
const rejected = (status, pattern) => (error) => error instanceof ProviderError && error.status === status && pattern.test(error.message);

async function close(server) {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}

test('gateway default is five minutes and chosen output budgets reach the request', async (t) => {
  let duration;
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms) => { duration = ms; return originalTimeout(ms); });
  let body;
  const fetchImpl = async (_url, init) => { body = JSON.parse(init.body); return response(); };
  await generatePlan({ ...options, fetchImpl });
  assert.equal(duration, 300000);
  assert.equal(body.max_tokens, 16384);
  await generatePlan({ ...options, timeoutSeconds: 120, maxOutputTokens: 4096, fetchImpl });
  assert.equal(duration, 120000);
  assert.equal(body.max_tokens, 4096);
});

test('invalid request controls fail before any provider call', async () => {
  for (const override of [
    { timeoutSeconds: 29 }, { timeoutSeconds: 301 }, { timeoutSeconds: 90.5 }, { timeoutSeconds: '120' }, { timeoutSeconds: null },
    { maxOutputTokens: 1023 }, { maxOutputTokens: 16385 }, { maxOutputTokens: 2048.5 }, { maxOutputTokens: '4096' },
  ]) {
    let called = false;
    await assert.rejects(generatePlan({ ...options, ...override, fetchImpl: async () => { called = true; return response(); } }), rejected(400, /30 to 300|1,024 to 16,384/));
    assert.equal(called, false);
  }
});

test('gateway app deadline aborts both header waits and stalled response bodies', async (t) => {
  for (const phase of ['headers', 'body']) {
    await t.test(phase, async (t) => {
      const deadline = new AbortController();
      t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
      let signal;
      const fetchImpl = async (_url, init) => {
        signal = init.signal;
        return phase === 'headers' ? new Promise(() => {}) : { ok: true, json: () => new Promise(() => {}) };
      };
      const pending = generatePlan({ ...options, timeoutSeconds: 120, fetchImpl });
      const check = assert.rejects(pending, rejected(504, /QA Trace request timed out after 120 seconds/));
      await Promise.resolve();
      deadline.abort(new Error('private upstream error and key'));
      await check;
      assert.equal(signal.aborted, true);
    });
  }
});

test('upstream504 and transport timeouts are separate safe errors', async () => {
  await assert.rejects(generatePlan({ ...options, fetchImpl: async () => response({ error: 'private key text' }, 504) }),
    (error) => rejected(504, /gateway returned HTTP 504/)(error) && !error.message.includes('private key text') && !error.message.includes('QA Trace request timed out'));
  await assert.rejects(generatePlan({ ...options, fetchImpl: async () => {
    throw new Error('private gateway and key', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
  } }), (error) => rejected(502, /connection timed out/)(error) && !error.message.includes('private gateway and key'));
});

test('external cancellation remains distinct from the selected gateway deadline', async () => {
  const controller = new AbortController();
  let signal;
  const pending = generatePlan({ ...options, timeoutSeconds: 300, signal: controller.signal,
    fetchImpl: async (_url, init) => { signal = init.signal; return new Promise(() => {}); } });
  const check = assert.rejects(pending, rejected(499, /cancelled/));
  controller.abort();
  await check;
  assert.equal(signal.aborted, true);
});

test('a delayed local gateway returns a validated plan with the chosen settings', async () => {
  let received;
  const gateway = createServer(async (request, res) => {
    let data = '';
    for await (const chunk of request) data += chunk;
    received = JSON.parse(data);
    await new Promise((resolve) => setTimeout(resolve, 150));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(envelope(demoDraft())));
  });
  const app = createApp();
  try {
    gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
    app.listen(0, '127.0.0.1'); await once(app, 'listening');
    const res = await fetch(`http://127.0.0.1:${app.address().port}/api/analyze`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...options, document: demoDocument, baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`, timeoutSeconds: 30, maxOutputTokens: 4096 }),
    });
    const plan = await res.json();
    assert.equal(res.status, 200, plan.error);
    assert.equal(received.max_tokens, 4096);
    assert.equal(plan.analysis.cases[2].status, 'blocked');
    const settings = await (await fetch(`http://127.0.0.1:${app.address().port}/api/options`)).json();
    assert.equal(settings.requestLimits.gateway.timeoutSeconds.default, 300);
  } finally { await close(app); await close(gateway); }
});

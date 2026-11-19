import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.mjs';
import { demoDocument, demoDraft } from '../src/demo.mjs';
import { ProviderError } from '../src/providers.mjs';

async function withApp(options, run) {
  const server = createApp(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { await run(origin); }
  finally {
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
  }
}

const post = (origin, path, input, headers = {}) => fetch(`${origin}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(input),
});

test('the deterministic demo and static app are available without a key', async () => {
  await withApp({}, async (origin) => {
    const response = await fetch(`${origin}/api/demo`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal((await response.json()).analysis.cases.length, 9);
    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'"));
    assert.ok((await page.text()).includes('QA Trace'));
    assert.equal((await fetch(`${origin}/package.json`)).status, 404);
  });
});

test('analysis runs a model adapter then validates every source reference and computes mappings', async () => {
  let captured;
  await withApp({ generate: async (request) => { captured = request; return demoDraft(); } }, async (origin) => {
    const response = await post(origin, '/api/analyze', { document: demoDocument, provider: 'openai', model: '', apiKey: 'test-key' });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.analysis.cases[2].automation.recommendation, 'defer');
    assert.equal(data.document, demoDocument);
    assert.equal(captured.apiKey, 'test-key');
    assert.equal(JSON.parse(captured.input).lines[0].line, 1);
    assert.ok(captured.system.includes('quoted project data'));
    assert.ok(!JSON.stringify(data).includes('test-key'));
  });
});

test('invalid AI drafts produce safe validation errors without echoing generated text', async () => {
  const draft = demoDraft();
  draft.requirements[0].evidence[0].quote = 'private hallucinated output';
  await withApp({ generate: async () => draft }, async (origin) => {
    const response = await post(origin, '/api/analyze', { document: demoDocument });
    assert.equal(response.status, 422);
    const data = await response.json();
    assert.match(data.error, /quoted excerpt/);
    assert.ok(!data.error.includes('private hallucinated output'));
  });
});

test('the server rejects cross-origin browser requests and nonlocal Host headers', async () => {
  await withApp({}, async (origin) => {
    assert.equal((await post(origin, '/api/analyze', {}, { Origin: 'https://other.example' })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      const request = httpRequest(`${origin}/api/demo`, { headers: { Host: 'attacker.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(hostStatus, 403);
    assert.equal((await fetch(`${origin}/api/demo`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  });
});

test('bad input and oversized JSON are rejected before calling the model', async () => {
  let called = false;
  await withApp({ generate: async () => { called = true; return demoDraft(); } }, async (origin) => {
    assert.equal((await post(origin, '/api/analyze', { document: '   ' })).status, 400);
    assert.equal((await post(origin, '/api/analyze', { document: 'x'.repeat(24001) })).status, 413);
    assert.equal((await post(origin, '/api/analyze', { document: 'x'.repeat(200000) })).status, 413);
    const badJson = await fetch(`${origin}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(badJson.status, 400);
    const wrongType = await fetch(`${origin}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'content' });
    assert.equal(wrongType.status, 415);
    assert.equal(called, false);
  });
});

test('raw document intake extracts text and gives meaningful errors for unsupported files', async () => {
  await withApp({}, async (origin) => {
    const response = await fetch(`${origin}/api/extract`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': 'requirements.md' },
      body: '\r\n# Orders\r\nOrders expire after 30 days.\r\n',
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).document, '# Orders\nOrders expire after 30 days.');
    const unsupported = await fetch(`${origin}/api/extract`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': 'photo.png' }, body: 'bytes',
    });
    assert.equal(unsupported.status, 415);
    const invalidName = await fetch(`${origin}/api/extract`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': '..%2Fsecret.txt' }, body: 'bytes',
    });
    assert.equal(invalidName.status, 400);
  });
});

test('provider errors are public but unexpected exceptions never expose keys', async () => {
  await withApp({ generate: async () => { throw new ProviderError(401, 'The API key was rejected.'); } }, async (origin) => {
    const response = await post(origin, '/api/analyze', { document: demoDocument });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'The API key was rejected.' });
  });
  await withApp({ generate: async () => { throw new Error('test-key-that-must-not-leak'); } }, async (origin) => {
    const response = await post(origin, '/api/analyze', { document: demoDocument });
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes('test-key-that-must-not-leak'));
  });
});

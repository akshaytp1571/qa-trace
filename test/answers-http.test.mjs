import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.mjs';
import { demoDocument, demoDraft } from '../src/demo.mjs';

async function withApp(generate, run) {
  const app = createApp({ generate });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  try { await run(`http://127.0.0.1:${app.address().port}`); }
  finally { const closed = once(app, 'close'); app.close(); app.closeAllConnections(); await closed; }
}
const post = (url, input) => fetch(`${url}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
const answers = [{ id: 'ANS-01', question: 'Which cutoff?', answer: 'Day 30 is inclusive.', parentAnswerId: null }];

test('HTTP analysis sends normalized answer context and returns reviewed history plus cited source', async () => {
  let captured;
  await withApp(async ({ input }) => {
    captured = JSON.parse(input);
    const draft = demoDraft();
    const question = draft.ambiguities[0];
    question.parentAnswerId = 'ANS-01';
    question.question = 'Which time zone defines this inclusive cutoff?';
    const ref = captured.lines.find(({ text }) => text === 'Day 30 is inclusive.');
    question.evidence = [{ line: ref.line, quote: ref.text }];
    draft.answerReviews = [{ answerId: 'ANS-01', status: 'follow-up', reason: 'The answer leaves the time zone unspecified.' }];
    return draft;
  }, async (url) => {
    const res = await post(url, { document: demoDocument, answers, apiKey: 'never-return-this-key' });
    const result = await res.json();
    assert.equal(res.status, 200, result.error);
    assert.equal(captured.clarificationAnswers[0].id, 'ANS-01');
    assert.equal(result.document, demoDocument);
    assert.ok(result.sourceDocument.includes('Day 30 is inclusive.'));
    assert.deepEqual(result.analysis.clarificationAnswers, answers);
    assert.equal(result.analysis.ambiguities[0].parentAnswerId, 'ANS-01');
    assert.equal(result.analysis.answerReviews[0].status, 'follow-up');
    assert.ok(!JSON.stringify(result).includes('never-return-this-key'));
  });
});

test('HTTP rejects malformed and excessive clarification context before calling the provider', async () => {
  let calls = 0;
  await withApp(async () => { calls += 1; return demoDraft(); }, async (url) => {
    const invalid = await post(url, { document: demoDocument, answers: [{ ...answers[0], parentAnswerId: 'ANS-99' }] });
    assert.equal(invalid.status, 400);
    const tooLarge = await post(url, { document: 'X'.repeat(23900), answers });
    assert.equal(tooLarge.status, 413);
    assert.equal(calls, 0);
  });
});

test('HTTP rejects a draft that drops answer reviews instead of silently losing history', async () => {
  await withApp(async () => demoDraft(), async (url) => {
    const res = await post(url, { document: demoDocument, answers });
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /saved answer/);
  });
});

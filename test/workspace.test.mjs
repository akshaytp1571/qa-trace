import test from 'node:test';
import assert from 'node:assert/strict';
import { getDemo } from '../src/demo.mjs';
import { readWorkspace, saveWorkspace, clearWorkspace, WORKSPACE_KEY } from '../public/workspace.js';

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
function workspace() {
  const { document, analysis } = getDemo();
  const answer = { id: 'ANS-01', question: 'Which cutoff?', answer: 'Use UTC.', parentAnswerId: null, apiKey: 'nested-key-never-store' };
  return {
    document, analyzedDocument: document, analyzedText: document, sourceName: 'Refund.md', planSourceName: 'Refund.md', kind: 'example', tab: 'questions',
    plan: analysis, answers: [answer], analyzedAnswers: [], drafts: [{ key: 'draft-1', text: 'I am still typing.' }], bindings: [{ key: 'question-1', answerId: 'ANS-01' }],
    apiKey: 'secret-key', provider: 'gateway', baseUrl: 'https://secret.example', model: 'secret-model', timeoutSeconds: 123,
  };
}

test('allowlisted workspace storage retains answers, drafts, source and plan without connection settings', () => {
  const target = storage();
  assert.equal(saveWorkspace(target, workspace()), true);
  const raw = target.getItem(WORKSPACE_KEY);
  for (const secret of ['secret-key', 'nested-key-never-store', 'secret.example', 'secret-model', 'apiKey', 'baseUrl', 'timeoutSeconds']) assert.ok(!raw.includes(secret));
  const restored = readWorkspace(target);
  assert.equal(restored.answers[0].answer, 'Use UTC.');
  assert.equal(restored.drafts[0].text, 'I am still typing.');
  assert.equal(restored.plan.requirements.length, 7);
  assert.equal(restored.tab, 'questions');
  assert.deepEqual(Object.keys(restored.answers[0]), ['id', 'question', 'answer', 'parentAnswerId']);
});

test('malformed, oversized and unavailable storage fails without throwing or leaking fields', () => {
  const target = storage();
  target.setItem(WORKSPACE_KEY, '{invalid');
  assert.equal(readWorkspace(target), null);
  target.setItem(WORKSPACE_KEY, JSON.stringify({ version: 999 }));
  assert.equal(readWorkspace(target), null);
  const unavailable = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  assert.equal(saveWorkspace(unavailable, workspace()), false);
  assert.equal(readWorkspace(unavailable), null);
  const invalid = workspace();
  invalid.answers = [{ apiKey: 'bad' }];
  assert.equal(saveWorkspace(target, invalid), false);
});

test('workspace reset removes only this app workspace', () => {
  const target = storage();
  target.setItem('unrelated', 'keep');
  saveWorkspace(target, workspace());
  assert.equal(clearWorkspace(target), true);
  assert.equal(readWorkspace(target), null);
  assert.equal(target.getItem('unrelated'), 'keep');
});

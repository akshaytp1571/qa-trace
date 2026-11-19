import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compilePlan } from '../src/plan.mjs';
import { demoDocument, demoDraft } from '../src/demo.mjs';

test('a scenario with an uncovered linked requirement is partial rather than ready', () => {
  const draft = demoDraft();
  draft.scenarios[1].requirementIds.push('REQ-06');
  const plan = compilePlan(draft, demoDocument);
  assert.equal(plan.scenarios[1].status, 'partial');
});

test('native form fallback keeps sensitive values out of URL history and picker matches accepted formats', async () => {
  const markup = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(markup, /<form[^>]*method="post"/u);
  assert.match(markup, /accept="\.txt,\.md,\.docx,\.pdf"/u);
});

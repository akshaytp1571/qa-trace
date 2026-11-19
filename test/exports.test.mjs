import test from 'node:test';
import assert from 'node:assert/strict';
import { exportFile, matrixCsv, planMarkdown } from '../public/exports.js';
import { getDemo } from '../src/demo.mjs';

const options = { kind: 'example', sourceName: 'refunds.md' };

test('CSV exports the derived requirement links with spreadsheet formula protection', () => {
  const { analysis } = getDemo();
  analysis.requirements[0].statement = ' =WEBSERVICE("untrusted")';
  const csv = matrixCsv(analysis);
  assert.ok(csv.startsWith('\ufeff"Requirement ID"'));
  assert.ok(csv.includes(`"' =WEBSERVICE(""untrusted"")"`));
  assert.ok(csv.includes('TC-01, TC-02, TC-03'));
  assert.ok(csv.endsWith('\r\n'));
});

test('Markdown contains all evidence and recommendations and escapes model-provided markup', () => {
  const { analysis } = getDemo();
  analysis.title = '<img src=x onerror=alert(1)>';
  const report = planMarkdown(analysis, options);
  assert.ok(report.includes('&lt;img'));
  assert.ok(!report.includes('<img'));
  assert.ok(report.includes('## Traceability matrix'));
  assert.ok(report.includes('## Clarifications'));
  assert.ok(report.includes('Awaiting clarification'));
  assert.ok(report.includes('Regression'));
  assert.ok(report.includes('Line') || report.includes('L2'));
});

test('Markdown and JSON retain reviewed answer history and parent links', () => {
  const { analysis } = getDemo();
  analysis.clarificationAnswers = [{ id: 'ANS-01', question: 'Which cutoff?', answer: 'Day 30 is inclusive.', parentAnswerId: null }];
  analysis.answerReviews = [{ answerId: 'ANS-01', status: 'follow-up', reason: 'Time zone is still open.' }];
  analysis.ambiguities[0].parentAnswerId = 'ANS-01';
  const markdown = planMarkdown(analysis, options);
  assert.ok(markdown.includes('## Answer history'));
  assert.ok(markdown.includes('Day 30 is inclusive'));
  assert.ok(markdown.includes('Time zone is still open'));
  assert.ok(markdown.includes('Follow-up to answer'));
  const report = JSON.parse(exportFile('json', analysis, options).contents);
  assert.equal(report.analysis.clarificationAnswers[0].answer, 'Day 30 is inclusive.');
  assert.equal(report.analysis.ambiguities[0].parentAnswerId, 'ANS-01');
});

test('JSON export includes only intended report metadata and analysis', () => {
  const { analysis } = getDemo();
  const file = exportFile('json', analysis, { ...options, apiKey: 'never-export-key', document: 'private-source' });
  const parsed = JSON.parse(file.contents);
  assert.deepEqual(Object.keys(parsed), ['schemaVersion', 'sourceName', 'kind', 'analysis']);
  assert.equal(parsed.analysis.cases[2].status, 'blocked');
  assert.ok(!file.contents.includes('never-export-key'));
  assert.ok(!file.contents.includes('private-source'));
  assert.equal(file.name, 'refund-requests-plan.json');
});

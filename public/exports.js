const list = (values) => values.join(', ');
const source = (refs) => refs.map(({ line, quote }) => `L${line} ${quote}`).join(' | ');

function csvCell(value) {
  let text = String(value ?? '');
  if (/^\s*[=+\-@]/u.test(text) || /^[\t\r]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function matrixCsv(plan) {
  const header = ['Requirement ID', 'Requirement', 'Priority', 'Status', 'Source excerpts', 'Scenario IDs', 'Test case IDs', 'Clarification IDs'];
  const rows = plan.requirements.map((item) => [
    item.id, item.statement, item.priority, item.status, source(item.evidence),
    list(item.scenarioIds), list(item.caseIds), list(item.ambiguityIds),
  ]);
  return '\ufeff' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function md(value) {
  return String(value).replace(/\s+/gu, ' ').trim()
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~\-]/gu, '\\$&');
}

const mdList = (values) => values.length ? values.map(md).join(', ') : 'None';
const modeLabel = (options) => options.kind === 'example' ? 'Example analysis' : 'AI draft · human review required';

export function planMarkdown(plan, options) {
  const output = [`# ${md(plan.title)}`, '', modeLabel(options), '', `Source — ${md(options.sourceName)}`, ''];
  output.push('## Traceability matrix', '', '| ID | Requirement | Priority | Status | Source excerpts | Scenarios | Cases | Clarifications |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of plan.requirements) {
    output.push(`| ${[row.id, row.statement, row.priority, row.status, source(row.evidence)].map(md).join(' | ')} | ${mdList(row.scenarioIds)} | ${mdList(row.caseIds)} | ${mdList(row.ambiguityIds)} |`);
  }
  output.push('', '## Scenarios', '');
  for (const item of plan.scenarios) {
    output.push(`### ${md(item.id)} · ${md(item.title)}`, '', md(item.description), '',
      `- Requirements — ${mdList(item.requirementIds)}`, `- Test cases — ${mdList(item.caseIds)}`, `- Status — ${md(item.status)}`, '');
  }
  output.push('## Test cases', '');
  for (const item of plan.cases) {
    output.push(`### ${md(item.id)} · ${md(item.title)}`, '', `- Scenario — ${md(item.scenarioId)}`, `- Requirements — ${mdList(item.requirementIds)}`,
      `- Status — ${md(item.status)} · ${md(item.priority)} priority · ${md(item.kind)}`,
      `- Clarifications — ${mdList(item.ambiguityIds)}`, `- Preconditions — ${mdList(item.preconditions)}`, `- Test data — ${md(item.testData)}`, '');
    item.steps.forEach(({ action, expected }, index) => {
      output.push(`${index + 1}. ${md(action)}  `, `   Expected — ${expected === null ? 'Awaiting clarification' : md(expected)}`);
    });
    output.push('', `**Expected outcome** — ${item.expectedResult === null ? 'Awaiting clarification' : md(item.expectedResult)}`, '',
      `- Regression — ${md(item.regression.recommendation)}. ${md(item.regression.reason)}`,
      `- Automation — ${md(item.automation.recommendation)}${item.automation.layer ? ` (${md(item.automation.layer)})` : ''}. ${md(item.automation.reason)}`, '');
  }
  output.push('## Clarifications', '');
  for (const item of plan.ambiguities) {
    output.push(`### ${md(item.id)} · ${md(item.question)}`, '', `- Impact — ${md(item.impact)}`,
      `- Type — ${md(item.kind)}${item.blocking ? ' · blocking' : ''}`, `- Requirements — ${mdList(item.requirementIds)}`,
      `- Dependent tests — ${mdList(item.caseIds)}`, `- Source — ${md(source(item.evidence))}`,
      ...(item.parentAnswerId ? [`- Follow-up to answer — ${md(item.parentAnswerId)}`] : []), '');
  }
  if (plan.clarificationAnswers?.length) {
    output.push('## Answer history', '');
    for (const item of plan.clarificationAnswers) {
      const review = plan.answerReviews?.find(({ answerId }) => answerId === item.id);
      output.push(`### ${md(item.id)}`, '', `- Question — ${md(item.question)}`, `- Answer — ${md(item.answer)}`,
        ...(item.parentAnswerId ? [`- Parent answer — ${md(item.parentAnswerId)}`] : []),
        `- Draft review — ${review ? `${md(review.status)}. ${md(review.reason)}` : 'Awaiting review'}`, '');
    }
  }
  if (plan.scopeNotes.length) output.push('## Review notes', '', ...plan.scopeNotes.map((note) => `- ${md(note)}`), '');
  return output.join('\n');
}

export function exportFile(format, plan, options) {
  const stem = plan.title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 60) || 'qa-trace';
  if (format === 'csv') return { name: `${stem}-matrix.csv`, type: 'text/csv;charset=utf-8', contents: matrixCsv(plan) };
  if (format === 'markdown') return { name: `${stem}-plan.md`, type: 'text/markdown;charset=utf-8', contents: planMarkdown(plan, options) };
  if (format === 'json') {
    const { sourceName, kind } = options;
    const contents = JSON.stringify({ schemaVersion: 1, sourceName, kind, analysis: plan }, null, 2) + '\n';
    return { name: `${stem}-plan.json`, type: 'application/json;charset=utf-8', contents };
  }
  throw new Error('Unknown export format.');
}

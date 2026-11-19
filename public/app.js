import { exportFile } from './exports.js';
import { saveWorkspace, readWorkspace, clearWorkspace } from './workspace.js';

const byId = (id) => document.getElementById(id);
const ui = {
  source: byId('document'), sourceName: byId('document-name'), count: byId('character-count'),
  file: byId('file-input'), drop: byId('drop-zone'), upload: byId('upload-button'), clear: byId('clear-source'),
  demo: byId('demo-button'), form: byId('analysis-form'), provider: byId('provider'), model: byId('model'),
  modelHint: byId('model-hint'), key: byId('api-key'), reveal: byId('toggle-key'),
  gatewayFields: byId('gateway-fields'), baseUrl: byId('base-url'), outputMode: byId('output-mode'),
  timeoutSeconds: byId('timeout-seconds'), outputTokens: byId('output-tokens'), progress: byId('request-progress'),
  analyze: byId('analyze-button'), cancel: byId('cancel-button'), feedback: byId('feedback'),
  panel: byId('results-panel'), title: byId('results-title'), label: byId('result-label'),
  exports: byId('export-menu'), stale: byId('stale-note'), empty: byId('empty-state'), body: byId('result-body'),
  metrics: byId('metrics'), tabs: byId('tabs'), view: byId('view'),
  sourceDialog: byId('source-dialog'), excerpt: byId('source-excerpt'),
};

const state = {
  plan: null, analyzedText: '', sourceName: '', planSourceName: '', kind: '',
  tab: 'matrix', caseFilter: 'all', busy: false, operation: null, providers: [],
  maxDocumentChars: 24000, maxUploadBytes: 5 * 1024 * 1024,
  requestLimits: {
    native: { timeoutSeconds: 90 },
    gateway: { timeoutSeconds: { default: 300, min: 30, max: 300 }, maxOutputTokens: { default: 16384, min: 1024, max: 16384 } },
  },
  progressTimer: null,
  analyzedDocument: '', answers: [], analyzedAnswers: [], drafts: [], bindings: [],
};

const statusLabels = {
  ready: 'Ready', partial: 'Partial', blocked: 'Blocked', uncovered: 'Uncovered',
  high: 'High', medium: 'Medium', low: 'Low', include: 'Include', exclude: 'Exclude',
  review: 'Review', defer: 'Defer', automate: 'Automate', manual: 'Manual',
};
const tones = {
  ready: 'green', include: 'green', automate: 'green', partial: 'amber', review: 'amber',
  blocked: 'red', defer: 'red', high: 'violet',
};
const layerLabels = { api: 'API', ui: 'UI', unit: 'Unit', integration: 'Integration' };
const questionKinds = { 'missing-detail': 'Missing detail', 'vague-language': 'Vague language', conflict: 'Conflict' };

function element(tag, className, content) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (content !== undefined) item.textContent = content;
  return item;
}

function badge(value) {
  const item = element('span', 'badge', statusLabels[value] ?? value);
  if (tones[value]) item.dataset.tone = tones[value];
  return item;
}

function feedback(message = '', kind = '') {
  ui.feedback.hidden = !message;
  ui.feedback.dataset.kind = kind;
  ui.feedback.textContent = message;
  const localStatus = byId('clarification-status');
  if (localStatus) {
    localStatus.textContent = message;
    localStatus.hidden = !message;
    localStatus.dataset.kind = kind;
  }
}

function persistWorkspace() {
  let stored = false;
  try {
    stored = saveWorkspace(sessionStorage, {
      document: ui.source.value, analyzedDocument: state.analyzedDocument, analyzedText: state.analyzedText,
      sourceName: state.sourceName, planSourceName: state.planSourceName, kind: state.kind, tab: state.tab,
      answers: state.answers, analyzedAnswers: state.analyzedAnswers, drafts: state.drafts, bindings: state.bindings, plan: state.plan,
    });
  } catch { /* Storage may be unavailable; in-memory answers still work. */ }
  byId('workspace-note').textContent = stored
    ? 'Requirements, answers and the last plan are saved in this tab. Connection settings and API keys are never saved.'
    : 'Answers are kept in memory. Tab storage is unavailable; export the reviewed plan before closing this page.';
}

function questionKey(question) {
  return JSON.stringify([question.question, question.parentAnswerId ?? null, question.evidence]);
}

function draftText(key, fallback = '') {
  return state.drafts.find((item) => item.key === key)?.text ?? fallback;
}

function setDraft(key, text) {
  const entry = state.drafts.find((item) => item.key === key);
  if (entry) entry.text = text;
  else if (state.drafts.length < 180) state.drafts.push({ key, text });
  updateSourceState();
}

function savedForQuestion(question) {
  const id = state.bindings.find((item) => item.key === questionKey(question))?.answerId;
  return state.answers.find((item) => item.id === id);
}

function saveAnswer(question, text, existing) {
  const answer = text.trim().replace(/\r\n?/gu, '\n');
  if (!answer || answer.length > 1500) {
    feedback('Enter an answer of up to 1,500 characters.', 'error');
    return false;
  }
  const key = questionKey(question);
  let record = existing || savedForQuestion(question);
  if (record) record.answer = answer;
  else {
    if (state.answers.length >= 60) {
      feedback('This document has 60 saved answers. Start a new document for another section.', 'error');
      return false;
    }
    const next = Math.max(0, ...state.answers.map(({ id }) => Number(id.slice(4)))) + 1;
    const item = { id: `ANS-${String(next).padStart(2, '0')}`, question: question.question, answer, parentAnswerId: question.parentAnswerId ?? null };
    state.answers.push(item);
    record = item;
    state.bindings.push({ key, answerId: item.id });
  }
  const aliases = new Set([key, `answer:${record.id}`, `history:${record.id}`,
    ...state.bindings.filter((item) => item.answerId === record.id).map((item) => item.key)]);
  state.drafts = state.drafts.filter((item) => !aliases.has(item.key));
  updateSourceState();
  return true;
}

function saveTypedAnswers() {
  for (const item of state.plan?.ambiguities || []) {
    const saved = savedForQuestion(item);
    const text = draftText(saved ? `answer:${saved.id}` : questionKey(item));
    if (text.trim() && !saveAnswer(item, text, saved)) return false;
  }
  for (const item of state.answers) {
    const text = draftText(`answer:${item.id}`);
    if (text.trim() && !saveAnswer({ question: item.question, parentAnswerId: item.parentAnswerId, evidence: [] }, text, item)) return false;
  }
  return true;
}

function updateSourceState() {
  ui.sourceName.textContent = state.sourceName || 'Pasted text';
  ui.sourceName.title = state.sourceName;
  ui.count.textContent = `${ui.source.value.length.toLocaleString()} / ${state.maxDocumentChars.toLocaleString()}`;
  const hasDraftChanges = state.drafts.some(({ key, text }) => {
    const id = key.startsWith('answer:') ? key.slice(7)
      : key.startsWith('history:') ? key.slice(8) : state.bindings.find((item) => item.key === key)?.answerId;
    const saved = state.answers.find((item) => item.id === id)?.answer || '';
    return text.trim() && text.trim() !== saved;
  });
  const stale = state.plan && (ui.source.value.trim().replace(/\r\n?/gu, '\n') !== state.analyzedDocument
    || hasDraftChanges || JSON.stringify(state.answers) !== JSON.stringify(state.analyzedAnswers));
  ui.stale.hidden = !stale;
  ui.exports.hidden = !state.plan || Boolean(stale);
  if (ui.exports.hidden) ui.exports.open = false;
  persistWorkspace();
}

function setSource(text, label) {
  ui.source.value = text;
  state.sourceName = label;
  updateSourceState();
}

function stopWaiting() {
  clearInterval(state.progressTimer);
  state.progressTimer = null;
  ui.progress.hidden = true;
}

function startWaiting(timeoutSeconds) {
  stopWaiting();
  const started = performance.now();
  const update = () => {
    const elapsed = Math.floor((performance.now() - started) / 1000);
    const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const seconds = String(elapsed % 60).padStart(2, '0');
    ui.progress.textContent = `Elapsed ${minutes}:${seconds} · app limit ${timeoutSeconds} seconds`;
  };
  update();
  ui.progress.hidden = false;
  state.progressTimer = setInterval(update, 1000);
}

function setBusy(kind = '') {
  state.busy = Boolean(kind);
  for (const control of [ui.source, ui.file, ui.upload, ui.clear, ui.demo, ui.provider, ui.model, ui.baseUrl, ui.outputMode, ui.timeoutSeconds, ui.outputTokens, ui.key, ui.reveal, ui.analyze]) {
    control.disabled = state.busy;
  }
  for (const control of ui.view.querySelectorAll('[data-workspace-control]')) control.disabled = state.busy;
  byId('reset-workspace').disabled = state.busy;
  const clarificationCancel = byId('clarification-cancel');
  if (clarificationCancel) clarificationCancel.hidden = kind !== 'analysis';
  ui.cancel.hidden = kind !== 'analysis';
  ui.panel.setAttribute('aria-busy', String(state.busy));
}

async function json(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

function addLinkGroup(ids, target) {
  if (!ids.length) return element('span', 'decision-reason', '—');
  const group = element('div', 'links');
  for (const id of ids) {
    const button = element('button', 'link-chip', id);
    button.type = 'button';
    button.addEventListener('click', () => openTab(target, id));
    group.append(button);
  }
  return group;
}

function openSource({ line, quote }) {
  const text = state.analyzedText.split('\n')[line - 1] || quote;
  const start = text.indexOf(quote);
  const block = element('blockquote', 'source-text');
  block.append(text.slice(0, start), element('mark', '', quote), text.slice(start + quote.length));
  byId('source-title').textContent = `Source line ${line}`;
  ui.excerpt.replaceChildren(block);
  ui.sourceDialog.showModal();
}

function addSourceGroup(refs) {
  const group = element('div', 'links');
  for (const ref of refs) {
    const button = element('button', 'source-link', `Line ${ref.line}`);
    button.type = 'button';
    button.setAttribute('aria-label', `Line ${ref.line}`);
    button.title = ref.quote;
    button.addEventListener('click', () => openSource(ref));
    group.append(button);
  }
  return group;
}

function addTable(headers, className) {
  const container = element('div', 'table-scroll');
  container.tabIndex = 0;
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', className === 'matrix-table' ? 'Requirement links' : 'Case recommendations');
  const table = element('table', className);
  const row = table.createTHead().insertRow();
  for (const label of headers) {
    const cell = element('th', '', label);
    cell.scope = 'col';
    row.append(cell);
  }
  const body = table.createTBody();
  const hint = element('p', 'table-hint', 'Scroll sideways to explore all linked evidence →');
  container.append(hint, table);
  ui.view.append(container);
  return body;
}

function addCells(parent, ...content) {
  for (const value of content) parent.insertCell().append(value);
}

function addIntro(text) {
  const intro = element('div', 'view-intro');
  intro.append(element('p', '', text));
  ui.view.append(intro);
  return intro;
}

function addScopeNotes(notes) {
  if (!notes.length) return;
  const area = element('div', 'scope-notes');
  const list = element('ul');
  for (const note of notes) list.append(element('li', '', note));
  area.append(element('strong', '', 'Review notes'), list);
  ui.view.append(area);
}

function drawMatrix(plan) {
  if (!plan.requirements.length) {
    ui.view.append(element('p', 'view-empty', 'No testable requirements were extracted. Add concrete acceptance criteria and analyze again.'));
    addScopeNotes(plan.scopeNotes);
    return;
  }
  addIntro('Open a source line or follow an ID to review the mapped evidence.');
  const table = addTable(['Requirement', 'Status', 'Scenarios', 'Test cases', 'Clarifications'], 'matrix-table');
  for (const item of plan.requirements) {
    const row = table.insertRow();
    row.id = item.id;
    const main = element('div');
    main.append(element('span', 'mono-id', item.id), element('span', 'statement', item.statement), addSourceGroup(item.evidence));
    addCells(row, main, badge(item.status), addLinkGroup(item.scenarioIds, 'scenarios'),
      addLinkGroup(item.caseIds, 'cases'), addLinkGroup(item.ambiguityIds, 'questions'));
  }
  addScopeNotes(plan.scopeNotes);
}

function cardHeader(id, ...labels) {
  const header = element('div', 'card-meta');
  header.append(element('span', 'mono-id', id), ...labels.map(badge));
  return header;
}

function cardList() {
  const cards = element('div', 'card-list');
  ui.view.append(cards);
  return cards;
}

function drawScenarios(plan) {
  addIntro('Open the linked requirements and cases for each scenario.');
  if (!plan.scenarios.length) {
    ui.view.append(element('p', 'view-empty', 'No scenarios were drafted.'));
    return;
  }
  const cards = cardList();
  for (const item of plan.scenarios) {
    const card = element('article', 'result-card');
    card.id = item.id;
    card.tabIndex = -1;
    card.append(cardHeader(item.id, item.status), element('h3', '', item.title), element('p', '', item.description),
      addLinkGroup(item.requirementIds, 'matrix'), addLinkGroup(item.caseIds, 'cases'));
    cards.append(card);
  }
}

function addCaseFilter(intro) {
  const group = element('div', 'filter-group');
  const label = element('label', '', 'Status');
  const select = element('select');
  select.id = 'case-filter';
  label.htmlFor = select.id;
  for (const [value, title] of [['all', 'All'], ['ready', 'Ready'], ['blocked', 'Blocked']]) {
    select.append(new Option(title, value));
  }
  select.value = state.caseFilter;
  select.addEventListener('change', () => {
    state.caseFilter = select.value;
    openTab('cases');
    byId('case-filter').focus();
  });
  group.append(label, select);
  intro.append(group);
}

function drawCases(plan) {
  const intro = addIntro('Expand a case to see setup, test data, steps, and expected results.');
  addCaseFilter(intro);
  const cases = plan.cases.filter((item) => state.caseFilter === 'all' || state.caseFilter === item.status);
  if (!cases.length) {
    ui.view.append(element('p', 'view-empty', 'No test cases match this view.'));
    return;
  }
  const cards = cardList();
  for (const item of cases) {
    const card = element('details', 'result-card');
    card.id = item.id;
    const summary = element('summary', 'case-summary');
    const heading = element('div');
    heading.append(cardHeader(item.id, item.status, `${statusLabels[item.priority]} priority`, item.kind), element('h3', '', item.title));
    const arrow = element('span', 'case-arrow', '⌄');
    arrow.setAttribute('aria-hidden', 'true');
    summary.append(heading, arrow);
    const details = element('div', 'detail-body');
    const preconditions = element('ul');
    for (const text of item.preconditions.length ? item.preconditions : ['No additional preconditions.']) {
      preconditions.append(element('li', '', text));
    }
    const steps = element('ol');
    for (const step of item.steps) {
      const row = element('li', '', step.action);
      row.append(element('span', step.expected ? 'step-expected' : 'step-expected unresolved',
        step.expected ? `Expected — ${step.expected}` : 'Expected result pending clarification.'));
      steps.append(row);
    }
    details.append(element('h4', '', 'Preconditions'), preconditions, element('h4', '', 'Test data'), element('p', '', item.testData),
      element('h4', '', 'Steps'), steps, element('h4', '', 'Expected outcome'),
      element('p', item.expectedResult ? '' : 'unresolved', item.expectedResult || 'Awaiting clarification.'),
      addLinkGroup(item.requirementIds, 'matrix'), addLinkGroup([item.scenarioId], 'scenarios'));
    if (item.ambiguityIds.length) details.append(addLinkGroup(item.ambiguityIds, 'questions'));
    card.append(summary, details);
    cards.append(card);
  }
}

function workspaceControl(control) {
  control.dataset.workspaceControl = 'true';
  control.disabled = state.busy;
  return control;
}

function clarificationEditor(question, savedRecord) {
  const saved = savedRecord || savedForQuestion(question);
  const key = saved ? `answer:${saved.id}` : questionKey(question);
  const box = element('details', 'clarification-form');
  const label = element('label', '', 'Your answer');
  const answer = workspaceControl(element('textarea'));
  const button = workspaceControl(element('button', 'button outline', saved ? 'Update answer' : 'Save answer'));
  const note = element('p', 'field-hint', saved ? `Saved as ${saved.id}. Reanalyze to review changes.` : 'Typed answers are kept when you switch views.');
  note.setAttribute('role', 'status');
  answer.id = savedRecord ? `edit-${savedRecord.id}` : `answer-${question.id}`;
  answer.maxLength = 1500;
  answer.rows = 2;
  answer.value = draftText(key, saved?.answer || '');
  answer.addEventListener('input', () => setDraft(key, answer.value));
  label.htmlFor = answer.id;
  button.type = 'button';
  button.addEventListener('click', () => {
    if (state.busy) return;
    if (!saveAnswer(question, answer.value, savedRecord)) { answer.focus(); return; }
    note.textContent = 'Answer saved. Select Analyze with answers to review it and check for follow-up questions.';
    if (state.tab === 'questions') openTab('questions');
  });
  const analyze = workspaceControl(element('button', 'button outline', 'Save and analyze'));
  analyze.type = 'button';
  analyze.addEventListener('click', () => {
    if (state.busy || !saveAnswer(question, answer.value, savedRecord)) return;
    void runAnalysis(true);
  });
  const actions = element('div', 'clarification-actions');
  actions.append(button, analyze);
  box.append(element('summary', '', savedRecord ? 'Edit saved answer' : saved ? 'Review your answer' : 'Add an answer'), label, answer, actions, note);
  return box;
}

function drawAnswerHistory(plan) {
  if (!state.answers.length) return;
  const section = element('section', 'answer-history');
  section.append(element('h3', '', 'Answer history'));
  const cards = element('div', 'card-list');
  for (const item of state.answers) {
    const card = element('article', 'result-card');
    card.id = `history-${item.id}`;
    card.tabIndex = -1;
    const analyzed = state.analyzedAnswers.find(({ id }) => id === item.id);
    const changed = !analyzed || analyzed.answer !== item.answer || analyzed.question !== item.question;
    const review = plan.answerReviews?.find(({ answerId }) => answerId === item.id);
    const status = changed ? 'Awaiting analysis' : review?.status === 'follow-up' ? 'Follow-up needed' : review ? 'Resolved in this draft' : 'Awaiting analysis';
    card.append(cardHeader(item.id, status), element('h3', '', item.question), element('p', 'saved-answer', item.answer));
    if (item.parentAnswerId) card.append(answerLink(item.parentAnswerId, `Reply to ${item.parentAnswerId}`));
    if (!changed && review) card.append(element('p', 'decision-reason', review.reason));
    const followups = plan.ambiguities.filter((question) => question.parentAnswerId === item.id);
    for (const question of followups) card.append(addLinkGroup([question.id], 'questions'));
    card.append(clarificationEditor({ question: item.question, parentAnswerId: item.parentAnswerId, evidence: [] }, item));
    cards.append(card);
  }
  section.append(cards);
  ui.view.append(section);
}

function answerLink(id, text = `Follow-up to ${id}`) {
  const link = element('button', 'link-chip', text);
  link.type = 'button';
  link.addEventListener('click', () => openTab('questions', `history-${id}`));
  return link;
}

function drawQuestions(plan) {
  const toolbar = element('div', 'clarification-toolbar');
  const actions = element('div', 'clarification-actions');
  const analyze = workspaceControl(element('button', 'button primary', 'Analyze with answers'));
  analyze.type = 'button';
  analyze.addEventListener('click', () => runAnalysis(true));
  const cancel = element('button', 'button outline', 'Cancel analysis');
  cancel.id = 'clarification-cancel';
  cancel.type = 'button';
  cancel.hidden = !state.operation;
  cancel.addEventListener('click', () => state.operation?.abort());
  const status = element('p', 'feedback', ui.feedback.textContent);
  status.id = 'clarification-status';
  status.hidden = ui.feedback.hidden;
  status.dataset.kind = ui.feedback.dataset.kind || '';
  status.setAttribute('role', 'status');
  actions.append(analyze, cancel);
  toolbar.append(element('p', '', 'Add answers below, then analyze here. All typed answers are saved before the request.'), actions, status);
  ui.view.append(toolbar);
  if (!plan.ambiguities.length) ui.view.append(element('p', 'view-empty', 'No open clarification questions in this draft. Your previous answers remain below.'));
  else {
    const cards = cardList();
    for (const item of plan.ambiguities) {
      const card = element('article', 'result-card');
      card.id = item.id;
      card.tabIndex = -1;
      const saved = savedForQuestion(item);
      card.append(cardHeader(item.id, saved ? 'Answer saved' : item.blocking ? 'blocked' : 'review', questionKinds[item.kind]),
        element('h3', '', item.question), element('p', '', item.impact));
      if (item.parentAnswerId) card.append(answerLink(item.parentAnswerId));
      card.append(addSourceGroup(item.evidence), addLinkGroup(item.requirementIds, 'matrix'));
      if (item.caseIds.length) card.append(addLinkGroup(item.caseIds, 'cases'));
      card.append(clarificationEditor(item));
      cards.append(card);
    }
  }
  drawAnswerHistory(plan);
}

function decision(advice) {
  const block = element('div');
  block.append(badge(advice.recommendation));
  if (advice.layer) block.append(` ${layerLabels[advice.layer]}`);
  block.append(element('span', 'decision-reason', advice.reason));
  return block;
}

function drawRecommendations(plan) {
  addIntro('Review the regression and automation recommendations before adopting them.');
  if (!plan.cases.length) {
    ui.view.append(element('p', 'view-empty', 'No test cases to prioritize.'));
    return;
  }
  const table = addTable(['Test case', 'Regression', 'Automation'], 'decision-table');
  for (const item of plan.cases) {
    const row = table.insertRow();
    const main = element('div');
    main.append(element('span', 'statement', item.title), addLinkGroup([item.id], 'cases'));
    addCells(row, main, decision(item.regression), decision(item.automation));
  }
}

const renderViews = { matrix: drawMatrix, scenarios: drawScenarios, cases: drawCases, questions: drawQuestions, recommendations: drawRecommendations };
const tabButtons = [...ui.tabs.querySelectorAll('button')];

function openTab(name, target) {
  if (!state.plan) return;
  if (target && name === 'cases') state.caseFilter = 'all';
  state.tab = name;
  for (const tab of tabButtons) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  ui.view.setAttribute('aria-labelledby', `tab-${name}`);
  ui.view.replaceChildren();
  renderViews[name](state.plan);
  persistWorkspace();
  if (target) {
    const item = byId(target);
    if (!item) return;
    item.classList.add('is-target');
    if (item.tagName === 'DETAILS') item.open = true;
    if (item.tagName === 'TR') item.tabIndex = -1;
    (item.querySelector('summary') || item).focus({ preventScroll: true });
    item.scrollIntoView({ block: 'nearest' });
  }
}

function addMetric(value, label) {
  const box = element('div', 'metric');
  box.append(element('strong', 'metric-value', value), element('span', 'metric-label', label));
  ui.metrics.append(box);
}

function showPlan({ document: source, sourceDocument, analysis }, kind, label, tab = 'matrix') {
  state.plan = analysis;
  state.analyzedDocument = source;
  state.analyzedText = sourceDocument || source;
  state.answers = structuredClone(analysis.clarificationAnswers || []);
  state.analyzedAnswers = structuredClone(state.answers);
  state.planSourceName = label;
  state.kind = kind;
  state.caseFilter = 'all';
  setSource(source, label);
  ui.title.textContent = analysis.title;
  ui.label.textContent = kind === 'example' ? 'Example analysis' : 'AI draft · Review before use';
  ui.empty.hidden = true;
  ui.body.hidden = false;
  ui.metrics.replaceChildren();
  addMetric(analysis.requirements.length, 'Requirements');
  addMetric(analysis.cases.length, 'Test cases');
  addMetric(analysis.cases.filter((item) => item.status === 'ready').length, 'Ready cases');
  addMetric(analysis.ambiguities.length, 'Open questions');
  openTab(tab);
}

async function loadExample() {
  if (state.busy) return;
  setBusy('example');
  feedback();
  try {
    const example = await json('/api/demo');
    state.drafts = [];
    state.bindings = [];
    showPlan(example, 'example', 'Refund requests.md');
  } catch (error) {
    feedback(error.message, 'error');
    if (!state.plan) ui.empty.textContent = 'The example could not be loaded. Try Load example again.';
  } finally {
    setBusy();
  }
}

async function uploadFile(file) {
  if (!file || state.busy) return;
  if (file.size > state.maxUploadBytes) {
    feedback('The file exceeds 5 MB. Upload a smaller document.', 'error');
    return;
  }
  setBusy('extract');
  feedback('Extracting text locally…');
  try {
    const data = await json('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': encodeURIComponent(file.name) },
      body: file,
    });
    setSource(data.document, file.name);
    feedback('Document loaded. Review the extracted text before analysis.', 'success');
  } catch (error) {
    feedback(error.message, 'error');
  } finally {
    setBusy();
    ui.file.value = '';
  }
}

function revealControl(control) {
  let container = control.parentElement;
  while (container) {
    if (container.tagName === 'DETAILS') container.open = true;
    container = container.parentElement;
  }
  control.focus();
}

function updateConnectionCaption() {
  const provider = state.providers.find(({ id }) => id === ui.provider.value);
  const ready = provider && (provider.id === 'gateway'
    ? ui.baseUrl.value.trim() && ui.model.value.trim()
    : ui.key.value.trim());
  const prompt = byId('configure-connection');
  prompt.dataset.configured = String(Boolean(ready));
  byId('connection-caption').textContent = ready ? `${provider.label} settings entered` : 'Set up your AI connection';
}

function concealKey() {
  ui.key.type = 'password';
  ui.reveal.textContent = 'Show';
  ui.reveal.setAttribute('aria-label', 'Show API key');
  ui.reveal.setAttribute('aria-pressed', 'false');
}

function selectProvider() {
  const provider = state.providers.find(({ id }) => id === ui.provider.value);
  const isGateway = provider?.id === 'gateway';
  ui.model.value = '';
  ui.key.value = '';
  ui.baseUrl.value = '';
  ui.outputMode.value = 'json_object';
  ui.timeoutSeconds.value = String(state.requestLimits.gateway.timeoutSeconds.default);
  ui.outputTokens.value = String(state.requestLimits.gateway.maxOutputTokens.default);
  concealKey();
  ui.gatewayFields.hidden = !isGateway;
  document.querySelector('.model-details').open = isGateway;
  ui.model.maxLength = isGateway ? 256 : 128;
  ui.model.placeholder = isGateway ? 'Exact model ID, e.g. provider/model-name' : provider?.defaultModel || '';
  ui.modelHint.textContent = isGateway ? 'Use the exact model ID available through your gateway.'
    : provider ? `Default model · ${provider.defaultModel}` : 'Choose a provider before analyzing.';
  document.querySelector('label[for="api-key"]').textContent = isGateway ? 'API key (optional)' : 'API key';
  byId('key-hint').textContent = isGateway
    ? 'Your text and any key are sent to this gateway for analysis. Settings stay in this tab.'
    : 'QA Trace keeps the key in this tab. Analysis sends your text to the selected provider.';
  updateConnectionCaption();
}

async function runAnalysis(fromClarifications = false) {
  if (state.busy) return;
  if (!saveTypedAnswers()) return;
  if (!ui.source.value.trim()) {
    feedback('Upload or paste requirements before analysis.', 'error');
    ui.source.focus();
    return;
  }
  const isGateway = ui.provider.value === 'gateway';
  if (!ui.provider.value || (!isGateway && !ui.key.value.trim())) {
    feedback('Select an AI provider and enter its API key. Load example works without a key.', 'error');
    revealControl(ui.provider.value ? ui.key : ui.provider);
    return;
  }
  if (isGateway && !ui.baseUrl.value.trim()) {
    feedback('Enter the base URL for your OpenAI-compatible gateway.', 'error');
    revealControl(ui.baseUrl);
    return;
  }
  if (isGateway && !ui.model.value.trim()) {
    feedback('Enter the exact model ID available through your gateway.', 'error');
    document.querySelector('.model-details').open = true;
    revealControl(ui.model);
    return;
  }
  const tuning = {};
  if (isGateway) {
    for (const [name, input] of [['timeoutSeconds', ui.timeoutSeconds], ['maxOutputTokens', ui.outputTokens]]) {
      const limits = state.requestLimits.gateway[name];
      const value = input.valueAsNumber;
      if (!Number.isInteger(value) || value < limits.min || value > limits.max) {
        feedback(`${name === 'timeoutSeconds' ? 'Timeout' : 'Maximum output tokens'} must be an integer from ${limits.min.toLocaleString()} to ${limits.max.toLocaleString()}.`, 'error');
        document.querySelector('.request-details').open = true;
        revealControl(input);
        return;
      }
      tuning[name] = value;
    }
  }
  const operation = new AbortController();
  state.operation = operation;
  concealKey();
  setBusy('analysis');
  startWaiting(isGateway ? tuning.timeoutSeconds : state.requestLimits.native.timeoutSeconds);
  feedback('Drafting the test plan and checking source links…');
  try {
    const data = await json('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        document: ui.source.value, answers: state.answers, provider: ui.provider.value, model: ui.model.value.trim(), apiKey: ui.key.value.trim(),
        ...(isGateway ? { baseUrl: ui.baseUrl.value.trim(), outputMode: ui.outputMode.value, ...tuning } : {}),
      }),
      signal: operation.signal,
    });
    showPlan(data, 'draft', state.sourceName || 'Pasted requirements', fromClarifications ? 'questions' : state.tab);
    feedback('Draft ready for review.', 'success');
  } catch (error) {
    if (operation.signal.aborted) feedback('Analysis canceled.');
    else feedback(error.message, 'error');
  } finally {
    stopWaiting();
    state.operation = null;
    setBusy();
  }
}

ui.form.addEventListener('submit', (event) => {
  event.preventDefault();
  void runAnalysis();
});

function startNewDocument() {
  if (state.busy) return;
  try { clearWorkspace(sessionStorage); } catch { /* Keep reset available without storage. */ }
  state.plan = null;
  state.answers = [];
  state.analyzedAnswers = [];
  state.drafts = [];
  state.bindings = [];
  state.analyzedDocument = '';
  state.analyzedText = '';
  state.kind = '';
  state.tab = 'matrix';
  state.planSourceName = '';
  setSource('', '');
  ui.body.hidden = true;
  ui.empty.hidden = false;
  ui.empty.textContent = 'Upload or paste requirements to start a new plan.';
  ui.title.textContent = 'Test plan';
  ui.label.textContent = 'Analysis';
  ui.exports.hidden = true;
  ui.stale.hidden = true;
  feedback();
  ui.source.focus();
}
byId('reset-workspace').addEventListener('click', startNewDocument);

ui.source.addEventListener('input', updateSourceState);
ui.clear.addEventListener('click', () => {
  setSource('', '');
  feedback();
  ui.source.focus();
});
ui.demo.addEventListener('click', loadExample);
ui.cancel.addEventListener('click', () => state.operation?.abort());
ui.upload.addEventListener('click', () => ui.file.click());
ui.file.addEventListener('change', () => uploadFile(ui.file.files[0]));
ui.provider.addEventListener('change', selectProvider);
byId('configure-connection').addEventListener('click', () => {
  byId('connection-settings').open = true;
  revealControl(ui.provider);
});
for (const control of [ui.key, ui.baseUrl, ui.model]) control.addEventListener('input', updateConnectionCaption);
ui.reveal.addEventListener('click', () => {
  if (ui.key.type === 'text') concealKey();
  else {
    ui.key.type = 'text';
    ui.reveal.textContent = 'Hide';
    ui.reveal.setAttribute('aria-label', 'Hide API key');
    ui.reveal.setAttribute('aria-pressed', 'true');
  }
});

for (const name of ['dragenter', 'dragover']) {
  ui.drop.addEventListener(name, (event) => {
    event.preventDefault();
    if (!state.busy) ui.drop.classList.add('is-dragging');
  });
}
ui.drop.addEventListener('dragleave', (event) => {
  if (!ui.drop.contains(event.relatedTarget)) ui.drop.classList.remove('is-dragging');
});
ui.drop.addEventListener('drop', (event) => {
  event.preventDefault();
  ui.drop.classList.remove('is-dragging');
  uploadFile(event.dataTransfer.files[0]);
});

for (const tab of tabButtons) tab.addEventListener('click', () => openTab(tab.dataset.tab));
ui.tabs.addEventListener('keydown', (event) => {
  const index = tabButtons.indexOf(event.target);
  if (index < 0) return;
  const last = tabButtons.length - 1;
  const targets = { ArrowLeft: index === 0 ? last : index - 1, ArrowRight: index === last ? 0 : index + 1, Home: 0, End: last };
  const next = targets[event.key];
  if (typeof next !== 'number') return;
  event.preventDefault();
  const button = tabButtons[next];
  openTab(button.dataset.tab);
  button.focus();
});
byId('close-source').addEventListener('click', () => ui.sourceDialog.close());

ui.exports.addEventListener('click', (event) => {
  const format = event.target.dataset.export;
  if (!format || !state.plan || ui.exports.hidden) return;
  const file = exportFile(format, state.plan, { sourceName: state.planSourceName, kind: state.kind });
  const url = URL.createObjectURL(new Blob([file.contents], { type: file.type }));
  const link = element('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  ui.exports.open = false;
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

let restored;
try { restored = readWorkspace(sessionStorage); } catch { /* Storage can be disabled. */ }
if (restored) {
  const tab = Object.hasOwn(renderViews, restored.tab) ? restored.tab : 'matrix';
  if (restored.plan) {
    showPlan({ document: restored.analyzedDocument, sourceDocument: restored.analyzedText, analysis: restored.plan }, restored.kind, restored.planSourceName, tab);
  } else {
    ui.empty.textContent = 'Upload or paste requirements to start a plan.';
    ui.panel.setAttribute('aria-busy', 'false');
  }
  state.answers = restored.answers;
  state.analyzedAnswers = restored.analyzedAnswers;
  state.drafts = restored.drafts;
  state.bindings = restored.bindings;
  setSource(restored.document, restored.sourceName);
  if (state.plan) openTab(tab);
} else {
  await loadExample();
}
try {
  const options = await json('/api/options');
  state.providers = options.providers;
  state.maxDocumentChars = options.maxDocumentChars;
  state.maxUploadBytes = options.maxUploadBytes;
  if (options.requestLimits) state.requestLimits = options.requestLimits;
  for (const [name, input] of [['timeoutSeconds', ui.timeoutSeconds], ['maxOutputTokens', ui.outputTokens]]) {
    const limits = state.requestLimits.gateway[name];
    input.min = String(limits.min);
    input.max = String(limits.max);
  }
  ui.source.maxLength = state.maxDocumentChars;
  ui.provider.replaceChildren(...options.providers.map(({ id, label }) => new Option(label, id)));
  selectProvider();
  updateSourceState();
} catch (error) {
  feedback(`Provider settings could not be loaded. ${error.message}`, 'error');
}

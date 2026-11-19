export const WORKSPACE_KEY = 'qa-trace.workspace.v1';
const string = 'string';
const nullable = 'nullable';
const evidence = [{ line: 'number', quote: string }];
const answer = { id: string, question: string, answer: string, parentAnswerId: nullable };
const planShape = {
  title: string, scopeNotes: [string],
  requirements: [{ id: string, statement: string, priority: string, evidence, scenarioIds: [string], caseIds: [string], ambiguityIds: [string], status: string }],
  ambiguities: [{ id: string, requirementIds: [string], kind: string, blocking: 'boolean', question: string, impact: string, evidence, caseIds: [string], parentAnswerId: nullable }],
  scenarios: [{ id: string, requirementIds: [string], title: string, description: string, caseIds: [string], status: string }],
  cases: [{
    id: string, scenarioId: string, requirementIds: [string], ambiguityIds: [string], title: string, priority: string, kind: string,
    preconditions: [string], testData: string, steps: [{ action: string, expected: nullable }], expectedResult: nullable, status: string,
    regression: { recommendation: string, reason: string }, automation: { recommendation: string, layer: nullable, reason: string },
  }],
};

function clean(value, shape) {
  if (typeof shape === 'string') {
    if (shape === nullable) {
      if (value === null || typeof value === 'string') return value;
    } else if (typeof value === shape && (shape !== 'number' || Number.isFinite(value))) return value;
    throw new Error('Invalid workspace value.');
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value) || value.length > 500) throw new Error('Invalid workspace list.');
    return value.map((item) => clean(item, shape[0]));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workspace object.');
  return Object.fromEntries(Object.entries(shape).map(([key, child]) => [key, clean(value[key], child)]));
}

function cleanPlan(plan) {
  if (plan === null) return null;
  const result = clean(plan, planShape);
  result.clarificationAnswers = clean(plan.clarificationAnswers ?? [], [answer]);
  result.answerReviews = clean(plan.answerReviews ?? [], [{ answerId: string, status: string, reason: string }]);
  return result;
}

function snapshot(workspace) {
  const result = clean(workspace, {
    document: string, analyzedDocument: string, analyzedText: string, sourceName: string, planSourceName: string,
    kind: string, tab: string, answers: [answer], analyzedAnswers: [answer],
    drafts: [{ key: string, text: string }], bindings: [{ key: string, answerId: string }],
  });
  result.plan = cleanPlan(workspace.plan);
  result.version = 1;
  return result;
}

// Explicit allowlists above intentionally exclude all connection and request settings.
export function saveWorkspace(storage, workspace) {
  try {
    const json = JSON.stringify(snapshot(workspace));
    if (json.length > 3_000_000) return false;
    storage.setItem(WORKSPACE_KEY, json);
    return true;
  } catch { return false; }
}

export function readWorkspace(storage) {
  try {
    const raw = storage.getItem(WORKSPACE_KEY);
    if (!raw || raw.length > 3_000_000) return null;
    const value = JSON.parse(raw);
    if (value.version !== 1) return null;
    return snapshot(value);
  } catch { return null; }
}

export function clearWorkspace(storage) {
  try { storage.removeItem(WORKSPACE_KEY); return true; }
  catch { return false; }
}

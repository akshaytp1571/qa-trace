import { compilePlan } from './plan.mjs';

export const demoDocument = `# Refund requests
Customers can request a refund from the order details page within 30 calendar days of delivery.
Only delivered orders can be refunded. Guests cannot access the refund page.
A customer may submit only one refund request per order.
After submission, the refund request is Pending and its status is visible on the order details page.
A customer can cancel a Pending refund request. Approved requests cannot be cancelled.
The customer receives a confirmation email promptly after submission.
Support may reopen a cancelled request when appropriate.`;

const requirement = (id, statement, priority, line, quote) => ({
  id, statement, priority, evidence: [{ line, quote }],
});
const question = (id, requirementId, kind, text, impact, line, quote) => ({
  id, requirementIds: [requirementId], kind, parentAnswerId: null, blocking: true, question: text, impact,
  evidence: [{ line, quote }],
});
const scenario = (id, requirementIds, title, description) => ({ id, requirementIds, title, description });
const step = (action, expected) => ({ action, expected });

const cases = [
  {
    id: 'TC-01', scenarioId: 'SCN-01', requirementIds: ['REQ-01', 'REQ-02', 'REQ-04'], ambiguityIds: [],
    title: 'Request a refund for an eligible order', priority: 'high', kind: 'positive',
    preconditions: ['Signed-in customer owns a delivered order with no existing refund request.'],
    testData: 'Order A-100, delivered 10 calendar days ago.',
    steps: [
      step('Open the order details page as the customer.', 'The refund request flow is available.'),
      step('Submit the refund request.', 'The order details show the request as Pending.'),
    ],
    expectedResult: 'The order details show one Pending refund request.',
    regression: { recommendation: 'include', reason: 'This verifies the primary refund flow and the state the customer relies on.' },
    automation: { recommendation: 'automate', layer: 'ui', reason: 'The end-to-end check verifies both the entry point and the displayed status.' },
  },
  {
    id: 'TC-02', scenarioId: 'SCN-01', requirementIds: ['REQ-01'], ambiguityIds: [],
    title: 'Reject a request after the refund window', priority: 'high', kind: 'boundary',
    preconditions: ['Signed-in customer owns a delivered order with no existing refund request.'],
    testData: 'Order A-101, delivered 31 calendar days ago. Use a controlled clock.',
    steps: [
      step('Open the order details and attempt to request a refund if the option is visible.', 'No refund request can be created.'),
    ],
    expectedResult: 'The order still has no refund request.',
    regression: { recommendation: 'include', reason: 'Refund timing is a business rule with financial impact.' },
    automation: { recommendation: 'automate', layer: 'api', reason: 'A fixed clock and seeded order make the eligibility outcome repeatable.' },
  },
  {
    id: 'TC-03', scenarioId: 'SCN-01', requirementIds: ['REQ-01'], ambiguityIds: ['AMB-01'],
    title: 'Request a refund at the exact 30-day boundary', priority: 'high', kind: 'boundary',
    preconditions: ['Signed-in customer owns a delivered order with no refund request.'],
    testData: 'Order A-102, delivered exactly 30 calendar days ago.',
    steps: [step('Attempt to request a refund exactly at the boundary.', null)],
    expectedResult: null,
    regression: { recommendation: 'review', reason: 'The cutoff rule determines the expected result.' },
    automation: { recommendation: 'review', layer: null, reason: 'The time cutoff needs clarification.' },
  },
  {
    id: 'TC-04', scenarioId: 'SCN-01', requirementIds: ['REQ-02'], ambiguityIds: [],
    title: 'Prevent a guest from accessing the refund page', priority: 'high', kind: 'negative',
    preconditions: ['A delivered order exists. The browser session is signed out.'],
    testData: 'Order A-103. Use the refund page address captured from a signed-in test session.',
    steps: [step('Navigate to the refund page in the guest session.', 'The guest cannot access the refund page.')],
    expectedResult: 'The refund page and its order details are unavailable to the guest.',
    regression: { recommendation: 'include', reason: 'The requirement sets a customer access boundary.' },
    automation: { recommendation: 'automate', layer: 'ui', reason: 'A signed-out browser session directly verifies the specified page behavior.' },
  },
  {
    id: 'TC-05', scenarioId: 'SCN-02', requirementIds: ['REQ-03'], ambiguityIds: [],
    title: 'Reject a second refund request for the same order', priority: 'high', kind: 'negative',
    preconditions: ['The signed-in customer owns an order with one Pending refund request.'],
    testData: 'Order A-104 with one Pending refund request.',
    steps: [step('Attempt to submit another request for the same order.', 'No second request is created.')],
    expectedResult: 'Exactly one refund request remains for the order.',
    regression: { recommendation: 'include', reason: 'Duplicate requests could cause incorrect processing.' },
    automation: { recommendation: 'automate', layer: 'api', reason: 'The check can verify that a second request does not create another record.' },
  },
  {
    id: 'TC-06', scenarioId: 'SCN-03', requirementIds: ['REQ-05'], ambiguityIds: [],
    title: 'Exercise both refund cancellation states', priority: 'medium', kind: 'state',
    preconditions: ['The customer owns one refund request in each state.'],
    testData: 'A-105 is Pending. A-106 is Approved.',
    steps: [
      step('Cancel the Pending request.', 'The cancellation is accepted.'),
      step('Attempt to cancel the Approved request.', 'The Approved request remains Approved.'),
    ],
    expectedResult: 'Only the Pending request can be cancelled.',
    regression: { recommendation: 'include', reason: 'The state rule protects approved requests from unintended changes.' },
    automation: { recommendation: 'automate', layer: 'api', reason: 'Seeded request states make permission to cancel straightforward to verify.' },
  },
  {
    id: 'TC-07', scenarioId: 'SCN-04', requirementIds: ['REQ-06'], ambiguityIds: [],
    title: 'Review receipt of the confirmation email', priority: 'medium', kind: 'positive',
    preconditions: ['A test inbox is available for the customer.'],
    testData: 'A-107 with a dedicated test inbox.',
    steps: [step('Submit the request and review the customer’s inbox.', 'A confirmation email is present once delivery occurs.')],
    expectedResult: 'The customer receives a confirmation email.',
    regression: { recommendation: 'review', reason: 'Email delivery matters to customers. Pick a reliable observation window before making this a release check.' },
    automation: { recommendation: 'manual', layer: null, reason: 'Start with a test inbox review while the delivery time and sandbox are being agreed.' },
  },
  {
    id: 'TC-08', scenarioId: 'SCN-04', requirementIds: ['REQ-06'], ambiguityIds: ['AMB-02'],
    title: 'Verify the email delivery time', priority: 'medium', kind: 'non-functional',
    preconditions: ['A test inbox is available and timestamps can be observed.'],
    testData: 'A-108 with a dedicated test inbox.',
    steps: [step('Record the submission and email receipt times.', null)],
    expectedResult: null,
    regression: { recommendation: 'review', reason: 'An agreed delivery time is needed.' },
    automation: { recommendation: 'review', layer: null, reason: 'The timing threshold is unknown.' },
  },
  {
    id: 'TC-09', scenarioId: 'SCN-03', requirementIds: ['REQ-07'], ambiguityIds: ['AMB-03'],
    title: 'Reopen a cancelled request as support', priority: 'medium', kind: 'state',
    preconditions: ['Support account and a cancelled refund request are available.'],
    testData: 'A-109 with a cancelled request.',
    steps: [step('Have a support agent attempt to reopen the request.', null)],
    expectedResult: null,
    regression: { recommendation: 'review', reason: 'The support rule needs an expected outcome.' },
    automation: { recommendation: 'review', layer: null, reason: 'The support rule is not yet testable.' },
  },
];

const draft = {
  title: 'Refund requests',
  scopeNotes: ['Review the cases that depend on timing and support rules with the product owner. The sample checks use synthetic orders.'],
  requirements: [
    requirement('REQ-01', 'Customers can request a refund from order details within 30 calendar days of delivery.', 'high', 2, 'within 30 calendar days of delivery'),
    requirement('REQ-02', 'Only delivered orders are eligible. Guests cannot access the refund page.', 'high', 3, 'Only delivered orders can be refunded. Guests cannot access the refund page.'),
    requirement('REQ-03', 'A customer can create at most one refund request per order.', 'high', 4, 'only one refund request per order'),
    requirement('REQ-04', 'A submitted refund is Pending and its status is visible on the order details page.', 'high', 5, 'the refund request is Pending and its status is visible on the order details page'),
    requirement('REQ-05', 'A customer can cancel a Pending request but cannot cancel an Approved request.', 'medium', 6, 'A customer can cancel a Pending refund request. Approved requests cannot be cancelled.'),
    requirement('REQ-06', 'The customer receives a confirmation email after submitting a request.', 'medium', 7, 'receives a confirmation email promptly after submission'),
    requirement('REQ-07', 'Support can reopen a cancelled refund request under conditions to be clarified.', 'medium', 8, 'Support may reopen a cancelled request when appropriate'),
  ],
  ambiguities: [
    question('AMB-01', 'REQ-01', 'missing-detail', 'Is day 30 inclusive, and which time zone defines the cutoff?', 'The outcome of the boundary case depends on the cutoff rule.', 2, 'within 30 calendar days of delivery'),
    question('AMB-02', 'REQ-06', 'vague-language', 'What is the maximum acceptable delay for the confirmation email?', 'The timing check needs a measurable expected result.', 7, 'promptly'),
    question('AMB-03', 'REQ-07', 'vague-language', 'Under which conditions may support reopen a request, and what status should it enter?', 'The allowed transition and resulting status are unspecified.', 8, 'when appropriate'),
  ],
  answerReviews: [],
  scenarios: [
    scenario('SCN-01', ['REQ-01', 'REQ-02', 'REQ-04'], 'Refund eligibility and submission', 'Verify which customers and orders can enter the refund flow and confirm the resulting state.'),
    scenario('SCN-02', ['REQ-03'], 'Duplicate request prevention', 'Confirm that an existing request prevents a second request on the same order.'),
    scenario('SCN-03', ['REQ-05', 'REQ-07'], 'Refund status transitions', 'Verify customer cancellation and record the rules needed to test staff reopening.'),
    scenario('SCN-04', ['REQ-06'], 'Customer notification', 'Verify the confirmation email and clarify the delivery-time target.'),
  ],
  cases,
};

export function getDemo() {
  return { document: demoDocument, analysis: compilePlan(draft, demoDocument) };
}

export function demoDraft() {
  return structuredClone(draft);
}

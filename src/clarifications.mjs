const ANSWER_ID = /^ANS-[0-9]{2,4}$/u;
const MAX_ANSWERS = 60;
const MAX_COMPOSED_CHARS = 24000;

export class ClarificationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ClarificationError';
    this.status = status;
  }
}

function invalid() {
  throw new ClarificationError('Saved clarification answers are invalid.');
}

function normalizeText(value, maxLength) {
  if (typeof value !== 'string') invalid();
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  if (!normalized) invalid();
  if (normalized.length > maxLength) {
    throw new ClarificationError('Saved clarification answers exceed the allowed size.', 413);
  }
  return normalized;
}

function lineCount(text) {
  return text.split('\n').length;
}

/**
 * Validate and compose saved clarification answers as quoted source data.
 * The document is expected to have been normalized by its caller.
 */
export function prepareClarifications(document, answers = []) {
  if (typeof document !== 'string' || !Array.isArray(answers)) invalid();
  if (answers.length > MAX_ANSWERS) {
    throw new ClarificationError('Too many saved clarification answers.', 413);
  }

  const seen = new Set();
  const normalizedAnswers = Array.from(answers, (answer) => {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) invalid();
    const { id, question, answer: answerText, parentAnswerId } = answer;
    if (typeof id !== 'string' || !ANSWER_ID.test(id) || seen.has(id)) invalid();
    if (parentAnswerId !== null && (typeof parentAnswerId !== 'string' || !ANSWER_ID.test(parentAnswerId))) invalid();
    seen.add(id);
    return {
      id,
      question: normalizeText(question, 1600),
      answer: normalizeText(answerText, 1500),
      parentAnswerId,
    };
  });

  const ordered = new Set();
  for (const record of normalizedAnswers) {
    if (record.parentAnswerId !== null && !ordered.has(record.parentAnswerId)) invalid();
    ordered.add(record.id);
  }

  let sourceDocument = document;
  const answerLines = [];
  for (const record of normalizedAnswers) {
    const sectionPrefix = `${sourceDocument}\n\nClarification answer ${record.id}\nQuestion: ${record.question}\nParent answer: ${record.parentAnswerId ?? 'none'}\nAnswer:\n`;
    const startLine = lineCount(sectionPrefix);
    const endLine = startLine + lineCount(record.answer) - 1;
    sourceDocument = `${sectionPrefix}${record.answer}`;
    answerLines.push({ id: record.id, startLine, endLine });
  }

  if (sourceDocument.length > MAX_COMPOSED_CHARS) {
    throw new ClarificationError('The document and saved answers exceed the allowed size.', 413);
  }
  return { answers: normalizedAnswers, sourceDocument, answerLines };
}

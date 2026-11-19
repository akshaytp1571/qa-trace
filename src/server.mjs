import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DocumentError, extractDocument, MAX_DOCUMENT_CHARS, MAX_UPLOAD_BYTES, normalizeDocument } from './documents.mjs';
import { getDemo } from './demo.mjs';
import { ANALYSIS_INSTRUCTIONS, analysisInput, compilePlan, PLAN_SCHEMA, PlanError } from './plan.mjs';
import { generatePlan, ProviderError, PROVIDERS } from './providers.mjs';
import { REQUEST_LIMITS } from './request-settings.mjs';
import { ClarificationError, prepareClarifications } from './clarifications.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/exports.js', ['exports.js', 'text/javascript; charset=utf-8']],
  ['/workspace.js', ['workspace.js', 'text/javascript; charset=utf-8']],
]);
const publicRoot = new URL('../public/', import.meta.url);
const maxJsonBytes = 192 * 1024;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function setHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function checkRequestOrigin(request) {
  const host = request.headers.host ?? '';
  if (!/^(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/iu.test(host)) {
    throw new RequestError(403, 'Open QA Trace at its local address.');
  }
  const origin = request.headers.origin;
  if ((origin && origin !== `http://${host.toLowerCase()}`) || request.headers['sec-fetch-site'] === 'cross-site') {
    throw new RequestError(403, 'Use the QA Trace page to submit a document.');
  }
}

function requireType(request, expected) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== expected) {
    throw new RequestError(415, 'The request format is unsupported. Reload the page and try again.');
  }
}

async function readBody(request, maxBytes) {
  const sizeError = () => new RequestError(413, 'The request is too large. Try a smaller document.');
  if (Number(request.headers['content-length']) > maxBytes) {
    request.resume();
    throw sizeError();
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      request.resume();
      throw sizeError();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function readAnalysisRequest(request) {
  requireType(request, 'application/json');
  const data = await readBody(request, maxJsonBytes);
  let input;
  try {
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    throw new RequestError(400, 'The analysis request is invalid.');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.document !== 'string') {
    throw new RequestError(400, 'Enter a requirements document before analyzing it.');
  }
  return input;
}

function documentName(request) {
  try {
    const name = decodeURIComponent(request.headers['x-document-name'] ?? '');
    if (name.length < 1 || name.length > 255 || /[\u0000-\u001f/\\]/u.test(name)) throw new Error();
    return name;
  } catch {
    throw new RequestError(400, 'The uploaded document needs a valid filename.');
  }
}

export function createApp({ generate = generatePlan, extract = extractDocument } = {}) {
  return createServer({ requestTimeout: 20_000, headersTimeout: 10_000 }, async (request, response) => {
    setHeaders(response);
    const controller = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) controller.abort();
    });

    try {
      checkRequestOrigin(request);
      const pathname = (request.url ?? '').split('?', 1)[0];
      const asset = request.method === 'GET' && files.get(pathname);
      if (asset) {
        const [file, type] = asset;
        const data = await readFile(new URL(file, publicRoot));
        response.writeHead(200, { 'Content-Type': type });
        response.end(data);
        return;
      }

      if (request.method === 'GET' && pathname === '/api/options') {
        sendJson(response, 200, { providers: PROVIDERS, requestLimits: REQUEST_LIMITS, maxDocumentChars: MAX_DOCUMENT_CHARS, maxUploadBytes: MAX_UPLOAD_BYTES });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/demo') {
        sendJson(response, 200, getDemo());
        return;
      }
      if (request.method === 'POST' && pathname === '/api/extract') {
        requireType(request, 'application/octet-stream');
        const name = documentName(request);
        const content = await readBody(request, MAX_UPLOAD_BYTES);
        const document = await extract(name, content);
        if (!response.destroyed) sendJson(response, 200, { document });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/analyze') {
        const { document, provider, model, apiKey, baseUrl, outputMode, timeoutSeconds, maxOutputTokens, answers } = await readAnalysisRequest(request);
        const normalized = normalizeDocument(document);
        const context = prepareClarifications(normalized, answers);
        const draft = await generate({
          provider, model, apiKey, baseUrl, outputMode, timeoutSeconds, maxOutputTokens,
          system: ANALYSIS_INSTRUCTIONS,
          input: analysisInput(normalized, context.answers),
          schema: PLAN_SCHEMA,
          signal: controller.signal,
        });
        const analysis = compilePlan(draft, normalized, context.answers);
        if (!response.destroyed) sendJson(response, 200, { document: normalized, sourceDocument: context.sourceDocument, analysis });
        return;
      }
      sendJson(response, 404, { error: 'This page or endpoint could not be found.' });
    } catch (error) {
      if (response.destroyed) return;
      const publicError = error instanceof RequestError || error instanceof DocumentError
        || error instanceof PlanError || error instanceof ProviderError || error instanceof ClarificationError;
      sendJson(response, publicError ? error.status : 500, {
        error: publicError ? error.message : 'QA Trace could not complete the request. Try again.',
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4173);
  const server = createApp();
  server.once('error', (error) => {
    const message = error.code === 'EADDRINUSE'
      ? `Port ${port} is in use. Set PORT to an available port and run npm start again.`
      : `QA Trace could not start (${error.code || 'server error'}).`;
    console.error(message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`QA Trace is ready at http://127.0.0.1:${server.address().port}`);
  });
}

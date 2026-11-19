import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { crc32 } from 'node:zlib';

export const MAX_DOCUMENT_CHARS = 24_000;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const MAX_DOCX_ENTRIES = 512;
const MAX_DOCX_PART_BYTES = 8 * 1024 * 1024;
const MAX_DOCX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const MAX_ACTIVE_EXTRACTORS = 2;
const EXTRACT_TIMEOUT_MS = 10_000;
const EXTRACT_TASK = 'qa-trace:extract-document';
const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.docx', '.pdf']);
let activeExtractors = 0;

export class DocumentError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'DocumentError';
    this.status = status;
  }
}

function textTooLong() {
  return new DocumentError(413, `Document text must be ${MAX_DOCUMENT_CHARS.toLocaleString('en-US')} characters or fewer.`);
}

function extractionUnavailable() {
  return new DocumentError(503, 'Document extraction is temporarily unavailable.');
}

function extractionLimit() {
  return new DocumentError(413, 'This document takes too much work to extract. Try a smaller file or paste its text.');
}

function unreadableDocument(extension) {
  return new DocumentError(422, extension === '.docx'
    ? 'Could not read this DOCX. Upload a valid, unencrypted Word document.'
    : 'Could not read this PDF. Upload a valid PDF file.');
}

export function normalizeDocument(text) {
  if (typeof text !== 'string') {
    throw new DocumentError(400, 'Document text must be a string.');
  }

  const normalized = text.trim().replace(/\r\n?/g, '\n');
  if (!normalized) {
    throw new DocumentError(400, 'Document text is empty.');
  }
  if (normalized.length > MAX_DOCUMENT_CHARS) throw textTooLong();
  return normalized;
}

function readUtf8(buffer) {
  const invalidText = () => new DocumentError(422, 'Upload a valid UTF-8 text file.');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw invalidText();
  }
  if (text.includes('\0')) throw invalidText();
  return normalizeDocument(text);
}

async function loadParser(specifier) {
  try {
    return await import(specifier);
  } catch {
    throw extractionUnavailable();
  }
}

async function readDocx(data) {
  const [{ default: yauzl }, { default: JSZip }, { default: mammoth }] = await Promise.all([
    loadParser('yauzl'),
    loadParser('jszip'),
    loadParser('mammoth'),
  ]);
  const input = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const archive = await yauzl.fromBufferPromise(input, { validateEntrySizes: true, strictFileNames: true });
  if (archive.entryCount > MAX_DOCX_ENTRIES) {
    throw new DocumentError(413, 'This DOCX contains too many parts.');
  }

  // Mammoth only reads the new ZIP, built from verified streams with bounded output sizes.
  const checkedZip = new JSZip();
  const seen = new Set();
  let expandedSize = 0;
  for await (const entry of archive.eachEntry()) {
    const { fileName, uncompressedSize } = entry;
    const directory = fileName.endsWith('/');
    const path = directory ? fileName.slice(0, -1) : fileName;
    if (seen.has(path) || path.split('/').some((segment) => !segment || segment === '.')) {
      throw unreadableDocument('.docx');
    }
    seen.add(path);

    expandedSize += uncompressedSize;
    if (uncompressedSize > MAX_DOCX_PART_BYTES || expandedSize > MAX_DOCX_EXPANDED_BYTES) {
      throw new DocumentError(413, 'This DOCX is too large when unpacked.');
    }
    if (directory && uncompressedSize !== 0) throw unreadableDocument('.docx');

    const chunks = [];
    let checksum = 0;
    for await (const chunk of await archive.openReadStreamPromise(entry)) {
      checksum = crc32(chunk, checksum);
      chunks.push(chunk);
    }
    if (checksum !== entry.crc32) throw unreadableDocument('.docx');
    if (!directory) checkedZip.file(fileName, Buffer.concat(chunks, uncompressedSize), { createFolders: false });
  }

  if (!checkedZip.file('[Content_Types].xml') || !checkedZip.file('_rels/.rels')) {
    throw unreadableDocument('.docx');
  }

  // Buffer input leaves Mammoth's external file access disabled. Only raw text is requested.
  const buffer = await checkedZip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  const { value } = await mammoth.extractRawText({ buffer });
  return normalizeDocument(value);
}

function collectPdfText() {
  const parts = [];
  let committedLength = 0;
  let pendingWhitespace = '';

  return {
    append(value) {
      if (!committedLength) value = value.trimStart();
      const content = value.trimEnd();
      if (content) {
        committedLength += pendingWhitespace.length + content.length;
        if (committedLength > MAX_DOCUMENT_CHARS) throw textTooLong();
        parts.push(pendingWhitespace, content);
        pendingWhitespace = '';
      }

      // Trailing whitespace is dropped unless more text follows it. Keep enough
      // to detect overflow without retaining an arbitrarily large blank suffix.
      const spaceLeft = MAX_DOCUMENT_CHARS + 1 - pendingWhitespace.length;
      pendingWhitespace += value.slice(content.length, content.length + spaceLeft);
    },
    text: () => parts.join(''),
  };
}

async function readPdf(data) {
  const { getDocument } = await loadParser('pdfjs-dist/legacy/build/pdf.mjs');
  const assets = fileURLToPath(new URL('./', import.meta.resolve('pdfjs-dist/package.json'))).replaceAll('\\', '/');
  const task = getDocument({
    data,
    cMapUrl: `${assets}cmaps/`,
    standardFontDataUrl: `${assets}standard_fonts/`,
    stopAtErrors: true,
    verbosity: 0,
    useWorkerFetch: false,
    useWasm: false,
    enableXfa: false,
  });

  try {
    const pdf = await task.promise;
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new DocumentError(413, `PDFs must have ${MAX_PDF_PAGES} pages or fewer.`);
    }

    const text = collectPdfText();
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        for await (const { items } of page.streamTextContent()) {
          for (const item of items) {
            if (typeof item.str === 'string') text.append(item.str);
            if (item.hasEOL) text.append('\n');
          }
        }
      } finally {
        page.cleanup();
      }
      text.append('\n\n');
    }

    const value = text.text();
    if (!value) {
      throw new DocumentError(422, 'This PDF has no selectable text. Upload a text-based PDF or paste its text.');
    }
    return normalizeDocument(value);
  } catch (error) {
    if (error?.name === 'PasswordException') {
      throw new DocumentError(422, 'This PDF requires a password. Upload an unlocked copy.');
    }
    throw error;
  } finally {
    await task.destroy().catch(() => {});
  }
}

async function extractInWorker(extension, buffer) {
  if (activeExtractors >= MAX_ACTIVE_EXTRACTORS) {
    throw new DocumentError(503, 'Document extraction is busy. Try again shortly.');
  }

  // A separate thread keeps CPU-bound parsing off the HTTP event loop and can
  // be terminated when a parser exceeds its time or V8 heap budget.
  const data = Uint8Array.from(buffer);
  let worker;
  try {
    worker = new Worker(new URL(import.meta.url), {
      workerData: { task: EXTRACT_TASK, extension, data },
      transferList: [data.buffer],
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
      stdout: true,
      stderr: true,
    });
  } catch {
    throw extractionUnavailable();
  }

  // Libraries may put document details in diagnostic messages.
  worker.stdout.resume();
  worker.stderr.resume();
  activeExtractors += 1;
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(extractionLimit()), EXTRACT_TIMEOUT_MS);
      worker.once('message', ({ text, error }) => {
        if (error) reject(new DocumentError(error.status, error.message));
        else resolve(text);
      });
      worker.once('error', (error) => {
        reject(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? extractionLimit() : extractionUnavailable());
      });
      worker.once('exit', () => reject(extractionUnavailable()));
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate().catch(() => {});
    activeExtractors -= 1;
  }
}

export async function extractDocument(name, buffer) {
  const extension = typeof name === 'string' ? extname(name).toLowerCase() : '';
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new DocumentError(415, 'Upload a .txt, .md, .docx, or .pdf file.');
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new DocumentError(400, 'The uploaded file is empty or missing.');
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new DocumentError(413, `Upload files of ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB or less.`);
  }
  if (extension === '.txt' || extension === '.md') return readUtf8(buffer);

  if (extension === '.docx' && (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50)) {
    throw unreadableDocument(extension);
  }
  if (extension === '.pdf' && !buffer.subarray(0, 1024).includes('%PDF-')) {
    throw unreadableDocument(extension);
  }
  return extractInWorker(extension, buffer);
}

if (!isMainThread && workerData?.task === EXTRACT_TASK) {
  const { extension, data } = workerData;
  try {
    const text = await (extension === '.docx' ? readDocx(data) : readPdf(data));
    parentPort.postMessage({ text });
  } catch (error) {
    const { status, message } = error instanceof DocumentError ? error : unreadableDocument(extension);
    parentPort.postMessage({ error: { status, message } });
  }
}

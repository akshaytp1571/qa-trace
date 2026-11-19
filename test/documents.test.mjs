import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import { DocumentError, MAX_DOCUMENT_CHARS, MAX_UPLOAD_BYTES, extractDocument, normalizeDocument } from '../src/documents.mjs';

const privateMarker = 'private-document-marker';

function publicError(status, message) {
  return (error) => {
    assert.ok(error instanceof DocumentError);
    assert.equal(error.status, status);
    assert.match(error.message, message);
    assert.ok(!error.message.includes(privateMarker));
    return true;
  };
}

async function makeDocx(paragraphs, addParts = () => {}) {
  const zip = new JSZip();
  const relationship = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
  const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  zip.file('[Content_Types].xml', [
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '</Types>',
  ].join(''));
  zip.file('_rels/.rels', [
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    `<Relationship Id="rId1" Type="${relationship}" Target="word/document.xml"/>`,
    '</Relationships>',
  ].join(''));
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `<w:document xmlns:w="${namespace}"><w:body>${body}</w:body></w:document>`);
  addParts(zip);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function pdfStream(data, options = '') {
  return `<< /Length ${data.length} ${options} >>\nstream\n${data}\nendstream`;
}

function makePdf(pageContents) {
  const pageNumbers = pageContents.map((_, index) => 5 + 2 * index);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pageNumbers.length} /Kids [${pageNumbers.map((number) => `${number} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    pdfStream('00>', '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode'),
  ];
  for (const [index, contents] of pageContents.entries()) {
    objects.push([
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]',
      '/Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >>',
      `/Contents ${pageNumbers[index] + 1} 0 R >>`,
    ].join(' '), pdfStream(contents));
  }

  // Every fixture string is ASCII, so string offsets are byte offsets.
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

test('normalizes line endings and edges while preserving interior formatting', () => {
  assert.equal(normalizeDocument('\uFEFF \r\n# Plan\r\n  - Café\rNext\tstep\n  '), '# Plan\n  - Café\nNext\tstep');
  const atLimit = `${'x'.repeat(MAX_DOCUMENT_CHARS - 2)}\r\ny`;
  assert.equal(normalizeDocument(` ${atLimit} `).length, MAX_DOCUMENT_CHARS);
  assert.throws(() => normalizeDocument(`${atLimit}z`), publicError(413, /24,000 characters/));
  assert.throws(() => normalizeDocument('\r\n\t  '), publicError(400, /empty/));
  assert.throws(() => normalizeDocument(null), publicError(400, /string/));
});

test('extracts UTF-8 text and Markdown without interpreting markup', async () => {
  assert.equal(await extractDocument('notes.TXT', Buffer.from('\uFEFF  Café\r\nDone ')), 'Café\nDone');
  assert.equal(await extractDocument('plan.Md', Buffer.from('# A\r  - **B** <tag>')), '# A\n  - **B** <tag>');
});

test('reports invalid UTF-8, empty uploads, oversized uploads, and unsupported extensions', async () => {
  await assert.rejects(extractDocument('invalid.txt', Buffer.from([0xc3, 0x28])), publicError(422, /UTF-8/));
  await assert.rejects(extractDocument('utf16.txt', Buffer.from('not UTF-8', 'utf16le')), publicError(422, /UTF-8/));
  await assert.rejects(extractDocument('empty.md', Buffer.alloc(0)), publicError(400, /empty/));
  await assert.rejects(extractDocument('large.txt', Buffer.alloc(MAX_UPLOAD_BYTES + 1)), publicError(413, /5 MiB/));
  await assert.rejects(extractDocument(`${privateMarker}.doc`, Buffer.from(privateMarker)), publicError(415, /\.docx/));
});

test('extracts DOCX paragraphs and literal text entities', async () => {
  const docx = await makeDocx(['First – café', '&lt;label&gt; &amp; details']);
  assert.equal(await extractDocument('plan.DOCX', docx), 'First – café\n\n<label> & details');
});

test('rejects non-DOCX ZIPs, empty documents, and text beyond the character cap', async () => {
  const otherZip = new JSZip();
  otherZip.file('readme.txt', privateMarker);
  const notDocx = await otherZip.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(extractDocument(`${privateMarker}.docx`, notDocx), publicError(422, /could not read this DOCX/i));
  await assert.rejects(extractDocument('blank.docx', await makeDocx([])), publicError(400, /empty/));
  const largeDocx = await makeDocx(['A'.repeat(MAX_DOCUMENT_CHARS + 1)]);
  await assert.rejects(extractDocument('long.docx', largeDocx), publicError(413, /24,000 characters/));
});

test('checks DOCX expansion before extracting raw text', async () => {
  const docx = await makeDocx(['Short text'], (zip) => {
    zip.file('word/extra.txt', Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
  });
  assert.ok(docx.length < MAX_UPLOAD_BYTES);
  await assert.rejects(extractDocument('large-part.docx', docx), publicError(413, /too large when unpacked/));
});

test('extracts selectable PDF text across lines and pages', async () => {
  const pdf = makePdf([
    'BT /F1 12 Tf 72 720 Td (First line) Tj 0 -16 Td (Second line) Tj ET',
    'BT /F1 12 Tf 72 720 Td (Next page) Tj ET',
  ]);
  assert.equal(await extractDocument('plan.PDF', pdf), 'First line\nSecond line\n\nNext page');
});

test('reports image-only and malformed PDFs without exposing their content', async () => {
  const imageOnly = makePdf(['q 144 0 0 144 72 540 cm /Im1 Do Q']);
  await assert.rejects(extractDocument('scan.pdf', imageOnly), publicError(422, /no selectable text/i));
  const broken = Buffer.from(`%PDF-1.4\n${privateMarker}\n`);
  await assert.rejects(extractDocument(`${privateMarker}.pdf`, broken), publicError(422, /could not read this PDF/i));
});

test('limits PDF pages and extracted characters', async () => {
  const tooManyPages = makePdf(Array(101).fill(''));
  await assert.rejects(extractDocument('many-pages.pdf', tooManyPages), publicError(413, /100 pages/));

  const line = `(${'x'.repeat(96)}) Tj`;
  const contents = `BT /F1 8 Tf 72 750 Td ${line}${` 0 -16 Td ${line}`.repeat(45)} ET`;
  const tooMuchText = makePdf(Array(6).fill(contents));
  await assert.rejects(extractDocument('long.pdf', tooMuchText), publicError(413, /24,000 characters/));
});

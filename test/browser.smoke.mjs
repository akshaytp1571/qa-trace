import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApp } from '../src/server.mjs';
import { demoDraft } from '../src/demo.mjs';
import { ProviderError } from '../src/providers.mjs';

function browserExecutable() {
  if (process.env.QA_TRACE_BROWSER) return process.env.QA_TRACE_BROWSER;
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ];
    return candidates.find(existsSync) || chromium.executablePath();
  }
  return chromium.executablePath();
}

async function startBrowser() {
  // Native Playwright launch keeps the captured bitmap width in sync with the
  // emulated viewport. CDP attach cropped a scrollbar-width strip on Windows.
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable() });
  return { browser };
}

function clarificationDraft(input) {
  const context = JSON.parse(input);
  const answers = context.clarificationAnswers || [];
  const draft = demoDraft();
  draft.answerReviews = answers.map(({ id }) => ({ answerId: id, status: 'resolved', reason: 'The answer defines the remaining timing rule in this draft.' }));
  if (answers.length === 1) {
    const question = draft.ambiguities[0];
    question.parentAnswerId = answers[0].id;
    question.question = 'Which time zone defines the refund cutoff?';
    question.impact = 'The inclusive day is clear, but its time zone remains unspecified.';
    const line = context.lines.find(({ text }) => text.includes(answers[0].answer));
    question.evidence = [{ line: line.line, quote: answers[0].answer }];
    draft.answerReviews[0] = { answerId: answers[0].id, status: 'follow-up', reason: 'The answer specifies inclusion but leaves the time zone open.' };
  } else if (answers.length > 1) {
    draft.ambiguities = draft.ambiguities.filter(({ id }) => id !== 'AMB-01');
    const boundary = draft.cases.find(({ id }) => id === 'TC-03');
    boundary.ambiguityIds = [];
    boundary.expectedResult = 'The refund is accepted through the inclusive day-30 cutoff in UTC.';
    boundary.steps[0].expected = boundary.expectedResult;
  }
  return draft;
}

test('browser: document intake, source traceability, clarification, recommendations and exports', { timeout: 90000 }, async () => {
  let responseDelay = 250;
  let failNext = false;
  const server = createApp({ generate: async ({ signal, input }) => {
    const delay = responseDelay;
    const shouldFail = failNext;
    failNext = false;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    });
    if (shouldFail) throw new ProviderError(504, 'The gateway returned HTTP 504: its own request timed out.');
    return clarificationDraft(input);
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let instance;
  try {
    instance = await startBrowser();
    const { browser } = instance;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Refund requests', exact: true }).waitFor();
    await page.locator('#provider option').first().waitFor({ state: 'attached' });
    assert.equal(await page.locator('.metric-value').allTextContents().then((values) => values.join(',')), '7,9,6,3');
    assert.equal(await page.locator('tbody tr').count(), 7);
    const textContrast = await page.evaluate(() => {
      const rgb = (value) => value.match(/[\d.]+/gu).map(Number);
      const luminance = (values) => values.slice(0, 3).map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      return ['.page-description', '.panel-eyebrow', '.statement', '.mono-id', '.source-link', '.link-chip',
        '.badge[data-tone="green"]', '.badge[data-tone="amber"]', '.badge[data-tone="red"]',
        '.primary', '.tabs button', '#workspace-note', 'th'].map((selector) => {
        const el = document.querySelector(selector);
        const foreground = luminance(rgb(getComputedStyle(el).color));
        let parent = el;
        let backdrop;
        while (parent) {
          const color = rgb(getComputedStyle(parent).backgroundColor);
          if (color.length === 3 || color[3] === 1) { backdrop = color; break; }
          parent = parent.parentElement;
        }
        const background = luminance(backdrop || [8, 13, 23]);
        return { selector, ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) };
      });
    });
    for (const { selector, ratio } of textContrast) assert.ok(ratio >= 4.5, `${selector} contrast ${ratio.toFixed(2)} is below 4.5:1`);
    assert.equal(await page.locator('#connection-settings').getAttribute('open'), null);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL('../artifacts/qa-trace-desktop.png', import.meta.url)), fullPage: true });

    await page.getByRole('button', { name: 'Line 2', exact: true }).first().click();
    await page.getByRole('dialog').waitFor();
    assert.match(await page.locator('.source-text').textContent(), /30 calendar days/);
    await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL('../artifacts/qa-trace-source-dialog.png', import.meta.url)), fullPage: true });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: 'Line 2', exact: true }).first().evaluate((el) => el === document.activeElement), true);

    await page.getByRole('button', { name: 'TC-03', exact: true }).click();
    assert.equal(await page.locator('#TC-03').getAttribute('open'), '');
    assert.match(await page.locator('#TC-03').textContent(), /Awaiting clarification/);
    await page.screenshot({ path: fileURLToPath(new URL('../artifacts/qa-trace-case-detail.png', import.meta.url)), fullPage: true });
    await page.getByRole('tab', { name: 'Recommendations' }).click();
    assert.equal(await page.locator('tbody tr').count(), 9);
    assert.equal(await page.getByText('Defer', { exact: true }).count(), 6);

    await page.getByRole('tab', { name: 'Traceability matrix' }).click();
    await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL('../artifacts/qa-trace-desktop.png', import.meta.url)), fullPage: true });

    await page.getByRole('tab', { name: 'Clarifications' }).click();
    await page.locator('#AMB-01 summary').click();
    await page.locator('#answer-AMB-01').fill('Day 30 is inclusive.');
    await page.getByRole('tab', { name: 'Scenarios', exact: true }).click();
    await page.getByRole('tab', { name: 'Clarifications' }).click();
    await page.locator('#AMB-01 summary').click();
    assert.equal(await page.locator('#answer-AMB-01').inputValue(), 'Day 30 is inclusive.');
    await page.locator('#AMB-01').getByRole('button', { name: 'Save answer', exact: true }).click();
    assert.equal(await page.locator('#history-ANS-01 .saved-answer').textContent(), 'Day 30 is inclusive.');
    await page.locator('#AMB-01 summary').click();
    await page.locator('#answer-AMB-01').fill('An older unsaved edit that must not return.');
    await page.locator('#history-ANS-01 summary').click();
    await page.locator('#edit-ANS-01').fill('Day 30 is inclusive.');
    await page.locator('#history-ANS-01').getByRole('button', { name: 'Update answer', exact: true }).click();
    assert.ok(!(await page.evaluate(() => sessionStorage.getItem('qa-trace.workspace.v1'))).includes('An older unsaved edit that must not return.'));
    assert.ok(!(await page.locator('#document').inputValue()).includes('Day 30 is inclusive.'));
    assert.equal(await page.locator('#stale-note').isVisible(), true);
    assert.equal(await page.locator('#export-menu').isHidden(), true);
    await page.screenshot({ path: fileURLToPath(new URL('../artifacts/qa-trace-stale.png', import.meta.url)), fullPage: true });
    await page.reload();
    await page.locator('#history-ANS-01').waitFor();
    assert.equal(await page.locator('#history-ANS-01 .saved-answer').textContent(), 'Day 30 is inclusive.');
    assert.equal(await page.locator('#api-key').inputValue(), '');
    await page.getByRole('button', { name: 'Set up your AI connection' }).click();
    await page.locator('#api-key').fill('clarification-test-key');
    responseDelay = 5000;
    await page.getByRole('button', { name: 'Analyze with answers', exact: true }).click();
    await page.locator('#clarification-cancel').waitFor({ state: 'visible' });
    await page.locator('#clarification-cancel').click();
    await page.locator('#clarification-status').filter({ hasText: 'Analysis canceled.' }).waitFor();
    assert.equal(await page.locator('#history-ANS-01 .saved-answer').textContent(), 'Day 30 is inclusive.');
    responseDelay = 20;
    failNext = true;
    await page.getByRole('button', { name: 'Analyze with answers', exact: true }).click();
    await page.locator('#clarification-status').filter({ hasText: 'HTTP 504' }).waitFor();
    assert.equal(await page.locator('#history-ANS-01 .saved-answer').textContent(), 'Day 30 is inclusive.');
    await page.getByRole('button', { name: 'Analyze with answers', exact: true }).click();
    await page.locator('#history-ANS-01').getByText('Follow-up needed', { exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Clarifications' }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#AMB-01').getByRole('button', { name: 'Follow-up to ANS-01' }).count(), 1);
    await page.screenshot({ path: fileURLToPath(new URL('../artifacts/qa-trace-clarifications.png', import.meta.url)), fullPage: true });
    await page.locator('#AMB-01 summary').click();
    await page.locator('#answer-AMB-01').fill('Use UTC at the recorded delivery time.');
    await page.locator('#AMB-01').getByRole('button', { name: 'Save and analyze', exact: true }).click();
    await page.locator('#history-ANS-02').getByText('Resolved in this draft', { exact: true }).waitFor();
    assert.equal(await page.locator('#history-ANS-01 .saved-answer').textContent(), 'Day 30 is inclusive.');
    assert.equal(await page.locator('#history-ANS-02 .saved-answer').textContent(), 'Use UTC at the recorded delivery time.');
    await page.reload();
    await page.locator('#history-ANS-02').waitFor();
    assert.equal(await page.locator('#api-key').inputValue(), '');
    assert.equal(await page.locator('#stale-note').isHidden(), true);
    await page.getByRole('button', { name: 'Load example' }).click();

    await page.getByRole('button', { name: 'Analyze requirements' }).click();
    assert.match(await page.locator('#feedback').textContent(), /API key/);
    await page.locator('#api-key').fill('test-key-never-save');
    await page.getByRole('button', { name: 'Show API key' }).click();
    await page.getByRole('button', { name: 'Hide API key' }).click();
    assert.equal(await page.locator('#api-key').getAttribute('type'), 'password');
    await page.getByRole('button', { name: 'Analyze requirements' }).click();
    await page.getByText('Draft ready for review.', { exact: true }).waitFor();
    assert.match(await page.locator('#result-label').textContent(), /AI draft/);
    {
      assert.equal(await page.evaluate(() => localStorage.length), 0);
      const storedWorkspace = await page.evaluate(() => JSON.stringify(Object.values(sessionStorage)));
      assert.ok(!storedWorkspace.includes('test-key-never-save'));
      assert.ok(!storedWorkspace.includes('gateway-test-key'));
      assert.ok(!storedWorkspace.includes('gateway.example'));
    }

    await page.locator('#provider').selectOption('gateway');
    assert.equal(await page.locator('#gateway-fields').isVisible(), true);
    assert.equal(await page.locator('#api-key').inputValue(), '');
    await page.getByRole('button', { name: 'Analyze requirements' }).click();
    assert.match(await page.locator('#feedback').textContent(), /base URL/);
    await page.locator('#base-url').fill('https://gateway.example/v1');
    await page.getByRole('button', { name: 'Analyze requirements' }).click();
    assert.match(await page.locator('#feedback').textContent(), /exact model ID/);
    await page.locator('#model').fill('some-org/test-model:free');
    await page.locator('#output-mode').selectOption('prompt');
    await page.locator('#api-key').fill('gateway-test-key');
    await page.locator('.request-details > summary').click();
    assert.equal(await page.locator('#timeout-seconds').inputValue(), '300');
    await page.locator('#timeout-seconds').fill('0');
    await page.getByRole('button', { name: 'Analyze requirements' }).click();
    assert.match(await page.locator('#feedback').textContent(), /Timeout must be an integer/);
    await page.locator('#timeout-seconds').fill('120');
    await page.locator('#output-tokens').fill('4096');
    const gatewayRequest = page.waitForRequest((request) => request.url() === `${origin}/api/analyze`);
    await page.getByRole('button', { name: 'Analyze requirements' }).click();
    const gatewaySettings = (await gatewayRequest).postDataJSON();
    assert.equal(gatewaySettings.provider, 'gateway');
    assert.equal(gatewaySettings.baseUrl, 'https://gateway.example/v1');
    assert.equal(gatewaySettings.model, 'some-org/test-model:free');
    assert.equal(gatewaySettings.outputMode, 'prompt');
    assert.equal(gatewaySettings.apiKey, 'gateway-test-key');
    assert.equal(gatewaySettings.timeoutSeconds, 120);
    assert.equal(gatewaySettings.maxOutputTokens, 4096);
    await page.getByText('Draft ready for review.', { exact: true }).waitFor();
    assert.equal(await page.locator('#request-progress').isHidden(), true);
    {
      assert.equal(await page.evaluate(() => localStorage.length), 0);
      const storedWorkspace = await page.evaluate(() => JSON.stringify(Object.values(sessionStorage)));
      assert.ok(!storedWorkspace.includes('test-key-never-save'));
      assert.ok(!storedWorkspace.includes('gateway-test-key'));
      assert.ok(!storedWorkspace.includes('gateway.example'));
    }
    await page.screenshot({ path: fileURLToPath(new URL('../artifacts/qa-trace-gateway.png', import.meta.url)), fullPage: true });

    await page.locator('#export-menu summary').click();
    await page.screenshot({ path: fileURLToPath(new URL('../artifacts/qa-trace-exports.png', import.meta.url)), fullPage: true });
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Full analysis (.json)' }).click();
    const download = await downloaded;
    assert.equal(download.suggestedFilename(), 'refund-requests-plan.json');
    const stream = await download.createReadStream();
    let exported = '';
    for await (const chunk of stream) exported += chunk.toString('utf8');
    assert.equal(JSON.parse(exported).analysis.cases.length, 9);
    assert.ok(!exported.includes('test-key-never-save'));
    assert.ok(!exported.includes('gateway-test-key'));
    assert.ok(!exported.includes('gateway.example'));
    assert.ok(!exported.includes('some-org/test-model:free'));

    responseDelay = 5000;
    await page.getByRole('button', { name: 'Analyze requirements' }).click();
    await page.locator('#request-progress').filter({ hasText: 'Elapsed 00:01' }).waitFor();
    await page.screenshot({ path: fileURLToPath(new URL('../artifacts/qa-trace-loading.png', import.meta.url)), fullPage: true });
    assert.equal(await page.locator('#timeout-seconds').isDisabled(), true);
    await page.getByRole('button', { name: 'Cancel analysis' }).click();
    await page.getByText('Analysis canceled.', { exact: true }).waitFor();
    assert.equal(await page.locator('#request-progress').isHidden(), true);
    assert.equal(await page.getByRole('button', { name: 'Analyze requirements' }).isEnabled(), true);

    responseDelay = 30;
    failNext = true;
    await page.getByRole('button', { name: 'Analyze requirements' }).click();
    await page.getByText('The gateway returned HTTP 504: its own request timed out.', { exact: true }).waitFor();
    await page.screenshot({ path: fileURLToPath(new URL('../artifacts/qa-trace-error.png', import.meta.url)), fullPage: true });
    assert.equal(await page.locator('#request-progress').isHidden(), true);
    assert.equal(await page.locator('#cancel-button').isHidden(), true);
    assert.equal(await page.locator('#timeout-seconds').isEnabled(), true);
    await page.locator('#provider').selectOption('anthropic');
    assert.equal(await page.locator('#gateway-fields').isHidden(), true);
    assert.equal(await page.locator('#api-key').inputValue(), '');
    assert.equal(await page.locator('#base-url').inputValue(), '');
    await page.locator('#provider').selectOption('openai');

    await page.locator('#file-input').setInputFiles({ name: 'new-requirements.md', mimeType: 'text/markdown', buffer: Buffer.from('# Login\nA user can sign out.') });
    await page.getByText('Document loaded. Review the extracted text before analysis.', { exact: true }).waitFor();
    assert.equal(await page.locator('#document').inputValue(), '# Login\nA user can sign out.');
    assert.equal(await page.locator('#stale-note').isVisible(), true);
    await page.getByRole('button', { name: 'Load example' }).click();
    await page.getByRole('tab', { name: 'Traceability matrix' }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Scenarios', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByRole('tab', { name: 'Scenarios', exact: true }).evaluate((el) => getComputedStyle(el).outlineStyle), 'solid');
    await page.keyboard.press('End');
    assert.equal(await page.getByRole('tab', { name: 'Recommendations' }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Home');
    assert.equal(await page.getByRole('tab', { name: 'Traceability matrix' }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('ArrowRight');
    await page.screenshot({ path: fileURLToPath(new URL('../artifacts/qa-trace-focus.png', import.meta.url)), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#connection-settings > summary').click();
    await page.getByRole('tab', { name: 'Traceability matrix' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    const mobileImage = await page.screenshot({ path: fileURLToPath(new URL('../artifacts/qa-trace-mobile.png', import.meta.url)), fullPage: true });
    assert.equal(mobileImage.readUInt32BE(16), 390);
    await page.locator('.table-scroll').evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    assert.ok(await page.locator('.table-scroll').evaluate((el) => el.scrollLeft > 0));
    await page.getByRole('tab', { name: 'Traceability matrix' }).focus();
    await page.keyboard.press('End');
    assert.equal(await page.getByRole('tab', { name: 'Recommendations' }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.getByRole('button', { name: 'Start a new document' }).click();
    await page.getByText('Upload or paste requirements to start a new plan.', { exact: true }).waitFor();
    await page.screenshot({ path: fileURLToPath(new URL('../artifacts/qa-trace-empty.png', import.meta.url)), fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await instance?.browser.close();
    instance?.process?.kill();
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
  }
});

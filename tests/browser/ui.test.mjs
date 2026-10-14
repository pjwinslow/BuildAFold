/**
 * Browser test for the application wiring.
 *
 * Run with `npm run test:ui`. It serves the repository, substitutes a test
 * double for three.js (the CDN is not reachable from CI here), and drives the
 * page with a real browser. It checks the parts of the UI that are ours — the
 * palette, the chain list, validation reporting and export — not the rendering.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const PORT = 8891;
const BASE = `http://localhost:${PORT}`;

let server;
let browser;

async function waitForServer(url, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server at ${url} never became ready`);
}

test.before(async () => {
  server = spawn(process.execPath, [resolve(root, 'tools/serve.js'), String(PORT), root], {
    stdio: 'ignore',
  });
  await waitForServer(BASE + '/index.html');
  browser = await chromium.launch({ args: ['--no-sandbox'] });
});

test.after(async () => {
  await browser?.close();
  server?.kill();
});

/** A page with the three.js imports redirected to the local test doubles. */
async function openApp(options = {}) {
  const { navigate = true, ...contextOptions } = options;
  const page = await browser.newPage(contextOptions);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  // Serve the doubles as the response to the CDN request itself. Redirecting
  // instead would fail: a module request that began cross-origin still needs
  // CORS headers after the redirect.
  await page.route('**/cdn.jsdelivr.net/**', async (route) => {
    const url = route.request().url();
    const file = url.includes('/controls/') ? 'controls-stub.js' : 'three-stub.js';
    return route.fulfill({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: await readFile(resolve(here, file), 'utf8'),
    });
  });

  if (!navigate) return { page, errors };

  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#palette button').length > 0);
  return { page, errors };
}

test('the app boots and builds the example design', async () => {
  const { page, errors } = await openApp();

  const paletteCount = await page.locator('#palette button').count();
  assert.equal(paletteCount, 5, 'every block type should be offered');

  // The example is a four-helix bundle: 4 blocks, 3 linkers.
  const blocks = await page.locator('#chain-list li').count();
  assert.equal(blocks, 4);
  const linkers = await page.locator('.linker-row').count();
  assert.equal(linkers, 3);

  const status = await page.locator('.validation .status').textContent();
  assert.match(status, /Buildable/);
  assert.ok(!status.includes('Not buildable'), `example should be valid, got: ${status}`);

  const readout = await page.locator('#readout').textContent();
  assert.match(readout, /\d+ aa/);

  // Secondary structure strip should show four helical runs.
  const ss = await page.locator('.ss-strip').textContent();
  assert.equal(ss.replace(/[^HEL]/g, '').length, ss.length, 'strip should be H/E/L only');
  assert.equal(ss.match(/H+/g).length, 4);

  assert.deepEqual(errors, []);
  await page.close();
});

test('adding a block from the palette extends the chain', async () => {
  const { page, errors } = await openApp();

  await page.locator('#palette button', { hasText: 'Beta strand' }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('#chain-list li').length === 5);

  const ss = await page.locator('.ss-strip').textContent();
  assert.ok(ss.includes('E'), 'a strand should appear in the secondary structure');

  assert.deepEqual(errors, []);
  await page.close();
});

test('deleting the selection removes it from the chain', async () => {
  const { page, errors } = await openApp();

  await page.locator('#chain-list li').first().click();
  await page.waitForSelector('#chain-list li.selected');
  await page.locator('#inspector button', { hasText: 'Delete' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#chain-list li').length === 3);

  assert.deepEqual(errors, []);
  await page.close();
});

test('changing a block length rebuilds the chain', async () => {
  const { page, errors } = await openApp();

  const lengthBefore = await page.locator('#readout').textContent();

  await page.locator('#chain-list li').first().click();
  const field = page.locator('#inspector input[type="number"]').first();
  await field.fill('24');
  await field.dispatchEvent('change');

  await page.waitForFunction(
    (before) => document.querySelector('#readout').textContent !== before,
    lengthBefore,
  );

  const first = await page.locator('#chain-list li .len').first().textContent();
  assert.equal(first.trim(), '24');

  assert.deepEqual(errors, []);
  await page.close();
});

test('an impossible linker is reported rather than silently accepted', async () => {
  const { page, errors } = await openApp();

  // Pin the second linker to one residue; the blocks are far too far apart.
  const input = page.locator('.linker-row input').first();
  await input.fill('1');
  await input.dispatchEvent('change');

  await page.waitForFunction(() =>
    document.querySelector('.validation .status')?.textContent.includes('Not buildable'),
  );

  const problems = await page.locator('.validation ul').textContent();
  assert.match(problems, /chain break|could not be closed|needs at least/i);

  assert.deepEqual(errors, []);
  await page.close();
});

test('export produces a well-formed PDB and design spec', async () => {
  const { page, errors } = await openApp();

  const pdbDownload = page.waitForEvent('download');
  await page.locator('#export-pdb').click();
  const pdb = await (await pdbDownload).createReadStream();
  const pdbText = await streamToString(pdb);

  const atomLines = pdbText.split('\n').filter((l) => l.startsWith('ATOM'));
  assert.ok(atomLines.length > 200, `expected a full backbone, got ${atomLines.length} atoms`);
  assert.equal(atomLines[0].slice(12, 16), ' N  ');
  assert.ok(pdbText.includes('HELIX '));
  assert.ok(pdbText.trimEnd().endsWith('END'));

  const specDownload = page.waitForEvent('download');
  await page.locator('#export-spec').click();
  const spec = JSON.parse(await streamToString(await (await specDownload).createReadStream()));

  assert.equal(spec.format, 'buildafold.designspec');
  assert.equal(spec.ssIndex.length, spec.length);
  assert.equal(spec.secondaryStructure.length, spec.length);
  assert.ok(spec.segmentAdjacency.length > 0, 'a bundle should have adjacent helices');
  assert.ok(spec.commands.rfdiffusionFoldConditioned.includes('scaffoldguided'));

  assert.deepEqual(errors, []);
  await page.close();
});

test('undo restores the previous state', async () => {
  const { page, errors } = await openApp();

  const before = await page.locator('#chain-list li').count();
  await page.locator('#palette button').first().click();
  await page.waitForFunction(
    (n) => document.querySelectorAll('#chain-list li').length === n + 1,
    before,
  );

  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    (n) => document.querySelectorAll('#chain-list li').length === n,
    before,
  );

  assert.deepEqual(errors, []);
  await page.close();
});

test('switching to sketch mode shows its guidance', async () => {
  const { page, errors } = await openApp();

  assert.ok(await page.locator('#sketch-hint').isHidden());
  await page.locator('[data-tool="sketch"]').click();
  await page.waitForSelector('#sketch-hint:visible');
  assert.ok(await page.locator('.stage.sketching').count());

  assert.deepEqual(errors, []);
  await page.close();
});

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

test('the canvas never paints over the panels beside it', async () => {
  // Regression: the renderer was sized with updateStyle disabled, so the canvas
  // kept its drawing-buffer size (width * devicePixelRatio) as its CSS size and
  // spilled over the right-hand panel on any display above 1x. A 1x viewport
  // hides the bug entirely, so this runs at 2x.
  const { page, errors } = await openApp({ deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } });

  const metrics = await page.evaluate(() => {
    const canvas = document.querySelector('#viewport canvas');
    const stage = document.querySelector('.stage');
    const panel = document.querySelector('.panel.right');
    return {
      ratio: window.devicePixelRatio,
      canvasRight: canvas.getBoundingClientRect().right,
      canvasWidth: canvas.getBoundingClientRect().width,
      stageRight: stage.getBoundingClientRect().right,
      stageWidth: stage.getBoundingClientRect().width,
      panelLeft: panel.getBoundingClientRect().left,
      bodyScrollsSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });

  assert.ok(metrics.ratio > 1, 'the test must run above 1x to be meaningful');
  assert.ok(
    metrics.canvasWidth <= metrics.stageWidth + 1,
    `canvas (${metrics.canvasWidth}px) is wider than its stage (${metrics.stageWidth}px)`,
  );
  assert.ok(
    metrics.canvasRight <= metrics.panelLeft + 1,
    `canvas reaches ${metrics.canvasRight}px, past the panel edge at ${metrics.panelLeft}px`,
  );
  assert.equal(metrics.bodyScrollsSideways, false, 'the page must not scroll sideways');

  assert.deepEqual(errors, []);
  await page.close();
});

test('the residue slider resizes a block and takes one undo step', async () => {
  const { page, errors } = await openApp();

  await page.locator('#chain-list li').first().click();
  const slider = page.locator('#inspector input[type="range"]').first();
  await slider.waitFor();

  assert.equal(await slider.inputValue(), '16');

  // Drive it the way a drag does: several input events, then a commit.
  await slider.evaluate((el) => {
    for (const value of [20, 26, 32]) {
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await page.waitForFunction(
    () => document.querySelector('#chain-list li .len')?.textContent.trim() === '32',
  );

  // The number box beside it tracks the slider.
  assert.equal(await page.locator('#inspector input[type="number"]').first().inputValue(), '32');

  // A whole drag is one undo step, not one per frame.
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    () => document.querySelector('#chain-list li .len')?.textContent.trim() === '16',
  );

  assert.deepEqual(errors, []);
  await page.close();
});

test('the export panel stays hidden until an export is made', async () => {
  // Regression: .export-output sets `display: flex`, which overrode the
  // browser's `[hidden] { display: none }` and left the panel on screen from
  // the first paint, overlapping the rest of the export section.
  const { page, errors } = await openApp();
  assert.ok(await page.locator('#export-output').isHidden(), 'panel should start hidden');
  assert.deepEqual(errors, []);
  await page.close();
});

test('embedded, exports are offered as text because downloads are blocked', async () => {
  // In a frame the page cannot start a download, and the attempt fails
  // silently, so the file is shown to copy instead. This is the path a page
  // embedded in another site takes.
  const { page, errors } = await openApp({ navigate: false });
  await page.setContent(
    `<body style="margin:0"><iframe id="f" src="${BASE}/index.html" ` +
      `style="width:1200px;height:800px;border:0"></iframe></body>`,
  );

  const app = page.frameLocator('#f');
  await app.locator('#palette button').first().waitFor({ timeout: 20000 });
  assert.ok(await app.locator('#export-output').isHidden(), 'panel should start hidden');

  await app.locator('#export-spec').click();
  await app.locator('#export-output').waitFor({ state: 'visible', timeout: 10000 });

  const spec = JSON.parse(await app.locator('#export-text').inputValue());
  assert.equal(spec.format, 'buildafold.designspec');
  assert.equal(spec.ssIndex.length, spec.length);

  await app.locator('#export-close').click();
  await app.locator('#export-output').waitFor({ state: 'hidden' });

  assert.deepEqual(errors, []);
  await page.close();
});

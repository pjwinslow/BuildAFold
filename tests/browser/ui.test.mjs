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
async function openApp() {
  const page = await browser.newPage();
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

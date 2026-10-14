/**
 * Assemble the static site into `_site/` for deployment.
 *
 * The app needs no bundling — it is ES modules and one stylesheet — so this
 * copies the files the browser actually asks for and leaves the rest of the
 * repository (tests, tooling, the Python helper) out of what gets served.
 *
 * Run `node tools/build-site.js`.
 */

import { cp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, '_site');

/** Everything the page loads, as paths relative to the repository root. */
const CONTENTS = ['index.html', 'src'];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const entry of CONTENTS) {
  const from = join(root, entry);
  if (!(await stat(from).catch(() => null))) {
    throw new Error(`cannot build the site: ${entry} is missing`);
  }
  await cp(from, join(out, entry), { recursive: true });
}

// Tell GitHub Pages to serve the files as they are rather than running Jekyll
// over them, which would skip any path beginning with an underscore.
await writeFile(join(out, '.nojekyll'), '');

console.log(`built _site/ from: ${CONTENTS.join(', ')}`);

/**
 * Assemble the static site into `_site/` for deployment.
 *
 * The app needs no bundling — it is ES modules and one stylesheet — so this
 * copies the files the browser actually asks for and leaves the rest of the
 * repository (tests, tooling, the Python helper) out of what gets served.
 *
 * It also stamps a build id onto every asset URL. GitHub Pages serves static
 * files with a cache lifetime and offers no way to set headers, so without
 * this a browser happily keeps running yesterday's JavaScript after a deploy —
 * which is indistinguishable, from the outside, from a fix that did not work.
 * Versioned URLs make a new deploy a different URL, and the id is shown in the
 * page so there is never any doubt about which build is on screen.
 *
 * Run `node tools/build-site.js`.
 */

import { cp, mkdir, rm, writeFile, stat, readdir, readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, '_site');

/** Everything the page loads, as paths relative to the repository root. */
const CONTENTS = ['index.html', 'src'];

/** Short, changes whenever the source does. */
function buildId() {
  try {
    return execSync('git rev-parse --short=8 HEAD', { cwd: root }).toString().trim();
  } catch {
    return Date.now().toString(36);
  }
}

/** Every file under a directory, recursively. */
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

/**
 * Append the build id to relative asset URLs.
 *
 * Only `./` and `../` specifiers are touched: bare names resolve through the
 * import map to a CDN, and stamping those would break them.
 */
function stamp(source, version) {
  return source
    .replace(/(\bfrom\s+['"])(\.{1,2}\/[^'"]+?\.js)(['"])/g, `$1$2?v=${version}$3`)
    .replace(/(\bimport\s*\(\s*['"])(\.{1,2}\/[^'"]+?\.js)(['"])/g, `$1$2?v=${version}$3`)
    .replace(/(\bfrom\s+['"])(\/src\/[^'"]+?\.js)(['"])/g, `$1$2?v=${version}$3`)
    .replace(/(\bimport\s*\(\s*['"])(\/src\/[^'"]+?\.js)(['"])/g, `$1$2?v=${version}$3`);
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const entry of CONTENTS) {
  const from = join(root, entry);
  if (!(await stat(from).catch(() => null))) {
    throw new Error(`cannot build the site: ${entry} is missing`);
  }
  await cp(from, join(out, entry), { recursive: true });
}

const version = buildId();

// Version every module URL so a deploy cannot be served from a stale cache.
for (const file of await walk(join(out, 'src'))) {
  if (extname(file) !== '.js') continue;
  await writeFile(file, stamp(await readFile(file, 'utf8'), version), 'utf8');
}

const indexPath = join(out, 'index.html');
const index = (await readFile(indexPath, 'utf8'))
  .replace('href="src/ui/style.css"', `href="src/ui/style.css?v=${version}"`)
  .replace('src="src/ui/app.js"', `src="src/ui/app.js?v=${version}"`)
  .replace('<body>', `<body data-build="${version}">`);
await writeFile(indexPath, index, 'utf8');

// Tell GitHub Pages to serve the files as they are rather than running Jekyll
// over them, which would skip any path beginning with an underscore.
await writeFile(join(out, '.nojekyll'), '');
await writeFile(join(out, 'build.json'), JSON.stringify({ version, built: new Date().toISOString() }));

console.log(`built _site/ from: ${CONTENTS.join(', ')} (build ${version})`);

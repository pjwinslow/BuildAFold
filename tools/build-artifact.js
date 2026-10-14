/**
 * Produce the entry file for a published Artifact from `index.html`.
 *
 * A published Artifact wraps the page in its own document skeleton, so the
 * page file must not carry `<!doctype>`, `<html>`, `<head>` or `<body>` of its
 * own; the title, the import map and the stylesheet link move to the top of
 * the file instead. The charset and viewport metas are dropped because the
 * skeleton already supplies them.
 *
 * Generated rather than hand-maintained so the hosted build cannot drift away
 * from the one that runs locally. Run `node tools/build-artifact.js`.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function extract(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) throw new Error(`index.html is missing its ${label}`);
  return match[0];
}

const source = await readFile(resolve(root, 'index.html'), 'utf8');

const title = extract(source, /<title>[\s\S]*?<\/title>/, '<title>');
const stylesheet = extract(source, /<link rel="stylesheet"[^>]*>/, 'stylesheet link');
const importmap = extract(source, /<script type="importmap">[\s\S]*?<\/script>/, 'import map');

const body = source.match(/<body>([\s\S]*)<\/body>/);
if (!body) throw new Error('index.html is missing its <body>');

const output = `${title}
${stylesheet}
${importmap}
${body[1].trimEnd()}
`;

// The skeleton rejects a page that brings its own document structure. Matched
// with a boundary so that <header> is not mistaken for <head>.
const structural = output.match(/<!doctype|<\/?(html|head|body)(\s|>)/i);
if (structural) {
  throw new Error(`generated artifact page still contains ${structural[0]}`);
}

await mkdir(resolve(root, 'artifact'), { recursive: true });
await writeFile(resolve(root, 'artifact/index.html'), output, 'utf8');

console.log(`wrote artifact/index.html (${output.length} bytes)`);

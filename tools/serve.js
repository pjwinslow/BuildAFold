/**
 * Minimal static file server for local development.
 *
 * ES modules cannot be loaded over file://, so the app needs to be served.
 * No dependencies: `npm run serve` and open the printed address.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[3] ?? '.');
const port = Number(process.argv[2] ?? process.env.PORT ?? 8173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdb': 'chemical/x-pdb',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    // Resolve against the root and refuse anything that escapes it.
    const requested = resolve(join(root, normalize(decodeURIComponent(url.pathname))));
    if (requested !== root && !requested.startsWith(root + '/')) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    let target = requested;
    const info = await stat(target).catch(() => null);
    if (info?.isDirectory()) target = join(target, 'index.html');

    const body = await readFile(target);
    response.writeHead(200, {
      'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

server.listen(port, () => {
  console.log(`BuildAFold serving ${root}`);
  console.log(`  http://localhost:${port}/`);
});

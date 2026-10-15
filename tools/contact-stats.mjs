/** What Ca-Ca distances do real structures actually contain? */
import { readFile } from 'node:fs/promises';
import { parseStructure } from '../src/io/structures.js';
import { distance } from '../src/geometry/vec3.js';

const buckets = new Map();
let pairs = 0;
let minimum = Infinity;
let minWhere = '';

for (const path of process.argv.slice(2)) {
  for (const chain of parseStructure(await readFile(path, 'utf8'))) {
    const cas = chain.residues.map((r) => r.CA);
    for (let i = 0; i < cas.length; i += 1) {
      for (let j = i + 3; j < cas.length; j += 1) {
        const d = distance(cas[i], cas[j]);
        if (d > 6) continue;
        pairs += 1;
        const key = (Math.floor(d * 5) / 5).toFixed(1);
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
        if (d < minimum) {
          minimum = d;
          minWhere = `${path.split('/').pop()} ${chain.chainId} ${i + 1}<->${j + 1} (sep ${j - i})`;
        }
      }
    }
  }
}

console.log(`non-local Ca pairs under 6 A: ${pairs}`);
console.log(`closest anywhere: ${minimum.toFixed(2)} A  ${minWhere}`);
console.log('distribution:');
for (const key of [...buckets.keys()].sort()) {
  if (Number(key) > 5.2) break;
  console.log(`  ${key} A  ${'#'.repeat(Math.min(50, buckets.get(key)))} ${buckets.get(key)}`);
}

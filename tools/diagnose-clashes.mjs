/** Diagnostic: where do clashes in an imported structure actually come from? */
import { readFile } from 'node:fs/promises';
import { parseStructure, assemblyFromChain } from '../src/io/structures.js';
import { realize } from '../src/model/assembly.js';
import { findClashes, radiusOfGyration } from '../src/geometry/validate.js';
import { secondaryStructureRuns } from '../src/geometry/ssassign.js';

for (const path of process.argv.slice(2)) {
  const name = path.split('/').pop();
  const chains = parseStructure(await readFile(path, 'utf8'));
  if (!chains.length) { console.log(name, 'no chains'); continue; }
  const chain = chains[0];

  // 1. The structure exactly as deposited.
  const native = findClashes(chain.residues);
  console.log(`\n${name}  chain ${chain.chainId}  ${chain.residues.length} aa  Rg ${radiusOfGyration(chain.residues).toFixed(1)}  ss=${chain.source}`);
  console.log(`  native clashes: ${native.length}` +
    (native.length ? `  closest ${native[0].distance.toFixed(2)} A  e.g. ${native[0].i + 1}<->${native[0].j + 1}` : ''));

  // 2. As imported: elements kept, loops regenerated.
  const { assembly, elements } = assemblyFromChain(chain, { maxBlocks: 60 });
  const out = realize(assembly);

  const kind = new Array(out.residues.length).fill('?');
  for (const seg of out.segments) for (let i = seg.start; i <= seg.end; i += 1) kind[i] = seg.kind === 'linker' ? 'L' : 'B';
  const tally = { 'B-B': 0, 'B-L': 0, 'L-L': 0 };
  for (const c of out.validation.clashes) tally[[kind[c.i], kind[c.j]].sort().join('-')] += 1;

  const realLoops = secondaryStructureRuns(chain.ss).filter((r) => r.code === 'L');
  console.log(`  imported: ${elements.length} elements, ${out.residues.length} aa, Rg ${out.validation.radiusOfGyration.toFixed(1)}`);
  console.log(`  imported clashes: ${out.validation.clashes.length}  (block-block ${tally['B-B']}, block-loop ${tally['B-L']}, loop-loop ${tally['L-L']})`);
  console.log(`  loops: real lengths [${realLoops.map((r) => r.length).join(',')}]  rebuilt [${out.closures.map((c) => c.nResidues).join(',')}]`);
}

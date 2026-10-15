import test from 'node:test';
import assert from 'node:assert/strict';

import {
  structureUrl,
  fetchStructure,
  parseStructure,
  chainToElements,
  chainSecondaryStructure,
} from '../src/io/structures.js';
import { writePDB, parseSecondaryStructureRecords } from '../src/io/pdb.js';
import { createAssembly, addBlock, realize, resetIds } from '../src/model/assembly.js';
import { distance } from '../src/geometry/vec3.js';

/** A two-helix design written out as a PDB, with HELIX records. */
function helixPairPdb() {
  resetIds();
  const assembly = createAssembly('pair');
  addBlock(assembly, { type: 'helix', nResidues: 14, position: [0, 0, 0] });
  addBlock(assembly, {
    type: 'helix',
    nResidues: 14,
    position: [10.5, 0, 0],
    quaternion: [1, 0, 0, 0],
  });
  const realized = realize(assembly);
  return { text: writePDB(realized.residues, { segments: realized.segments }), realized };
}

test('identifiers route to the right archive', () => {
  assert.equal(structureUrl('1crn').source, 'RCSB');
  assert.match(structureUrl('1crn').url, /files\.rcsb\.org\/download\/1CRN\.pdb$/);
  assert.equal(structureUrl('P69905').source, 'AlphaFold');
  assert.match(structureUrl('AF-P69905').url, /AF-P69905-F1-model_v4\.pdb$/);

  for (const bad of ['', 'hello', 'ABCDE', '12']) {
    assert.throws(() => structureUrl(bad), /PDB ID|UniProt/);
  }
});

test('HELIX records are read back from a written file', () => {
  const { text } = helixPairPdb();
  const records = parseSecondaryStructureRecords(text);
  assert.equal(records.helices.length, 2);
  for (const helix of records.helices) {
    assert.equal(helix.chainId, 'A');
    assert.equal(helix.end - helix.start + 1, 14);
  }
});

test('a structure parses into chains with secondary structure', () => {
  const { text, realized } = helixPairPdb();
  const chains = parseStructure(text);

  assert.equal(chains.length, 1);
  assert.equal(chains[0].chainId, 'A');
  assert.equal(chains[0].residues.length, realized.residues.length);
  assert.equal(chains[0].source, 'records', 'the file has records, so use them');
  assert.match(chains[0].ss, /^H{14}L+H{14}$/);
});

test('secondary structure is assigned when the file has no records', () => {
  const { text } = helixPairPdb();
  const stripped = text
    .split('\n')
    .filter((line) => !line.startsWith('HELIX') && !line.startsWith('SHEET'))
    .join('\n');

  const chains = parseStructure(stripped);
  assert.equal(chains[0].source, 'assigned');
  // The helices must still be found, even without the records.
  assert.ok([...chains[0].ss].filter((c) => c === 'H').length > 18, chains[0].ss);
});

test('chains are cut into elements, keeping real coordinates', () => {
  const { text, realized } = helixPairPdb();
  const [chain] = parseStructure(text);
  const elements = chainToElements(chain);

  assert.equal(elements.length, 2, 'two helices, the loop left out');
  for (const element of elements) {
    assert.equal(element.code, 'H');
    assert.equal(element.residues.length, 14);
    for (const residue of element.residues) {
      assert.ok(residue.N && residue.CA && residue.C && residue.O);
    }
  }

  // Coordinates are the file's own, not an idealised stand-in.
  assert.ok(distance(elements[0].residues[0].CA, realized.residues[0].CA) < 0.002);
});

test('elements too short to be real are skipped', () => {
  const chain = {
    chainId: 'A',
    ss: 'HHHEEEEEEELL',
    residues: Array.from({ length: 12 }, (_, i) => ({
      resSeq: i + 1,
      N: [i * 3.8, 0, 0],
      CA: [i * 3.8 + 1, 0, 0],
      C: [i * 3.8 + 2, 0, 0],
    })),
  };
  const elements = chainToElements(chain, { minHelix: 5, minStrand: 3 });
  assert.equal(elements.length, 1, 'the 3-residue helix is dropped, the strand kept');
  assert.equal(elements[0].code, 'E');
});

test('chainToElements will not flood the scene with blocks', () => {
  const chain = {
    chainId: 'A',
    ss: 'HHHHHHHHHHL'.repeat(60),
    residues: Array.from({ length: 11 * 60 }, (_, i) => ({
      resSeq: i + 1,
      N: [i, 0, 0],
      CA: [i, 1, 0],
      C: [i, 2, 0],
    })),
  };
  assert.equal(chainToElements(chain, { maxBlocks: 40 }).length, 40);
});

test('a fetch failure explains itself', async () => {
  await assert.rejects(
    fetchStructure('1crn', { fetchImpl: async () => { throw new Error('offline'); } }),
    /could not reach RCSB/,
  );
  await assert.rejects(
    fetchStructure('1crn', { fetchImpl: async () => ({ ok: false, status: 404 }) }),
    /no entry 1CRN/,
  );
  await assert.rejects(
    fetchStructure('1crn', { fetchImpl: async () => ({ ok: false, status: 500 }) }),
    /returned 500/,
  );
});

test('a successful fetch returns the text and its source', async () => {
  const { text } = helixPairPdb();
  const result = await fetchStructure('1crn', {
    fetchImpl: async () => ({ ok: true, text: async () => text }),
  });
  assert.equal(result.source, 'RCSB');
  assert.equal(result.id, '1CRN');
  assert.ok(result.text.includes('ATOM'));
});

test('chainSecondaryStructure ignores records for other chains', () => {
  const residues = Array.from({ length: 10 }, (_, i) => ({
    resSeq: i + 1,
    CA: [i * 3.8, 0, 0],
  }));
  const result = chainSecondaryStructure(residues, 'A', {
    helices: [{ chainId: 'B', start: 1, end: 10 }],
    sheets: [],
  });
  assert.equal(result.source, 'assigned', 'records for chain B must not apply to chain A');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAssembly,
  addBlock,
  addSketchBlock,
  realize,
  serialize,
  deserialize,
  reorderBlock,
  removeBlock,
  secondaryStructureSegments,
  resetIds,
} from '../src/model/assembly.js';
import { writePDB, parsePDB, formatAtomLine } from '../src/io/pdb.js';
import { buildDesignSpec, segmentAdjacency, contigString } from '../src/io/designspec.js';
import { buildElement } from '../src/geometry/chain.js';
import { distance } from '../src/geometry/vec3.js';
import { BOND } from '../src/geometry/constants.js';

/** Two antiparallel helices about 10 A apart: the smallest real topology. */
function helixHairpin() {
  resetIds();
  const assembly = createAssembly('Test hairpin');
  addBlock(assembly, { type: 'helix', nResidues: 14, position: [0, 0, 0] });
  addBlock(assembly, {
    type: 'helix',
    nResidues: 14,
    position: [10, 0, 0],
    quaternion: [1, 0, 0, 0], // 180 degrees about x: antiparallel
  });
  return assembly;
}

test('a two-block assembly realises into one continuous chain', () => {
  const assembly = helixHairpin();
  const result = realize(assembly);

  assert.equal(result.segments.filter((s) => s.kind === 'block').length, 2);
  assert.equal(result.closures.length, 1);
  assert.ok(result.closures[0].converged, `linker should close, rmsd ${result.closures[0].rmsd}`);
  assert.equal(result.validation.breaks.length, 0, 'no chain breaks');

  // Every peptide bond across the whole chain, linker junctions included.
  for (let i = 0; i + 1 < result.residues.length; i += 1) {
    const d = distance(result.residues[i].C, result.residues[i + 1].N);
    assert.ok(
      Math.abs(d - BOND.C_N) < 0.1,
      `peptide bond ${i}->${i + 1} is ${d.toFixed(2)} A`,
    );
  }

  assert.equal(result.ss.length, result.residues.length);
  assert.match(result.ss, /^H{14}L+H{14}$/);
});

test('auto linkers grow with the gap they have to span', () => {
  const near = helixHairpin();
  const far = helixHairpin();
  far.blocks[1].position = [26, 0, 0];

  const nearLinker = realize(near).closures[0].nResidues;
  const farLinker = realize(far).closures[0].nResidues;

  assert.ok(farLinker > nearLinker, `expected a longer linker across a wider gap (${nearLinker} vs ${farLinker})`);
  assert.ok(realize(far).closures[0].converged);
});

test('an explicitly too-short linker is reported, not faked', () => {
  const assembly = helixHairpin();
  assembly.blocks[1].position = [34, 0, 0];
  assembly.blocks[1].linkerBefore = 1;

  const result = realize(assembly);
  assert.equal(result.closures[0].converged, false);
  assert.equal(result.ok, false);
  assert.ok(result.closures[0].feasibility.minResidues > 1);
  assert.ok(result.validation.warnings.some((w) => w.includes('chain break')));
});

test('overlapping blocks are flagged as clashes', () => {
  const assembly = helixHairpin();
  assembly.blocks[1].position = [1.5, 0, 0]; // driven straight through block one

  const result = realize(assembly);
  assert.ok(result.validation.clashes.length > 0);
  assert.equal(result.ok, false);
  assert.ok(result.validation.warnings.some((w) => w.includes('clash')));
});

test('secondaryStructureSegments splits a string into runs', () => {
  const runs = secondaryStructureSegments('HHHLLEEEE');
  assert.deepEqual(
    runs.map((r) => [r.code, r.start, r.end]),
    [
      ['H', 0, 2],
      ['L', 3, 4],
      ['E', 5, 8],
    ],
  );
});

test('PDB records land in the columns the format specifies', () => {
  const line = formatAtomLine({
    serial: 7,
    name: 'CA',
    resName: 'GLY',
    chainId: 'A',
    resSeq: 3,
    xyz: [-12.345, 6.789, 101.2],
  });

  assert.equal(line.length, 78);
  assert.equal(line.slice(0, 6), 'ATOM  ');
  assert.equal(line.slice(6, 11), '    7');
  assert.equal(line.slice(12, 16), ' CA ');
  assert.equal(line.slice(17, 20), 'GLY');
  assert.equal(line[21], 'A');
  assert.equal(line.slice(22, 26), '   3');
  assert.equal(line.slice(30, 38), ' -12.345');
  assert.equal(line.slice(38, 46), '   6.789');
  assert.equal(line.slice(46, 54), ' 101.200');
  assert.equal(line.slice(54, 60), '  1.00');
  assert.equal(line.slice(76, 78), ' C');
});

test('PDB write/read round trip preserves backbone coordinates', () => {
  const assembly = helixHairpin();
  const result = realize(assembly);
  const text = writePDB(result.residues, { segments: result.segments, remarks: ['test design'] });

  assert.ok(text.includes('REMARK 999'));
  assert.ok(text.includes('HELIX '));
  assert.ok(text.trimEnd().endsWith('END'));

  const parsed = parsePDB(text);
  const chain = parsed.chains.get('A');
  assert.equal(chain.length, result.residues.length);

  for (let i = 0; i < chain.length; i += 1) {
    for (const atom of ['N', 'CA', 'C']) {
      // PDB stores three decimals, so agreement to 0.001 A is exact round trip.
      assert.ok(distance(chain[i][atom], result.residues[i][atom]) < 0.002, `${atom} ${i}`);
    }
  }
});

test('design spec captures topology and segment adjacency', () => {
  const assembly = helixHairpin();
  const result = realize(assembly);
  const spec = buildDesignSpec(assembly, result);

  assert.equal(spec.format, 'buildafold.designspec');
  assert.equal(spec.length, result.residues.length);
  assert.equal(spec.ssIndex.length, spec.length);
  assert.equal(spec.ssIndex[0], 0, 'helix encodes as 0');
  assert.equal(spec.ssIndex[spec.length - 1], 0);

  const helixRuns = spec.runs.filter((r) => r.code === 'H');
  assert.equal(helixRuns.length, 2);

  // The two helices are packed at ~10 A, so they must register as adjacent.
  assert.equal(spec.segmentAdjacency.length, 1);
  assert.deepEqual(spec.segmentAdjacency[0], [helixRuns[0].index, helixRuns[1].index]);

  assert.equal(spec.contigs, contigString(spec.length));
  assert.equal(spec.diagnostics.ok, true);
});

test('segment adjacency excludes loops and distant elements', () => {
  resetIds();
  const assembly = createAssembly('spread');
  addBlock(assembly, { type: 'helix', nResidues: 12, position: [0, 0, 0] });
  addBlock(assembly, { type: 'helix', nResidues: 12, position: [40, 0, 0], quaternion: [1, 0, 0, 0] });

  const result = realize(assembly);
  const runs = secondaryStructureSegments(result.ss);
  const pairs = segmentAdjacency(result.residues, runs);

  assert.equal(pairs.length, 0, 'helices 40 A apart are not in contact');
});

test('sketch blocks join the chain like any other block', () => {
  resetIds();
  const assembly = createAssembly('sketched');
  addBlock(assembly, { type: 'helix', nResidues: 10, position: [0, 0, 0] });
  addSketchBlock(assembly, buildElement('polyproline', 8), { position: [14, 0, 0] });

  const result = realize(assembly);
  assert.equal(result.segments.filter((s) => s.kind === 'block').length, 2);
  assert.equal(result.validation.breaks.length, 0);
  assert.ok(result.ss.startsWith('HHHHHHHHHH'));
});

test('assemblies serialise and reload without drift', () => {
  const assembly = helixHairpin();
  const before = realize(assembly);

  const reloaded = deserialize(JSON.parse(JSON.stringify(serialize(assembly))));
  const after = realize(reloaded);

  assert.equal(after.residues.length, before.residues.length);
  assert.equal(after.ss, before.ss);
  for (let i = 0; i < before.residues.length; i += 1) {
    assert.ok(distance(before.residues[i].CA, after.residues[i].CA) < 1e-9);
  }
});

test('sketch block geometry survives a serialisation round trip', () => {
  resetIds();
  const assembly = createAssembly('sketched');
  addSketchBlock(assembly, buildElement('strand', 9), { position: [2, 1, 0] });

  const before = realize(assembly);
  const after = realize(deserialize(JSON.parse(JSON.stringify(serialize(assembly)))));

  for (let i = 0; i < before.residues.length; i += 1) {
    assert.ok(distance(before.residues[i].CA, after.residues[i].CA) < 1e-9);
  }
});

test('blocks can be reordered and removed', () => {
  const assembly = helixHairpin();
  const [first, second] = assembly.blocks.map((b) => b.id);

  reorderBlock(assembly, second, 0);
  assert.deepEqual(assembly.blocks.map((b) => b.id), [second, first]);

  assert.equal(removeBlock(assembly, second), true);
  assert.equal(removeBlock(assembly, 'nonexistent'), false);
  assert.equal(assembly.blocks.length, 1);
  assert.equal(realize(assembly).closures.length, 0);
});

test('directly bonded blocks need no linker and are not an error', () => {
  // Two elements can run straight into each other with no loop between them,
  // which is common in real structures and is how they import. Previously any
  // zero-length linker was reported as unclosed, so such a design could never
  // be buildable.
  resetIds();
  const source = createAssembly('continuous');
  addBlock(source, { type: 'helix', nResidues: 20, position: [0, 0, 0] });
  const chain = realize(source).residues;

  // Split that one helix into two halves and rejoin them with no linker.
  resetIds();
  const split = createAssembly('split');
  addSketchBlock(split, chain.slice(0, 10), { type: 'helix' });
  addSketchBlock(split, chain.slice(10), { type: 'helix', linkerBefore: 0 });

  const result = realize(split);
  assert.equal(result.closures.length, 1);
  assert.equal(result.closures[0].nResidues, 0);
  assert.equal(result.closures[0].converged, true, 'an intact peptide bond is closed');
  assert.equal(result.validation.breaks.length, 0);
  assert.equal(result.ok, true, 'a directly bonded pair must not read as unbuildable');
  assert.equal(result.residues.length, 20);
});

test('a direct junction with a gap still reports the gap', () => {
  resetIds();
  const assembly = createAssembly('gapped');
  addBlock(assembly, { type: 'helix', nResidues: 10, position: [0, 0, 0] });
  addBlock(assembly, { type: 'helix', nResidues: 10, position: [30, 0, 0], linkerBefore: 0 });

  const result = realize(assembly);
  assert.equal(result.closures[0].converged, false);
  assert.equal(result.ok, false);
  assert.match(result.closures[0].note, /apart/);
});

test('a block placed at the chain end needs only a minimal linker', async () => {
  const { blockExtent } = await import('../src/model/assembly.js');
  const { placeAfter } = await import('../src/geometry/frame.js');

  resetIds();
  const assembly = createAssembly('Continued chain');
  const first = addBlock(assembly, { type: 'helix', nResidues: 14, position: [0, 0, 0] });

  const second = addBlock(assembly, { type: 'helix', nResidues: 14 });
  Object.assign(
    second,
    placeAfter(
      { position: first.position, quaternion: first.quaternion, extent: blockExtent(first) },
      blockExtent(second),
      11,
    ),
  );

  const continued = realize(assembly);
  const junction = continued.closures.find((c) => c.blockId === second.id);
  assert.ok(junction.nResidues <= 4, `a short junction, got ${junction.nResidues} residues`);
  assert.ok(junction.converged, 'and it closes');
  assert.equal(junction.clashes, 0);
  assert.equal(continued.validation.clashes.length, 0, 'with nothing overlapping');

  // The lattice placement the palette used to use drops the block beside the
  // first one instead, which costs a longer loop for the same two elements.
  const lattice = createAssembly('Lattice');
  addBlock(lattice, { type: 'helix', nResidues: 14, position: [0, 0, 0] });
  const dropped = addBlock(lattice, {
    type: 'helix',
    nResidues: 14,
    position: [10.5, 0, 0],
    quaternion: [1, 0, 0, 0],
  });
  const beside = realize(lattice).closures.find((c) => c.blockId === dropped.id);
  assert.ok(
    beside.nResidues > junction.nResidues,
    `continuing the chain should need a shorter linker than dropping alongside ` +
      `(${junction.nResidues} vs ${beside.nResidues})`,
  );
});

test('a bent block realises, round-trips and keeps ideal bonds', async () => {
  const { bendResidual, blockExtent } = await import('../src/model/assembly.js');

  resetIds();
  const assembly = createAssembly('Bent sheet');
  addBlock(assembly, { type: 'strand', nResidues: 18, position: [0, 0, 0], bend: 60 });
  addBlock(assembly, {
    type: 'strand',
    nResidues: 18,
    position: [5, 0, 0],
    quaternion: [1, 0, 0, 0],
    bend: -60,
  });

  const result = realize(assembly);
  assert.equal(result.residues.length > 36, true);
  for (let i = 1; i < result.residues.length; i += 1) {
    const bond = distance(result.residues[i - 1].C, result.residues[i].N);
    assert.ok(Math.abs(bond - BOND.C_N) < 0.3, `peptide bond ${i} is ${bond.toFixed(2)} A`);
  }

  // A bent strand is shorter end to end than a straight one of the same length.
  const straight = createAssembly('Straight');
  addBlock(straight, { type: 'strand', nResidues: 18, position: [0, 0, 0] });
  assert.ok(
    blockExtent(assembly.blocks[0]) < blockExtent(straight.blocks[0]),
    'bending has to shorten the element along its axis',
  );

  // The residual is reported, and reported as zero when there is no bend.
  assert.ok(bendResidual(assembly.blocks[0]) > 0);
  assert.equal(bendResidual(straight.blocks[0]), 0);

  // Bend survives save and load, geometry and all.
  const reloaded = deserialize(JSON.parse(JSON.stringify(serialize(assembly))));
  assert.equal(reloaded.blocks[0].bend, 60);
  assert.equal(reloaded.blocks[1].bend, -60);
  assert.deepEqual(
    realize(reloaded).residues.map((r) => r.CA),
    result.residues.map((r) => r.CA),
    'a reloaded design must rebuild identically',
  );
});

test('changing bend or length invalidates the cached geometry', async () => {
  const { blockGeometry } = await import('../src/model/assembly.js');

  resetIds();
  const assembly = createAssembly('Cache');
  const block = addBlock(assembly, { type: 'strand', nResidues: 16, position: [0, 0, 0] });

  const flat = blockGeometry(block).map((r) => [...r.CA]);
  block.bend = 60;
  const bent = blockGeometry(block).map((r) => [...r.CA]);
  assert.notDeepEqual(bent, flat, 'a new bend must not serve the old geometry');

  // And going back gets the original, from cache or not.
  block.bend = 0;
  assert.deepEqual(blockGeometry(block).map((r) => [...r.CA]), flat);

  // The preview fit is a separate cache entry, not a replacement for the exact one.
  block.bend = 60;
  blockGeometry(block, { preview: true });
  assert.deepEqual(blockGeometry(block).map((r) => [...r.CA]), bent);
});

test('realising a block records how long it actually is', async () => {
  // The viewer sizes its drag handles from this, so it has to track the
  // geometry rather than being estimated from the residue count.
  resetIds();
  const assembly = createAssembly('Extents');
  const helix = addBlock(assembly, { type: 'helix', nResidues: 20, position: [0, 0, 0] });

  realize(assembly);
  const straight = helix.extent;
  assert.ok(straight > 25 && straight < 32, `a 20-residue helix is ~29 A, got ${straight}`);

  helix.bend = 60;
  realize(assembly);
  // Bent into a 60 degree arc, the element's end-to-end length is the chord of
  // that arc: sin(30)/(pi/6) of what it was.
  const chord = straight * (Math.sin(Math.PI / 6) / (Math.PI / 6));
  assert.ok(helix.extent < straight, `bending must shorten the extent, got ${helix.extent}`);
  assert.ok(
    Math.abs(helix.extent - chord) < 0.05 * chord,
    `expected about ${chord.toFixed(1)} A, got ${helix.extent.toFixed(1)}`,
  );

  helix.bend = 0;
  realize(assembly);
  assert.equal(helix.extent, straight, 'and straightening must restore it');
});

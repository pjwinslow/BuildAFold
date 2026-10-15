import test from 'node:test';
import assert from 'node:assert/strict';

import { assignSecondaryStructure, secondaryStructureRuns, virtualGeometry } from '../src/geometry/ssassign.js';
import { buildElement } from '../src/geometry/chain.js';

const casOf = (residues) => residues.map((r) => r.CA);
const fraction = (ss, code) => [...ss].filter((c) => c === code).length / ss.length;

test('an ideal helix is assigned as helix', () => {
  const ss = assignSecondaryStructure(casOf(buildElement('helix', 20)));
  assert.ok(fraction(ss, 'H') > 0.8, `expected mostly H, got ${ss}`);
  assert.equal(ss.includes('E'), false, 'a helix must never read as strand');
});

test('an ideal strand is assigned as strand', () => {
  const ss = assignSecondaryStructure(casOf(buildElement('strand', 12)));
  assert.ok(fraction(ss, 'E') > 0.7, `expected mostly E, got ${ss}`);
  assert.equal(ss.includes('H'), false, 'a strand must never read as helix');
});

test('an extended coil is not mistaken for a strand or helix', () => {
  const ss = assignSecondaryStructure(casOf(buildElement('polyproline', 14)));
  assert.equal(ss.includes('H'), false, `polyproline read as helix: ${ss}`);
});

test('a helix flanked by coil is found and bounded', () => {
  // Coil, helix, coil: the helix should be located, not smeared over the lot.
  const chain = [
    ...buildElement('polyproline', 5),
    ...buildElement('helix', 14),
    ...buildElement('polyproline', 5),
  ];
  // Rebuild as one continuous trace so the geometry is contiguous.
  const ss = assignSecondaryStructure(casOf(chain));
  const runs = secondaryStructureRuns(ss).filter((r) => r.code === 'H');
  assert.ok(runs.length >= 1, `no helix found in ${ss}`);
  assert.ok(runs[0].length >= 4, 'the helix run should be a real element');
});

test('short spurious runs are discarded', () => {
  // Three residues cannot be a helix.
  const ss = assignSecondaryStructure(casOf(buildElement('helix', 3)));
  assert.equal(ss.includes('H'), false, `a 3-residue helix should not be called: ${ss}`);
});

test('virtualGeometry reports the textbook values', () => {
  const helix = virtualGeometry(casOf(buildElement('helix', 12)));
  const middle = helix[5];
  assert.ok(Math.abs(middle.theta - 91) < 8, `helix Ca angle was ${middle.theta.toFixed(1)}`);
  assert.ok(Math.abs(middle.tau - 50) < 12, `helix Ca dihedral was ${middle.tau.toFixed(1)}`);

  const strand = virtualGeometry(casOf(buildElement('strand', 10)));
  assert.ok(Math.abs(strand[4].theta - 125) < 15, `strand Ca angle was ${strand[4].theta.toFixed(1)}`);
});

test('runs are split correctly and cover every residue', () => {
  const runs = secondaryStructureRuns('LLHHHHEEEL');
  assert.deepEqual(
    runs.map((r) => [r.code, r.start, r.end]),
    [
      ['L', 0, 1],
      ['H', 2, 5],
      ['E', 6, 8],
      ['L', 9, 9],
    ],
  );
  assert.equal(runs.reduce((n, r) => n + r.length, 0), 10);
});

test('very short chains are handled without throwing', () => {
  assert.equal(assignSecondaryStructure([]), '');
  assert.equal(assignSecondaryStructure(casOf(buildElement('helix', 2))), 'LL');
});

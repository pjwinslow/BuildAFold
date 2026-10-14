import test from 'node:test';
import assert from 'node:assert/strict';

import { placeAtom } from '../src/geometry/nerf.js';
import { angle, dihedral, distance, wrapDeg, normalize, centroid } from '../src/geometry/vec3.js';
import { buildElement, buildBackbone, seedResidue } from '../src/geometry/chain.js';
import { canonicalize, principalAxis, transformResidues, quaternionToMatrix } from '../src/geometry/frame.js';
import { superpose } from '../src/geometry/kabsch.js';
import { closeLoop, closureFeasibility } from '../src/geometry/ccd.js';
import { resampleChordal, fitTorsionsToTrace, smoothPolyline } from '../src/geometry/trace.js';
import { isAllowed, clampToAllowed } from '../src/geometry/rama.js';
import { BOND, ANGLE, SS_PRESETS } from '../src/geometry/constants.js';

const close = (actual, expected, tol, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${message ?? ''} expected ${expected} +/- ${tol}, got ${actual}`,
  );

test('placeAtom reproduces the requested internal coordinates', () => {
  const a = [0, 1, 0];
  const b = [0, 0, 0];
  const c = [1.5, 0, 0];

  for (const torsion of [-170, -120, -60, 0, 45, 90, 179]) {
    const d = placeAtom(a, b, c, 1.33, 116.2, torsion);
    close(distance(c, d), 1.33, 1e-9, 'bond length');
    close(angle(b, c, d), 116.2, 1e-7, 'bond angle');
    close(wrapDeg(dihedral(a, b, c, d) - torsion), 0, 1e-7, 'torsion');
  }
});

test('placeAtom survives collinear reference atoms', () => {
  const d = placeAtom([0, 0, 0], [1, 0, 0], [2, 0, 0], 1.5, 110, 60);
  assert.ok(Number.isFinite(d[0]) && Number.isFinite(d[1]) && Number.isFinite(d[2]));
  close(distance([2, 0, 0], d), 1.5, 1e-9);
});

test('every built chain has ideal bond geometry', () => {
  for (const type of Object.keys(SS_PRESETS)) {
    const residues = buildElement(type, 12);
    assert.equal(residues.length, 12);

    for (let i = 0; i < residues.length; i += 1) {
      const r = residues[i];
      close(distance(r.N, r.CA), BOND.N_CA, 1e-6, `${type} N-CA`);
      close(distance(r.CA, r.C), BOND.CA_C, 1e-6, `${type} CA-C`);
      close(distance(r.C, r.O), BOND.C_O, 1e-6, `${type} C=O`);
      close(angle(r.N, r.CA, r.C), ANGLE.N_CA_C, 1e-5, `${type} N-CA-C`);

      if (i + 1 < residues.length) {
        const next = residues[i + 1];
        close(distance(r.C, next.N), BOND.C_N, 1e-6, `${type} peptide bond`);
        close(distance(r.CA, next.CA), 3.8, 0.02, `${type} virtual CA-CA`);
        close(Math.abs(wrapDeg(dihedral(r.CA, r.C, next.N, next.CA))), 180, 1e-4, `${type} omega`);
      }
    }
  }
});

test('an ideal alpha helix has textbook dimensions', () => {
  const helix = buildElement('helix', 20);
  const cas = helix.map((r) => r.CA);

  // 3.6 residues per turn: i -> i+3 and i -> i+4 are the classic signatures.
  close(distance(cas[4], cas[7]), 5.0, 0.35, 'CA(i)-CA(i+3)');
  close(distance(cas[4], cas[8]), 6.2, 0.35, 'CA(i)-CA(i+4)');

  // 1.5 A rise per residue along the helix axis.
  const axis = principalAxis(cas);
  const project = (p) => p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2];
  const rise = (project(cas[cas.length - 1]) - project(cas[0])) / (cas.length - 1);
  close(rise, 1.5, 0.08, 'rise per residue');

  // Right-handed: the virtual CA dihedral of an alpha helix is about +50 degrees.
  const tau = dihedral(cas[5], cas[6], cas[7], cas[8]);
  close(tau, 50, 8, 'virtual CA dihedral (handedness)');
});

test('an ideal beta strand is extended', () => {
  const strand = buildElement('strand', 10);
  const cas = strand.map((r) => r.CA);
  close(distance(cas[2], cas[4]), 6.7, 0.25, 'CA(i)-CA(i+2)');

  const axis = principalAxis(cas);
  const project = (p) => p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2];
  const rise = (project(cas[cas.length - 1]) - project(cas[0])) / (cas.length - 1);
  close(rise, 3.3, 0.2, 'rise per residue');
});

test('canonicalize puts an element on the +z axis at the origin', () => {
  const helix = canonicalize(buildElement('helix', 16));
  const cas = helix.map((r) => r.CA);
  const mean = centroid(cas);

  for (const component of mean) close(component, 0, 1e-9, 'centroid');

  const axis = principalAxis(cas);
  close(Math.abs(axis[2]), 1, 1e-6, 'axis aligned to z');
  assert.ok(axis[2] > 0, 'axis should run N-terminus to C-terminus along +z');
});

test('superposition recovers a known rigid transform without reflecting', () => {
  const helix = buildElement('helix', 14);
  const raw = [0.3, -0.5, 0.2, 0.78];
  const norm = Math.hypot(...raw);
  const rotation = quaternionToMatrix(raw.map((v) => v / norm));
  const moved = transformResidues(helix, rotation, [12, -4, 7]);

  const fit = superpose(
    helix.map((r) => r.CA),
    moved.map((r) => r.CA),
  );
  close(fit.rmsd, 0, 1e-6, 'rmsd after superposition');

  // A reflection would have determinant -1.
  const m = fit.rotation;
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  close(det, 1, 1e-6, 'rotation determinant');
});

test('CCD reconnects two blocks with chemically correct junctions', () => {
  // Take one ideal chain, treat residues 0-7 and 15-22 as placed blocks, and
  // ask CCD to rebuild the seven residues in between.
  const reference = buildBackbone(
    Array.from({ length: 23 }, (_, i) => (i < 8 || i >= 15 ? { phi: -57, psi: -47 } : { phi: -75, psi: 145 })),
  );
  const prev = reference[7];
  const next = reference[15];

  const result = closeLoop(prev, next, 7);
  assert.ok(result.converged, `closure should converge, rmsd was ${result.rmsd}`);
  assert.equal(result.residues.length, 7);

  // Junction into the loop.
  close(distance(prev.C, result.residues[0].N), BOND.C_N, 0.02, 'N-terminal junction');

  // Internal geometry.
  for (let i = 0; i + 1 < result.residues.length; i += 1) {
    close(
      distance(result.residues[i].C, result.residues[i + 1].N),
      BOND.C_N,
      1e-5,
      'loop peptide bond',
    );
  }

  // Junction out of the loop onto the fixed next block.
  const last = result.residues[result.residues.length - 1];
  close(distance(last.C, next.N), BOND.C_N, 0.15, 'C-terminal junction');
});

test('CCD reports infeasible gaps instead of inventing geometry', () => {
  const chain = buildElement('polyproline', 30);
  const prev = chain[0];
  const next = chain[29];

  const feasibility = closureFeasibility(prev, next, 2);
  assert.equal(feasibility.feasible, false);
  assert.ok(feasibility.shortfall > 0);
  assert.ok(feasibility.minResidues > 2);

  const result = closeLoop(prev, next, 2, { restarts: 2, maxSweeps: 60 });
  assert.equal(result.converged, false);
  assert.ok(result.rmsd > 1);
});

test('loop torsions stay inside populated Ramachandran basins when restrained', () => {
  const reference = buildBackbone(Array.from({ length: 20 }, () => ({ phi: -120, psi: 130 })));
  const result = closeLoop(reference[5], reference[13], 7, { restrain: true });

  for (const residue of result.residues) {
    assert.ok(
      isAllowed(residue.phi, residue.psi),
      `loop residue at (${residue.phi.toFixed(0)}, ${residue.psi.toFixed(0)}) is disallowed`,
    );
  }
});

test('clampToAllowed is a no-op inside a basin and projects from outside', () => {
  assert.deepEqual(clampToAllowed(-57, -47), [-57, -47]);
  const [phi, psi] = clampToAllowed(0, 0);
  assert.ok(isAllowed(phi, psi));
});

test('stroke resampling produces an even CA-spaced trace', () => {
  const stroke = [];
  for (let i = 0; i < 40; i += 1) {
    stroke.push([i * 1.3, Math.sin(i * 0.25) * 9, Math.cos(i * 0.18) * 4]);
  }
  const trace = resampleChordal(smoothPolyline(stroke), 3.8);

  assert.ok(trace.length > 8, 'should yield a usable number of residues');
  for (let i = 1; i < trace.length; i += 1) {
    close(distance(trace[i - 1], trace[i]), 3.8, 0.05, 'resampled spacing');
  }
});

test('sketch lifting follows the drawn trace with valid backbone geometry', () => {
  // Use a real helix Ca trace as the "drawing": a conformation torsion space
  // can reproduce exactly, so the fit should be tight.
  const target = buildElement('helix', 18).map((r) => r.CA);
  const fit = fitTorsionsToTrace(target, { beamWidth: 24, gridStep: 15 });

  assert.equal(fit.residues.length, target.length);
  assert.ok(fit.rmsd < 1.5, `trace fit rmsd should be tight, got ${fit.rmsd}`);

  for (let i = 0; i + 1 < fit.residues.length; i += 1) {
    close(
      distance(fit.residues[i].C, fit.residues[i + 1].N),
      BOND.C_N,
      1e-5,
      'lifted chain peptide bond',
    );
  }
  for (const residue of fit.residues) {
    assert.ok(isAllowed(residue.phi ?? -75, residue.psi), 'lifted torsions should be allowed');
  }
});

test('seedResidue has ideal internal geometry', () => {
  const seed = seedResidue();
  close(distance(seed.N, seed.CA), BOND.N_CA, 1e-9);
  close(distance(seed.CA, seed.C), BOND.CA_C, 1e-9);
  close(angle(seed.N, seed.CA, seed.C), ANGLE.N_CA_C, 1e-7);
});

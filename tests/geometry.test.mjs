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

test('transformAbout moves a group rigidly', async () => {
  const { transformAbout, quaternionMultiply } = await import('../src/geometry/frame.js');

  const blocks = [
    { id: 'a', position: [10, 0, 0], quaternion: [0, 0, 0, 1] },
    { id: 'b', position: [-10, 0, 0], quaternion: [0, 0, 0, 1] },
    { id: 'c', position: [0, 6, 0], quaternion: [0, 0, 0, 1] },
  ];
  const pivot = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };

  // Pure translation shifts everything by the same amount.
  const shifted = transformAbout(blocks, pivot, { position: [5, -2, 3], quaternion: [0, 0, 0, 1] });
  shifted.forEach((block, i) => {
    assert.deepEqual(
      block.position.map((v) => Number(v.toFixed(6))),
      blocks[i].position.map((v, axis) => Number((v + [5, -2, 3][axis]).toFixed(6))),
    );
    assert.deepEqual(block.quaternion, [0, 0, 0, 1], 'translation must not rotate anything');
  });

  // A quarter turn about z sends +x to +y, about the pivot.
  const quarter = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const turned = transformAbout(blocks, pivot, { position: [0, 0, 0], quaternion: quarter });
  close(turned[0].position[0], 0, 1e-6, 'x should rotate away');
  close(turned[0].position[1], 10, 1e-6, 'onto y');
  close(turned[2].position[0], -6, 1e-6, '+y goes to -x');

  // Every block picks up the same rotation.
  for (const block of turned) {
    assert.deepEqual(
      block.quaternion.map((v) => Number(v.toFixed(6))),
      quarter.map((v) => Number(v.toFixed(6))),
    );
  }

  // Distances inside the group are preserved: it is rigid.
  const spread = (list) => distance(list[0].position, list[1].position);
  close(spread(turned), spread(blocks), 1e-6, 'a rigid move cannot change the shape');

  // Rotating about an off-centre pivot swings the group around it.
  const offset = { position: [10, 0, 0], quaternion: [0, 0, 0, 1] };
  const swung = transformAbout(blocks, offset, { position: [10, 0, 0], quaternion: quarter });
  close(swung[0].position[0], 10, 1e-6, 'a block at the pivot stays put');
  close(swung[0].position[1], 0, 1e-6);
  close(spread(swung), spread(blocks), 1e-6);

  // Composing the rotation twice equals a half turn.
  const twice = transformAbout(turned, pivot, { position: [0, 0, 0], quaternion: quarter });
  close(twice[0].position[0], -10, 1e-6);
  assert.ok(
    quaternionMultiply(quarter, quarter).every((v, i) => Math.abs(v - [0, 0, 1, 0][i]) < 1e-6),
  );
});

test('placeAfter continues the chain from the end of the previous block', async () => {
  const { placeAfter } = await import('../src/geometry/frame.js');

  // Along +z: half of each extent plus the gap.
  const straight = placeAfter({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], extent: 20 }, 14, 7);
  assert.deepEqual(straight.position, [0, 0, 10 + 7 + 7]);
  assert.deepEqual(straight.quaternion, [0, 0, 0, 1], 'the orientation is inherited, not reset');

  // A quarter turn about y sends the element axis from +z to +x, so the next
  // block has to go out along +x from wherever the previous one sits.
  const quarter = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  const turned = placeAfter({ position: [5, 1, -2], quaternion: quarter, extent: 20 }, 14, 7);
  close(turned.position[0], 5 + 24, 1e-6, 'advances along the rotated axis');
  close(turned.position[1], 1, 1e-6, 'and not across it');
  close(turned.position[2], -2, 1e-6);
  assert.deepEqual(turned.quaternion, quarter);

  // The gap between the two blocks' near ends is exactly what was asked for,
  // whatever the two extents are — that is what sizes the linker.
  for (const [a, b, gap] of [[20, 14, 7], [8, 30, 3], [12, 12, 0]]) {
    const next = placeAfter({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], extent: a }, b, gap);
    close(next.position[2] - a / 2 - b / 2, gap, 1e-9);
  }
});

test('arcBend wraps an axis onto a circle without stretching it', async () => {
  const { arcBend } = await import('../src/geometry/bend.js');

  // A straight run of points along z, 1 A apart, centred on the origin.
  const points = [];
  for (let z = -10; z <= 10; z += 1) points.push([0, 0, z]);

  assert.deepEqual(arcBend(points, 0), points, 'no bend leaves the points alone');

  const bent = arcBend(points, 90);

  // Arc length is preserved: spacing along the curve is unchanged.
  for (let i = 1; i < bent.length; i += 1) {
    close(distance(bent[i - 1], bent[i]), 1, 1e-3, 'bending must not stretch the axis');
  }

  // The chord of a 90 degree arc is sin(45)/(pi/4) of its length.
  const expected = 20 * (Math.sin(Math.PI / 4) / (Math.PI / 4));
  close(distance(bent[0], bent[bent.length - 1]), expected, 1e-6);

  // Every point is the same distance from the centre of curvature.
  const radius = 20 / (Math.PI / 2);
  for (const p of bent) close(distance(p, [radius, 0, 0]), radius, 1e-6);

  // Negative bends curve the other way, and are otherwise a mirror image.
  const other = arcBend(points, -90);
  other.forEach((p, i) => {
    close(p[0], -bent[i][0], 1e-9);
    close(p[2], bent[i][2], 1e-9);
  });

  // Off-axis points are carried round, keeping their distance from the centre
  // of curvature — that is what makes the map a bend and not a projection.
  const column = points.map(([, , z]) => [1, 0, z]);
  const radius60 = 20 / (Math.PI / 3);
  for (const p of arcBend(column, 60)) {
    close(distance(p, [radius60, 0, 0]), radius60 - 1, 1e-6, 'inside the bend');
  }
  for (const p of arcBend(column, -60)) {
    close(distance(p, [-radius60, 0, 0]), radius60 + 1, 1e-6, 'outside the bend');
  }
});

test('a bent element is still the element it started as', async () => {
  const { bentElement, MAX_BEND } = await import('../src/geometry/bend.js');
  const { assignSecondaryStructure } = await import('../src/geometry/ssassign.js');
  const { findClashes } = await import('../src/geometry/validate.js');
  const { isAllowed: allowed } = await import('../src/geometry/rama.js');

  for (const [type, n, code] of [['strand', 16, 'E'], ['helix', 20, 'H'], ['strandPar', 16, 'E']]) {
    const straight = bentElement(type, n, 0);
    close(straight.rmsd, 0, 0, 'a straight element is not fitted at all');
    assert.deepEqual(
      straight.residues.map((r) => r.CA),
      buildElement(type, n).map((r) => r.CA),
      'bend 0 must be the ideal element, untouched',
    );

    for (const bend of [30, 60, MAX_BEND, -60]) {
      const { residues, rmsd } = bentElement(type, n, bend);
      assert.equal(residues.length, n);

      // Ideal bond geometry is not negotiable: it is what every export relies on.
      for (let i = 1; i < residues.length; i += 1) {
        close(distance(residues[i - 1].C, residues[i].N), BOND.C_N, 1e-6, `${type} ${bend}`);
      }
      for (const residue of residues) {
        close(distance(residue.N, residue.CA), BOND.N_CA, 1e-6);
        close(angle(residue.N, residue.CA, residue.C), ANGLE.N_CA_C, 1e-5);
      }

      // Still in a populated basin, and still reads as its own structure.
      for (const residue of residues) {
        if (residue.phi === null || residue.psi === null) continue;
        assert.ok(allowed(residue.phi, residue.psi), `${type} ${bend} left the Ramachandran plot`);
      }
      const assigned = assignSecondaryStructure(residues.map((r) => r.CA));
      const fraction = [...assigned].filter((c) => c === code).length / assigned.length;
      assert.ok(fraction > 0.8, `${type} bent ${bend} assigned ${assigned}`);

      assert.equal(findClashes(residues).length, 0, `${type} bent ${bend} clashes with itself`);
      assert.ok(rmsd < 2, `${type} bent ${bend} missed the arc by ${rmsd.toFixed(2)} A`);
    }
  }
});

test('a bent element really does bend, by about the amount asked for', async () => {
  const { bentElement } = await import('../src/geometry/bend.js');

  // Independent of the fit: a circular arc of angle t has a chord of
  // sin(t/2)/(t/2) of its arc length, so the end-to-end span of a bent element
  // has to shrink by that factor. Nothing about the torsion search is involved.
  for (const [type, n] of [['strand', 16], ['strand', 24], ['helix', 20]]) {
    const span = (bend) => {
      const residues = bentElement(type, n, bend).residues;
      return distance(residues[0].CA, residues[residues.length - 1].CA);
    };
    const straight = span(0);

    let previous = straight;
    for (const bend of [30, 60, 90]) {
      const t = (bend * Math.PI) / 180;
      const predicted = straight * (Math.sin(t / 2) / (t / 2));
      const measured = span(bend);

      // Within 8% of a true arc. A strand is stiff and the torsion window is
      // deliberately narrow, so this is the honest accuracy, not a loose bound:
      // at bend 0 the same measure is exact.
      close(measured, predicted, 0.08 * predicted, `${type} ${n} bend ${bend}`);
      assert.ok(measured < previous, `${type} ${n}: bending further must not straighten it`);
      previous = measured;
    }
  }
});

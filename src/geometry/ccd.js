/**
 * Loop closure by Cyclic Coordinate Descent.
 *
 * Once two blocks have been placed independently in space, something has to
 * physically connect them. CCD (Canutescu & Dunbrack, 2003) solves exactly
 * this: it walks the free backbone torsions of the linker and, for each one in
 * turn, applies the closed-form rotation that best superimposes the three
 * terminal atoms onto the fixed anchor atoms of the next block.
 *
 * The result is a linker with ideal bond geometry whose junctions to both
 * blocks are chemically correct — not an interpolated ribbon.
 */

import { ANGLE, BOND, MAX_SPAN_PER_RESIDUE, OMEGA_TRANS } from './constants.js';
import { placeAtom } from './nerf.js';
import { completeResidue } from './chain.js';
import { clampToAllowed } from './rama.js';
import { cross, distance, dot, normalize, scale, sub, wrapDeg } from './vec3.js';

/**
 * Count loop residues that collide with already-placed structure, or with the
 * loop itself. Closure alone only guarantees the two ends meet — without this
 * the shortest path between two blocks is frequently straight through a third.
 */
function countClashes(residues, avoid, cutoff, loopStart, sequenceSeparation) {
  const cutoffSq = cutoff * cutoff;
  let clashes = 0;

  for (let i = 0; i < residues.length; i += 1) {
    const ca = residues[i].CA;
    const globalIndex = loopStart + i;

    for (const obstacle of avoid) {
      // Residues close in sequence are bonded neighbours, not obstacles.
      if (
        obstacle.index != null &&
        Math.abs(obstacle.index - globalIndex) < sequenceSeparation
      ) {
        continue;
      }
      const dx = ca[0] - obstacle.xyz[0];
      const dy = ca[1] - obstacle.xyz[1];
      const dz = ca[2] - obstacle.xyz[2];
      if (dx * dx + dy * dy + dz * dz < cutoffSq) {
        clashes += 1;
        break;
      }
    }

    for (let j = i + sequenceSeparation; j < residues.length; j += 1) {
      if (distance(ca, residues[j].CA) < cutoff) clashes += 1;
    }
  }
  return clashes;
}

/** Small deterministic PRNG so retries are reproducible across runs. */
function makeRng(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/**
 * Can `nResidues` residues plausibly bridge the gap between two anchors?
 * Returns the geometric budget so callers can explain a failure rather than
 * just reporting that closure did not converge.
 */
export function closureFeasibility(prev, next, nResidues) {
  const gap = distance(prev.C, next.N);
  const reach = MAX_SPAN_PER_RESIDUE * (nResidues + 1);
  return {
    gap,
    reach,
    feasible: gap <= reach,
    shortfall: Math.max(0, gap - reach),
    minResidues: Math.max(0, Math.ceil(gap / MAX_SPAN_PER_RESIDUE) - 1),
  };
}

/**
 * Build the linker atoms for a given torsion vector.
 *
 * Torsion layout: `[psiPrev, phi_1, psi_1, ..., phi_n, psi_n, phiNext]`.
 * The chain is grown from the previous block's fixed N/CA/C and ends with a
 * virtual copy of the next block's first residue, whose N/CA/C are the atoms
 * CCD drives onto the real ones.
 */
function buildLinker(prev, torsions, nResidues) {
  const residues = [];
  let previous = { N: prev.N, CA: prev.CA, C: prev.C, psi: torsions[0], omega: OMEGA_TRANS };

  for (let i = 0; i < nResidues; i += 1) {
    const phi = torsions[1 + i * 2];
    const psi = torsions[2 + i * 2];
    const N = placeAtom(previous.N, previous.CA, previous.C, BOND.C_N, ANGLE.CA_C_N, previous.psi);
    const CA = placeAtom(previous.CA, previous.C, N, BOND.N_CA, ANGLE.C_N_CA, OMEGA_TRANS);
    const C = placeAtom(previous.C, N, CA, BOND.CA_C, ANGLE.N_CA_C, phi);
    previous = { N, CA, C, phi, psi, omega: OMEGA_TRANS };
    residues.push(previous);
  }

  // Virtual rebuild of the next block's first residue.
  const phiNext = torsions[torsions.length - 1];
  const N = placeAtom(previous.N, previous.CA, previous.C, BOND.C_N, ANGLE.CA_C_N, previous.psi);
  const CA = placeAtom(previous.CA, previous.C, N, BOND.N_CA, ANGLE.C_N_CA, OMEGA_TRANS);
  const C = placeAtom(previous.C, N, CA, BOND.CA_C, ANGLE.N_CA_C, phiNext);

  return { residues, probe: { N, CA, C } };
}

/** RMSD over the three junction atoms. */
function probeRmsd(probe, next) {
  const d =
    distance(probe.N, next.N) ** 2 +
    distance(probe.CA, next.CA) ** 2 +
    distance(probe.C, next.C) ** 2;
  return Math.sqrt(d / 3);
}

/**
 * Closed-form optimal rotation about a bond, from the CCD paper: the angle
 * maximising the alignment of moving points with fixed points is the
 * `atan2` of the summed perpendicular/radial projections.
 */
function optimalRotation(axisOrigin, axisDirection, moving, fixed) {
  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < moving.length; i += 1) {
    const rel = sub(moving[i], axisOrigin);
    const along = dot(rel, axisDirection);
    const projection = sub(rel, scale(axisDirection, along));
    const radius = Math.sqrt(dot(projection, projection));
    if (radius < 1e-8) continue;

    const rHat = scale(projection, 1 / radius);
    const sHat = cross(axisDirection, rHat);

    const target = sub(fixed[i], axisOrigin);
    const targetPerp = sub(target, scale(axisDirection, dot(target, axisDirection)));

    numerator += radius * dot(targetPerp, sHat);
    denominator += radius * dot(targetPerp, rHat);
  }

  if (Math.abs(numerator) < 1e-12 && Math.abs(denominator) < 1e-12) return 0;
  return (Math.atan2(numerator, denominator) * 180) / Math.PI;
}

/** Bond axis (origin + unit direction) that a given torsion index rotates about. */
function torsionAxis(prev, built, index, nResidues) {
  if (index === 0) {
    return { origin: prev.C, direction: normalize(sub(prev.C, prev.CA)) };
  }
  const last = index === nResidues * 2 + 1;
  if (last) {
    // phi of the virtual next residue rotates about its own N-CA bond.
    return { origin: built.probe.CA, direction: normalize(sub(built.probe.CA, built.probe.N)) };
  }

  const residueIndex = Math.floor((index - 1) / 2);
  const residue = built.residues[residueIndex];
  const isPhi = (index - 1) % 2 === 0;
  return isPhi
    ? { origin: residue.CA, direction: normalize(sub(residue.CA, residue.N)) }
    : { origin: residue.C, direction: normalize(sub(residue.C, residue.CA)) };
}

/**
 * Close a loop of `nResidues` residues between two placed blocks.
 *
 * @param {{N: number[], CA: number[], C: number[]}} prev last residue of the preceding block
 * @param {{N: number[], CA: number[], C: number[]}} next first residue of the following block
 * @param {number} nResidues number of linker residues to insert
 * @param {object} [options]
 * @returns {{residues: Array, rmsd: number, converged: boolean, psiPrev: number,
 *            phiNext: number, feasibility: object, restrained: boolean}}
 */
export function closeLoop(prev, next, nResidues, options = {}) {
  const {
    // Tight enough that the junction peptide bond lands inside the 0.1 A
    // tolerance the chain validator applies; a looser fit shows up downstream
    // as a chain break.
    tolerance = 0.05,
    maxSweeps = 400,
    restarts = 6,
    restrain = true,
    seed = 20260101,
    avoid = [],
    clashCutoff = 4.0,
    loopStart = 0,
    sequenceSeparation = 3,
  } = options;

  const feasibility = closureFeasibility(prev, next, nResidues);
  const nTorsions = nResidues * 2 + 2;
  const rng = makeRng(seed);

  let best = null;

  for (let restart = 0; restart < restarts; restart += 1) {
    const torsions = new Array(nTorsions);
    if (restart === 0) {
      // Extended start: reaches furthest, converges fastest on long gaps.
      torsions.fill(0);
      torsions[0] = 145;
      for (let i = 0; i < nResidues; i += 1) {
        torsions[1 + i * 2] = -75;
        torsions[2 + i * 2] = 145;
      }
      torsions[nTorsions - 1] = -75;
    } else {
      torsions[0] = -180 + rng() * 360;
      for (let i = 0; i < nResidues; i += 1) {
        const [phi, psi] = clampToAllowed(-180 + rng() * 360, -180 + rng() * 360);
        torsions[1 + i * 2] = phi;
        torsions[2 + i * 2] = psi;
      }
      torsions[nTorsions - 1] = -180 + rng() * 360;
    }

    let built = buildLinker(prev, torsions, nResidues);
    let rmsd = probeRmsd(built.probe, next);

    for (let sweep = 0; sweep < maxSweeps && rmsd > tolerance; sweep += 1) {
      for (let index = 0; index < nTorsions; index += 1) {
        const axis = torsionAxis(prev, built, index, nResidues);
        const moving = [built.probe.N, built.probe.CA, built.probe.C];
        const fixed = [next.N, next.CA, next.C];
        const delta = optimalRotation(axis.origin, axis.direction, moving, fixed);
        if (!Number.isFinite(delta) || Math.abs(delta) < 1e-6) continue;

        const candidate = [...torsions];
        candidate[index] = wrapDeg(candidate[index] + delta);

        if (restrain && index > 0 && index < nTorsions - 1) {
          const residueIndex = Math.floor((index - 1) / 2);
          const phiIdx = 1 + residueIndex * 2;
          const psiIdx = 2 + residueIndex * 2;
          const [phi, psi] = clampToAllowed(candidate[phiIdx], candidate[psiIdx]);
          candidate[phiIdx] = phi;
          candidate[psiIdx] = psi;
        }

        const candidateBuild = buildLinker(prev, candidate, nResidues);
        const candidateRmsd = probeRmsd(candidateBuild.probe, next);
        // Restraint projection can overshoot; only accept genuine improvements.
        if (candidateRmsd < rmsd) {
          for (let k = 0; k < nTorsions; k += 1) torsions[k] = candidate[k];
          built = candidateBuild;
          rmsd = candidateRmsd;
        }
      }
    }

    const converged = rmsd <= tolerance;
    const clashes = avoid.length
      ? countClashes(built.residues, avoid, clashCutoff, loopStart, sequenceSeparation)
      : 0;
    // Closing at all dominates; among closed solutions, prefer the one that
    // routes around the existing structure rather than through it.
    const rank = (converged ? 0 : 1000) + clashes * 10 + Math.min(rmsd, 9);

    if (!best || rank < best.rank) {
      best = { torsions: [...torsions], residues: built.residues, rmsd, clashes, rank, converged };
    }
    if (best.converged && best.clashes === 0) break;
  }

  const residues = best.residues.map((residue) => completeResidue({ ...residue }));

  return {
    residues,
    rmsd: best.rmsd,
    clashes: best.clashes,
    converged: best.converged,
    psiPrev: best.torsions[0],
    phiNext: best.torsions[best.torsions.length - 1],
    torsions: best.torsions,
    feasibility,
    restrained: restrain,
  };
}

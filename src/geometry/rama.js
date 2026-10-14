/**
 * Ramachandran bookkeeping.
 *
 * Loop closure and sketch lifting both search over backbone torsions. Without
 * a constraint they happily return chains no real protein would adopt, so both
 * are restricted to the populated basins of the general-case Ramachandran plot.
 * The boxes below are deliberately generous outlines of those basins rather
 * than a statistical potential — enough to keep results buildable, not enough
 * to pretend this is an energy function.
 */

import { wrapDeg } from './vec3.js';

/** Generous rectangles covering the populated regions, in degrees. */
export const BASINS = [
  { name: 'alphaR', phi: [-160, -45], psi: [-70, 10] },
  { name: 'beta', phi: [-180, -45], psi: [95, 180] },
  { name: 'ppII', phi: [-100, -45], psi: [120, 180] },
  { name: 'bridge', phi: [-130, -45], psi: [10, 95] },
  { name: 'alphaL', phi: [35, 95], psi: [-10, 85] },
];

/** True when (phi, psi) falls inside any populated basin. */
export function isAllowed(phi, psi) {
  const p = wrapDeg(phi);
  const s = wrapDeg(psi);
  return BASINS.some(
    (basin) => p >= basin.phi[0] && p <= basin.phi[1] && s >= basin.psi[0] && s <= basin.psi[1],
  );
}

/** Name of the basin containing (phi, psi), or null if it is disallowed. */
export function basinOf(phi, psi) {
  const p = wrapDeg(phi);
  const s = wrapDeg(psi);
  const hit = BASINS.find(
    (basin) => p >= basin.phi[0] && p <= basin.phi[1] && s >= basin.psi[0] && s <= basin.psi[1],
  );
  return hit ? hit.name : null;
}

/**
 * Nearest allowed (phi, psi) to the given pair, measured on the torus. Used to
 * project CCD iterates back into legal conformational space.
 */
export function clampToAllowed(phi, psi) {
  if (isAllowed(phi, psi)) return [wrapDeg(phi), wrapDeg(psi)];

  const p = wrapDeg(phi);
  const s = wrapDeg(psi);
  let best = null;
  let bestCost = Infinity;

  for (const basin of BASINS) {
    const cp = Math.min(basin.phi[1], Math.max(basin.phi[0], p));
    const cs = Math.min(basin.psi[1], Math.max(basin.psi[0], s));
    const dp = wrapDeg(cp - p);
    const ds = wrapDeg(cs - s);
    const cost = dp * dp + ds * ds;
    if (cost < bestCost) {
      bestCost = cost;
      best = [cp, cs];
    }
  }
  return best;
}

let cachedGrid = null;

/**
 * Discrete (phi, psi) states used by the sketch lifter's beam search.
 * Cached because it is regenerated on every stroke otherwise.
 *
 * @param {number} step grid spacing in degrees
 */
export function torsionGrid(step = 15) {
  if (cachedGrid && cachedGrid.step === step) return cachedGrid.states;

  const states = [];
  for (const basin of BASINS) {
    for (let phi = basin.phi[0]; phi <= basin.phi[1]; phi += step) {
      for (let psi = basin.psi[0]; psi <= basin.psi[1]; psi += step) {
        states.push([phi, psi]);
      }
    }
  }

  // Deduplicate overlapping basin rectangles.
  const seen = new Set();
  const unique = states.filter(([phi, psi]) => {
    const key = `${phi}:${psi}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  cachedGrid = { step, states: unique };
  return unique;
}

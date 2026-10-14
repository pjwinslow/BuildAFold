/**
 * Structural sanity checks on a realised chain.
 *
 * None of this is an energy function and it is not trying to be. It answers
 * the narrow question a builder has to answer honestly: is the thing on screen
 * a physically possible chain, or has the user dragged two blocks through each
 * other? Downstream models will happily consume a self-intersecting backbone
 * and return confident nonsense, so the check belongs here.
 */

import { distance, distanceSq, centroid, dot, sub } from './vec3.js';
import { BOND } from './constants.js';

/**
 * Uniform spatial hash for neighbour queries. Clash detection is O(n^2) done
 * naively, which stalls the UI on anything over a few hundred residues.
 */
class SpatialGrid {
  constructor(points, cellSize) {
    this.cellSize = cellSize;
    this.cells = new Map();
    points.forEach((point, index) => {
      const key = this.key(point);
      let bucket = this.cells.get(key);
      if (!bucket) {
        bucket = [];
        this.cells.set(key, bucket);
      }
      bucket.push(index);
    });
  }

  key(point) {
    const x = Math.floor(point[0] / this.cellSize);
    const y = Math.floor(point[1] / this.cellSize);
    const z = Math.floor(point[2] / this.cellSize);
    return `${x},${y},${z}`;
  }

  /** Indices in the 27 cells around a point. */
  neighbours(point) {
    const cx = Math.floor(point[0] / this.cellSize);
    const cy = Math.floor(point[1] / this.cellSize);
    const cz = Math.floor(point[2] / this.cellSize);
    const out = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = this.cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (bucket) out.push(...bucket);
        }
      }
    }
    return out;
  }
}

/**
 * Residue pairs whose Cα atoms are closer than `cutoff` while being far apart
 * in sequence. 4.0 A is the usual steric floor for non-adjacent Cα atoms;
 * genuine packed helices sit at 5 A and up.
 *
 * @returns {Array<{i: number, j: number, distance: number}>}
 */
export function findClashes(residues, { cutoff = 4.0, sequenceSeparation = 3 } = {}) {
  const cas = residues.map((r) => r.CA);
  const grid = new SpatialGrid(cas, cutoff);
  const cutoffSq = cutoff * cutoff;
  const seen = new Set();
  const clashes = [];

  for (let i = 0; i < cas.length; i += 1) {
    for (const j of grid.neighbours(cas[i])) {
      if (j <= i) continue;
      if (j - i < sequenceSeparation) continue;
      const key = `${i}:${j}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const dSq = distanceSq(cas[i], cas[j]);
      if (dSq < cutoffSq) clashes.push({ i, j, distance: Math.sqrt(dSq) });
    }
  }

  clashes.sort((a, b) => a.distance - b.distance);
  return clashes;
}

/**
 * Peptide bonds that are not 1.33 A. A break here means a linker failed to
 * close, and is the single most important thing to surface to the user.
 */
export function findChainBreaks(residues, { tolerance = 0.1 } = {}) {
  const breaks = [];
  for (let i = 0; i + 1 < residues.length; i += 1) {
    const d = distance(residues[i].C, residues[i + 1].N);
    if (Math.abs(d - BOND.C_N) > tolerance) {
      breaks.push({ afterResidue: i, distance: d, expected: BOND.C_N });
    }
  }
  return breaks;
}

/** Radius of gyration over Cα atoms — a quick read on how compact a design is. */
export function radiusOfGyration(residues) {
  if (residues.length === 0) return 0;
  const cas = residues.map((r) => r.CA);
  const mean = centroid(cas);
  let sum = 0;
  for (const ca of cas) sum += distanceSq(ca, mean);
  return Math.sqrt(sum / cas.length);
}

/**
 * Binary Cβ contact map. Reported in the design spec because fold-conditioned
 * generation is driven by block adjacency, and because it is the cheapest
 * objective read on whether the shape the user drew is actually a packed fold
 * or a loose ribbon in space.
 */
export function contactMap(residues, { cutoff = 8.0 } = {}) {
  const points = residues.map((r) => r.CB ?? r.CA);
  const n = points.length;
  const grid = new SpatialGrid(points, cutoff);
  const cutoffSq = cutoff * cutoff;

  const contacts = Array.from({ length: n }, () => new Uint8Array(n));
  for (let i = 0; i < n; i += 1) {
    for (const j of grid.neighbours(points[i])) {
      if (j === i) continue;
      if (distanceSq(points[i], points[j]) < cutoffSq) {
        contacts[i][j] = 1;
        contacts[j][i] = 1;
      }
    }
  }
  return contacts;
}

/** Fraction of residue pairs in contact, excluding near neighbours. */
export function contactOrder(residues, options = {}) {
  const contacts = contactMap(residues, options);
  const n = contacts.length;
  let count = 0;
  let separationSum = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 4; j < n; j += 1) {
      if (contacts[i][j]) {
        count += 1;
        separationSum += j - i;
      }
    }
  }
  return { contacts: count, meanSeparation: count ? separationSum / count : 0 };
}

/**
 * Handedness check for a helix: a right-handed alpha helix has a positive
 * virtual Cα dihedral of roughly +50 degrees. Catching a mirrored element
 * early matters because no downstream model will build a left-handed alpha
 * helix, and the error is invisible in a cartoon rendering.
 */
export function helixHandedness(residues) {
  if (residues.length < 4) return null;
  const cas = residues.map((r) => r.CA);
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 3 < cas.length; i += 1) {
    const b1 = sub(cas[i + 1], cas[i]);
    const b2 = sub(cas[i + 2], cas[i + 1]);
    const b3 = sub(cas[i + 3], cas[i + 2]);
    const normal = [
      b1[1] * b2[2] - b1[2] * b2[1],
      b1[2] * b2[0] - b1[0] * b2[2],
      b1[0] * b2[1] - b1[1] * b2[0],
    ];
    sum += Math.sign(dot(normal, b3));
    count += 1;
  }
  return count ? sum / count : null;
}

/**
 * Full report for a realised chain.
 *
 * @param {Array} residues
 * @returns {{ok: boolean, clashes: Array, breaks: Array, radiusOfGyration: number,
 *            length: number, warnings: string[]}}
 */
export function validateChain(residues) {
  const clashes = findClashes(residues);
  const breaks = findChainBreaks(residues);
  const rg = radiusOfGyration(residues);
  const { contacts } = contactOrder(residues);

  const warnings = [];
  if (breaks.length) {
    warnings.push(
      `${breaks.length} chain break${breaks.length > 1 ? 's' : ''}: a linker could not close. ` +
        'Add residues to the linker or move the blocks closer.',
    );
  }
  if (clashes.length) {
    warnings.push(
      `${clashes.length} steric clash${clashes.length > 1 ? 'es' : ''} ` +
        `(closest ${clashes[0].distance.toFixed(2)} A). Blocks are passing through each other.`,
    );
  }
  if (residues.length > 12 && contacts === 0) {
    warnings.push(
      'No long-range contacts: this chain is extended rather than folded, and will give a ' +
        'diffusion model very little to work with.',
    );
  }

  return {
    ok: breaks.length === 0 && clashes.length === 0,
    clashes,
    breaks,
    radiusOfGyration: rg,
    contacts,
    length: residues.length,
    warnings,
  };
}

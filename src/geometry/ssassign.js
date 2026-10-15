/**
 * Secondary structure assignment from a Cα trace.
 *
 * Needed because a fetched structure has to be split into elements before it
 * can become blocks, and the file often cannot tell us where they are: HELIX
 * and SHEET records are optional, frequently absent, and essentially never
 * present in predicted models.
 *
 * This is the virtual-angle approach rather than DSSP. DSSP works from
 * backbone hydrogen bonds and is the right answer when you have the atoms for
 * it; here the question is narrower — which residues form a helix or a strand,
 * accurately enough to cut the chain into elements — and the virtual bond
 * angle and dihedral of consecutive Cα atoms answer it with no dependence on
 * side chains, hydrogens or occupancies.
 */

import { angle, dihedral, distance } from './vec3.js';

/** Angle and dihedral windows for each conformation, in degrees. */
export const SIGNATURES = {
  H: { theta: [80, 102], tau: [25, 75], span: [4.8, 6.4] },
  E: { theta: [108, 142], tau: [-180, -120], span: [9.0, 11.2] },
};

/**
 * Per-residue virtual geometry: the Cα bond angle at `i` and the dihedral
 * starting at `i - 1`, plus the i→i+3 span that separates a turn from a coil.
 */
export function virtualGeometry(cas) {
  return cas.map((_, i) => {
    const theta =
      i >= 1 && i + 1 < cas.length ? angle(cas[i - 1], cas[i], cas[i + 1]) : null;
    const tau =
      i >= 1 && i + 2 < cas.length
        ? dihedral(cas[i - 1], cas[i], cas[i + 1], cas[i + 2])
        : null;
    const span = i + 3 < cas.length ? distance(cas[i], cas[i + 3]) : null;
    return { theta, tau, span };
  });
}

const within = (value, [low, high]) => value !== null && value >= low && value <= high;

/**
 * Assign H, E or L to every residue of a Cα trace.
 *
 * Raw per-residue matches are noisy, so runs shorter than a real element are
 * dropped: a helix needs at least a full turn, and a lone "strand" residue
 * between two coils is an artefact of the angle windows rather than a strand.
 *
 * @param {number[][]} cas
 * @param {{minHelix?: number, minStrand?: number}} [options]
 * @returns {string} one character per residue
 */
export function assignSecondaryStructure(cas, options = {}) {
  const { minHelix = 4, minStrand = 3 } = options;
  if (cas.length < 4) return 'L'.repeat(cas.length);

  const geometry = virtualGeometry(cas);
  const codes = geometry.map(({ theta, tau, span }) => {
    for (const [code, signature] of Object.entries(SIGNATURES)) {
      const tauMatch =
        code === 'E'
          ? within(tau, signature.tau) || within(tau, [120, 180])
          : within(tau, signature.tau);
      if (within(theta, signature.theta) && tauMatch && within(span, signature.span)) {
        return code;
      }
    }
    return 'L';
  });

  // A match at residue i describes the turn starting there, so extend each run
  // forward to cover the residues it actually involves.
  const extended = [...codes];
  for (let i = 0; i < codes.length; i += 1) {
    if (codes[i] === 'L') continue;
    const reach = codes[i] === 'H' ? 3 : 2;
    for (let k = 1; k <= reach && i + k < extended.length; k += 1) {
      if (extended[i + k] === 'L') extended[i + k] = codes[i];
    }
  }

  // Drop runs too short to be the element they claim to be.
  let start = 0;
  for (let i = 1; i <= extended.length; i += 1) {
    if (i < extended.length && extended[i] === extended[start]) continue;
    const code = extended[start];
    const length = i - start;
    const minimum = code === 'H' ? minHelix : code === 'E' ? minStrand : 0;
    if (code !== 'L' && length < minimum) {
      for (let k = start; k < i; k += 1) extended[k] = 'L';
    }
    start = i;
  }

  return extended.join('');
}

/**
 * Contiguous runs of one code.
 *
 * @param {string} ss
 * @returns {Array<{code: string, start: number, end: number, length: number}>}
 */
export function secondaryStructureRuns(ss) {
  const runs = [];
  let start = 0;
  for (let i = 1; i <= ss.length; i += 1) {
    if (i === ss.length || ss[i] !== ss[start]) {
      runs.push({ code: ss[start], start, end: i - 1, length: i - start });
      start = i;
    }
  }
  return runs;
}

/**
 * Bending a secondary structure element.
 *
 * Real long strands and sheets are not straight — they curve, which is what
 * lets a sheet close into a barrel or wrap round a core. A builder that only
 * offers straight elements cannot make those shapes at all.
 *
 * The honest way to bend one is not to move atoms: bond lengths and angles are
 * fixed, so the only freedom a backbone has is its torsions. So the element is
 * bent in three steps:
 *
 *   1. build the ideal, straight element and take its Ca trace;
 *   2. bend that trace around a circular arc — a rigid map, so the result still
 *      has the element's own pleat or coil riding on a curved axis;
 *   3. refit torsions to the bent trace, restrained to a window around the
 *      element's own ideal conformation.
 *
 * Step 3 is what keeps a bent strand a strand. Fitting a curve with the whole
 * Ramachandran plot available returns whatever conformation follows the curve
 * best, which is usually a coil; holding the search near the ideal (phi, psi)
 * means the answer is the same element, bent as far as beta torsions will go.
 *
 * Because a bent element is an approximation to the requested arc, the fit
 * residual is reported rather than hidden: that is the number that says whether
 * what you asked for was reachable.
 */

import { buildElement } from './chain.js';
import { canonicalize } from './frame.js';
import { fitTorsionsToTrace } from './trace.js';
import { SS_PRESETS } from './constants.js';

const DEG = Math.PI / 180;

/**
 * How far torsions may stray from the ideal conformation while bending, and
 * how finely that window is sampled.
 *
 * 35 degrees is wide enough to reach a quarter-circle over a dozen residues
 * and still inside the populated beta and alpha basins, which are both far
 * wider than that; the Ramachandran filter clips the window where it is not.
 * Below about 30 degrees a strand cannot bend much at all — the extended
 * backbone is stiff, and the axis direction barely responds to small torsion
 * changes.
 */
export const BEND_WINDOW = 35;
export const BEND_STEP = 5;

/** Largest bend offered, in degrees of total arc across the element. */
export const MAX_BEND = 90;

/**
 * Cheap fit for use while a slider is moving: a narrow beam on a coarse grid.
 * It lands within a degree or two of the same shape at a tenth of the cost,
 * which is the difference between a slider that tracks the mouse and one that
 * does not. Like the preview loop closure, it is never what gets exported.
 */
export const PREVIEW_BEND = { beamWidth: 4, step: 10 };

/**
 * Bend a point cloud around a circular arc.
 *
 * The cloud is expected in a canonical frame — long axis on +z, centred at the
 * origin — as `canonicalize` leaves it. The axis is wrapped onto a circle of
 * radius `length / angle` curving toward +x, and every point keeps its
 * distance from the centre of curvature, so the map is the standard bending of
 * a rod: arc length along the axis is preserved and offsets across it are
 * carried round.
 *
 * @param {number[][]} points
 * @param {number} bendDegrees total turn from one end to the other; negative
 *   bends the other way
 * @returns {number[][]}
 */
export function arcBend(points, bendDegrees) {
  const copy = points.map((p) => [...p]);
  if (!bendDegrees || points.length < 2) return copy;

  const zs = points.map((p) => p[2]);
  const length = Math.max(...zs) - Math.min(...zs);
  if (length < 1e-6) return copy;

  const radius = length / (Math.abs(bendDegrees) * DEG);
  const sign = Math.sign(bendDegrees);

  return copy.map(([x, y, z]) => {
    const theta = z / radius;
    // Distance from the centre of curvature, which sits at x = sign * radius.
    const r = radius - sign * x;
    return [sign * (radius - r * Math.cos(theta)), y, r * Math.sin(theta)];
  });
}

/**
 * Build a secondary structure element bent by `bendDegrees` of total arc.
 *
 * `bendDegrees` of 0 returns the ideal element itself, with no fitting done at
 * all, so a straight block is bit-for-bit what it was before bending existed.
 *
 * @param {string} type key into SS_PRESETS
 * @param {number} nResidues
 * @param {number} bendDegrees total turn across the element
 * @param {{phi?: number, psi?: number, window?: number, step?: number,
 *          beamWidth?: number}} [options]
 * @returns {{residues: Array, rmsd: number, requested: number}}
 */
export function bentElement(type, nResidues, bendDegrees, options = {}) {
  const preset = SS_PRESETS[type];
  if (!preset) throw new Error(`unknown secondary structure type: ${type}`);

  const phi = options.phi ?? preset.phi;
  const psi = options.psi ?? preset.psi;
  const straight = buildElement(type, nResidues, { phi, psi });

  // Four residues is the shortest trace with a virtual dihedral to fit, and
  // nothing shorter has a meaningful axis to bend in the first place.
  if (!bendDegrees || nResidues < 4) {
    return { residues: straight, rmsd: 0, requested: 0 };
  }

  const canonical = canonicalize(straight);
  const target = arcBend(
    canonical.map((residue) => residue.CA),
    bendDegrees,
  );

  const fit = fitTorsionsToTrace(target, {
    beamWidth: options.beamWidth ?? 12,
    restrain: {
      phi,
      psi,
      window: options.window ?? BEND_WINDOW,
      step: options.step ?? BEND_STEP,
    },
  });

  return { residues: fit.residues, rmsd: fit.rmsd, requested: bendDegrees };
}

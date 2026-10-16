/**
 * Sketch lifting: turn a hand-drawn 3D polyline into a real backbone.
 *
 * A mouse stroke is a noisy, unevenly sampled curve with no notion of residues
 * or chemistry. Lifting it happens in three steps:
 *
 *   1. smooth and resample the stroke at the 3.8 A Ca-Ca spacing, giving a
 *      target Ca trace of a definite residue count;
 *   2. fit backbone torsions to that trace by beam search over the populated
 *      Ramachandran basins — the fit is done on rotation- and
 *      translation-invariant descriptors (virtual Ca angles and dihedrals), so
 *      no guess about the stroke's absolute frame is needed;
 *   3. superimpose the built chain back onto the stroke.
 *
 * The output is therefore always a chemically valid backbone that follows the
 * drawing as closely as real torsion space allows — never an interpolated
 * ribbon that merely looks like one.
 */

import { CA_CA_DISTANCE } from './constants.js';
import { buildBackbone, appendResidue, seedResidue, completeResidue } from './chain.js';
import { isAllowed, torsionGrid } from './rama.js';
import { superpose } from './kabsch.js';
import { transformResidues } from './frame.js';
import { add, angle, dihedral, distance, dot, lerp, scale, sub, wrapDeg } from './vec3.js';

/** Moving-average smoothing to take the jitter out of a mouse stroke. */
export function smoothPolyline(points, window = 2) {
  if (points.length <= 2 || window < 1) return points.map((p) => [...p]);
  return points.map((_, i) => {
    const lo = Math.max(0, i - window);
    const hi = Math.min(points.length - 1, i + window);
    let sum = [0, 0, 0];
    for (let k = lo; k <= hi; k += 1) sum = add(sum, points[k]);
    return scale(sum, 1 / (hi - lo + 1));
  });
}

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    out[i] =
      0.5 *
      (2 * p1[i] +
        (-p0[i] + p2[i]) * t +
        (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
        (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
  }
  return out;
}

/** Dense Catmull-Rom samples through a control polyline. */
export function densify(points, samplesPerSegment = 16) {
  if (points.length < 2) return points.map((p) => [...p]);
  const padded = [points[0], ...points, points[points.length - 1]];
  const out = [];
  for (let i = 0; i + 3 < padded.length; i += 1) {
    for (let s = 0; s < samplesPerSegment; s += 1) {
      out.push(catmullRom(padded[i], padded[i + 1], padded[i + 2], padded[i + 3], s / samplesPerSegment));
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Resample a polyline so that consecutive output points are exactly `spacing`
 * apart *in a straight line*.
 *
 * Chord spacing, not arc length: Ca atoms are 3.8 A apart through space, and on
 * a curved stroke arc-length stepping would put them systematically closer than
 * that, biasing the whole fit toward over-wound chains.
 *
 * @param {number[][]} points
 * @param {number} spacing angstrom between consecutive output points
 * @returns {number[][]}
 */
export function resampleChordal(points, spacing = CA_CA_DISTANCE) {
  const dense = densify(points);
  if (dense.length < 2) return dense.map((p) => [...p]);

  const out = [[...dense[0]]];
  let anchor = out[0];
  let cursor = 0; // index of the dense segment start we are scanning from
  let t = 0; // fractional position along that segment

  while (cursor + 1 < dense.length) {
    const a = t > 0 ? lerp(dense[cursor], dense[cursor + 1], t) : dense[cursor];
    const b = dense[cursor + 1];
    const hit = intersectSegmentSphere(a, b, anchor, spacing);

    if (hit === null) {
      cursor += 1;
      t = 0;
      continue;
    }

    const point = lerp(a, b, hit);
    out.push(point);
    anchor = point;
    // Continue scanning from the hit point on this same segment.
    t = t + hit * (1 - t);
    if (1 - t < 1e-9) {
      cursor += 1;
      t = 0;
    }
  }

  return out;
}

/**
 * Smallest t in [0, 1] with |a + t(b - a) - centre| = radius, or null if the
 * segment never reaches the sphere.
 */
function intersectSegmentSphere(a, b, centre, radius) {
  const d = sub(b, a);
  const f = sub(a, centre);
  const A = dot(d, d);
  if (A < 1e-18) return null;
  const B = 2 * dot(f, d);
  const C = dot(f, f) - radius * radius;

  const discriminant = B * B - 4 * A * C;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);

  for (const t of [(-B - root) / (2 * A), (-B + root) / (2 * A)]) {
    if (t > 1e-9 && t <= 1) return t;
  }
  return null;
}

/** Virtual Ca angles and dihedrals describing a trace, independent of its frame. */
export function traceDescriptors(trace) {
  const angles = [];
  const dihedrals = [];
  for (let i = 1; i + 1 < trace.length; i += 1) {
    angles.push(angle(trace[i - 1], trace[i], trace[i + 1]));
  }
  for (let i = 0; i + 3 < trace.length; i += 1) {
    dihedrals.push(dihedral(trace[i], trace[i + 1], trace[i + 2], trace[i + 3]));
  }
  return { angles, dihedrals };
}

function gridOptions(step, restrain) {
  const [phiValues, psiValues] = restrain
    ? [
        windowValues(restrain.phi, restrain.window, restrain.step ?? step),
        windowValues(restrain.psi, restrain.window, restrain.step ?? step),
      ]
    : [
        [...new Set(torsionGrid(step).map(([phi]) => phi))].sort((a, b) => a - b),
        [...new Set(torsionGrid(step).map(([, psi]) => psi))].sort((a, b) => a - b),
      ];

  const psiByPhi = new Map();
  for (const phi of phiValues) {
    psiByPhi.set(
      phi,
      psiValues.filter((psi) => isAllowed(phi, psi)),
    );
  }
  return { phiValues, psiValues, psiByPhi };
}

/**
 * Torsion values within `window` degrees of `centre`, inclusive, stepping by
 * `step`. The centre itself is always present, so restraining a search to an
 * ideal conformation can always return exactly that conformation.
 */
export function windowValues(centre, window, step) {
  const out = [];
  for (let k = -Math.floor(window / step); k <= Math.floor(window / step); k += 1) {
    out.push(centre + k * step);
  }
  return out;
}

/**
 * Fit backbone torsions to a Ca trace.
 *
 * @param {number[][]} trace target Ca positions, already spaced at ~3.8 A
 * @param {object} [options]
 * @param {number} [options.beamWidth=24]
 * @param {number} [options.gridStep=20] Ramachandran sampling step in degrees
 * @param {{phi: number, psi: number, window: number, step?: number}} [options.restrain]
 *   search only within `window` degrees of this conformation, instead of over
 *   the whole allowed plot. Used to bend a secondary structure element without
 *   letting it stop being one.
 * @returns {{residues: Array, rmsd: number, torsions: Array, traceLength: number}}
 */
export function fitTorsionsToTrace(trace, options = {}) {
  const { beamWidth = 24, gridStep = 20, angleWeight = 1, dihedralWeight = 0.6, restrain } = options;

  if (trace.length < 2) throw new Error('a trace needs at least two points to fit');
  if (trace.length === 2) {
    // Degenerate: a single bond. Nothing to fit, so use the restraint target if
    // there is one and a default extended conformation otherwise.
    const pair = { phi: restrain?.phi ?? -75, psi: restrain?.psi ?? 145 };
    const torsions = [{ ...pair }, { ...pair }];
    return finalise(buildBackbone(torsions), trace, torsions);
  }

  const target = traceDescriptors(trace);
  const { phiValues, psiValues, psiByPhi } = gridOptions(gridStep, restrain);

  const seed = seedResidue();
  let beam = [
    {
      residue: { ...seed, phi: null, psi: null },
      cas: [seed.CA],
      torsions: [],
      cost: 0,
    },
  ];

  for (let step = 1; step < trace.length; step += 1) {
    const candidates = [];
    const index = step; // index of the Ca about to be produced

    for (const state of beam) {
      const psiChoices = state.residue.phi === null ? psiValues : psiByPhi.get(state.residue.phi) ?? psiValues;

      for (const psi of psiChoices) {
        const previous = { ...state.residue, psi };
        for (const phiNext of phiValues) {
          // Only keep phi values that still have a legal psi partner downstream.
          const partners = psiByPhi.get(phiNext);
          if (!partners || partners.length === 0) continue;

          const next = appendResidue(previous, phiNext);
          const cas = [...state.cas, next.CA];

          let cost = state.cost;
          if (index >= 2) {
            const built = angle(cas[index - 2], cas[index - 1], cas[index]);
            const want = target.angles[index - 2];
            const d = built - want;
            cost += angleWeight * d * d;
          }
          if (index >= 3) {
            const flankA = target.angles[index - 3];
            const flankB = target.angles[index - 2];
            // A dihedral through a straight stretch is meaningless; skip it.
            if (flankA < 170 && flankB < 170) {
              const built = dihedral(cas[index - 3], cas[index - 2], cas[index - 1], cas[index]);
              const want = target.dihedrals[index - 3];
              const d = wrapDeg(built - want);
              cost += dihedralWeight * d * d;
            }
          }

          candidates.push({
            residue: { ...next, phi: phiNext, psi: null },
            cas,
            torsions: [...state.torsions, { phi: state.residue.phi, psi }],
            cost,
          });
        }
      }
    }

    candidates.sort((a, b) => a.cost - b.cost);
    beam = candidates.slice(0, beamWidth);
    if (beam.length === 0) throw new Error('torsion search exhausted every candidate');
  }

  const best = beam[0];
  // Close out the final residue with a reasonable psi; it only places the last O.
  const torsions = [...best.torsions, { phi: best.residue.phi, psi: restrain?.psi ?? 145 }];
  return finalise(buildBackbone(torsions), trace, torsions);
}

function finalise(residues, trace, torsions) {
  const built = residues.map((r) => r.CA);
  const n = Math.min(built.length, trace.length);
  const fit = superpose(built.slice(0, n), trace.slice(0, n));
  const placed = transformResidues(residues, fit.rotation, fit.translation).map((r) =>
    completeResidue({ ...r }),
  );

  return {
    residues: placed,
    rmsd: fit.rmsd,
    torsions,
    traceLength: trace.length,
  };
}

/**
 * Full pipeline from a raw stroke to a backbone block.
 *
 * @param {number[][]} stroke raw 3D points from the sketch tool
 * @param {object} [options]
 */
export function liftSketch(stroke, options = {}) {
  const { smoothing = 2, spacing = CA_CA_DISTANCE, maxResidues = 120 } = options;
  const smoothed = smoothPolyline(stroke, smoothing);
  let trace = resampleChordal(smoothed, spacing);

  if (trace.length > maxResidues) trace = trace.slice(0, maxResidues);
  if (trace.length < 2) throw new Error('stroke is too short to become a backbone');

  const fit = fitTorsionsToTrace(trace, options);
  return { ...fit, trace };
}

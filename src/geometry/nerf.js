/**
 * Natural Extension Reference Frame (NeRF): place an atom from internal
 * coordinates. This is the primitive every backbone in BuildAFold is made of —
 * blocks, sketched traces and closed loops all come out of it, which is why
 * every chain the tool produces has exact ideal bond geometry by construction.
 */

import { add, cross, dot, normalize, scale, sub, DEG } from './vec3.js';

/**
 * Place atom D given three preceding atoms.
 *
 * @param {number[]} a first atom (defines the torsion)
 * @param {number[]} b second atom
 * @param {number[]} c third atom; D is bonded to it
 * @param {number} bond        |C-D| in angstrom
 * @param {number} angleDeg    angle B-C-D in degrees
 * @param {number} torsionDeg  dihedral A-B-C-D in degrees
 * @returns {number[]} coordinates of D
 */
export function placeAtom(a, b, c, bond, angleDeg, torsionDeg) {
  const theta = angleDeg * DEG;
  const phi = torsionDeg * DEG;

  const bc = normalize(sub(c, b));
  const ab = sub(b, a);

  // Component of ab perpendicular to bc, used to build a right-handed frame.
  let n = cross(ab, bc);
  const nLen = Math.sqrt(dot(n, n));
  if (nLen < 1e-9) {
    // a, b, c are collinear: any perpendicular will do, pick a stable one.
    const fallback = Math.abs(bc[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    n = cross(fallback, bc);
  }
  n = normalize(n);
  const m = cross(n, bc); // completes the orthonormal frame {bc, m, n}

  const sinT = Math.sin(theta);
  const d2 = [-bond * Math.cos(theta), bond * sinT * Math.cos(phi), bond * sinT * Math.sin(phi)];

  return add(c, add(add(scale(bc, d2[0]), scale(m, d2[1])), scale(n, d2[2])));
}

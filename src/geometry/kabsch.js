/**
 * Optimal rigid superposition via Horn's quaternion method.
 *
 * Preferred over a bare SVD here because the quaternion formulation can never
 * return a reflection, which would silently mirror a chain into its
 * left-handed twin — a failure mode that is very hard to spot in a viewer.
 */

import { jacobiEigen } from './eigen.js';
import { centroid, sub, add } from './vec3.js';
import { quaternionToMatrix, matVec } from './frame.js';

/**
 * Rotation + translation mapping `mobile` onto `reference`.
 *
 * @param {number[][]} mobile points to move
 * @param {number[][]} reference target points, same length
 * @returns {{rotation: number[][], translation: number[], rmsd: number, quaternion: number[]}}
 */
export function superpose(mobile, reference) {
  if (mobile.length !== reference.length) {
    throw new Error('superposition requires equal-length point sets');
  }
  if (mobile.length < 3) throw new Error('superposition requires at least three points');

  const mobileCenter = centroid(mobile);
  const referenceCenter = centroid(reference);
  const p = mobile.map((point) => sub(point, mobileCenter));
  const q = reference.map((point) => sub(point, referenceCenter));

  // Correlation matrix.
  const r = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let k = 0; k < p.length; k += 1) {
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) r[i][j] += p[k][i] * q[k][j];
    }
  }

  // Horn's symmetric 4x4 key matrix.
  const key = [
    [
      r[0][0] + r[1][1] + r[2][2],
      r[1][2] - r[2][1],
      r[2][0] - r[0][2],
      r[0][1] - r[1][0],
    ],
    [
      r[1][2] - r[2][1],
      r[0][0] - r[1][1] - r[2][2],
      r[0][1] + r[1][0],
      r[2][0] + r[0][2],
    ],
    [
      r[2][0] - r[0][2],
      r[0][1] + r[1][0],
      -r[0][0] + r[1][1] - r[2][2],
      r[1][2] + r[2][1],
    ],
    [
      r[0][1] - r[1][0],
      r[2][0] + r[0][2],
      r[1][2] + r[2][1],
      -r[0][0] - r[1][1] + r[2][2],
    ],
  ];

  // Largest eigenvalue's eigenvector is the optimal rotation quaternion (w, x, y, z).
  const top = jacobiEigen(key).vectors[0];
  const quaternion = [top[1], top[2], top[3], top[0]]; // reorder to [x, y, z, w]
  const rotation = quaternionToMatrix(quaternion);

  const translation = sub(referenceCenter, matVec(rotation, mobileCenter));

  let sum = 0;
  for (let k = 0; k < mobile.length; k += 1) {
    const moved = add(matVec(rotation, mobile[k]), translation);
    const d = sub(moved, reference[k]);
    sum += d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  }

  return {
    rotation,
    translation,
    quaternion,
    rmsd: Math.sqrt(sum / mobile.length),
  };
}

/** Apply a superposition result to a list of points. */
export function applySuperposition({ rotation, translation }, points) {
  return points.map((point) => add(matVec(rotation, point), translation));
}

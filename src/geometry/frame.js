/**
 * Rigid-body framing.
 *
 * Blocks are authored once in a canonical frame (long axis on +z, centroid at
 * the origin) and then placed in the scene by a position + quaternion. That is
 * what makes dragging a helix around feel like moving a LEGO brick rather than
 * re-deriving a torsion chain on every mouse move.
 */

import { centroid, cross, dot, normalize, scale, sub, add } from './vec3.js';
import { jacobiEigen } from './eigen.js';

/**
 * Principal axis of a point cloud, oriented from the first point toward the
 * last. For both helices and strands this is the element's long axis.
 */
export function principalAxis(points) {
  if (points.length < 2) throw new Error('need at least two points for an axis');
  const mean = centroid(points);
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of points) {
    const d = sub(p, mean);
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) cov[i][j] += d[i] * d[j];
  }
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) cov[i][j] /= points.length;

  let axis = normalize(jacobiEigen(cov).vectors[0]);
  if (dot(axis, sub(points[points.length - 1], points[0])) < 0) axis = scale(axis, -1);
  return axis;
}

/** Multiply a 3x3 matrix (row-major) by a vector. */
export function matVec(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/** Rotation matrix whose rows are the given orthonormal basis vectors. */
export function basisToMatrix(xAxis, yAxis, zAxis) {
  return [
    [xAxis[0], xAxis[1], xAxis[2]],
    [yAxis[0], yAxis[1], yAxis[2]],
    [zAxis[0], zAxis[1], zAxis[2]],
  ];
}

/**
 * Re-express a residue list in its canonical frame: Cα centroid at the origin,
 * principal axis along +z, and the first Cα placed on the +x side so that the
 * roll about the axis is reproducible.
 */
export function canonicalize(residues) {
  const cas = residues.map((r) => r.CA);
  const mean = centroid(cas);
  const zAxis = principalAxis(cas);

  // Reference direction: component of the first Cα offset perpendicular to the axis.
  const first = sub(cas[0], mean);
  let xAxis = sub(first, scale(zAxis, dot(first, zAxis)));
  if (Math.sqrt(dot(xAxis, xAxis)) < 1e-6) {
    const fallback = Math.abs(zAxis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    xAxis = sub(fallback, scale(zAxis, dot(fallback, zAxis)));
  }
  xAxis = normalize(xAxis);
  const yAxis = cross(zAxis, xAxis);

  const rotation = basisToMatrix(xAxis, yAxis, zAxis);
  return transformResidues(residues, rotation, scale(mean, -1), { translateFirst: true });
}

/**
 * Apply a rotation and translation to every atom of a residue list.
 * By default the rotation is applied first (`x -> R x + t`); with
 * `translateFirst` the translation is applied first (`x -> R (x + t)`), which
 * is the convenient order when centring a cloud before rotating it.
 */
export function transformResidues(residues, rotation, translation, { translateFirst = false } = {}) {
  const apply = translateFirst
    ? (p) => matVec(rotation, add(p, translation))
    : (p) => add(matVec(rotation, p), translation);

  return residues.map((residue) => {
    const next = { ...residue, N: apply(residue.N), CA: apply(residue.CA), C: apply(residue.C) };
    if (residue.O) next.O = apply(residue.O);
    if (residue.CB) next.CB = apply(residue.CB);
    return next;
  });
}

/** Rotation matrix from a quaternion `[x, y, z, w]`. */
export function quaternionToMatrix(q) {
  const [x, y, z, w] = q;
  const n = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  const [qx, qy, qz, qw] = [x / n, y / n, z / n, w / n];
  return [
    [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
    [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
    [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
  ];
}

/** Shortest-arc quaternion rotating unit vector `from` onto unit vector `to`. */
export function quaternionFromUnitVectors(from, to) {
  const d = dot(from, to);
  if (d > 0.999999) return [0, 0, 0, 1];
  if (d < -0.999999) {
    // Antiparallel: rotate 180 degrees about any perpendicular axis.
    const fallback = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const axis = normalize(cross(from, fallback));
    return [axis[0], axis[1], axis[2], 0];
  }
  const axis = cross(from, to);
  return normalize4([axis[0], axis[1], axis[2], 1 + d]);
}

function normalize4(q) {
  const n = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Place a canonical residue list into the scene using a position/quaternion. */
export function placeBlock(canonicalResidues, position, quaternion) {
  return transformResidues(canonicalResidues, quaternionToMatrix(quaternion), position);
}

/** Hamilton product of two quaternions, each `[x, y, z, w]`. */
export function quaternionMultiply(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] + a[1] * b[3] + a[2] * b[0] - a[0] * b[2],
    a[3] * b[2] + a[2] * b[3] + a[0] * b[1] - a[1] * b[0],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** Inverse of a unit quaternion: the same rotation, backwards. */
export function quaternionInvert(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Rotate a vector by a quaternion. */
export function rotateByQuaternion(v, q) {
  return matVec(quaternionToMatrix(q), v);
}

/**
 * Move a set of placements rigidly, as one body.
 *
 * Used when the whole design is dragged at once: the handle's change in
 * transform is applied to every block about the handle's starting point, so
 * the assembly turns as a single object rather than each block spinning on its
 * own axis. Translation alone would be a subtraction; it is the rotation that
 * has to be composed about a common centre.
 *
 * @param {Array<{id?: string, position: number[], quaternion: number[]}>} blocks
 * @param {{position: number[], quaternion: number[]}} from the handle before
 * @param {{position: number[], quaternion: number[]}} to the handle after
 * @returns {Array} the same blocks with updated placements
 */
export function transformAbout(blocks, from, to) {
  const delta = quaternionMultiply(to.quaternion, quaternionInvert(from.quaternion));

  return blocks.map((block) => ({
    ...block,
    position: add(rotateByQuaternion(sub(block.position, from.position), delta), to.position),
    quaternion: quaternionMultiply(delta, block.quaternion),
  }));
}

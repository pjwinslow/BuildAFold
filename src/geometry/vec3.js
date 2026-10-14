/**
 * Minimal 3-vector helpers. Vectors are plain `[x, y, z]` arrays so that the
 * whole geometry layer stays free of any rendering dependency and can be unit
 * tested under plain node.
 */

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const length = (a) => Math.sqrt(dot(a, a));
export const distance = (a, b) => length(sub(a, b));
export const distanceSq = (a, b) => {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
};

export function normalize(a) {
  const n = length(a);
  if (n < 1e-12) throw new Error('cannot normalize a zero-length vector');
  return [a[0] / n, a[1] / n, a[2] / n];
}

export function lerp(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export function centroid(points) {
  if (points.length === 0) throw new Error('centroid of an empty point set');
  const sum = [0, 0, 0];
  for (const p of points) {
    sum[0] += p[0];
    sum[1] += p[1];
    sum[2] += p[2];
  }
  return scale(sum, 1 / points.length);
}

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** Wrap an angle in degrees into (-180, 180]. */
export function wrapDeg(angle) {
  let a = angle % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

/**
 * IUPAC dihedral a-b-c-d in degrees, in (-180, 180].
 * Uses the numerically stable "praxeolitic" formulation.
 */
export function dihedral(a, b, c, d) {
  const b0 = sub(a, b);
  const b1 = normalize(sub(c, b));
  const b2 = sub(d, c);

  // Project b0 and b2 onto the plane perpendicular to b1.
  const v = sub(b0, scale(b1, dot(b0, b1)));
  const w = sub(b2, scale(b1, dot(b2, b1)));

  const x = dot(v, w);
  const y = dot(cross(b1, v), w);
  return Math.atan2(y, x) * RAD;
}

/** Bond angle a-b-c in degrees. */
export function angle(a, b, c) {
  const u = normalize(sub(a, b));
  const v = normalize(sub(c, b));
  const cosine = Math.min(1, Math.max(-1, dot(u, v)));
  return Math.acos(cosine) * RAD;
}

/**
 * Rotate `point` by `angleDeg` around the axis through `origin` with unit
 * direction `axis` (Rodrigues' rotation formula).
 */
export function rotateAround(point, origin, axis, angleDeg) {
  const theta = angleDeg * DEG;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const p = sub(point, origin);
  const term1 = scale(p, cosT);
  const term2 = scale(cross(axis, p), sinT);
  const term3 = scale(axis, dot(axis, p) * (1 - cosT));
  return add(origin, add(add(term1, term2), term3));
}

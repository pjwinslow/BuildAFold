/**
 * Cartoon ribbon geometry, in the Richardson tradition: helices as flat
 * twisted ribbons, strands as arrows, loops as thin tubes.
 *
 * A uniform tube shows where the chain goes but not what it is. A ribbon
 * carries two extra pieces of information for free — which way the element
 * faces, and which direction the chain runs — and those are exactly the things
 * you need to judge whether two helices are packed sensibly.
 *
 * Geometry is built by hand rather than with ExtrudeGeometry because the
 * built-in Frenet frames spin wildly through the near-straight stretches of a
 * strand, and because the arrowhead needs a width that varies along the run.
 */

import * as THREE from 'three';

const FALLBACK = new THREE.Vector3(0, 1, 0);

/**
 * Per-residue "side" vectors — the direction the ribbon's width runs.
 *
 * Derived from the local curvature of the Cα trace, which puts a helix ribbon
 * face-on to its own axis. Beta strands pleat, flipping this vector by about
 * 180 degrees every residue, so each one is aligned to its predecessor;
 * without that correction a strand renders as a sequence of half-turns.
 */
export function sideVectors(points) {
  const sides = [];

  for (let i = 0; i < points.length; i += 1) {
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];

    const tangent = new THREE.Vector3().subVectors(next, previous);
    if (tangent.lengthSq() < 1e-12) tangent.copy(FALLBACK);
    tangent.normalize();

    // Offset of the midpoint from this residue: points across the local curve.
    const curvature = new THREE.Vector3()
      .addVectors(previous, next)
      .multiplyScalar(0.5)
      .sub(points[i]);

    let side = new THREE.Vector3().crossVectors(tangent, curvature);
    if (side.lengthSq() < 1e-10) {
      // A straight run has no curvature to work from; any perpendicular will do.
      side = new THREE.Vector3().crossVectors(tangent, FALLBACK);
      if (side.lengthSq() < 1e-10) side.set(1, 0, 0);
    }
    side.normalize();

    if (i > 0 && side.dot(sides[i - 1]) < 0) side.negate();
    sides.push(side);
  }

  return sides;
}

/** Constant-width profile, for helices. */
export const flatProfile = (halfWidth) => () => halfWidth;

/**
 * Width profile for a strand: a constant body that flares into an arrowhead
 * over the final residues and comes to a point at the C-terminus.
 */
export function arrowProfile(count, { body = 1.0, flare = 1.95, tip = 0.12, length = 2 } = {}) {
  const last = count - 1;
  const arrowLength = Math.min(length, Math.max(0.75, last));
  const arrowStart = last - arrowLength;

  return (position) => {
    if (position <= arrowStart) return body;
    const t = Math.min(1, (position - arrowStart) / arrowLength);
    return flare * (1 - t) + tip * t;
  };
}

/**
 * Build a flat ribbon following a Cα run.
 *
 * Vertex colours carry the Richardson card look: the broad faces take the
 * element's colour, the thin edges a near-white, so a ribbon reads as a solid
 * object with a visible edge rather than a flat painted band.
 *
 * @param {THREE.Vector3[]} points Cα positions for this element
 * @param {object} options
 * @returns {THREE.BufferGeometry} non-indexed, with position/normal/color
 */
export function buildRibbon(points, options = {}) {
  const {
    halfWidth = flatProfile(1.25),
    halfThickness = 0.2,
    subdivisions = 6,
    color = 0xffffff,
    edgeColor = 0xeef1f6,
    underShade = 0.55,
  } = options;

  if (points.length < 2) return null;

  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const sides = sideVectors(points);
  const steps = Math.max(2, (points.length - 1) * subdivisions);

  const face = new THREE.Color(color);
  const under = face.clone().multiplyScalar(underShade);
  const edge = new THREE.Color(edgeColor);

  // Four corners of the cross-section at every sample along the run.
  const rings = [];
  const scratchSide = new THREE.Vector3();
  const up = new THREE.Vector3();

  for (let step = 0; step <= steps; step += 1) {
    const u = step / steps;
    const residue = u * (points.length - 1);
    const index = Math.min(points.length - 2, Math.floor(residue));
    const fraction = residue - index;

    const position = curve.getPoint(u);
    const tangent = curve.getTangent(u).normalize();

    scratchSide.copy(sides[index]).lerp(sides[index + 1], fraction);
    // Keep the cross-section square to the path after interpolating.
    scratchSide.addScaledVector(tangent, -scratchSide.dot(tangent));
    if (scratchSide.lengthSq() < 1e-10) {
      scratchSide.crossVectors(tangent, FALLBACK);
      if (scratchSide.lengthSq() < 1e-10) scratchSide.set(1, 0, 0);
    }
    scratchSide.normalize();
    up.crossVectors(scratchSide, tangent).normalize();

    const w = Math.max(0.02, halfWidth(residue));
    const t = halfThickness;

    rings.push([
      position.clone().addScaledVector(scratchSide, w).addScaledVector(up, t),
      position.clone().addScaledVector(scratchSide, -w).addScaledVector(up, t),
      position.clone().addScaledVector(scratchSide, -w).addScaledVector(up, -t),
      position.clone().addScaledVector(scratchSide, w).addScaledVector(up, -t),
    ]);
  }

  const positions = [];
  const normals = [];
  const colors = [];

  const quad = (a, b, c, d, tint) => {
    const normal = new THREE.Vector3()
      .crossVectors(new THREE.Vector3().subVectors(b, a), new THREE.Vector3().subVectors(d, a))
      .normalize();
    for (const [p, q, r] of [
      [a, b, c],
      [a, c, d],
    ]) {
      for (const vertex of [p, q, r]) {
        positions.push(vertex.x, vertex.y, vertex.z);
        normals.push(normal.x, normal.y, normal.z);
        colors.push(tint.r, tint.g, tint.b);
      }
    }
  };

  for (let i = 0; i + 1 < rings.length; i += 1) {
    const a = rings[i];
    const b = rings[i + 1];
    quad(a[0], a[1], b[1], b[0], face); // top
    quad(a[2], a[3], b[3], b[2], under); // underside
    quad(a[3], a[0], b[0], b[3], edge); // one edge
    quad(a[1], a[2], b[2], b[1], edge); // the other
  }

  // Close both ends so the ribbon reads as a solid card.
  const first = rings[0];
  const last = rings[rings.length - 1];
  quad(first[3], first[2], first[1], first[0], edge);
  quad(last[0], last[1], last[2], last[3], edge);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

/**
 * TEST DOUBLE — not three.js, and not shipped.
 *
 * The CDN that serves three.js is unreachable from the build container, so the
 * browser test substitutes this module for it. It implements the vector and
 * quaternion maths for real (the UI does geometry with them, and stubbing that
 * out would make the test meaningless) and reduces everything that touches the
 * GPU to inert shells.
 *
 * What this verifies: that the application wiring, the assembly pipeline and
 * the DOM all work in a browser. What it cannot verify: that the calls into
 * three.js are correct against the real library.
 */

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  clone() {
    return new Vector3(this.x, this.y, this.z);
  }
  copy(v) {
    return this.set(v.x, v.y, v.z);
  }
  add(v) {
    return this.set(this.x + v.x, this.y + v.y, this.z + v.z);
  }
  sub(v) {
    return this.set(this.x - v.x, this.y - v.y, this.z - v.z);
  }
  addScaledVector(v, s) {
    return this.set(this.x + v.x * s, this.y + v.y * s, this.z + v.z * s);
  }
  multiplyScalar(s) {
    return this.set(this.x * s, this.y * s, this.z * s);
  }
  divideScalar(s) {
    return this.multiplyScalar(1 / s);
  }
  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  cross(v) {
    return this.set(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x,
    );
  }
  lengthSq() {
    return this.dot(this);
  }
  length() {
    return Math.sqrt(this.lengthSq());
  }
  normalize() {
    const n = this.length() || 1;
    return this.divideScalar(n);
  }
  distanceTo(v) {
    return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
  }
  fromArray(a) {
    return this.set(a[0], a[1], a[2]);
  }
  toArray() {
    return [this.x, this.y, this.z];
  }
  lerp(v, t) {
    return this.set(
      this.x + (v.x - this.x) * t,
      this.y + (v.y - this.y) * t,
      this.z + (v.z - this.z) * t,
    );
  }
  negate() {
    return this.set(-this.x, -this.y, -this.z);
  }
  subVectors(a, b) {
    return this.set(a.x - b.x, a.y - b.y, a.z - b.z);
  }
  addVectors(a, b) {
    return this.set(a.x + b.x, a.y + b.y, a.z + b.z);
  }
  crossVectors(a, b) {
    return this.set(
      a.y * b.z - a.z * b.y,
      a.z * b.x - a.x * b.z,
      a.x * b.y - a.y * b.x,
    );
  }
  applyQuaternion(q) {
    const { x, y, z } = this;
    const ix = q.w * x + q.y * z - q.z * y;
    const iy = q.w * y + q.z * x - q.x * z;
    const iz = q.w * z + q.x * y - q.y * x;
    const iw = -q.x * x - q.y * y - q.z * z;
    return this.set(
      ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
      iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
      iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
    );
  }
}

export class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    Object.assign(this, { x, y, z, w });
  }
  set(x, y, z, w) {
    Object.assign(this, { x, y, z, w });
    return this;
  }
  clone() {
    return new Quaternion(this.x, this.y, this.z, this.w);
  }
  copy(q) {
    return this.set(q.x, q.y, q.z, q.w);
  }
  fromArray(a) {
    return this.set(a[0], a[1], a[2], a[3]);
  }
  toArray() {
    return [this.x, this.y, this.z, this.w];
  }
  setFromAxisAngle(axis, angle) {
    const half = angle / 2;
    const s = Math.sin(half);
    return this.set(axis.x * s, axis.y * s, axis.z * s, Math.cos(half));
  }
  setFromUnitVectors(from, to) {
    const d = from.dot(to);
    if (d > 0.999999) return this.set(0, 0, 0, 1);
    if (d < -0.999999) {
      const fallback = Math.abs(from.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
      const axis = fallback.clone().cross(from).normalize();
      return this.set(axis.x, axis.y, axis.z, 0);
    }
    const axis = from.clone().cross(to);
    this.set(axis.x, axis.y, axis.z, 1 + d);
    const n = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    return this.set(this.x / n, this.y / n, this.z / n, this.w / n);
  }
  invert() {
    return this.set(-this.x, -this.y, -this.z, this.w);
  }
  multiply(q) {
    const { x: ax, y: ay, z: az, w: aw } = this;
    const { x: bx, y: by, z: bz, w: bw } = q;
    return this.set(
      ax * bw + aw * bx + ay * bz - az * by,
      ay * bw + aw * by + az * bx - ax * bz,
      az * bw + aw * bz + ax * by - ay * bx,
      aw * bw - ax * bx - ay * by - az * bz,
    );
  }
}

export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
}

export class Color {
  constructor(value = 0) {
    // Real Color accepts CSS strings as well as numbers, and the theme tokens
    // arrive as strings.
    this.setHex(typeof value === 'string' ? parseInt(value.replace('#', ''), 16) || 0 : value);
  }
  setHex(hex) {
    this.hex = hex;
    this.r = ((hex >> 16) & 255) / 255;
    this.g = ((hex >> 8) & 255) / 255;
    this.b = (hex & 255) / 255;
    return this;
  }
  clone() {
    return new Color(this.hex);
  }
  multiplyScalar(s) {
    this.r *= s;
    this.g *= s;
    this.b *= s;
    return this;
  }
}

export class Object3D {
  constructor() {
    this.children = [];
    this.position = new Vector3();
    this.quaternion = new Quaternion();
    // Real Object3D carries a scale; code that uses it must be exercised here
    // too, or a call like scale.setScalar() only fails in a real browser.
    this.scale = Object.assign(new Vector3(1, 1, 1), {
      setScalar(v) {
        return this.set(v, v, v);
      },
    });
    this.userData = {};
    this.visible = true;
  }
  add(...objects) {
    this.children.push(...objects);
    return this;
  }
  remove(object) {
    const i = this.children.indexOf(object);
    if (i >= 0) this.children.splice(i, 1);
    return this;
  }
}

export class Group extends Object3D {}
export class Scene extends Object3D {
  constructor() {
    super();
    this.background = null;
  }
}

export class PerspectiveCamera extends Object3D {
  constructor(fov = 50) {
    super();
    this.fov = fov;
    this.aspect = 1;
  }
  updateProjectionMatrix() {}
  getWorldDirection(target) {
    return target.set(0, 0, -1);
  }
}

export class Float32BufferAttribute {
  constructor(array, itemSize) {
    this.array = array;
    this.itemSize = itemSize;
    this.count = array.length / itemSize;
  }
}

class Geometry {
  constructor() {
    this.attributes = {};
  }
  setAttribute(name, attribute) {
    this.attributes[name] = attribute;
    return this;
  }
  dispose() {}
  rotateX() {
    return this;
  }
  setFromPoints(points) {
    this.points = points;
    return this;
  }
}
export class BufferGeometry extends Geometry {}
export class CylinderGeometry extends Geometry {}
export class BoxGeometry extends Geometry {}
export class SphereGeometry extends Geometry {}
export class TubeGeometry extends Geometry {}

class Material {
  constructor(options = {}) {
    Object.assign(this, options);
    this.color = new Color(options.color ?? 0);
    this.emissive = new Color(0);
  }
  dispose() {}
}
export class MeshStandardMaterial extends Material {}
export class LineBasicMaterial extends Material {}

export class Mesh extends Object3D {
  constructor(geometry, material) {
    super();
    this.geometry = geometry;
    this.material = material;
  }
}
export class Line extends Mesh {}

export class AmbientLight extends Object3D {}
export class DirectionalLight extends Object3D {}
export class GridHelper extends Object3D {}

export class CatmullRomCurve3 {
  constructor(points) {
    this.points = points;
  }
  getPoint(u) {
    const span = this.points.length - 1;
    const at = Math.max(0, Math.min(span, u * span));
    const i = Math.min(span - 1, Math.floor(at));
    return this.points[i].clone().lerp(this.points[i + 1], at - i);
  }
  getTangent(u) {
    const span = this.points.length - 1;
    const i = Math.min(span - 1, Math.max(0, Math.floor(u * span)));
    return new Vector3().subVectors(this.points[i + 1], this.points[i]).normalize();
  }
}

export class Plane {
  setFromNormalAndCoplanarPoint(normal, point) {
    this.normal = normal;
    this.point = point;
    return this;
  }
}

export class Raycaster {
  constructor() {
    this.pointer = new Vector2();
    this.ray = {
      /**
       * Enough of a projection to exercise sketching: the stub camera looks
       * down -z (see PerspectiveCamera.getWorldDirection), so the plane facing
       * it is z = 0, and normalised device coordinates map onto it linearly.
       * The 30 A half-width stands in for a default camera distance. Not the
       * real projection, but it turns a drag across the viewport into a stroke
       * of plausible size instead of a pile of points at the origin.
       */
      intersectPlane: (plane, target) =>
        target.set(this.pointerRef.x * 30, this.pointerRef.y * 30, 0),
    };
    this.pointerRef = this.pointer;
  }
  setFromCamera(pointer) {
    this.pointerRef = pointer;
  }
  intersectObjects() {
    return [];
  }
}

export class Box3 {
  constructor() {
    this.min = new Vector3(Infinity, Infinity, Infinity);
    this.max = new Vector3(-Infinity, -Infinity, -Infinity);
    this.empty = true;
  }
  expandByPoint(p) {
    this.empty = false;
    this.min.set(Math.min(this.min.x, p.x), Math.min(this.min.y, p.y), Math.min(this.min.z, p.z));
    this.max.set(Math.max(this.max.x, p.x), Math.max(this.max.y, p.y), Math.max(this.max.z, p.z));
    return this;
  }
  setFromObject() {
    return this;
  }
  isEmpty() {
    return this.empty;
  }
  getCenter(target) {
    return target.set(
      (this.min.x + this.max.x) / 2,
      (this.min.y + this.max.y) / 2,
      (this.min.z + this.max.z) / 2,
    );
  }
  getSize(target) {
    return target.set(
      this.max.x - this.min.x,
      this.max.y - this.min.y,
      this.max.z - this.min.z,
    );
  }
}

export class WebGLRenderer {
  constructor() {
    this.domElement = document.createElement('canvas');
    this.pixelRatio = 1;
  }
  setPixelRatio(ratio) {
    this.pixelRatio = ratio || 1;
  }
  /**
   * Faithful to three.js, because the difference matters: the drawing buffer is
   * scaled by the pixel ratio, and a CSS size is set only when `updateStyle` is
   * not false. A canvas left without a CSS size falls back to its attribute
   * size in CSS pixels, which is how it ends up larger than its container.
   */
  setSize(width, height, updateStyle = true) {
    this.domElement.width = Math.floor(width * this.pixelRatio);
    this.domElement.height = Math.floor(height * this.pixelRatio);
    if (updateStyle !== false) {
      this.domElement.style.width = `${width}px`;
      this.domElement.style.height = `${height}px`;
    }
  }
  render() {
    globalThis.__renderCount = (globalThis.__renderCount ?? 0) + 1;
  }
  setAnimationLoop(fn) {
    // Run a single frame so the loop body is exercised, then stop: a real
    // animation loop would keep the test process spinning.
    if (fn) fn();
  }
  dispose() {}
}

export const MathUtils = { degToRad: (d) => (d * Math.PI) / 180 };

export const DoubleSide = 2;
export const FrontSide = 0;
export const BackSide = 1;

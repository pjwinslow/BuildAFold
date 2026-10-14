/**
 * TEST DOUBLE for three's OrbitControls and TransformControls — see
 * `three-stub.js`. Both are reduced to event-emitting shells that record the
 * calls the viewer makes, which is enough to check that selection attaches a
 * gizmo and that snapping is wired up.
 */

import { Object3D, Vector3 } from 'three';

class Emitter {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatchEvent(event) {
    for (const handler of this.listeners.get(event.type) ?? []) handler(event);
  }
}

export class OrbitControls extends Emitter {
  constructor(camera, domElement) {
    super();
    this.object = camera;
    this.domElement = domElement;
    this.target = new Vector3();
    this.enabled = true;
    this.enableDamping = false;
    this.dampingFactor = 0;
  }
  update() {}
  dispose() {}
}

export class TransformControls extends Emitter {
  constructor(camera, domElement) {
    super();
    this.camera = camera;
    this.domElement = domElement;
    this.dragging = false;
    this.object = null;
    this.mode = 'translate';
    this.helper = new Object3D();
    this.snaps = { translation: null, rotation: null };
  }
  getHelper() {
    return this.helper;
  }
  setSize() {}
  setMode(mode) {
    this.mode = mode;
  }
  setTranslationSnap(value) {
    this.snaps.translation = value;
  }
  setRotationSnap(value) {
    this.snaps.rotation = value;
  }
  attach(object) {
    this.object = object;
    return this;
  }
  detach() {
    this.object = null;
    return this;
  }
  dispose() {}
}

/**
 * Three.js viewport.
 *
 * Two things are drawn and they serve different purposes:
 *
 *  - the **chain**: tubes through the realised Ca trace. This is the actual
 *    molecule, rebuilt whenever the assembly changes. It is not interactive.
 *  - the **proxies**: one translucent solid per block, sized to the element it
 *    stands for. These are what the user clicks and drags.
 *
 * Separating them is what makes manipulation feel direct. Dragging a proxy
 * writes a position and a quaternion; the chain is then re-derived from
 * scratch, loops and all, so what is on screen is always a real backbone
 * rather than a stretched approximation of one.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

import { buildRibbon, flatProfile, arrowProfile } from './ribbon.js';

const COLORS = {
  helix: 0xe05f6a,
  helix310: 0xd97aa0,
  strand: 0xe3c05c,
  strandPar: 0xd4b24a,
  polyproline: 0x7f8a9c,
  sketch: 0xa888e8,
  loop: 0x7f8a9c,
};

const RADIUS = { H: 0.85, E: 0.75, L: 0.34 };

export class Viewer {
  constructor(container, handlers = {}) {
    this.container = container;
    this.handlers = handlers;
    this.mode = 'translate';
    this.proxies = new Map();
    this.strokePoints = [];
    this.drawing = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f1115);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 2000);
    this.camera.position.set(42, 28, 48);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(30, 50, 40);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x90a8d0, 0.5);
    fill.position.set(-40, -20, -30);
    this.scene.add(fill);

    const grid = new THREE.GridHelper(120, 24, 0x2a2f3a, 0x1d212a);
    grid.position.y = -24;
    this.scene.add(grid);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.8);
    // TransformControls stopped being an Object3D itself in recent releases;
    // getHelper() is the supported way to obtain the scene-graph node.
    this.gizmoHelper =
      typeof this.gizmo.getHelper === 'function' ? this.gizmo.getHelper() : this.gizmo;
    this.scene.add(this.gizmoHelper);

    this.gizmo.addEventListener('dragging-changed', (event) => {
      this.orbit.enabled = !event.value;
      if (!event.value) this.emitTransform();
    });
    this.gizmo.addEventListener('objectChange', () => this.emitTransform(true));

    this.chainGroup = new THREE.Group();
    this.scene.add(this.chainGroup);
    this.proxyGroup = new THREE.Group();
    this.scene.add(this.proxyGroup);
    this.clashGroup = new THREE.Group();
    this.scene.add(this.clashGroup);
    this.showClashMarkers = true;

    this.strokeLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xa888e8 }),
    );
    this.strokeLine.frustumCulled = false;
    this.scene.add(this.strokeLine);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this.bindPointerEvents();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.animate = this.animate.bind(this);
    this.renderer.setAnimationLoop(this.animate);
  }

  animate() {
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // updateStyle must stay on: three.js sizes the drawing buffer to
    // width * devicePixelRatio, and without a CSS size the canvas falls back to
    // that buffer size in CSS pixels. On any display above 1x it would then be
    // wider than the stage and paint over the panel beside it.
    this.renderer.setSize(w, h);
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === 'sketch') {
      this.gizmo.detach();
    } else {
      this.gizmo.setMode(mode);
      if (this.selectedId && this.proxies.has(this.selectedId)) {
        this.gizmo.attach(this.proxies.get(this.selectedId).node);
      }
    }
  }

  setSnap(enabled) {
    this.gizmo.setTranslationSnap(enabled ? 1 : null);
    this.gizmo.setRotationSnap(enabled ? THREE.MathUtils.degToRad(15) : null);
  }

  // ---------------------------------------------------------------- picking

  bindPointerEvents() {
    const element = this.renderer.domElement;

    let pressed = null;

    element.addEventListener('pointerdown', (event) => {
      if (this.mode === 'sketch') {
        this.beginStroke(event);
        return;
      }
      pressed = this.gizmo.dragging ? null : { x: event.clientX, y: event.clientY };
    });

    element.addEventListener('pointermove', (event) => {
      if (this.drawing) this.extendStroke(event);
    });

    element.addEventListener('pointerup', (event) => {
      if (this.drawing) {
        this.endStroke();
        return;
      }
      if (!pressed || this.gizmo.dragging) {
        pressed = null;
        return;
      }
      // Distinguish a click from an orbit drag: both start with a pointerdown
      // on the canvas, and only the click should change the selection.
      const moved = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y);
      pressed = null;
      if (moved < 5) this.pickAt(event);
    });

    element.addEventListener('pointerleave', () => {
      if (this.drawing) this.endStroke();
      pressed = null;
    });
  }

  updatePointer(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  pickAt(event) {
    this.updatePointer(event);
    const targets = [...this.proxies.values()].map((p) => p.mesh);
    const hits = this.raycaster.intersectObjects(targets, false);
    const id = hits.length ? hits[0].object.userData.blockId : null;
    this.handlers.onSelect?.(id);
  }

  // ---------------------------------------------------------------- sketching

  /**
   * Strokes are projected onto the plane through the orbit target that faces
   * the camera. Depth along the view direction is therefore not specified by
   * the drawing — the user supplies it by orbiting and redrawing. This is the
   * deliberate simplification against sketch-conditioned generative work,
   * which infers depth from a learned prior instead.
   */
  sketchPlane() {
    const normal = new THREE.Vector3();
    this.camera.getWorldDirection(normal);
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, this.orbit.target.clone());
  }

  beginStroke(event) {
    this.drawing = true;
    this.orbit.enabled = false;
    this.plane = this.sketchPlane();
    this.strokePoints = [];
    this.renderer.domElement.setPointerCapture?.(event.pointerId);
    this.extendStroke(event);
  }

  extendStroke(event) {
    this.updatePointer(event);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.plane, point)) return;

    const last = this.strokePoints[this.strokePoints.length - 1];
    // Drop samples the mouse produced while barely moving.
    if (last && point.distanceTo(last) < 0.4) return;

    this.strokePoints.push(point);
    this.strokeLine.geometry.dispose();
    this.strokeLine.geometry = new THREE.BufferGeometry().setFromPoints(this.strokePoints);
  }

  endStroke() {
    this.drawing = false;
    this.orbit.enabled = true;

    const points = this.strokePoints.map((p) => [p.x, p.y, p.z]);
    this.strokePoints = [];
    this.strokeLine.geometry.dispose();
    this.strokeLine.geometry = new THREE.BufferGeometry();

    if (points.length >= 3) this.handlers.onSketch?.(points);
  }

  // ------------------------------------------------------------------ blocks

  emitTransform(live = false) {
    if (!this.selectedId) return;
    const entry = this.proxies.get(this.selectedId);
    if (!entry) return;

    const p = entry.node.position;
    const q = entry.node.quaternion;
    this.handlers.onTransform?.(
      this.selectedId,
      [p.x, p.y, p.z],
      [q.x, q.y, q.z, q.w],
      live,
    );
  }

  /** Create, update or remove one proxy per block. */
  syncBlocks(assembly) {
    const seen = new Set();

    for (const block of assembly.blocks) {
      seen.add(block.id);
      let entry = this.proxies.get(block.id);
      const shapeKey = `${block.type}:${block.nResidues}`;

      if (!entry) {
        const node = new THREE.Group();
        const mesh = new THREE.Mesh(
          proxyGeometry(block),
          new THREE.MeshStandardMaterial({
            color: COLORS[block.type] ?? COLORS.loop,
            transparent: true,
            opacity: 0.16,
            roughness: 0.6,
            depthWrite: false,
          }),
        );
        mesh.userData.blockId = block.id;
        node.add(mesh);
        this.proxyGroup.add(node);
        entry = { node, mesh, shapeKey };
        this.proxies.set(block.id, entry);
      } else if (entry.shapeKey !== shapeKey) {
        entry.mesh.geometry.dispose();
        entry.mesh.geometry = proxyGeometry(block);
        entry.mesh.material.color.setHex(COLORS[block.type] ?? COLORS.loop);
        entry.shapeKey = shapeKey;
      }

      entry.node.position.fromArray(block.position);
      entry.node.quaternion.fromArray(block.quaternion);
    }

    for (const [id, entry] of [...this.proxies]) {
      if (seen.has(id)) continue;
      if (this.selectedId === id) this.gizmo.detach();
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
      this.proxyGroup.remove(entry.node);
      this.proxies.delete(id);
    }
  }

  setSelection(blockId) {
    this.selectedId = blockId;

    for (const [id, entry] of this.proxies) {
      const selected = id === blockId;
      entry.mesh.material.opacity = selected ? 0.34 : 0.16;
      entry.mesh.material.emissive?.setHex(selected ? 0x223344 : 0x000000);
    }

    if (blockId && this.proxies.has(blockId) && this.mode !== 'sketch') {
      this.gizmo.attach(this.proxies.get(blockId).node);
    } else {
      this.gizmo.detach();
    }
  }

  // ------------------------------------------------------------------- chain

  /**
   * Rebuild the rendered backbone from a realised assembly.
   *
   * Helices and strands are drawn as cartoon ribbons over exactly their own
   * residues; loops are tubes that reach one residue into each neighbour, so
   * they plug into the ribbon ends and no seam shows at the junction.
   */
  showChain(realized) {
    this.clearChain();
    if (!realized || realized.residues.length < 2) return;

    const cas = realized.residues.map((r) => new THREE.Vector3(...r.CA));

    for (const segment of realized.segments) {
      const code = ssCodeOf(segment.type);
      const color = COLORS[segment.type] ?? COLORS.loop;
      const mesh = code === 'L'
        ? loopMesh(cas, segment, color)
        : ribbonMesh(cas, segment, code, color);
      if (mesh) this.chainGroup.add(mesh);
    }

    // Mark the chain termini so direction is never ambiguous.
    this.chainGroup.add(terminusMarker(cas[0], 0x4ec9a0));
    this.chainGroup.add(terminusMarker(cas[cas.length - 1], 0x5aa9ff));
  }

  /**
   * Mark every steric clash in place.
   *
   * The geometry panel can say there are forty clashes, but not which part of
   * the design is wrong. A marker at the midpoint of each offending pair, sized
   * by how deep the overlap runs, turns that number into somewhere to look.
   */
  showClashes(realized) {
    this.clearClashes();
    if (!this.showClashMarkers || !realized?.validation?.clashes?.length) return;

    const residues = realized.residues;
    // Worst first, and capped: a few hundred markers would hide the structure
    // they are meant to point at.
    const clashes = realized.validation.clashes.slice(0, 150);

    const geometry = new THREE.SphereGeometry(1, 10, 8);
    const material = new THREE.MeshStandardMaterial({
      color: 0xff4d4f,
      emissive: 0x5c0f10,
      roughness: 0.35,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });

    for (const clash of clashes) {
      const a = residues[clash.i]?.CA;
      const b = residues[clash.j]?.CA;
      if (!a || !b) continue;

      const marker = new THREE.Mesh(geometry, material);
      marker.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      // 4.0 A is the threshold; the deeper the overlap, the bigger the marker.
      const severity = Math.max(0.1, (4.0 - clash.distance) / 4.0);
      const radius = 0.7 + severity * 1.6;
      marker.scale.setScalar(radius);
      marker.userData.clash = clash;
      this.clashGroup.add(marker);
    }

    this.clashGeometry = geometry;
    this.clashMaterial = material;
  }

  clearClashes() {
    for (const child of [...this.clashGroup.children]) this.clashGroup.remove(child);
    this.clashGeometry?.dispose();
    this.clashMaterial?.dispose();
    this.clashGeometry = null;
    this.clashMaterial = null;
  }

  setClashMarkers(visible) {
    this.showClashMarkers = visible;
    this.clashGroup.visible = visible;
  }

  clearChain() {
    for (const child of [...this.chainGroup.children]) {
      child.geometry?.dispose();
      child.material?.dispose();
      this.chainGroup.remove(child);
    }
  }

  /** Frame the whole design in view. */
  recentre(realized) {
    const box = new THREE.Box3();
    if (realized?.residues?.length) {
      for (const residue of realized.residues) box.expandByPoint(new THREE.Vector3(...residue.CA));
    } else {
      box.setFromObject(this.proxyGroup);
    }
    if (box.isEmpty()) return;

    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 8);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2));

    const direction = new THREE.Vector3(0.6, 0.45, 0.75).normalize();
    this.camera.position.copy(centre).addScaledVector(direction, distance * 1.15);
    this.orbit.target.copy(centre);
    this.orbit.update();
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** A helix or strand drawn as a cartoon ribbon. */
function ribbonMesh(cas, segment, code, color) {
  const points = cas.slice(segment.start, segment.end + 1);
  if (points.length < 2) return null;

  const geometry = buildRibbon(points, {
    color,
    halfWidth: code === 'E' ? arrowProfile(points.length) : flatProfile(1.25),
    halfThickness: code === 'E' ? 0.17 : 0.22,
  });
  if (!geometry) return null;

  return new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.52,
      metalness: 0.02,
      side: THREE.DoubleSide,
    }),
  );
}

/** A loop drawn as a thin tube, reaching into the elements on either side. */
function loopMesh(cas, segment, color) {
  const from = Math.max(0, segment.start - 1);
  const to = Math.min(cas.length - 1, segment.end + 1);
  const points = cas.slice(from, to + 1);
  if (points.length < 2) return null;

  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const geometry = new THREE.TubeGeometry(curve, Math.max(8, points.length * 6), RADIUS.L, 10, false);

  return new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.02 }),
  );
}

function ssCodeOf(type) {
  if (type === 'helix' || type === 'helix310') return 'H';
  if (type === 'strand' || type === 'strandPar') return 'E';
  return 'L';
}

/**
 * A solid standing in for the element: a cylinder enclosing a helix, a flat
 * slab for a strand. Dimensions come from the real rise per residue so the
 * handle is the size of the thing it represents.
 */
function proxyGeometry(block) {
  const n = Math.max(2, block.nResidues);
  const code = ssCodeOf(block.type);

  let geometry;
  if (code === 'H') {
    geometry = new THREE.CylinderGeometry(3.2, 3.2, 1.5 * (n - 1) + 4, 20, 1, false);
  } else if (code === 'E') {
    geometry = new THREE.BoxGeometry(5.0, 2.4, 3.35 * (n - 1) + 3);
  } else {
    geometry = new THREE.CylinderGeometry(2.6, 2.6, 2.8 * (n - 1) + 3, 14, 1, false);
  }

  // Canonical blocks run along +z; cylinders are built along +y.
  if (code !== 'E') geometry.rotateX(Math.PI / 2);
  return geometry;
}

function terminusMarker(position, color) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.1, 16, 12),
    new THREE.MeshStandardMaterial({ color, roughness: 0.4 }),
  );
  mesh.position.copy(position);
  return mesh;
}

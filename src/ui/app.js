/**
 * Application controller: palette, chain order, inspector, export and input.
 *
 * The loop is deliberately simple. Every edit mutates the assembly, pushes an
 * undo snapshot, and asks for a re-realisation; realisation runs the full
 * geometry pipeline (place blocks, close loops, validate) and the result is
 * what gets drawn and reported. There is no incremental or approximate path,
 * so the picture on screen and the file that is exported can never disagree.
 */

import * as THREE from 'three';

import {
  createAssembly,
  addBlock,
  addSketchBlock,
  removeBlock,
  reorderBlock,
  realize,
  serialize,
  deserialize,
} from '../model/assembly.js';
import { BLOCK_TYPES, SS_PRESETS } from '../geometry/constants.js';
import { liftSketch } from '../geometry/trace.js';
import { writePDB } from '../io/pdb.js';
import { buildDesignSpec, pipelineCommands, describeSpec } from '../io/designspec.js';
import { Viewer } from './viewer.js';

const SPACING = { helix: 10.5, helix310: 9.5, strand: 4.9, strandPar: 4.9, sketch: 8 };

const state = {
  assembly: createAssembly('Untitled design'),
  realized: null,
  selectedId: null,
  mode: 'translate',
  history: [],
};

const dom = {
  viewport: document.getElementById('viewport'),
  palette: document.getElementById('palette'),
  chainList: document.getElementById('chain-list'),
  inspector: document.getElementById('inspector'),
  validation: document.getElementById('validation'),
  commands: document.getElementById('commands'),
  readout: document.getElementById('readout'),
  sketchHint: document.getElementById('sketch-hint'),
  stage: document.querySelector('.stage'),
  fileInput: document.getElementById('file-input'),
};

const viewer = new Viewer(dom.viewport, {
  onSelect: (id) => select(id),
  onTransform: (id, position, quaternion, live) => {
    const block = findBlock(id);
    if (!block) return;
    block.position = position;
    block.quaternion = quaternion;
    scheduleRealize(!live);
  },
  onSketch: (points) => addSketchFromStroke(points),
});

const findBlock = (id) => state.assembly.blocks.find((b) => b.id === id);

// --------------------------------------------------------------- realisation

let realizeTimer = null;
let lastRealize = 0;

/**
 * Re-realise the assembly. During a drag this is throttled, because closure
 * runs CCD for every linker; on drag end it always runs so the committed state
 * is exact.
 */
function scheduleRealize(immediate = false) {
  if (immediate) {
    clearTimeout(realizeTimer);
    realizeTimer = null;
    runRealize();
    return;
  }
  if (realizeTimer) return;
  const wait = Math.max(0, 90 - (performance.now() - lastRealize));
  realizeTimer = setTimeout(() => {
    realizeTimer = null;
    runRealize();
  }, wait);
}

function runRealize() {
  const started = performance.now();
  state.realized = realize(state.assembly);
  lastRealize = performance.now();

  viewer.syncBlocks(state.assembly);
  viewer.showChain(state.realized);
  renderChainList();
  renderInspector();
  renderValidation(lastRealize - started);
  renderCommands();
}

// -------------------------------------------------------------------- history

function snapshot() {
  state.history.push(JSON.stringify(serialize(state.assembly)));
  if (state.history.length > 60) state.history.shift();
}

function undo() {
  const previous = state.history.pop();
  if (!previous) return;
  state.assembly = deserialize(JSON.parse(previous));
  if (!findBlock(state.selectedId)) state.selectedId = null;
  viewer.syncBlocks(state.assembly);
  viewer.setSelection(state.selectedId);
  scheduleRealize(true);
}

// ------------------------------------------------------------------ placement

/**
 * Lattice positions ordered outward from the origin. Clicking the same block
 * repeatedly therefore lays down a packed bundle rather than a pile at the
 * origin, which is the behaviour that makes the palette feel like a kit.
 */
function latticePoint(index) {
  const points = [[0, 0]];
  let x = 0;
  let y = 0;
  let dx = 1;
  let dy = 0;
  let run = 1;

  // Square spiral: the first four positions form a 2x2 block, so four helices
  // land as a bundle rather than a row.
  while (points.length <= index) {
    for (let leg = 0; leg < 2; leg += 1) {
      for (let step = 0; step < run; step += 1) {
        x += dx;
        y += dy;
        points.push([x, y]);
      }
      [dx, dy] = [-dy, dx];
    }
    run += 1;
  }
  return points[index];
}

function suggestPlacement(type) {
  const index = state.assembly.blocks.length;
  const spacing = SPACING[type] ?? 9;
  const [i, j] = latticePoint(index);

  // Alternate direction so consecutive elements run antiparallel, the usual
  // arrangement for both bundles and hairpins.
  const quaternion = index % 2 === 0 ? [0, 0, 0, 1] : [1, 0, 0, 0];
  return { position: [i * spacing, j * spacing, 0], quaternion };
}

/** Align the selected block antiparallel to the one before it, at contact distance. */
function packAgainstPrevious() {
  const index = state.assembly.blocks.findIndex((b) => b.id === state.selectedId);
  if (index < 1) return;

  const block = state.assembly.blocks[index];
  const previous = state.assembly.blocks[index - 1];
  snapshot();

  const previousQuaternion = new THREE.Quaternion().fromArray(previous.quaternion);
  const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(previousQuaternion);

  // Antiparallel: 180 degrees about any axis perpendicular to the element axis.
  const flip = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0).applyQuaternion(previousQuaternion),
    Math.PI,
  );
  block.quaternion = flip.multiply(previousQuaternion).toArray();

  const previousCentre = new THREE.Vector3().fromArray(previous.position);
  const offset = new THREE.Vector3().fromArray(block.position).sub(previousCentre);
  // Keep only the component across the element axis; that is the packing direction.
  offset.addScaledVector(axis, -offset.dot(axis));
  if (offset.lengthSq() < 1e-6) {
    offset.copy(new THREE.Vector3(1, 0, 0).applyQuaternion(previousQuaternion));
  }
  offset.normalize().multiplyScalar(SPACING[block.type] ?? 9);

  block.position = previousCentre.clone().add(offset).toArray();
  scheduleRealize(true);
  viewer.syncBlocks(state.assembly);
  viewer.setSelection(block.id);
}

// ---------------------------------------------------------------------- edits

function appendBlock(type) {
  snapshot();
  const block = addBlock(state.assembly, { type, ...suggestPlacement(type) });
  select(block.id);
  scheduleRealize(true);
}

function addSketchFromStroke(points) {
  let lifted;
  try {
    lifted = liftSketch(points);
  } catch (error) {
    flash(`Could not use that stroke: ${error.message}`);
    return;
  }
  if (lifted.residues.length < 3) {
    flash('That stroke is too short — draw a longer path.');
    return;
  }

  snapshot();
  // liftSketch returns the chain already superimposed on the stroke, so the
  // block's own placement is the identity: its canonical frame carries the shape.
  const block = addSketchBlock(state.assembly, lifted.residues, {
    name: `Sketch (${lifted.residues.length} aa)`,
  });
  recentreSketchBlock(block, lifted.residues);
  select(block.id);
  scheduleRealize(true);
  flash(`Lifted ${lifted.residues.length} residues, ${lifted.rmsd.toFixed(2)} A from your stroke.`);
}

/**
 * `addSketchBlock` canonicalises the geometry to the origin, so the block has
 * to be placed back where it was drawn.
 */
function recentreSketchBlock(block, worldResidues) {
  const centre = new THREE.Vector3();
  for (const residue of worldResidues) centre.add(new THREE.Vector3(...residue.CA));
  centre.divideScalar(worldResidues.length);

  const canonicalAxis = new THREE.Vector3(0, 0, 1);
  const first = new THREE.Vector3(...worldResidues[0].CA);
  const last = new THREE.Vector3(...worldResidues[worldResidues.length - 1].CA);
  const worldAxis = last.clone().sub(first).normalize();

  block.quaternion = new THREE.Quaternion()
    .setFromUnitVectors(canonicalAxis, worldAxis)
    .toArray();
  block.position = centre.toArray();
}

function deleteSelected() {
  if (!state.selectedId) return;
  snapshot();
  removeBlock(state.assembly, state.selectedId);
  select(null);
  scheduleRealize(true);
}

function select(id) {
  state.selectedId = id;
  viewer.setSelection(id);
  renderChainList();
  renderInspector();
}

// --------------------------------------------------------------------- render

function renderPalette() {
  dom.palette.innerHTML = '';
  for (const type of BLOCK_TYPES) {
    const preset = SS_PRESETS[type];
    const button = document.createElement('button');
    button.innerHTML =
      `<span class="swatch" style="background:${swatch(type)}"></span>` +
      `<span>${preset.label}</span>` +
      `<span class="sub">φ${preset.phi}</span>`;
    button.addEventListener('click', () => appendBlock(type));
    dom.palette.appendChild(button);
  }
}

const swatch = (type) =>
  ({
    helix: '#e05f6a',
    helix310: '#d97aa0',
    strand: '#e3c05c',
    strandPar: '#d4b24a',
    polyproline: '#7f8a9c',
  })[type] ?? '#7f8a9c';

function renderChainList() {
  dom.chainList.innerHTML = '';

  state.assembly.blocks.forEach((block, index) => {
    if (index > 0) {
      const closure = state.realized?.closures?.find((c) => c.blockId === block.id);
      const row = document.createElement('div');
      row.className = 'linker-row';

      const label = document.createElement('span');
      const status = closure && !closure.converged ? ' — will not close' : '';
      label.textContent = `linker ${closure ? closure.nResidues : '?'} aa${status}`;
      if (closure && !closure.converged) label.style.color = 'var(--bad)';

      const input = document.createElement('input');
      input.type = 'text';
      input.value = block.linkerBefore === 'auto' ? 'auto' : String(block.linkerBefore);
      input.title = 'Residues in this linker, or "auto"';
      input.addEventListener('change', () => {
        snapshot();
        const raw = input.value.trim().toLowerCase();
        block.linkerBefore = raw === 'auto' ? 'auto' : Math.max(0, Number.parseInt(raw, 10) || 0);
        scheduleRealize(true);
      });

      row.append(label, input);
      dom.chainList.appendChild(row);
    }

    const item = document.createElement('li');
    item.className = block.id === state.selectedId ? 'selected' : '';
    item.draggable = true;
    item.innerHTML =
      `<span class="swatch" style="background:${swatch(block.type)}"></span>` +
      `<span class="name">${block.name}</span>` +
      `<span class="len">${block.nResidues}</span>`;

    item.addEventListener('click', () => select(block.id));
    item.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', block.id);
    });
    item.addEventListener('dragover', (event) => {
      event.preventDefault();
      item.classList.add('drop-target');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      item.classList.remove('drop-target');
      const draggedId = event.dataTransfer.getData('text/plain');
      if (!draggedId || draggedId === block.id) return;
      snapshot();
      reorderBlock(state.assembly, draggedId, index);
      scheduleRealize(true);
    });

    dom.chainList.appendChild(item);
  });

  if (!state.assembly.blocks.length) {
    dom.chainList.innerHTML = '<p class="hint">Add a block to begin.</p>';
  }
}

function renderInspector() {
  const block = findBlock(state.selectedId);
  if (!block) {
    dom.inspector.innerHTML = '<p class="hint">Nothing selected.</p>';
    return;
  }

  dom.inspector.innerHTML = '';
  const title = document.createElement('p');
  title.innerHTML = `<strong>${block.name}</strong>`;
  dom.inspector.appendChild(title);

  if (block.kind === 'sse') {
    dom.inspector.appendChild(
      numberField('Residues', block.nResidues, 2, 60, 1, (value) => {
        snapshot();
        block.nResidues = value;
        block.name = SS_PRESETS[block.type].label;
        scheduleRealize(true);
      }),
    );
    dom.inspector.appendChild(
      numberField('phi', block.phi ?? SS_PRESETS[block.type].phi, -180, 180, 1, (value) => {
        snapshot();
        block.phi = value;
        scheduleRealize(true);
      }),
    );
    dom.inspector.appendChild(
      numberField('psi', block.psi ?? SS_PRESETS[block.type].psi, -180, 180, 1, (value) => {
        snapshot();
        block.psi = value;
        scheduleRealize(true);
      }),
    );
  } else {
    const info = document.createElement('p');
    info.className = 'hint';
    info.textContent = `${block.nResidues} residues fitted from a sketch.`;
    dom.inspector.appendChild(info);
  }

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const duplicate = document.createElement('button');
  duplicate.textContent = 'Duplicate';
  duplicate.addEventListener('click', () => {
    snapshot();
    const copy = addBlock(state.assembly, {
      type: block.type === 'sketch' ? 'polyproline' : block.type,
      nResidues: block.nResidues,
      ...suggestPlacement(block.type),
    });
    select(copy.id);
    scheduleRealize(true);
  });

  const remove = document.createElement('button');
  remove.textContent = 'Delete';
  remove.addEventListener('click', deleteSelected);

  actions.append(duplicate, remove);
  dom.inspector.appendChild(actions);
}

function numberField(label, value, min, max, step, onChange) {
  const wrapper = document.createElement('label');
  wrapper.textContent = label;

  const input = document.createElement('input');
  input.type = 'number';
  Object.assign(input, { value, min, max, step });
  input.addEventListener('change', () => {
    const parsed = Number(input.value);
    if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed)));
  });

  wrapper.appendChild(input);
  return wrapper;
}

function renderValidation(elapsedMs = 0) {
  const result = state.realized;
  if (!result || !result.residues.length) {
    dom.validation.innerHTML = '<p class="hint">Nothing built yet.</p>';
    dom.readout.innerHTML = '';
    return;
  }

  const { validation } = result;
  const parts = [
    `<div class="status"><span class="dot ${result.ok ? 'ok' : 'bad'}"></span>` +
      `${result.ok ? 'Buildable' : 'Not buildable yet'}</div>`,
  ];

  const problems = [...validation.warnings];
  for (const closure of result.closures) {
    if (closure.converged) continue;
    const need = closure.feasibility.minResidues;
    problems.push(
      closure.feasibility.feasible
        ? `A ${closure.nResidues}-residue linker could not be closed. Try a longer linker or move the blocks.`
        : `Gap of ${closure.feasibility.gap.toFixed(1)} A needs at least ${need} linker residues.`,
    );
  }
  if (problems.length) {
    parts.push(`<ul>${problems.map((p) => `<li>${p}</li>`).join('')}</ul>`);
  }

  parts.push(
    '<div class="metrics">' +
      `<span>Residues</span><span>${result.residues.length}</span>` +
      `<span>Radius of gyration</span><span>${validation.radiusOfGyration.toFixed(1)} A</span>` +
      `<span>Long-range contacts</span><span>${validation.contacts}</span>` +
      `<span>Clashes</span><span>${validation.clashes.length}</span>` +
      '</div>',
  );
  parts.push(`<code class="ss-strip">${colourSS(result.ss)}</code>`);

  dom.validation.innerHTML = parts.join('');
  dom.readout.innerHTML =
    `<strong>${result.residues.length}</strong> aa · ` +
    `<strong>${state.assembly.blocks.length}</strong> blocks · ` +
    `rebuilt in ${elapsedMs.toFixed(0)} ms`;
}

const colourSS = (ss) =>
  [...ss]
    .map((code) => (code === 'H' ? `<b>${code}</b>` : code === 'E' ? `<i>${code}</i>` : code))
    .join('');

function renderCommands() {
  if (!state.realized?.residues.length) {
    dom.commands.textContent = '';
    return;
  }
  const spec = buildDesignSpec(state.assembly, state.realized);
  const commands = pipelineCommands(spec, { stem: slug(state.assembly.name) });
  dom.commands.textContent = commands.prepare;
}

const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'design';

let flashTimer = null;
function flash(message) {
  dom.readout.innerHTML = `<strong>${message}</strong>`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => renderValidation(), 3200);
}

// --------------------------------------------------------------------- export

function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportPDB() {
  if (!state.realized?.residues.length) return flash('Nothing to export yet.');
  const spec = buildDesignSpec(state.assembly, state.realized);
  const text = writePDB(state.realized.residues, {
    segments: state.realized.segments,
    remarks: describeSpec(spec).split('\n'),
  });
  download(`${slug(state.assembly.name)}.pdb`, text, 'chemical/x-pdb');
}

function exportSpec() {
  if (!state.realized?.residues.length) return flash('Nothing to export yet.');
  const spec = buildDesignSpec(state.assembly, state.realized);
  spec.commands = pipelineCommands(spec, { stem: slug(state.assembly.name) });
  download(`${slug(state.assembly.name)}.spec.json`, JSON.stringify(spec, null, 2), 'application/json');
}

// ---------------------------------------------------------------------- input

function setMode(mode) {
  state.mode = mode;
  viewer.setMode(mode);
  dom.stage.classList.toggle('sketching', mode === 'sketch');
  dom.sketchHint.hidden = mode !== 'sketch';
  for (const button of document.querySelectorAll('[data-tool]')) {
    button.classList.toggle('active', button.dataset.tool === mode);
  }
}

for (const button of document.querySelectorAll('[data-tool]')) {
  button.addEventListener('click', () => setMode(button.dataset.tool));
}

document.getElementById('snap').addEventListener('change', (event) => {
  viewer.setSnap(event.target.checked);
});
document.getElementById('pack').addEventListener('click', packAgainstPrevious);
document.getElementById('recentre').addEventListener('click', () => viewer.recentre(state.realized));
document.getElementById('export-pdb').addEventListener('click', exportPDB);
document.getElementById('export-spec').addEventListener('click', exportSpec);
document.getElementById('load-example').addEventListener('click', () => loadExample());

document.getElementById('save').addEventListener('click', () => {
  download(`${slug(state.assembly.name)}.buildafold.json`, JSON.stringify(serialize(state.assembly), null, 2), 'application/json');
});
document.getElementById('open').addEventListener('click', () => dom.fileInput.click());
dom.fileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    state.assembly = deserialize(JSON.parse(await file.text()));
    state.history = [];
    select(null);
    viewer.syncBlocks(state.assembly);
    scheduleRealize(true);
    viewer.recentre(state.realized);
  } catch (error) {
    flash(`Could not open that file: ${error.message}`);
  }
  event.target.value = '';
});

window.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea')) return;

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undo();
    return;
  }
  if (event.key === 'g') setMode('translate');
  if (event.key === 'r') setMode('rotate');
  if (event.key === 'd') setMode('sketch');
  if (event.key === 'Escape') select(null);
  if (event.key === 'Delete' || event.key === 'Backspace') deleteSelected();
});

// --------------------------------------------------------------------- bootstrap

function loadExample() {
  snapshot();
  state.assembly = createAssembly('Four-helix bundle');
  for (let i = 0; i < 4; i += 1) {
    addBlock(state.assembly, { type: 'helix', nResidues: 16, ...suggestPlacement('helix') });
  }
  select(null);
  viewer.syncBlocks(state.assembly);
  scheduleRealize(true);
  viewer.recentre(state.realized);
}

renderPalette();
loadExample();
setMode('translate');

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
import { textToPaths, textToStrandBlocks, textToStrokeBlocks } from './shapes.js';
import { fetchStructure, parseStructure, chainToElements } from '../io/structures.js';

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
    runRealize(false);
    return;
  }
  if (realizeTimer) return;
  const wait = Math.max(0, 60 - (performance.now() - lastRealize));
  realizeTimer = setTimeout(() => {
    realizeTimer = null;
    runRealize(true);
  }, wait);
}

/**
 * Mid-drag frames use the cheap closure settings and only redraw the chain.
 * Validation, the chain list and the export commands are left alone until the
 * drag ends, so nothing the user reads or exports ever comes from a preview.
 */
function runRealize(preview) {
  const started = performance.now();
  const result = realize(state.assembly, preview ? { preview: true } : undefined);
  lastRealize = performance.now();

  viewer.syncBlocks(state.assembly);
  viewer.showChain(result);
  viewer.showClashes(result);

  if (preview) return;

  state.realized = result;
  renderChainList();
  renderInspector();
  renderValidation(lastRealize - started);
  renderCommands();
}

// -------------------------------------------------------------------- history

function snapshot() {
  state.history.push(JSON.stringify(serialize(state.assembly)));
  if (state.history.length > 60) state.history.shift();
  refreshUndoButton();
}

function refreshUndoButton() {
  const button = document.getElementById('undo');
  if (button) button.disabled = state.history.length === 0;
}

function undo() {
  const previous = state.history.pop();
  refreshUndoButton();
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
  addSketchBlock(state.assembly, lifted.residues, {
    name: `Sketch (${lifted.residues.length} aa)`,
  });
  select(block.id);
  scheduleRealize(true);
  flash(`Lifted ${lifted.residues.length} residues, ${lifted.rmsd.toFixed(2)} A from your stroke.`);
}


/**
 * Build a backbone shaped like the typed text.
 *
 * Each disconnected piece of the shape becomes its own block; the linkers that
 * join them are the same ones used everywhere else, so the result is a single
 * continuous chain that happens to read as a word. Pieces that torsion space
 * cannot follow closely are reported rather than silently accepted.
 */
function buildShape() {
  const text = document.getElementById('shape-text').value.trim();
  if (!text) return flash('Type something to build first.');

  const style = document.getElementById('shape-style').value;
  const capHeight = Math.max(
    14,
    Math.min(90, Number(document.getElementById("shape-height").value) || 44),
  );

  try {
    let built;
    if (style === 'outline') built = buildTracedShape(text);
    else if (style === 'fill') built = buildSheetShape(text);
    else {
      built = buildStrokeShape(text, {
        capHeight,
        type: style === 'strokes-strand' ? 'strand' : 'helix',
      });
    }
    if (!built) return;

    select(null);
    viewer.syncBlocks(state.assembly);
    scheduleRealize(true);
    viewer.recentre(state.realized);
    flash(built);
  } catch (error) {
    flash(`Could not build that shape: ${error.message}`);
  }
}

/**
 * Build text from its strokes: one element per stroke segment.
 *
 * A letter is a handful of lines, not a filled region, so this is both the
 * natural decomposition and the right scale — an N is three helices, and a
 * word comes out the size of a real protein rather than ten times it.
 */
function buildStrokeShape(text, options) {
  const specs = textToStrokeBlocks(text, options);
  if (!specs.length) {
    return flash(`Nothing drawable in "${text}" — letters and digits only.`);
  }

  snapshot();
  state.assembly = createAssembly(`Shape: ${text}`);

  const canonicalAxis = new THREE.Vector3(0, 0, 1);
  let residues = 0;

  for (const spec of specs) {
    const direction = new THREE.Vector3(...spec.direction).normalize();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(canonicalAxis, direction);
    addBlock(state.assembly, {
      type: spec.type,
      nResidues: spec.nResidues,
      position: spec.position,
      quaternion: quaternion.toArray(),
      name: `${spec.char} stroke`,
    });
    residues += spec.nResidues;
  }

  return `Built "${text}" from ${specs.length} elements, ${residues} residues.`;
}

/**
 * Filled shapes are built as a beta sheet: one strand per row of the shape,
 * alternating direction, joined by short turns. Straight elements can lie
 * exactly along a row, so this follows the outline far more closely than a
 * curve fitted through it, and it produces a fold rather than a wire.
 */
function buildSheetShape(text) {
  const specs = textToStrandBlocks(text, { heightAngstroms: 70 });
  if (!specs.length) return flash('That shape came out empty — try a larger word.');

  snapshot();
  state.assembly = createAssembly(`Shape: ${text}`);

  const canonicalAxis = new THREE.Vector3(0, 0, 1);
  let residues = 0;

  for (const spec of specs) {
    const direction = new THREE.Vector3(...spec.direction).normalize();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(canonicalAxis, direction);
    addBlock(state.assembly, {
      type: 'strand',
      nResidues: spec.nResidues,
      position: spec.position,
      quaternion: quaternion.toArray(),
      name: `${text} strand ${state.assembly.blocks.length + 1}`,
    });
    residues += spec.nResidues;
  }

  return `Built "${text}" as ${specs.length} strands, ${residues} residues.`;
}

/**
 * Outline mode traces the boundary and fits torsions to it. Kept because a
 * traced silhouette survives better at small sizes, but it is approximate:
 * a flat contour is not something backbone torsions can follow exactly, so the
 * reported deviation is part of the result rather than a detail.
 */
function buildTracedShape(text) {
  const paths = textToPaths(text, { style: 'outline', heightAngstroms: 70 });
  if (!paths.length) return flash('That shape came out empty — try a larger word.');

  snapshot();
  state.assembly = createAssembly(`Shape: ${text}`);

  let worst = 0;
  let residues = 0;

  for (const path of paths) {
    let lifted;
    try {
      lifted = liftSketch(path, { smoothing: 1 });
    } catch {
      continue; // a piece too short to build; the others still stand
    }
    if (lifted.residues.length < 3) continue;

    worst = Math.max(worst, lifted.rmsd);
    residues += lifted.residues.length;
    addSketchBlock(state.assembly, lifted.residues, {
      name: `${text} piece ${state.assembly.blocks.length + 1}`,
    });
  }

  if (!state.assembly.blocks.length) {
    undo();
    return flash('Nothing in that shape was long enough to build.');
  }

  return (
    `Traced "${text}": ${state.assembly.blocks.length} pieces, ${residues} residues, ` +
    `within ${worst.toFixed(1)} A of the outline.`
  );
}

// ------------------------------------------------------------ structure import

/** Chains from the most recently loaded structure, keyed for the chain picker. */
let loadedChains = [];

/**
 * Load a structure and offer its chains.
 *
 * Importing turns each helix and strand into a block that keeps its real
 * coordinates, so an imported element is the structure's own geometry rather
 * than an idealised stand-in. Loops are left out and rebuilt as linkers, which
 * is what lets the pieces be pulled apart and stay connected.
 */
async function loadStructureText(text, label) {
  let chains;
  try {
    chains = parseStructure(text);
  } catch (error) {
    return flash(`Could not read that structure: ${error.message}`);
  }
  if (!chains.length) return flash('No backbone found in that file.');

  loadedChains = chains;
  const picker = document.getElementById('pdb-chain');
  picker.innerHTML = '';
  for (const chain of chains) {
    const option = document.createElement('option');
    option.value = chain.chainId;
    option.textContent = `${chain.chainId} (${chain.residues.length} aa)`;
    picker.appendChild(option);
  }
  picker.disabled = false;

  importChain(chains[0], label);
}

function importChain(chain, label) {
  const elements = chainToElements(chain);
  if (!elements.length) {
    return flash(`Chain ${chain.chainId} has no helices or strands long enough to import.`);
  }

  snapshot();
  state.assembly = createAssembly(`${label} chain ${chain.chainId}`);
  for (const element of elements) {
    addSketchBlock(state.assembly, element.residues, {
      // Carry the element's own secondary structure: it decides the colour,
      // the proxy shape, and what the exported ss tensor says this is. Left as
      // "sketch", an imported helix would be exported as loop.
      type: element.code === 'H' ? 'helix' : 'strand',
      name: `${element.code}${element.residues.length} ${element.start + 1}-${element.end + 1}`,
    });
  }

  select(null);
  viewer.syncBlocks(state.assembly);
  scheduleRealize(true);
  viewer.recentre(state.realized);

  const helices = elements.filter((e) => e.code === 'H').length;
  const strands = elements.length - helices;
  flash(
    `${label} chain ${chain.chainId}: ${helices} helices, ${strands} strands ` +
      `(${chain.source === 'records' ? 'from the file' : 'assigned from geometry'}).`,
  );
}

async function fetchStructureById() {
  const input = document.getElementById('pdb-id');
  const button = document.getElementById('pdb-fetch');
  const id = input.value.trim();
  if (!id) return flash('Enter a PDB ID or UniProt accession.');

  button.disabled = true;
  flash(`Fetching ${id.toUpperCase()}…`);
  try {
    const result = await fetchStructure(id);
    await loadStructureText(result.text, result.id);
  } catch (error) {
    flash(`${error.message}.`);
  } finally {
    button.disabled = false;
  }
}

function deleteBlock(id) {
  if (!id || !findBlock(id)) return;
  snapshot();
  removeBlock(state.assembly, id);
  if (state.selectedId === id) select(null);
  scheduleRealize(true);
}

function deleteSelected() {
  deleteBlock(state.selectedId);
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

    const remove = document.createElement('button');
    remove.className = 'row-delete';
    remove.type = 'button';
    remove.textContent = '\u00d7';
    remove.title = `Delete ${block.name}`;
    remove.setAttribute('aria-label', `Delete ${block.name}`);
    remove.addEventListener('click', (event) => {
      event.stopPropagation(); // deleting should not also select the row
      deleteBlock(block.id);
    });
    item.appendChild(remove);

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
      sliderField('Residues', block.nResidues, 2, 60, {
        // Dragging previews on the cheap closure path so the chain keeps up;
        // releasing commits the exact rebuild.
        onPreview: (value) => {
          block.nResidues = value;
          scheduleRealize(false);
          updateLengthReadout(block, value);
        },
        onCommit: (value) => {
          block.nResidues = value;
          block.name = SS_PRESETS[block.type].label;
          scheduleRealize(true);
        },
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

/**
 * A slider paired with a number box, both showing the same value.
 *
 * The slider is for exploring — the chain rebuilds continuously as it moves, so
 * you can see a helix grow into its neighbours — and the box is for typing an
 * exact length. One undo entry is taken per interaction rather than per frame.
 */
function sliderField(label, value, min, max, { onPreview, onCommit }) {
  const wrapper = document.createElement('label');
  wrapper.className = 'slider-field';

  const name = document.createElement('span');
  name.className = 'slider-label';
  name.textContent = label;

  const range = document.createElement('input');
  range.type = 'range';
  Object.assign(range, { min, max, step: 1, value });

  const number = document.createElement('input');
  number.type = 'number';
  Object.assign(number, { min, max, step: 1, value });

  const clamp = (raw) => Math.min(max, Math.max(min, Math.round(Number(raw))));

  let editing = false;
  const beginEdit = () => {
    if (editing) return;
    editing = true;
    snapshot(); // one undo step for the whole drag, taken before anything moves
  };

  range.addEventListener('pointerdown', beginEdit);
  range.addEventListener('keydown', beginEdit);

  range.addEventListener('input', () => {
    beginEdit();
    const next = clamp(range.value);
    number.value = next;
    onPreview(next);
  });

  const commit = (source) => {
    const next = clamp(source.value);
    if (!Number.isFinite(next)) return;
    beginEdit();
    range.value = next;
    number.value = next;
    editing = false;
    onCommit(next);
  };

  range.addEventListener('change', () => commit(range));
  number.addEventListener('change', () => commit(number));

  wrapper.append(name, range, number);
  return wrapper;
}

/**
 * Keep the corner readout truthful while a slider is being dragged; the full
 * panels are only refreshed on the exact rebuild.
 */
function updateLengthReadout(block, value) {
  dom.readout.innerHTML =
    `<strong>${block.name}</strong>: ${value} residues · release to confirm`;
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
  if (validation.clashes.length) {
    const worst = validation.clashes.slice(0, 6);
    parts.push(
      '<p class="hint clash-caption">Worst overlaps, marked in red in the view:</p>' +
        '<ul class="clash-list">' +
        worst
          .map(
            (clash) =>
              `<li>residue ${clash.i + 1} &harr; ${clash.j + 1}` +
              ` <span>${clash.distance.toFixed(2)} A</span></li>`,
          )
          .join('') +
        (validation.clashes.length > worst.length
          ? `<li class="more">and ${validation.clashes.length - worst.length} more</li>`
          : '') +
        '</ul>',
    );
  }

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

/**
 * Some embedded viewers block a page from starting its own download, and do it
 * silently — the click simply does nothing. Rather than hand over a file that
 * may never arrive, detect the case and show the text to copy instead.
 */
const canDownload = () => {
  try {
    return window.self === window.top;
  } catch {
    return false; // cross-origin frame
  }
};

function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function deliver(filename, text, type) {
  if (canDownload()) {
    download(filename, text, type);
    flash(`Saved ${filename}`);
    return;
  }
  showExportText(filename, text);
}

function showExportText(filename, text) {
  document.getElementById('export-output').hidden = false;
  document.getElementById('export-output-name').textContent = filename;
  document.getElementById('export-text').value = text;
  document.getElementById('export-note').textContent =
    'This viewer blocks downloads, so the file is shown here. Copy it and save it ' +
    `as ${filename}.`;
}

document.getElementById('export-close').addEventListener('click', () => {
  document.getElementById('export-output').hidden = true;
});

document.getElementById('export-copy').addEventListener('click', async () => {
  const field = document.getElementById('export-text');
  const button = document.getElementById('export-copy');
  try {
    await navigator.clipboard.writeText(field.value);
    button.textContent = 'Copied';
  } catch {
    // Clipboard access is refused in some viewers; select it so the user can
    // copy with the keyboard.
    field.focus();
    field.select();
    button.textContent = 'Press Ctrl/Cmd-C';
  }
  setTimeout(() => {
    button.textContent = 'Copy';
  }, 2000);
});

function exportPDB() {
  if (!state.realized?.residues.length) return flash('Nothing to export yet.');
  const spec = buildDesignSpec(state.assembly, state.realized);
  const text = writePDB(state.realized.residues, {
    segments: state.realized.segments,
    remarks: describeSpec(spec).split('\n'),
  });
  deliver(`${slug(state.assembly.name)}.pdb`, text, 'chemical/x-pdb');
}

function exportSpec() {
  if (!state.realized?.residues.length) return flash('Nothing to export yet.');
  const spec = buildDesignSpec(state.assembly, state.realized);
  spec.commands = pipelineCommands(spec, { stem: slug(state.assembly.name) });
  deliver(`${slug(state.assembly.name)}.spec.json`, JSON.stringify(spec, null, 2), 'application/json');
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
document.getElementById('show-clashes').addEventListener('change', (event) => {
  viewer.setClashMarkers(event.target.checked);
});
document.getElementById('undo').addEventListener('click', undo);
document.getElementById('pack').addEventListener('click', packAgainstPrevious);
document.getElementById('recentre').addEventListener('click', () => viewer.recentre(state.realized));
document.getElementById('export-pdb').addEventListener('click', exportPDB);
document.getElementById('export-spec').addEventListener('click', exportSpec);
document.getElementById('load-example').addEventListener('click', () => loadExample());
document.getElementById('reset').addEventListener('click', resetAll);
document.getElementById('shape-build').addEventListener('click', buildShape);
document.getElementById('pdb-fetch').addEventListener('click', fetchStructureById);
document.getElementById('pdb-id').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') fetchStructureById();
});
document.getElementById('pdb-chain').addEventListener('change', (event) => {
  const chain = loadedChains.find((c) => c.chainId === event.target.value);
  if (chain) importChain(chain, state.assembly.name.split(' chain ')[0] || 'Structure');
});
document.getElementById('pdb-file-open').addEventListener('click', () => {
  document.getElementById('pdb-file').click();
});
document.getElementById('pdb-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (file) await loadStructureText(await file.text(), file.name.replace(/\.[^.]+$/, ''));
  event.target.value = '';
});
document.getElementById('shape-text').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') buildShape();
});

document.getElementById('save').addEventListener('click', () => {
  deliver(
    `${slug(state.assembly.name)}.buildafold.json`,
    JSON.stringify(serialize(state.assembly), null, 2),
    'application/json',
  );
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

/**
 * Clear the design. Snapshotted first, so this is undoable like any other edit
 * rather than a point of no return — which is also why it asks for no
 * confirmation.
 */
function resetAll() {
  if (!state.assembly.blocks.length) return flash('Nothing to clear.');
  snapshot();
  state.assembly.blocks = [];
  select(null);
  viewer.syncBlocks(state.assembly);
  scheduleRealize(true);
  flash('Cleared. Ctrl/Cmd-Z to bring it back.');
}

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
state.history = []; // loading the example is not something to undo back past
refreshUndoButton();

// Watched by the boot check in index.html: if this never runs, the page says so
// instead of showing an empty viewport.
window.__buildafoldReady = true;

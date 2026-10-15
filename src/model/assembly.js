/**
 * The assembly document.
 *
 * An assembly is an ordered list of rigid blocks plus the linkers between
 * them. Blocks carry their geometry in a canonical frame and a placement
 * (position + quaternion); "realising" the assembly means placing every block,
 * closing every linker, and concatenating the result into one chain.
 *
 * Keeping placement and geometry separate is what makes direct manipulation
 * cheap: dragging a helix rewrites three numbers, not a torsion chain.
 */

import { buildElement, cloneResidues, completeResidue } from '../geometry/chain.js';
import { canonicalize, placeBlock } from '../geometry/frame.js';
import { superpose } from '../geometry/kabsch.js';
import { closeLoop, closureFeasibility } from '../geometry/ccd.js';
import { validateChain } from '../geometry/validate.js';
import { BOND, COMFORTABLE_SPAN_PER_RESIDUE, SS3, SS_PRESETS } from '../geometry/constants.js';
import { distance } from '../geometry/vec3.js';

let nextId = 1;
const newId = (prefix) => `${prefix}${nextId++}`;

/** Reset the id counter. Only used so tests get stable ids. */
export function resetIds() {
  nextId = 1;
}

export function createAssembly(name = 'Untitled design') {
  return { name, blocks: [], version: 1 };
}

/**
 * Canonical geometry for a block, cached on the block itself. Sketch blocks
 * carry baked residues; SSE blocks are rebuilt whenever their parameters
 * change.
 */
export function blockGeometry(block) {
  if (block.kind === 'sketch') return block.canonical;
  if (!block._cache || block._cache.key !== geometryKey(block)) {
    const residues = buildElement(block.type, block.nResidues, {
      phi: block.phi,
      psi: block.psi,
    });
    block._cache = { key: geometryKey(block), residues: canonicalize(residues) };
  }
  return block._cache.residues;
}

const geometryKey = (block) => `${block.type}:${block.nResidues}:${block.phi ?? ''}:${block.psi ?? ''}`;

/**
 * Add an idealised secondary structure block.
 *
 * @param {object} assembly
 * @param {{type: string, nResidues?: number, position?: number[],
 *          quaternion?: number[], linkerBefore?: number|'auto', name?: string}} spec
 */
export function addBlock(assembly, spec) {
  const type = spec.type ?? 'helix';
  if (!SS_PRESETS[type]) throw new Error(`unknown block type: ${type}`);

  const block = {
    id: newId('b'),
    kind: 'sse',
    type,
    nResidues: spec.nResidues ?? defaultLength(type),
    phi: spec.phi,
    psi: spec.psi,
    position: spec.position ?? [0, 0, 0],
    quaternion: spec.quaternion ?? [0, 0, 0, 1],
    linkerBefore: spec.linkerBefore ?? 'auto',
    name: spec.name ?? SS_PRESETS[type].label,
  };
  assembly.blocks.push(block);
  return block;
}

/** Add a block whose geometry came from a sketched stroke. */
export function addSketchBlock(assembly, residues, spec = {}) {
  const world = cloneResidues(residues);
  const canonical = canonicalize(world);

  // Canonicalising moves the geometry to the origin, so the placement that
  // puts it back where it was given has to be recovered — otherwise a block
  // built from real coordinates silently lands at the origin, and a whole
  // imported structure collapses into one pile.
  const placement = restoringPlacement(canonical, world);

  const block = {
    id: newId('s'),
    kind: 'sketch',
    type: spec.type ?? 'sketch',
    nResidues: canonical.length,
    canonical,
    extent: axialExtent(canonical),
    position: spec.position ?? placement.position,
    quaternion: spec.quaternion ?? placement.quaternion,
    linkerBefore: spec.linkerBefore ?? 'auto',
    name: spec.name ?? `Sketch (${canonical.length} aa)`,
  };
  assembly.blocks.push(block);
  return block;
}

/**
 * The position and rotation that map canonical geometry back onto where it
 * came from. Superposition rather than an axis estimate, because the roll
 * about the element's own axis matters too and a first-to-last vector does not
 * capture it.
 */
function restoringPlacement(canonical, world) {
  if (canonical.length < 3) {
    const centre = world.length
      ? world
          .reduce((sum, r) => [sum[0] + r.CA[0], sum[1] + r.CA[1], sum[2] + r.CA[2]], [0, 0, 0])
          .map((v) => v / world.length)
      : [0, 0, 0];
    return { position: centre, quaternion: [0, 0, 0, 1] };
  }

  const fit = superpose(
    canonical.map((r) => r.CA),
    world.map((r) => r.CA),
  );
  return { position: fit.translation, quaternion: fit.quaternion };
}

/** Length of a canonical block along its own axis, which canonicalise puts on z. */
function axialExtent(canonical) {
  if (!canonical.length) return 0;
  const zs = canonical.map((r) => r.CA[2]);
  return Math.max(...zs) - Math.min(...zs);
}

const defaultLength = (type) => (type === 'helix' || type === 'helix310' ? 14 : 7);

export function removeBlock(assembly, id) {
  const index = assembly.blocks.findIndex((b) => b.id === id);
  if (index >= 0) assembly.blocks.splice(index, 1);
  return index >= 0;
}

/** Move a block within the chain order. Order is sequence order, not z-order. */
export function reorderBlock(assembly, id, toIndex) {
  const from = assembly.blocks.findIndex((b) => b.id === id);
  if (from < 0) return false;
  const clamped = Math.max(0, Math.min(assembly.blocks.length - 1, toIndex));
  const [block] = assembly.blocks.splice(from, 1);
  assembly.blocks.splice(clamped, 0, block);
  return true;
}

/**
 * Residues to use when a linker length is left on "auto".
 *
 * Sized against the comfortable span rather than the theoretical reach: a loop
 * planned at its limit is pulled straight, has no freedom to route around
 * neighbouring blocks, and often will not close at all.
 */
export function autoLinkerLength(prev, next, options = {}) {
  const { min = 3, max = 24, spanPerResidue = COMFORTABLE_SPAN_PER_RESIDUE } = options;
  const gap = distance(prev.C, next.N);
  return Math.max(min, Math.min(max, Math.ceil(gap / spanPerResidue)));
}

/**
 * Obstacles a linker must route around: everything already built, plus every
 * block still to come. Each carries a sequence index so that bonded
 * neighbours near the junction are not mistaken for collisions.
 */
function obstaclesFor({ built, remaining, loopStart, nLinker }) {
  const avoid = built.map((residue, i) => ({ xyz: residue.CA, index: i }));

  let cursor = loopStart + nLinker;
  for (const entry of remaining) {
    for (const residue of entry.residues) {
      avoid.push({ xyz: residue.CA, index: cursor });
      cursor += 1;
    }
    // Later blocks sit behind linkers of unknown length; the exact offset does
    // not matter because they are far away in sequence regardless.
    cursor += 4;
  }
  return avoid;
}

/**
 * Close one linker, lengthening it if a shorter one cannot get through.
 *
 * A loop sized purely on distance can still be forced through a neighbouring
 * block when the route is crowded. Rather than emit that, an auto-sized linker
 * is retried a few residues longer — which is also what a human would do.
 */
function resolveLinker({ prev, next, nLinker, grow, loopStart, built, remaining, closureOptions, preview }) {
  const candidates = grow && !preview ? [nLinker, nLinker + 1, nLinker + 2, nLinker + 3] : [nLinker];
  let best = null;

  for (const nResidues of candidates) {
    const avoid = obstaclesFor({ built, remaining, loopStart, nLinker: nResidues });
    const result = closeLoop(prev, next, nResidues, { avoid, loopStart, ...closureOptions });

    if (result.converged && (result.clashes ?? 0) === 0) return { result, nResidues };

    const rank = (result.converged ? 0 : 1000) + (result.clashes ?? 0) * 10 + result.rmsd;
    if (!best || rank < best.rank) best = { result, nResidues, rank };
  }
  return best;
}

/**
 * Closure settings for the interactive preview: one restart, a short sweep
 * budget and a loose tolerance. The chain this produces is still a real closed
 * backbone, just found with less effort — it is never what gets exported.
 */
export const PREVIEW_CLOSURE = {
  restarts: 1,
  maxSweeps: 80,
  tolerance: 0.25,
  stallThreshold: 5e-3,
};

/**
 * Place every block, close every linker, and concatenate into one chain.
 *
 * Pass `preview` while a drag is in flight: linkers are closed quickly and are
 * not grown to clear obstacles. Any state that is kept, validated or exported
 * must come from a full (non-preview) realisation.
 *
 * @param {object} assembly
 * @param {{closure?: object, preview?: boolean}} [options]
 * @returns {{residues: Array, segments: Array, ss: string, validation: object,
 *            closures: Array, ok: boolean}}
 */
export function realize(assembly, options = {}) {
  const placed = assembly.blocks.map((block) => ({
    block,
    residues: placeBlock(blockGeometry(block), block.position, block.quaternion),
  }));

  const residues = [];
  const segments = [];
  const closures = [];

  placed.forEach((entry, index) => {
    if (index > 0) {
      const previousResidues = residues;
      const prev = previousResidues[previousResidues.length - 1];
      const next = entry.residues[0];

      const requested = entry.block.linkerBefore;
      const nLinker =
        requested === 'auto' || requested === undefined
          ? autoLinkerLength(prev, next)
          : Math.max(0, Math.round(requested));

      if (nLinker === 0) {
        // Two elements can be directly bonded with nothing in between — a helix
        // running straight into a strand, which is common in real structures and
        // is how they import. Whether that is a problem depends on the geometry,
        // not on the absence of a linker: if the peptide bond is already the
        // right length, the junction is correct and there is nothing to close.
        const bond = distance(prev.C, next.N);
        const joined = Math.abs(bond - BOND.C_N) <= 0.1;
        closures.push({
          blockId: entry.block.id,
          nResidues: 0,
          converged: joined,
          rmsd: joined ? 0 : bond,
          feasibility: closureFeasibility(prev, next, 0),
          note: joined
            ? 'Directly bonded: these elements join with no linker.'
            : `Direct junction, but the ends are ${bond.toFixed(1)} A apart ` +
              '— add linker residues or move the blocks together.',
        });
      } else {
        const loopStart = residues.length;
        const { result, nResidues: resolvedLength } = resolveLinker({
          prev,
          next,
          nLinker,
          grow: requested === 'auto' || requested === undefined,
          loopStart,
          built: residues,
          remaining: placed.slice(index),
          preview: options.preview,
          closureOptions: options.preview
            ? { ...PREVIEW_CLOSURE, ...options.closure }
            : options.closure,
        });

        // The preceding residue's psi was a free variable during closure, so its
        // carbonyl oxygen has moved; rebuild it rather than leaving it stale.
        prev.psi = result.psiPrev;
        completeResidue(prev);

        const start = residues.length;
        for (const residue of result.residues) residues.push(residue);
        segments.push({
          kind: 'linker',
          blockId: entry.block.id,
          type: 'loop',
          start,
          end: residues.length - 1,
        });

        closures.push({
          blockId: entry.block.id,
          nResidues: resolvedLength,
          requested: nLinker,
          converged: result.converged,
          clashes: result.clashes ?? 0,
          rmsd: result.rmsd,
          feasibility: result.feasibility,
          auto: requested === 'auto',
        });
      }
    }

    const start = residues.length;
    for (const residue of entry.residues) residues.push(residue);
    segments.push({
      kind: 'block',
      blockId: entry.block.id,
      type: entry.block.type,
      name: entry.block.name,
      start,
      end: residues.length - 1,
    });
  });

  const ss = secondaryStructureString(residues.length, segments);
  const validation = validateChain(residues);
  const unclosed = closures.filter((c) => !c.converged);

  return {
    residues,
    segments,
    ss,
    closures,
    validation,
    ok: validation.ok && unclosed.length === 0,
  };
}

/** Three-state DSSP-style string, one character per residue. */
export function secondaryStructureString(length, segments) {
  const chars = new Array(length).fill('L');
  for (const segment of segments) {
    const code = SS3[segment.type] ?? 'L';
    for (let i = segment.start; i <= segment.end; i += 1) chars[i] = code;
  }
  return chars.join('');
}

/** Contiguous runs of identical SS code, which is what adjacency is defined over. */
export function secondaryStructureSegments(ss) {
  const runs = [];
  let start = 0;
  for (let i = 1; i <= ss.length; i += 1) {
    if (i === ss.length || ss[i] !== ss[start]) {
      runs.push({ code: ss[start], start, end: i - 1, length: i - start });
      start = i;
    }
  }
  return runs;
}

/** Plain-JSON form of an assembly, with caches and derived state stripped. */
export function serialize(assembly) {
  return {
    format: 'buildafold.assembly',
    version: assembly.version ?? 1,
    name: assembly.name,
    blocks: assembly.blocks.map((block) => ({
      id: block.id,
      kind: block.kind,
      type: block.type,
      nResidues: block.nResidues,
      phi: block.phi,
      psi: block.psi,
      position: [...block.position],
      quaternion: [...block.quaternion],
      linkerBefore: block.linkerBefore,
      name: block.name,
      extent: block.extent,
      canonical:
        block.kind === 'sketch'
          ? block.canonical.map((r) => ({
              N: [...r.N],
              CA: [...r.CA],
              C: [...r.C],
              phi: r.phi,
              psi: r.psi,
            }))
          : undefined,
    })),
  };
}

export function deserialize(data) {
  if (data?.format !== 'buildafold.assembly') {
    throw new Error('not a BuildAFold assembly file');
  }
  const assembly = createAssembly(data.name ?? 'Untitled design');
  assembly.blocks = data.blocks.map((block) => {
    const restored = { ...block };
    if (block.kind === 'sketch' && block.canonical) {
      restored.canonical = block.canonical.map((r) =>
        completeResidue({ N: [...r.N], CA: [...r.CA], C: [...r.C], phi: r.phi, psi: r.psi }),
      );
    }
    // Keep ids unique against anything created later in this session.
    const numeric = Number.parseInt(String(block.id).slice(1), 10);
    if (Number.isFinite(numeric) && numeric >= nextId) nextId = numeric + 1;
    return restored;
  });
  return assembly;
}

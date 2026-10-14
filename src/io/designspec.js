/**
 * Export a realised assembly as a design specification.
 *
 * This is the handoff point between "shape I drew" and "inputs a generative
 * model consumes". A BuildAFold assembly knows its own secondary structure
 * exactly — the user placed every element — so the specification is emitted
 * directly instead of being recovered from coordinates by DSSP.
 *
 * Adjacency follows RFdiffusion's fold-conditioning convention: contacts are
 * assigned between whole helix/strand segments when any virtual Cbeta pair is
 * within 6 A, loops are excluded, and within-segment entries are left unset.
 */

import { secondaryStructureSegments } from '../model/assembly.js';
import { distanceSq } from '../geometry/vec3.js';

export const ADJACENCY_CUTOFF = 6.0;

/** Channel indices for RFdiffusion's ss tensor. */
export const SS_INDEX = { H: 0, E: 1, L: 2 };

/**
 * Segment-level contacts between helix/strand runs.
 *
 * @param {Array} residues
 * @param {Array<{code: string, start: number, end: number}>} runs
 * @param {number} cutoff angstrom
 * @returns {Array<[number, number]>} index pairs into `runs`
 */
export function segmentAdjacency(residues, runs, cutoff = ADJACENCY_CUTOFF) {
  const points = residues.map((r) => r.CB ?? r.CA);
  const cutoffSq = cutoff * cutoff;
  const structured = runs
    .map((run, index) => ({ ...run, index }))
    .filter((run) => run.code === 'H' || run.code === 'E');

  const pairs = [];
  for (let a = 0; a < structured.length; a += 1) {
    for (let b = a + 1; b < structured.length; b += 1) {
      const first = structured[a];
      const second = structured[b];
      let touching = false;

      for (let i = first.start; i <= first.end && !touching; i += 1) {
        for (let j = second.start; j <= second.end; j += 1) {
          if (distanceSq(points[i], points[j]) < cutoffSq) {
            touching = true;
            break;
          }
        }
      }
      if (touching) pairs.push([first.index, second.index]);
    }
  }
  return pairs;
}

/**
 * RFdiffusion contig string. With no fixed motif this is simply the chain
 * length pinned to itself, which is what asks for a monomer of exactly this
 * many residues.
 */
export function contigString(length) {
  return `[${length}-${length}]`;
}

/**
 * Build the full design specification.
 *
 * @param {object} assembly
 * @param {object} realized result of `realize()`
 * @param {{name?: string}} [options]
 */
export function buildDesignSpec(assembly, realized, options = {}) {
  const { residues, ss, segments, closures, validation } = realized;
  const runs = secondaryStructureSegments(ss);
  const adjacency = segmentAdjacency(residues, runs);

  const blockOf = new Map();
  for (const segment of segments) {
    for (let i = segment.start; i <= segment.end; i += 1) {
      blockOf.set(i, { blockId: segment.blockId, kind: segment.kind, name: segment.name });
    }
  }

  return {
    format: 'buildafold.designspec',
    version: 1,
    name: options.name ?? assembly.name,
    generated: new Date().toISOString(),
    length: residues.length,

    secondaryStructure: ss,
    ssIndex: [...ss].map((code) => SS_INDEX[code] ?? SS_INDEX.L),

    runs: runs.map((run, index) => ({
      index,
      code: run.code,
      start: run.start,
      end: run.end,
      length: run.length,
      source: blockOf.get(run.start) ?? null,
    })),
    segmentAdjacency: adjacency,
    adjacencyCutoff: ADJACENCY_CUTOFF,

    blocks: assembly.blocks.map((block) => ({
      id: block.id,
      kind: block.kind,
      type: block.type,
      name: block.name,
      nResidues: block.nResidues,
      position: [...block.position],
      quaternion: [...block.quaternion],
      linkerBefore: block.linkerBefore,
    })),

    contigs: contigString(residues.length),

    diagnostics: {
      ok: realized.ok,
      radiusOfGyration: Number(validation.radiusOfGyration.toFixed(2)),
      contacts: validation.contacts,
      clashes: validation.clashes.length,
      chainBreaks: validation.breaks.length,
      warnings: validation.warnings,
      closures: closures.map((closure) => ({
        blockId: closure.blockId,
        nResidues: closure.nResidues,
        converged: closure.converged,
        rmsd: Number.isFinite(closure.rmsd) ? Number(closure.rmsd.toFixed(3)) : null,
        auto: closure.auto ?? false,
      })),
    },
  };
}

/**
 * Ready-to-run commands for the downstream tools.
 *
 * Written out as text rather than executed: the heavy models need GPUs, model
 * weights and their own environments, and the point of this tool is to produce
 * their inputs correctly, not to wrap them.
 */
export function pipelineCommands(spec, { stem = 'design' } = {}) {
  const length = spec.length;

  return {
    prepare: `python python/prepare_design_inputs.py ${stem}.spec.json --pdb ${stem}.pdb --out-dir rf_inputs`,

    rfdiffusionFoldConditioned: [
      './scripts/run_inference.py',
      'inference.output_prefix=out/' + stem,
      'scaffoldguided.scaffoldguided=True',
      `scaffoldguided.target_ss=rf_inputs/${stem}_ss.pt`,
      `scaffoldguided.target_adj=rf_inputs/${stem}_adj.pt`,
      'inference.num_designs=8',
    ].join(' \\\n    '),

    rfdiffusionPartial: [
      './scripts/run_inference.py',
      'inference.output_prefix=out/' + stem,
      `inference.input_pdb=${stem}.pdb`,
      `contigmap.contigs=['${length}-${length}']`,
      'diffuser.partial_T=20',
      'inference.num_designs=8',
    ].join(' \\\n    '),

    proteinmpnn: [
      'python protein_mpnn_run.py',
      '--pdb_path out/' + stem + '_0.pdb',
      '--out_folder out/seqs',
      '--num_seq_per_target 8',
      '--sampling_temp 0.1',
    ].join(' \\\n    '),
  };
}

/** Plain-text summary suitable for a REMARK block or the clipboard. */
export function describeSpec(spec) {
  const runs = spec.runs
    .filter((run) => run.code !== 'L')
    .map((run) => `${run.code}${run.length}`)
    .join('-');

  return [
    `BuildAFold design "${spec.name}"`,
    `${spec.length} residues; topology ${runs || 'none'}`,
    `secondary structure: ${spec.secondaryStructure}`,
    `radius of gyration ${spec.diagnostics.radiusOfGyration} A, ` +
      `${spec.diagnostics.contacts} long-range contacts`,
    spec.diagnostics.ok
      ? 'geometry checks passed'
      : `ISSUES: ${spec.diagnostics.warnings.join(' ') || 'unclosed linkers'}`,
  ].join('\n');
}

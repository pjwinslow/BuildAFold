/**
 * Loading existing structures: fetch a PDB entry, work out its elements, and
 * turn them into blocks that can be moved, deleted and built onto.
 *
 * The imported elements keep their real coordinates rather than being replaced
 * by idealised ones. A helix from a crystal structure is not an ideal helix,
 * and the point of bringing one in is to build against the real thing.
 */

import { parsePDB, parseSecondaryStructureRecords } from './pdb.js';
import { assignSecondaryStructure, secondaryStructureRuns } from '../geometry/ssassign.js';
import { completeResidue } from '../geometry/chain.js';

const RCSB = 'https://files.rcsb.org/download';
const ALPHAFOLD = 'https://alphafold.ebi.ac.uk/files';

/** Loose test for a UniProt accession, which means AlphaFold rather than RCSB. */
const UNIPROT = /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/i;

/**
 * Where to fetch an identifier from.
 *
 * @param {string} raw a PDB ID, a UniProt accession, or an AlphaFold model name
 * @returns {{url: string, source: string, id: string}}
 */
export function structureUrl(raw) {
  const id = String(raw).trim().toUpperCase();
  if (!id) throw new Error('give a PDB ID or UniProt accession');

  if (id.startsWith('AF-')) {
    const name = id.endsWith('.PDB') ? id.slice(0, -4) : id;
    const full = /-F\d+-MODEL_V\d+$/i.test(name) ? name : `${name}-F1-model_v4`;
    return { url: `${ALPHAFOLD}/${full}.pdb`, source: 'AlphaFold', id };
  }
  if (UNIPROT.test(id)) {
    return { url: `${ALPHAFOLD}/AF-${id}-F1-model_v4.pdb`, source: 'AlphaFold', id };
  }
  if (/^[0-9][A-Z0-9]{3}$/.test(id)) {
    return { url: `${RCSB}/${id}.pdb`, source: 'RCSB', id };
  }
  throw new Error(`"${raw}" is not a 4-character PDB ID or a UniProt accession`);
}

/**
 * Fetch a structure as text.
 *
 * @param {string} id
 * @param {{fetchImpl?: Function}} [options]
 */
export async function fetchStructure(id, options = {}) {
  const { fetchImpl = globalThis.fetch } = options;
  const target = structureUrl(id);

  let response;
  try {
    response = await fetchImpl(target.url);
  } catch (cause) {
    // Almost always the network or a blocked cross-origin request; say so
    // rather than surfacing a bare "Failed to fetch".
    throw new Error(`could not reach ${target.source} — check the connection`, { cause });
  }
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? `${target.source} has no entry ${target.id}`
        : `${target.source} returned ${response.status}`,
    );
  }

  return { ...target, text: await response.text() };
}

/**
 * Secondary structure for one chain: the file's own records where it has them,
 * otherwise assigned from the Cα trace.
 *
 * @returns {{ss: string, source: 'records'|'assigned'}}
 */
export function chainSecondaryStructure(residues, chainId, records) {
  const ss = new Array(residues.length).fill('L');
  const index = new Map(residues.map((residue, i) => [residue.resSeq, i]));

  let found = 0;
  const apply = (ranges, code) => {
    for (const range of ranges) {
      if (range.chainId !== chainId) continue;
      for (let seq = range.start; seq <= range.end; seq += 1) {
        const at = index.get(seq);
        if (at !== undefined) {
          ss[at] = code;
          found += 1;
        }
      }
    }
  };
  apply(records?.helices ?? [], 'H');
  apply(records?.sheets ?? [], 'E');

  if (found > 0) return { ss: ss.join(''), source: 'records' };
  return {
    ss: assignSecondaryStructure(residues.map((r) => r.CA)),
    source: 'assigned',
  };
}

/**
 * Parse a structure file into chains with secondary structure.
 *
 * @param {string} text
 * @returns {Array<{chainId: string, residues: Array, ss: string, source: string}>}
 */
export function parseStructure(text) {
  const { chains } = parsePDB(text);
  const records = parseSecondaryStructureRecords(text);

  return [...chains.entries()]
    .map(([chainId, residues]) => ({
      chainId,
      residues,
      ...chainSecondaryStructure(residues, chainId, records),
    }))
    .filter((chain) => chain.residues.length > 0)
    .sort((a, b) => b.residues.length - a.residues.length);
}

/**
 * Cut a chain into the elements worth importing as blocks.
 *
 * Loops are deliberately left out: they are rebuilt as linkers, which is what
 * lets the imported pieces be moved apart and still stay connected. Elements
 * shorter than a real one are skipped rather than imported as stubs.
 *
 * @param {object} chain from `parseStructure`
 * @param {{minHelix?: number, minStrand?: number, maxBlocks?: number}} [options]
 * @returns {Array<{code: string, residues: Array, start: number, end: number}>}
 */
export function chainToElements(chain, options = {}) {
  const { minHelix = 5, minStrand = 3, maxBlocks = 40 } = options;

  const elements = [];
  for (const run of secondaryStructureRuns(chain.ss)) {
    if (run.code === 'L') continue;
    const minimum = run.code === 'H' ? minHelix : minStrand;
    if (run.length < minimum) continue;

    const residues = chain.residues
      .slice(run.start, run.end + 1)
      .map((residue) => completeResidue({
        N: [...residue.N],
        CA: [...residue.CA],
        C: [...residue.C],
        psi: 0,
      }));

    elements.push({ code: run.code, residues, start: run.start, end: run.end });
    if (elements.length >= maxBlocks) break;
  }

  return elements;
}

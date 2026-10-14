/**
 * PDB reading and writing.
 *
 * The PDB format is column-oriented, not whitespace-delimited. Parsers in the
 * structural biology stack read by character offset, so a file that merely
 * "looks right" in a terminal can still be silently misread. Everything here
 * is written by column index for that reason.
 */

const pad = (value, width) => String(value).padStart(width);
const padRight = (value, width) => String(value).padEnd(width);
const fixed = (value, width, decimals) => pad(value.toFixed(decimals), width);

/**
 * Atom names occupy columns 13-16. One-character elements are indented by one
 * so that the element symbol sits in columns 13-14; this is what distinguishes
 * a backbone carbonyl carbon from, say, a calcium ion.
 */
function formatAtomName(name) {
  return name.length >= 4 ? name.slice(0, 4) : padRight(` ${name}`, 4);
}

const ELEMENT_OF = { N: 'N', CA: 'C', C: 'C', O: 'O', CB: 'C' };

/**
 * One ATOM record.
 *
 * @param {object} atom `{serial, name, resName, chainId, resSeq, xyz, occupancy, bFactor}`
 */
export function formatAtomLine(atom) {
  const element = atom.element ?? ELEMENT_OF[atom.name] ?? atom.name[0];
  return (
    'ATOM  ' + // 1-6
    pad(atom.serial, 5) + // 7-11
    ' ' + // 12
    formatAtomName(atom.name) + // 13-16
    ' ' + // 17 altLoc
    padRight(atom.resName ?? 'GLY', 3) + // 18-20
    ' ' + // 21
    (atom.chainId ?? 'A') + // 22
    pad(atom.resSeq, 4) + // 23-26
    ' ' + // 27 iCode
    '   ' + // 28-30
    fixed(atom.xyz[0], 8, 3) + // 31-38
    fixed(atom.xyz[1], 8, 3) + // 39-46
    fixed(atom.xyz[2], 8, 3) + // 47-54
    fixed(atom.occupancy ?? 1, 6, 2) + // 55-60
    fixed(atom.bFactor ?? 0, 6, 2) + // 61-66
    '          ' + // 67-76
    pad(element, 2) // 77-78
  );
}

/** HELIX record (columns per the PDB v3.3 specification). */
function formatHelixLine(serial, start, end, chainId, resName) {
  return (
    'HELIX ' +
    pad(serial, 4) +
    ' ' +
    pad(serial, 3) +
    ' ' +
    padRight(resName, 3) +
    ' ' +
    chainId +
    pad(start, 5) +
    ' ' +
    ' ' +
    padRight(resName, 3) +
    ' ' +
    chainId +
    pad(end, 5) +
    ' ' +
    pad(1, 2) + // helixClass 1 = right-handed alpha
    padRight('', 30) +
    ' ' +
    pad(end - start + 1, 5)
  );
}

/** SHEET record. Sense 0 marks the first strand of a sheet. */
function formatSheetLine(serial, numStrands, start, end, chainId, resName) {
  return (
    'SHEET ' +
    pad(serial, 4) +
    ' ' +
    padRight('A', 3) +
    pad(numStrands, 2) +
    ' ' +
    padRight(resName, 3) +
    ' ' +
    chainId +
    pad(start, 4) +
    ' ' +
    ' ' +
    padRight(resName, 3) +
    ' ' +
    chainId +
    pad(end, 4) +
    ' ' +
    pad(0, 2)
  );
}

/**
 * Write a realised chain as a PDB file.
 *
 * @param {Array} residues
 * @param {object} [options]
 * @param {string} [options.chainId='A']
 * @param {string} [options.resName='GLY'] poly-glycine is the usual placeholder
 *        for a designed backbone whose sequence has not been chosen yet
 * @param {boolean} [options.includeCB=false]
 * @param {Array} [options.segments] used to emit HELIX/SHEET records
 * @param {string[]} [options.remarks]
 * @returns {string}
 */
export function writePDB(residues, options = {}) {
  const {
    chainId = 'A',
    resName = 'GLY',
    includeCB = false,
    segments = [],
    remarks = [],
    bFactorBySegment = false,
  } = options;

  const lines = [];
  for (const remark of remarks) {
    // REMARK text is free-form but must stay inside the 80-column record.
    for (const chunk of wrap(remark, 68)) lines.push(`REMARK 999 ${chunk}`);
  }

  const helixSegments = segments.filter((s) => s.kind === 'block' && ssCodeOf(s) === 'H');
  const strandSegments = segments.filter((s) => s.kind === 'block' && ssCodeOf(s) === 'E');

  helixSegments.forEach((segment, index) => {
    lines.push(formatHelixLine(index + 1, segment.start + 1, segment.end + 1, chainId, resName));
  });
  strandSegments.forEach((segment, index) => {
    lines.push(
      formatSheetLine(
        index + 1,
        strandSegments.length,
        segment.start + 1,
        segment.end + 1,
        chainId,
        resName,
      ),
    );
  });

  const segmentIndexOf = new Array(residues.length).fill(0);
  segments.forEach((segment, index) => {
    for (let i = segment.start; i <= segment.end && i < residues.length; i += 1) {
      segmentIndexOf[i] = index;
    }
  });

  let serial = 1;
  residues.forEach((residue, index) => {
    const names = includeCB && residue.CB ? ['N', 'CA', 'C', 'O', 'CB'] : ['N', 'CA', 'C', 'O'];
    for (const name of names) {
      const xyz = residue[name];
      if (!xyz) continue;
      lines.push(
        formatAtomLine({
          serial,
          name,
          resName: name === 'CB' && resName === 'GLY' ? 'ALA' : resName,
          chainId,
          resSeq: index + 1,
          xyz,
          bFactor: bFactorBySegment ? segmentIndexOf[index] : 0,
        }),
      );
      serial += 1;
    }
  });

  lines.push(`TER   ${pad(serial, 5)}      ${padRight(resName, 3)} ${chainId}${pad(residues.length, 4)}`);
  lines.push('END');
  return `${lines.join('\n')}\n`;
}

const ssCodeOf = (segment) => {
  if (segment.type === 'helix' || segment.type === 'helix310') return 'H';
  if (segment.type === 'strand' || segment.type === 'strandPar') return 'E';
  return 'L';
};

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const out = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      if (line) out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/**
 * Parse backbone atoms out of a PDB file.
 *
 * Deliberately minimal: it reads ATOM records by column and groups them into
 * residues, which is all that is needed to bring an existing structure in as a
 * reference to build against. Alternate locations other than the first are
 * ignored, and hydrogens and side chains are dropped.
 *
 * @param {string} text
 * @returns {{chains: Map<string, Array>}}
 */
export function parsePDB(text) {
  const chains = new Map();

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('ATOM')) continue;

    const altLoc = line[16];
    if (altLoc !== ' ' && altLoc !== 'A') continue;

    const name = line.slice(12, 16).trim();
    if (!['N', 'CA', 'C', 'O', 'CB'].includes(name)) continue;

    const chainId = line[21] === ' ' ? 'A' : line[21];
    const resSeq = Number.parseInt(line.slice(22, 26), 10);
    const iCode = line[26].trim();
    const resName = line.slice(17, 20).trim();
    const xyz = [
      Number.parseFloat(line.slice(30, 38)),
      Number.parseFloat(line.slice(38, 46)),
      Number.parseFloat(line.slice(46, 54)),
    ];
    if (xyz.some((v) => !Number.isFinite(v))) continue;

    if (!chains.has(chainId)) chains.set(chainId, new Map());
    const residuesByKey = chains.get(chainId);
    const key = `${resSeq}${iCode}`;
    if (!residuesByKey.has(key)) {
      residuesByKey.set(key, { resSeq, iCode, resName, chainId });
    }
    residuesByKey.get(key)[name] = xyz;
  }

  const out = new Map();
  for (const [chainId, residuesByKey] of chains) {
    const residues = [...residuesByKey.values()]
      .filter((r) => r.N && r.CA && r.C)
      .sort((a, b) => a.resSeq - b.resSeq);
    out.set(chainId, residues);
  }
  return { chains: out };
}

/**
 * Ideal protein backbone geometry.
 *
 * Bond lengths and angles are the standard Engh & Huber restraint values used
 * by essentially every backbone builder. Torsion presets are the textbook
 * ideal values for each secondary structure type.
 */

export const BOND = {
  N_CA: 1.458,
  CA_C: 1.525,
  C_N: 1.329, // peptide bond
  C_O: 1.231,
};

export const ANGLE = {
  N_CA_C: 111.2,
  CA_C_N: 116.2,
  C_N_CA: 121.7,
  CA_C_O: 120.8,
};

/** Trans peptide bond. Cis-proline is out of scope for an idealised builder. */
export const OMEGA_TRANS = 180;

/** Virtual Cα-Cα distance across a trans peptide bond. */
export const CA_CA_DISTANCE = 3.8;

/**
 * Ideal (phi, psi) for each block type.
 *
 *  - `helix`      canonical right-handed alpha helix, 3.6 residues/turn, 1.5 A rise
 *  - `helix310`   tighter 3-10 helix, 3.0 residues/turn
 *  - `strand`     extended beta strand as found in antiparallel sheets
 *  - `strandPar`  slightly less extended strand typical of parallel sheets
 *  - `polyproline` left-handed PPII, the usual "extended coil" conformation
 */
export const SS_PRESETS = {
  helix: { phi: -57, psi: -47, label: 'Alpha helix', dssp: 'H' },
  helix310: { phi: -49, psi: -26, label: '3-10 helix', dssp: 'G' },
  strand: { phi: -139, psi: 135, label: 'Beta strand', dssp: 'E' },
  strandPar: { phi: -119, psi: 113, label: 'Beta strand (parallel)', dssp: 'E' },
  polyproline: { phi: -75, psi: 145, label: 'Extended coil', dssp: 'L' },
};

/** Block types the palette exposes, in display order. */
export const BLOCK_TYPES = ['helix', 'strand', 'polyproline', 'helix310', 'strandPar'];

/**
 * Three-state secondary structure code per block type, used for the DSSP-style
 * string that downstream fold-conditioning tools consume.
 */
export const SS3 = {
  helix: 'H',
  helix310: 'H',
  strand: 'E',
  strandPar: 'E',
  polyproline: 'L',
  loop: 'L',
  sketch: 'L',
};

/**
 * Hard limit on the Cα-Cα span `n` intervening residues can reach: a fully
 * extended chain advances ~3.3 A of end-to-end distance per residue once bond
 * angles are accounted for. Beyond this a gap is simply unbridgeable.
 */
export const MAX_SPAN_PER_RESIDUE = 3.3;

/**
 * Span per residue to *plan* a linker against.
 *
 * A loop sitting at its theoretical reach is pulled straight: it has no
 * conformational freedom left, the closure search stalls, and the one conformation
 * that does close is strained. Measured against this builder's own closure
 * routine, loops need roughly 2.4 A per residue to close comfortably with room
 * to route around obstacles. Auto-sized linkers use this; feasibility
 * reporting still uses the hard limit above.
 */
export const COMFORTABLE_SPAN_PER_RESIDUE = 2.4;

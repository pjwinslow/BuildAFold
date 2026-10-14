/**
 * Backbone construction from torsion angles.
 *
 * A "residue" here is a plain object `{ N, CA, C, O, CB, phi, psi, omega }`
 * where each atom is an `[x, y, z]` array. Only backbone atoms are modelled:
 * that is exactly what diffusion models and ProteinMPNN consume, and it keeps
 * the builder honest about what it does and does not know.
 */

import { ANGLE, BOND, OMEGA_TRANS, SS_PRESETS } from './constants.js';
import { placeAtom } from './nerf.js';
import { add, cross, DEG, scale, sub } from './vec3.js';

/**
 * First residue of a chain, placed in a deterministic reference frame:
 * N at the origin, CA on +x, C in the xy-plane.
 */
export function seedResidue() {
  const N = [0, 0, 0];
  const CA = [BOND.N_CA, 0, 0];
  // Direction CA->N is -x; rotate it by the N-CA-C angle within the xy-plane.
  const t = ANGLE.N_CA_C * DEG;
  const C = [CA[0] - BOND.CA_C * Math.cos(t), -BOND.CA_C * Math.sin(t), 0];
  return { N, CA, C };
}

/**
 * Carbonyl oxygen of residue i. O is anti to N(i+1), i.e. the dihedral
 * N-CA-C-O is psi + 180.
 */
export function placeOxygen(residue) {
  return placeAtom(residue.N, residue.CA, residue.C, BOND.C_O, ANGLE.CA_C_O, residue.psi + 180);
}

/**
 * Virtual Cβ from the backbone frame. This is the standard construction used
 * by AlphaFold and ProteinMPNN for glycine positions, so Cβ-based contact maps
 * computed here agree with the ones those tools compute internally.
 */
export function virtualCB(residue) {
  const b = sub(residue.CA, residue.N);
  const c = sub(residue.C, residue.CA);
  const a = cross(b, c);
  return add(
    residue.CA,
    add(add(scale(a, -0.58273431), scale(b, 0.56802827)), scale(c, -0.54067466)),
  );
}

/** Fill in O and CB for a residue that already has N, CA, C and psi. */
export function completeResidue(residue) {
  residue.O = placeOxygen(residue);
  residue.CB = virtualCB(residue);
  return residue;
}

/**
 * Extend a chain by one residue.
 *
 * @param {object} prev previous residue; its `psi` and `omega` are used
 * @param {number} phiNext phi of the residue being appended
 * @returns {{N: number[], CA: number[], C: number[]}}
 */
export function appendResidue(prev, phiNext) {
  const omega = prev.omega ?? OMEGA_TRANS;
  const N = placeAtom(prev.N, prev.CA, prev.C, BOND.C_N, ANGLE.CA_C_N, prev.psi);
  const CA = placeAtom(prev.CA, prev.C, N, BOND.N_CA, ANGLE.C_N_CA, omega);
  const C = placeAtom(prev.C, N, CA, BOND.CA_C, ANGLE.N_CA_C, phiNext);
  return { N, CA, C };
}

/**
 * Build a backbone from a list of per-residue torsions.
 *
 * `phi` of the first residue has no preceding carbonyl to rotate about and is
 * therefore ignored; `psi` of the last residue still matters because it places
 * the final carbonyl oxygen.
 *
 * @param {Array<{phi?: number, psi: number, omega?: number}>} torsions
 * @param {{seed?: {N: number[], CA: number[], C: number[]}}} [options]
 * @returns {Array<object>} residues
 */
export function buildBackbone(torsions, options = {}) {
  if (!torsions.length) return [];

  const seed = options.seed ?? seedResidue();
  const residues = [];

  let current = {
    N: seed.N,
    CA: seed.CA,
    C: seed.C,
    phi: torsions[0].phi ?? null,
    psi: torsions[0].psi,
    omega: torsions[0].omega ?? OMEGA_TRANS,
  };
  residues.push(current);

  for (let i = 1; i < torsions.length; i += 1) {
    const { N, CA, C } = appendResidue(current, torsions[i].phi);
    current = {
      N,
      CA,
      C,
      phi: torsions[i].phi,
      psi: torsions[i].psi,
      omega: torsions[i].omega ?? OMEGA_TRANS,
    };
    residues.push(current);
  }

  for (const residue of residues) completeResidue(residue);
  return residues;
}

/**
 * Build an idealised secondary structure element of `nResidues` residues.
 *
 * @param {string} type key into SS_PRESETS
 * @param {number} nResidues
 * @param {{phi?: number, psi?: number, seed?: object}} [overrides]
 */
export function buildElement(type, nResidues, overrides = {}) {
  const preset = SS_PRESETS[type];
  if (!preset) throw new Error(`unknown secondary structure type: ${type}`);
  const phi = overrides.phi ?? preset.phi;
  const psi = overrides.psi ?? preset.psi;

  const torsions = [];
  for (let i = 0; i < nResidues; i += 1) torsions.push({ phi, psi, omega: OMEGA_TRANS });
  return buildBackbone(torsions, { seed: overrides.seed });
}

/** Deep copy of a residue list, so transforms never alias cached geometry. */
export function cloneResidues(residues) {
  return residues.map((r) => ({
    ...r,
    N: [...r.N],
    CA: [...r.CA],
    C: [...r.C],
    O: r.O ? [...r.O] : undefined,
    CB: r.CB ? [...r.CB] : undefined,
  }));
}

/** Every backbone atom of a residue list, in standard PDB order. */
export function atomList(residues, { includeCB = false } = {}) {
  const atoms = [];
  residues.forEach((residue, index) => {
    atoms.push({ name: 'N', xyz: residue.N, residueIndex: index });
    atoms.push({ name: 'CA', xyz: residue.CA, residueIndex: index });
    atoms.push({ name: 'C', xyz: residue.C, residueIndex: index });
    if (residue.O) atoms.push({ name: 'O', xyz: residue.O, residueIndex: index });
    if (includeCB && residue.CB) atoms.push({ name: 'CB', xyz: residue.CB, residueIndex: index });
  });
  return atoms;
}

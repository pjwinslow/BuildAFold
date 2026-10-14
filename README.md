# BuildAFold

A visual, block-based protein backbone builder that runs in the browser.

Drag idealised secondary structure elements — helices, strands, extended coils —
into the arrangement you have in mind, or draw a path with the mouse. BuildAFold
connects them with real loops, checks that the result is a physically possible
chain, and exports the backbone plus the conditioning inputs that generative
design tools consume.

It is a **front end for specifying shape**. It does not run any model and does
not design sequences; it produces correct inputs for the tools that do.

```
   blocks / sketch  ->  closed, validated backbone  ->  .pdb + ss/adj tensors
                                                             |
                                                   RFdiffusion (fold-conditioned)
                                                             |
                                                        ProteinMPNN
```

## Running it

```bash
npm run serve          # static server, no build step, no dependencies
# open http://localhost:8173
```

`index.html` loads three.js from a CDN. To run fully offline, install it and
point the import map at the local copy:

```bash
npm install three@0.169.0
```

```html
<script type="importmap">
  { "imports": {
      "three": "./node_modules/three/build/three.module.js",
      "three/addons/": "./node_modules/three/examples/jsm/"
  } }
</script>
```

## Using it

| | |
|---|---|
| **Blocks** panel | click a type to append it to the chain |
| **Move / Rotate** (`G` / `R`) | drag the gizmo on the selected block |
| **Sketch** (`D`) | drag in the viewport to draw a backbone path |
| **Pack** | align the selection antiparallel to the previous block at contact distance |
| **Snap** | 1 Å translation, 15° rotation |
| **Chain order** panel | drag to reorder; set each linker's length or leave it on `auto` |
| `Ctrl/Cmd-Z` | undo |

The chain is rebuilt from scratch on every edit — blocks placed, every linker
re-closed, geometry re-validated — so what is on screen is always a real
backbone, and the export can never disagree with the picture.

### Exports

- **`design.pdb`** — N, CA, C, O for every residue as poly-glycine, with
  `HELIX`/`SHEET` records so it renders as a cartoon straight away.
- **`design.spec.json`** — length, per-residue secondary structure, the runs and
  their contact graph, block placements, diagnostics and the commands to run next.

Then:

```bash
python python/prepare_design_inputs.py design.spec.json --pdb design.pdb --out-dir rf_inputs
```

which writes `design_ss.pt` `(L,)` and `design_adj.pt` `(L, L)` in RFdiffusion's
fold-conditioning encoding (0 = helix, 1 = strand, 2 = loop; segment-level Cβ
contacts at 6 Å, loops excluded). Passing `--pdb` re-derives the contact graph
from coordinates and warns if it disagrees with the spec. Torch is only needed
to write `.pt`; otherwise you get `.npy` or JSON.

## How it works

Everything is built from one primitive: **NeRF** atom placement from internal
coordinates. Blocks, sketched strokes and closed loops all go through it, so
every chain has ideal bond lengths and angles by construction rather than by
cleanup afterwards.

**Blocks** carry their geometry in a canonical frame (long axis on +z, centroid
at the origin) plus a placement. Dragging one rewrites a position and a
quaternion; it never re-derives a torsion chain, which is what makes direct
manipulation feel immediate.

**Linkers** are closed with Ramachandran-restrained cyclic coordinate descent.
CCD walks the free torsions of the loop and applies, for each in turn, the
closed-form rotation that best superimposes the loop's terminal N/CA/C onto the
fixed anchor atoms of the next block. Candidate solutions are also scored
against the surrounding structure, because closure alone only guarantees that
the two ends meet — without that the shortest path between two blocks is
frequently straight through a third. An `auto` linker is sized against a
*comfortable* span (2.4 Å/residue) rather than the theoretical reach
(3.3 Å/residue), and grows a few residues if a shorter one cannot get through.

**Sketches** are lifted in three steps: smooth and resample the stroke at the
3.8 Å Cα spacing; fit backbone torsions to that trace by beam search over the
populated Ramachandran basins; superimpose the result back onto the drawing.
The fit is done on rotation- and translation-invariant descriptors (virtual Cα
angles and dihedrals), so no assumption about the stroke's absolute frame is
needed. The output is always a chemically valid backbone, never an interpolated
ribbon that merely looks like one.

**Validation** reports steric clashes, chain breaks, radius of gyration and
long-range contact count. A design that fails these is reported as not
buildable rather than quietly exported.

### Layout

```
src/geometry/   pure geometry, no rendering dependency, fully unit tested
  nerf.js         internal coordinates -> cartesian
  chain.js        backbone construction, ideal SSE presets, virtual CB
  frame.js        canonical framing, quaternions, rigid transforms
  kabsch.js       reflection-safe superposition (Horn's quaternion method)
  ccd.js          loop closure
  trace.js        stroke -> Cα trace -> torsions
  rama.js         populated basins, used to restrain both searches
  validate.js     clashes, breaks, contacts
src/model/      the assembly document and realisation
src/io/         PDB read/write, design spec and command generation
src/ui/         three.js viewport and application controller
python/         design spec -> model inputs
```

## What is verified

`npm test` — 27 tests over the geometry and model layers, including:

- NeRF reproduces requested bond lengths, angles and torsions, and survives
  collinear reference atoms
- every built chain has ideal geometry and trans peptide bonds
- an ideal α-helix has textbook dimensions: 1.5 Å rise, the CA(i)→CA(i+3) and
  CA(i)→CA(i+4) signatures, and **positive** virtual Cα dihedral — a mirrored
  helix is invisible in a cartoon and no model will build one
- superposition never returns a reflection
- CCD produces chemically correct junctions, keeps torsions in allowed basins,
  and reports unreachable gaps instead of inventing geometry
- PDB records land in the columns the format specifies, and round trip exactly

`npm run test:ui` — 8 Playwright tests driving the real page: boot, palette,
editing, undo, export, and that an impossible linker surfaces as an error.

A four-helix bundle built through this path gives 80 residues, Rg 12.0 Å, no
clashes or breaks, and the expected 1-2 / 1-4 / 2-3 / 3-4 adjacency graph.

## Limits worth knowing

- **Sketch depth is not inferred.** A stroke is projected onto the plane facing
  the camera; you supply depth by orbiting and redrawing. Sketch-conditioned
  generative work infers depth from a learned prior instead — see below.
- **No β-sheet registry.** Strands can be placed next to each other, but the
  tool does not snap them into a hydrogen-bonded register with the correct
  pleat and twist. This is the most valuable thing to add next.
- **No energy function.** Validation is steric and geometric only. A chain that
  passes is possible, not necessarily stable or designable.
- **Backbone only** — no side chains beyond the virtual Cβ used for contacts.
- The browser UI is exercised in CI against a **test double** for three.js,
  because the CDN is unreachable from the build container. That covers the
  application wiring and the geometry pipeline, not the calls into three.js
  itself.

## Relation to the papers this came from

Both attached papers condition a generative model on an abstract description of
intent. [Prompteina](https://arxiv.org/abs/2610.13917) uses natural language;
VenusSketch uses a 2D sketch lifted to a Cα trace by a learned model, with the
surrounding structure held fixed.

BuildAFold takes the same idea — specify intent at the level of shape and
topology, let a generative model supply the atoms — but makes the specification
*direct and explicit* rather than inferred. There is no model between you and
the geometry: a helix you place is exactly where you put it, and the tool's job
is to keep the result physically honest and hand the downstream models a
correct description of what you meant.

The natural next step in that direction is fixed-context editing, as in
VenusSketch: import an existing structure, hold it rigid, and build only into a
defined region. The PDB parser and the block/linker machinery are already in
place for it; what is missing is the UI for marking a region as fixed.

## Performance

A full realisation of a four-helix bundle takes ~160 ms: every linker is closed
from scratch by CCD, with restarts and obstacle avoidance. That is too slow for
a drag, so mid-drag frames use cheap closure settings (one restart, short sweep
budget, loose tolerance) and take ~5 ms. The preview is still a real closed
backbone, and it only ever feeds the viewport — validation, the chain list and
every export come from a full realisation after the drag ends.

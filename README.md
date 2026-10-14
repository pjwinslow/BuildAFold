# BuildAFold

### [→ Open the builder](https://pjwinslow.github.io/BuildAFold/)

Build protein backbones by hand, in a browser. Drag helices and strands into the
shape you want, or draw a path with the mouse; BuildAFold connects them with real
loops, checks the result is a physically possible chain, and exports the backbone
along with the conditioning inputs that generative design tools expect.

It is a front end for specifying **shape**. It runs no models and designs no
sequences — it produces correct inputs for the tools that do.

```
   blocks / sketch  ->  closed, validated backbone  ->  .pdb + ss/adj tensors
                                                             |
                                                   RFdiffusion (fold-conditioned)
                                                             |
                                                        ProteinMPNN
```

## Quickstart

Nothing to install and no build step:

```bash
npm run serve        # → http://localhost:8173
```

Or just use the [hosted copy](https://pjwinslow.github.io/BuildAFold/).

## Controls

| | |
|---|---|
| **Blocks** panel | click a type to append it to the chain |
| **Move / Rotate** (`G` / `R`) | drag the gizmo on the selected block |
| **Sketch** (`D`) | drag in the viewport to draw a backbone path |
| **Shape** panel | type a word and build a backbone shaped like it |
| **Pack** | align the selection antiparallel to the previous block, at contact distance |
| **Snap** | 1 Å translation, 15° rotation |
| **Undo** (`Ctrl/Cmd-Z`) | step back; a whole slider drag counts as one step |
| **Chain order** panel | drag to reorder, `×` to delete, set each linker's length or leave it `auto` |
| Residues slider | resize the selected element; the chain follows as you drag |

The chain is rebuilt from scratch on every edit — blocks placed, every linker
re-closed, geometry re-validated — so what is on screen is always a real
backbone, and an export can never disagree with the picture.

## Exports

- **`design.pdb`** — N, CA, C, O per residue as poly-glycine, with `HELIX` and
  `SHEET` records so it renders as a cartoon straight away.
- **`design.spec.json`** — length, per-residue secondary structure, the runs and
  their contact graph, block placements, diagnostics, and the commands to run next.

Then:

```bash
python python/prepare_design_inputs.py design.spec.json --pdb design.pdb --out-dir rf_inputs
```

This writes `design_ss.pt` `(L,)` and `design_adj.pt` `(L, L)` in RFdiffusion's
fold-conditioning encoding — 0 helix, 1 strand, 2 loop, with segment-level Cβ
contacts at 6 Å and loops excluded. Passing `--pdb` re-derives the contact graph
from coordinates and warns if it disagrees with the spec. Torch is only needed
to write `.pt`; otherwise you get `.npy` or JSON.

## How it works

Everything is built from one primitive: **NeRF** atom placement from internal
coordinates. Blocks, sketched strokes and closed loops all go through it, so every
chain has ideal bond lengths and angles by construction rather than by cleanup
afterwards.

**Blocks** hold their geometry in a canonical frame — long axis on +z, centroid at
the origin — plus a placement. Dragging one rewrites a position and a quaternion
rather than re-deriving a torsion chain, which is what makes manipulation feel
immediate.

**Linkers** are closed with Ramachandran-restrained cyclic coordinate descent. CCD
walks the loop's free torsions and applies, for each in turn, the closed-form
rotation that best superimposes the loop's terminal N/CA/C onto the fixed anchor
atoms of the next block. Candidates are also scored against the surrounding
structure, because closure alone only guarantees the two ends meet — without that,
the shortest path between two blocks is frequently straight through a third. An
`auto` linker is sized against a *comfortable* span (2.4 Å/residue) rather than the
theoretical reach (3.3 Å/residue), and grows a few residues if a shorter one cannot
get through.

**Shapes** are covered row by row and each row becomes a strand, with the runs
ordered by a greedy nearest-neighbour walk so the chain travels down one limb of
a letter and back up the other instead of crossing between them on every row.
Fitting torsions to a plane-filling curve was tried first and abandoned: a flat
serpentine is close to unrealisable in torsion space, and the fit came back 7 A
from the target with the chain folded through itself. Straight elements can lie
exactly along a row, so building the shape out of them is both truer to the
silhouette and more protein-like.

**Sketches** are lifted in three steps: smooth and resample the stroke at the 3.8 Å
Cα spacing; fit torsions to that trace by beam search over the populated
Ramachandran basins; superimpose the result back onto the drawing. The fit uses
rotation- and translation-invariant descriptors (virtual Cα angles and dihedrals),
so nothing needs to be assumed about the stroke's absolute frame. The output is
always a chemically valid backbone, never an interpolated ribbon that looks like one.

**Validation** reports steric clashes, chain breaks, radius of gyration and
long-range contact count. A design that fails is reported as not buildable rather
than quietly exported.

**Rendering** follows the Richardson cartoon convention: helices as flat twisted
ribbons, strands as arrows, loops as thin tubes, with pale card edges so an element
reads as a solid object and its facing and direction are both visible.

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
src/ui/         three.js viewport, cartoon ribbons, application controller
python/         design spec -> model inputs
```

## Tests

```bash
npm test         # 27 geometry and model tests
npm run test:ui  # 14 browser tests (Playwright)
```

The geometry tests check that NeRF reproduces requested internal coordinates, that
every built chain has ideal bonds and trans peptide bonds, that an ideal α-helix has
textbook dimensions including a *positive* virtual Cα dihedral (a mirrored helix is
invisible in a cartoon and no model will build one), that superposition never
returns a reflection, that CCD produces correct junctions and reports unreachable
gaps instead of inventing geometry, and that PDB records land in the columns the
format specifies.

## Limitations

- **Shape mode places elements well but its loops crowd.** A filled shape is
  built as a beta sheet, one strand per row, and the strand placement itself is
  clean — a letter typically has no strand-strand clashes at all. The
  connecting turns are the problem: a dense flat sheet needs one every few
  residues and gives them nowhere to route, so a letter arrives with tens of
  loop clashes. Shorter linkers clash less but stop closing, which is worse, so
  the auto sizing is kept and the clashes are reported. Treat the output as a
  scaffold to regularise, not a finished backbone. Proper loop routing, or
  letting partial diffusion rebuild the turns, is the fix.
- **Sketch depth is not inferred.** A stroke is projected onto the plane facing the
  camera; depth comes from orbiting and redrawing.
- **No β-sheet registry.** Strands can be placed side by side, but they are not
  snapped into a hydrogen-bonded register with the right pleat and twist. This is
  the most valuable thing to add next.
- **No energy function.** Validation is steric and geometric only. A chain that
  passes is possible, not necessarily stable or designable.
- **Backbone only** — no side chains beyond the virtual Cβ used for contacts.
- three.js loads from a CDN, so the page needs network access on first load. If it
  cannot be reached, the page says so rather than showing an empty viewport.

## Deploying

The app is static. `.github/workflows/pages.yml` runs the tests, assembles `_site/`
from `index.html` and `src/`, and publishes to GitHub Pages on every push to the
default branch. Pages has to be switched on once under **Settings → Pages →
Source: GitHub Actions**.

`node tools/build-artifact.js` additionally emits a wrapper-free copy of the page
for hosts that supply their own document skeleton.

A full rebuild of a four-helix bundle takes ~160 ms, since every linker is closed
by CCD with restarts and obstacle avoidance. That is too slow for a drag, so
mid-drag frames use cheap closure settings and take ~5 ms; the exact rebuild runs on
release, and only its result is validated or exported.

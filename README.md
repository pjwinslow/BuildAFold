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

## Related work, and what this is not

Sketching a topology and handing it to a generative model is well-trodden
ground. The nearest relatives, and why this is not one of them:

| | What it does | How this differs |
|---|---|---|
| [TopoBuilder](https://www.pnas.org/doi/10.1073/pnas.2206111119) (Correia lab, PNAS 2022) | Expands a topology string into an idealised sketch of elements with no loops, then folds and designs it with Rosetta | Closest in concept, and its layer spacings are essentially the ones used here. It takes a string and runs offline; this is direct manipulation with live feedback |
| [ProtoShop](https://web.cs.ucdavis.edu/~okreylos/ResDev/ProtoShop/MainPage.html) (UC Davis) | Drag helices and strands, with the drag converted into dihedral changes in the connecting coils | Closest in interaction, and it got there first. Desktop software, not a browser page, and it predates the generative tools this exports for |
| [ProtPainter](https://arxiv.org/pdf/2504.14274) (ICLR 2025) | Draw a 3D curve; a model infers secondary structure from it and diffusion builds the backbone | Does properly, with a learned model, what the sketch mode here does with a torsion fit. Needs a GPU and takes seconds to minutes per sample |
| [CAD blueprint-guided diffusion](https://www.biorxiv.org/content/10.64898/2026.07.22.740177v1) (Qi, Kortemme, Huang 2026) | Makes global shape a programmable design layer, with a signed-distance boundary term and Chamfer distance to a CAD blueprint | The serious version of "build a protein shaped like this" — 31 of 59 designs validated by crystallography or EM. Shape mode here is a toy beside it |
| [DiffTopo](https://www.biorxiv.org/content/10.1101/2024.02.01.578456.full.pdf) (ICLR workshop 2024) | Diffuses coarse topologies that then steer RFdiffusion | Generates topologies; this one lets you specify a particular topology by hand |
| [Tamarind](https://www.tamarind.bio/tools/rfdiffusion), Neurosnap | Hosted RFdiffusion behind a web form | Runs the models; this prepares their inputs and runs nothing |

**"Couldn't you just do this in PyMOL?"** Partly. `fab SEQUENCE, ss=1` builds an
ideal helix, so placing elements is easy. But PyMOL has no loop closure: joining
two fragments means moving them into one object and forming the bond by hand,
with nothing constraining the relative orientation. It also will not tell you
whether a linker is geometrically reachable, or emit conditioning tensors.
PyMOL builds the pieces; connecting them is the part this does.

The stronger objection is PyRosetta, where cyclic coordinate descent is a
built-in mover and blueprint-based building already exists. A competent person
could script most of this. The argument for this tool is not that the
algorithms are new — they are textbook — but that nothing found combines them
into something that opens in a browser, responds immediately, and emits
standard inputs.

**So, plainly: this is a sketchpad, not a design method.** It runs no model,
scores nothing, and has no energy function. A chain that passes its checks is
physically possible, not stable, foldable or designable. Use it to specify a
shape quickly and get correct inputs for the tools that do the real work.

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
| **Fetch structure** panel | pull a PDB entry or AlphaFold model in as editable blocks |
| **Clashes** toggle | red markers in the viewport at every steric overlap |
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

**Shapes** are built from a stroke font: each character is stored as the few
lines you would draw it with, and every stroke segment becomes one element. An
"N" is three strokes, so it is three helices. Strokes meet at shared corners, so
each element is pulled back from its ends — about a fifth of the cap height —
which both leaves room for the connecting loop and is, by measurement, the
single biggest factor in whether a letter comes out clash-free.

Two earlier approaches are worth recording. Fitting torsions to a plane-filling
curve through the letter came back 7 A from the target shape with the chain
folded through itself: a flat serpentine is close to unrealisable in torsion
space. Covering the letter row by row as a beta sheet placed its strands
cleanly, but needed two dozen of them per character and buried the letter in
turns. Both are still available in the Shape panel as "Filled sheet" and
"Traced outline"; neither is the default.

**Existing structures** are fetched by PDB ID (from RCSB) or UniProt accession
(from AlphaFold), or opened from a local file. Each helix and strand becomes a
block that keeps the structure's own coordinates — a helix from a crystal
structure is not an ideal helix, and the point of importing one is to build
against the real thing. Loops are left out and rebuilt as linkers, which is
what lets the imported pieces be pulled apart and still stay connected.
Secondary structure comes from the file's HELIX and SHEET records when it has
them, and is otherwise assigned from the virtual bond angles and dihedrals of
the Cα trace, since predicted models carry no records at all.

**Clashes** are marked in place, as red spheres at the midpoint of each
offending pair, sized by how deep the overlap runs. A count in a panel says
something is wrong; a marker says where.

**Sketches** are lifted in three steps: smooth and resample the stroke at the 3.8 Å
Cα spacing; fit torsions to that trace by beam search over the populated
Ramachandran basins; superimpose the result back onto the drawing. The fit uses
rotation- and translation-invariant descriptors (virtual Cα angles and dihedrals),
so nothing needs to be assumed about the stroke's absolute frame. The output is
always a chemically valid backbone, never an interpolated ribbon that looks like one.

**Validation** reports steric clashes, chain breaks, radius of gyration and
long-range contact count. Two Ca atoms closer than 4 A, more than two residues
apart in sequence, counts as a clash. That threshold is checked against real
structures rather than assumed: across four deposited structures, 937 non-local
Ca pairs fall within 6 A and only two of them are below 4 A, with the closest
anywhere at 3.6 A. So a design that trips it is genuinely too tight, and a real
structure almost never does. A design that fails is reported as not buildable rather
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
tools/          dev server, site build, and diagnostics:
                  diagnose-clashes.mjs  where an imported structure's clashes
                                        come from, split by element and loop
                  contact-stats.mjs     Ca-Ca distance distribution of real
                                        structures, used to set the threshold
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

- **Shape mode still leaves some loop clashes.** Element placement is good —
  across letters, element-on-element clashes are usually zero to three — but
  the loops that join the strokes have to cross the letter, and some of them
  pass through it. A short word often comes out clean; a dense letter like "H"
  arrives with on the order of fifteen overlaps, all of them involving a loop.
  They are marked in red so they are easy to find and fix by hand, and partial
  diffusion would rebuild those turns anyway. Treat the output as a scaffold to
  regularise rather than a finished backbone.
- **Fetching needs network access from the browser.** RCSB and AlphaFold both
  allow cross-origin requests, so the live site can reach them, but a page
  served inside a sandboxed frame cannot. The fetch path here is covered by
  tests against mocked responses; it has never been run against the real
  archives from this build environment.
- **Imported loops are rebuilt, not imported.** Only the helices and strands
  come in; the loops between them are regenerated so the pieces can be moved
  apart and stay connected. Each is rebuilt at the length the original used,
  which is usually enough to reproduce a clash-free chain: of four real
  structures tested, three import with no clashes at all. The exception is long
  loops in a crowded protein — a 566-residue structure with 35 elements and
  loops of up to 30 residues imports with about 50 clashes, nearly all of them
  loop-against-element, because there is no clear route through the interior.
  A clash inside an imported structure is therefore a loop that was rebuilt,
  not a flaw in the deposited coordinates; the import message says how many of
  each.
- **Imported structures are backbone only.** Side chains, ligands, waters and
  alternate conformations are dropped, and only the first model of an NMR
  ensemble is read.
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

## Which build am I looking at?

The header shows a build id, and `build.json` carries the same one. GitHub
Pages serves static files with a cache lifetime and gives no way to set
headers, so a browser will happily keep running a previous deploy — which from
the outside is indistinguishable from a fix that did not work. Every asset URL
is therefore stamped with the build id at deploy time, so a new deploy is a new
URL. If the id in the header does not match the latest commit, the page is
cached; everything else is a real bug.

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

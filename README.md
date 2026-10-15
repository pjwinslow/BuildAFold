# BuildAFold

### [→ Open the builder](https://pjwinslow.github.io/BuildAFold/)

I wanted an easy way to build protein shapes I had in my head, in a browser,
without installing anything. It started as a way to spell words out of helices
for fun, and grew into something that also spits out usable scaffolds.

Drag helices and strands around, draw a path with the mouse, or just type a
word. BuildAFold joins the pieces with real loops, tells you whether the result
is physically possible, and exports a backbone plus the conditioning files that
RFdiffusion and ProteinMPNN expect.

It doesn't run any models or design sequences — it makes the inputs for the
tools that do.

```
   blocks / sketch / word  ->  closed, checked backbone  ->  .pdb + ss/adj tensors
                                                                     |
                                                       RFdiffusion -> ProteinMPNN
```

## Try it

Use the [hosted copy](https://pjwinslow.github.io/BuildAFold/), or run it
locally — no install, no build step:

```bash
npm run serve        # → http://localhost:8173
```

## Controls

| | |
|---|---|
| **Blocks** panel | click a type to add it to the chain |
| **Move / Rotate** (`G` / `R`) | drag the gizmo on the selected block |
| **Sketch** (`D`) | drag in the viewport to draw a path |
| **Shape** panel | type a word, get a backbone shaped like it |
| **Fetch structure** panel | pull in a PDB entry or AlphaFold model as editable blocks |
| **Clashes** toggle | red markers wherever things overlap |
| **Pack** | snap the selection against the previous block at contact distance |
| **Undo** (`Ctrl/Cmd-Z`), **Reset** | a whole slider drag counts as one step |
| **Chain order** panel | drag to reorder, `×` to delete, set linker lengths or leave them `auto` |

The chain is rebuilt from scratch on every edit, so what's on screen is always
a real backbone and the export can't disagree with the picture.

## Exports

- **`design.pdb`** — backbone atoms as poly-glycine, with `HELIX`/`SHEET`
  records so it renders as a cartoon straight away.
- **`design.spec.json`** — length, secondary structure, contact graph, block
  placements, diagnostics, and the commands to run next.

Then:

```bash
python python/prepare_design_inputs.py design.spec.json --pdb design.pdb --out-dir rf_inputs
```

That writes `design_ss.pt` and `design_adj.pt` in RFdiffusion's fold-conditioning
encoding. Torch is only needed for `.pt`; otherwise you get `.npy` or JSON.

## How it works

Everything is built from one primitive — **NeRF** atom placement from internal
coordinates — so every chain has ideal bond geometry by construction rather
than by cleanup afterwards.

**Blocks** store their geometry in a canonical frame plus a placement, so
dragging one rewrites a position and a quaternion instead of re-deriving a
torsion chain. That's what makes it feel immediate.

**Linkers** are closed with Ramachandran-restrained cyclic coordinate descent,
scored against the surrounding structure — closure alone only guarantees the
two ends meet, and without the extra check the shortest path between two blocks
is often straight through a third.

**Shapes** come from a stroke font: each letter is stored as the few lines
you'd draw it with, and each stroke becomes one element. An "N" is three
strokes, so it's three helices. Elements are pulled back from their shared
corners to leave room for the connecting loop, which turns out to be the single
biggest factor in whether a letter comes out clash-free.

**Imported structures** keep their real coordinates — a helix from a crystal
structure isn't an ideal helix, and the point of importing one is to build
against the real thing. Loops are rebuilt at their original length so the
pieces can still be pulled apart.

**Validation** reports clashes, chain breaks, radius of gyration and contact
count. The 4 Å Cα clash threshold was checked against real structures rather
than guessed: across four deposited structures, 937 non-local Cα pairs fall
within 6 Å and only two are below 4 Å.

**Rendering** follows the Richardson cartoon convention — flat twisted ribbons
for helices, arrows for strands, thin tubes for loops.

### Layout

```
src/geometry/   pure geometry, no rendering dependency, fully unit tested
src/model/      the assembly document and realisation
src/io/         PDB read/write, design spec and command generation
src/ui/         three.js viewport, cartoon ribbons, app controller
python/         design spec -> model inputs
tools/          dev server, site build, diagnostics
```

## Tests

```bash
npm test         # 74 geometry and model tests
npm run test:ui  # 25 browser tests (Playwright)
```

## What it doesn't do

- **No energy function.** A chain that passes the checks is *possible*, not
  stable or designable. This is a sketchpad, not a design method.
- **Shape mode leaves some loop clashes.** Element placement is good, but the
  loops joining the strokes have to cross the letter and some pass through it.
  They're marked in red; partial diffusion would rebuild those turns anyway.
- **No β-sheet registry.** Strands can sit side by side but aren't snapped into
  a hydrogen-bonded register. Most valuable thing to add next.
- **Sketch depth isn't inferred.** Strokes land on the plane facing the camera;
  you supply depth by orbiting and redrawing.
- **Backbone only.** Side chains, ligands and waters are dropped on import, and
  only the first NMR model is read.
- **Needs network on first load** for three.js, and for fetching structures. If
  it can't connect, the page says so rather than showing an empty viewport.

## Similar things

Sketching a topology and handing it to a generative model isn't a new idea. If
you want the serious versions:

- [TopoBuilder](https://www.pnas.org/doi/10.1073/pnas.2206111119) — topology
  string in, idealised sketch out, then Rosetta. Closest in spirit.
- [CAD blueprint-guided diffusion](https://www.biorxiv.org/content/10.64898/2026.07.22.740177v1)
  — shape as a real design layer, with 31 of 59 designs validated
  experimentally. The proper version of the shape idea.
- [ProtPainter](https://arxiv.org/pdf/2504.14274) — draw a curve, a model
  infers the structure from it.
- [DiffTopo](https://www.biorxiv.org/content/10.1101/2024.02.01.578456.full.pdf)
  — generates coarse topologies to steer RFdiffusion.
- [ProtoShop](https://web.cs.ucdavis.edu/~okreylos/ResDev/ProtoShop/MainPage.html)
  — did the drag-the-helices-around thing years ago, as a desktop app.

This one is mostly trying to be quick and fun to use in a browser.

## Notes

The header shows a build id. Every asset URL is stamped with it at deploy time,
so if the id matches the latest commit you're definitely not on a cached copy.

`.github/workflows/pages.yml` runs the tests and publishes to GitHub Pages on
every push to the default branch.

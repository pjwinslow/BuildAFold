#!/usr/bin/env python3
"""Turn a BuildAFold design spec into fold-conditioning inputs.

A BuildAFold assembly knows its own secondary structure exactly -- the user
placed every element -- so the conditioning tensors are written straight from
the spec instead of being recovered from coordinates by DSSP.

The encoding follows RFdiffusion's ``make_secstruc_adj.py``:

* ``<stem>_ss.pt``   shape ``(L,)``   float32, 0 = helix, 1 = strand, 2 = loop
* ``<stem>_adj.pt``  shape ``(L, L)`` float32, 1 where two *segments* are in
  contact. Contacts are assigned between whole helix/strand segments, loops are
  excluded, and within-segment entries are left at 0.

Torch is only needed to write ``.pt`` files. Without it the same arrays are
written as ``.npy`` (numpy) or ``.json``, so the spec can still be inspected
and converted on a machine that has the full stack.

Nothing here runs a model: it prepares inputs. The generative steps need GPUs,
weights and their own environments.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

SS_NAMES = {0: "helix", 1: "strand", 2: "loop"}


def load_spec(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        spec = json.load(handle)

    if spec.get("format") != "buildafold.designspec":
        raise SystemExit(f"{path} is not a BuildAFold design spec")

    length = spec["length"]
    if len(spec["ssIndex"]) != length:
        raise SystemExit(
            f"spec is inconsistent: length is {length} but ssIndex has "
            f"{len(spec['ssIndex'])} entries"
        )

    covered = sum(run["length"] for run in spec["runs"])
    if covered != length:
        raise SystemExit(
            f"spec is inconsistent: runs cover {covered} of {length} residues"
        )
    return spec


def build_ss(spec: dict) -> list[float]:
    return [float(value) for value in spec["ssIndex"]]


def build_adjacency(spec: dict) -> list[list[float]]:
    """Expand segment-level contacts into the dense residue matrix."""
    length = spec["length"]
    runs = spec["runs"]
    adjacency = [[0.0] * length for _ in range(length)]

    for a, b in spec["segmentAdjacency"]:
        first, second = runs[a], runs[b]
        for i in range(first["start"], first["end"] + 1):
            for j in range(second["start"], second["end"] + 1):
                adjacency[i][j] = 1.0
                adjacency[j][i] = 1.0
    return adjacency


def contacts_from_pdb(pdb_path: Path, spec: dict, cutoff: float) -> list[tuple[int, int]]:
    """Recompute segment contacts from coordinates, as an independent check.

    Reads N, CA and C, rebuilds the virtual C-beta with the same construction
    the builder uses, and reports which helix/strand segments touch. If this
    disagrees with the spec, the spec and the structure have drifted apart.
    """
    backbone: dict[int, dict[str, tuple[float, float, float]]] = {}

    with pdb_path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.startswith("ATOM"):
                continue
            name = line[12:16].strip()
            if name not in ("N", "CA", "C"):
                continue
            resseq = int(line[22:26])
            xyz = (float(line[30:38]), float(line[38:46]), float(line[46:54]))
            backbone.setdefault(resseq, {})[name] = xyz

    ordered = [backbone[key] for key in sorted(backbone) if {"N", "CA", "C"} <= backbone[key].keys()]
    if len(ordered) != spec["length"]:
        print(
            f"  warning: {pdb_path.name} has {len(ordered)} residues but the spec "
            f"declares {spec['length']}",
            file=sys.stderr,
        )

    cbetas = [virtual_cbeta(r["N"], r["CA"], r["C"]) for r in ordered]
    structured = [run for run in spec["runs"] if run["code"] in ("H", "E")]

    found: list[tuple[int, int]] = []
    for i, first in enumerate(structured):
        for second in structured[i + 1 :]:
            if segments_touch(cbetas, first, second, cutoff):
                found.append((first["index"], second["index"]))
    return found


def virtual_cbeta(n, ca, c):
    """Ideal C-beta from the backbone frame (the AlphaFold/ProteinMPNN form)."""
    b = [ca[i] - n[i] for i in range(3)]
    d = [c[i] - ca[i] for i in range(3)]
    a = [
        b[1] * d[2] - b[2] * d[1],
        b[2] * d[0] - b[0] * d[2],
        b[0] * d[1] - b[1] * d[0],
    ]
    return tuple(
        -0.58273431 * a[i] + 0.56802827 * b[i] - 0.54067466 * d[i] + ca[i] for i in range(3)
    )


def segments_touch(points, first, second, cutoff) -> bool:
    limit = cutoff * cutoff
    for i in range(first["start"], min(first["end"] + 1, len(points))):
        for j in range(second["start"], min(second["end"] + 1, len(points))):
            p, q = points[i], points[j]
            if (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2 < limit:
                return True
    return False


def write_tensors(out_dir: Path, stem: str, ss, adjacency, fmt: str) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)

    if fmt in ("auto", "torch"):
        try:
            import torch
        except ImportError:
            if fmt == "torch":
                raise SystemExit("torch was requested but is not installed")
        else:
            paths = [out_dir / f"{stem}_ss.pt", out_dir / f"{stem}_adj.pt"]
            torch.save(torch.tensor(ss, dtype=torch.float32), paths[0])
            torch.save(torch.tensor(adjacency, dtype=torch.float32), paths[1])
            return paths

    if fmt in ("auto", "numpy"):
        try:
            import numpy
        except ImportError:
            if fmt == "numpy":
                raise SystemExit("numpy was requested but is not installed")
        else:
            paths = [out_dir / f"{stem}_ss.npy", out_dir / f"{stem}_adj.npy"]
            numpy.save(paths[0], numpy.asarray(ss, dtype="float32"))
            numpy.save(paths[1], numpy.asarray(adjacency, dtype="float32"))
            print(
                "  note: wrote .npy because torch is not available. Convert with\n"
                "        torch.save(torch.from_numpy(numpy.load(path)), path[:-4] + '.pt')",
                file=sys.stderr,
            )
            return paths

    paths = [out_dir / f"{stem}_ss.json", out_dir / f"{stem}_adj.json"]
    paths[0].write_text(json.dumps(ss), encoding="utf-8")
    paths[1].write_text(json.dumps(adjacency), encoding="utf-8")
    print(
        "  note: neither torch nor numpy is available, so plain JSON was written.",
        file=sys.stderr,
    )
    return paths


def summarise(spec: dict) -> str:
    topology = "-".join(
        f"{run['code']}{run['length']}" for run in spec["runs"] if run["code"] != "L"
    )
    counts: dict[str, int] = {}
    for value in spec["ssIndex"]:
        counts[SS_NAMES[value]] = counts.get(SS_NAMES[value], 0) + 1
    breakdown = ", ".join(f"{count} {name}" for name, count in sorted(counts.items()))
    return f"{spec['length']} residues ({breakdown}); topology {topology or 'none'}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("spec", type=Path, help="design spec exported by BuildAFold")
    parser.add_argument("--pdb", type=Path, help="matching backbone, used to verify the spec")
    parser.add_argument("--out-dir", type=Path, default=Path("rf_inputs"))
    parser.add_argument("--stem", help="output basename (defaults to the spec's filename)")
    parser.add_argument(
        "--format",
        choices=("auto", "torch", "numpy", "json"),
        default="auto",
        help="auto prefers torch, then numpy, then json",
    )
    args = parser.parse_args()

    spec = load_spec(args.spec)
    stem = args.stem or args.spec.name.split(".")[0]

    print(f"BuildAFold design {spec['name']!r}")
    print(f"  {summarise(spec)}")

    diagnostics = spec.get("diagnostics", {})
    if not diagnostics.get("ok", True):
        print("  warning: this design did not pass its geometry checks:", file=sys.stderr)
        for warning in diagnostics.get("warnings", []):
            print(f"    - {warning}", file=sys.stderr)
        print(
            "  generating from a backbone with clashes or chain breaks is unlikely\n"
            "  to give anything useful; fix it in the builder first.",
            file=sys.stderr,
        )

    if args.pdb:
        declared = {tuple(sorted(pair)) for pair in spec["segmentAdjacency"]}
        measured = {tuple(sorted(pair)) for pair in contacts_from_pdb(
            args.pdb, spec, spec.get("adjacencyCutoff", 6.0)
        )}
        if declared == measured:
            print(f"  adjacency verified against {args.pdb.name}: {len(declared)} segment contacts")
        else:
            print(
                f"  warning: adjacency in the spec {sorted(declared)} does not match the "
                f"structure {sorted(measured)}; the files may be from different versions",
                file=sys.stderr,
            )

    ss = build_ss(spec)
    adjacency = build_adjacency(spec)
    written = write_tensors(args.out_dir, stem, ss, adjacency, args.format)

    print(f"  wrote {written[0]}  shape ({len(ss)},)")
    print(f"  wrote {written[1]}  shape ({len(ss)}, {len(ss)})")

    commands = spec.get("commands", {})
    if commands:
        print("\nNext, in an environment that has the models:\n")
        for name in ("rfdiffusionFoldConditioned", "proteinmpnn"):
            if name in commands:
                print(f"# {name}")
                print(commands[name])
                print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

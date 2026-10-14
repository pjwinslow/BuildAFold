import test from 'node:test';
import assert from 'node:assert/strict';

import {
  labelComponents,
  rowRuns,
  fillPath,
  outlinePath,
  splitOnJumps,
  shapeToPaths,
  shapeRows,
  maskBounds,
  orderRuns,
} from '../src/geometry/shape.js';

/** Build a mask from an ASCII picture; '#' is inside. */
function maskFrom(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const mask = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      mask[y * width + x] = cell === '#' ? 1 : 0;
    });
  });
  return { mask, width, height };
}

const SQUARE = maskFrom([
  '........',
  '.######.',
  '.######.',
  '.######.',
  '.######.',
  '........',
]);

const TWO_BLOBS = maskFrom([
  '..........',
  '.##....##.',
  '.##....##.',
  '..........',
]);

test('connected components separate disjoint pieces', () => {
  const single = labelComponents(SQUARE.mask, SQUARE.width, SQUARE.height);
  assert.equal(single.count, 1);

  const pair = labelComponents(TWO_BLOBS.mask, TWO_BLOBS.width, TWO_BLOBS.height);
  assert.equal(pair.count, 2, 'the two letters of "ii" must not be joined');
});

test('rowRuns finds the spans of a row', () => {
  assert.deepEqual(rowRuns(SQUARE.mask, SQUARE.width, 0), []);
  assert.deepEqual(rowRuns(SQUARE.mask, SQUARE.width, 1), [[1, 6]]);
  assert.deepEqual(rowRuns(TWO_BLOBS.mask, TWO_BLOBS.width, 1), [
    [1, 2],
    [7, 8],
  ]);
});

test('fill sweeps alternate direction so rows join end to end', () => {
  const path = fillPath(SQUARE.mask, SQUARE.width, SQUARE.height, {
    rowStep: 1,
    pointStep: 1,
  });
  assert.ok(path.length > 0);

  // Every point must be inside the shape.
  for (const [x, y] of path) {
    assert.equal(SQUARE.mask[Math.round(y) * SQUARE.width + Math.round(x)], 1);
  }

  // Row 1 runs left to right, row 2 right to left.
  const firstRow = path.filter(([, y]) => y === 1);
  const secondRow = path.filter(([, y]) => y === 2);
  assert.ok(firstRow[0][0] < firstRow[firstRow.length - 1][0]);
  assert.ok(secondRow[0][0] > secondRow[secondRow.length - 1][0]);

  // The serpentine never jumps: consecutive points stay close.
  for (let i = 1; i < path.length; i += 1) {
    const step = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    assert.ok(step <= 2.5, `jump of ${step.toFixed(2)} between fill points`);
  }
});

test('outline traces the boundary and returns to its start', () => {
  const contour = outlinePath(SQUARE.mask, SQUARE.width, SQUARE.height, { pointStep: 1 });
  assert.ok(contour.length >= 8, `expected a boundary loop, got ${contour.length} points`);

  for (const [x, y] of contour) {
    assert.equal(SQUARE.mask[y * SQUARE.width + x], 1);
  }

  // It is a loop: the last point is adjacent to the first.
  const [fx, fy] = contour[0];
  const [lx, ly] = contour[contour.length - 1];
  assert.ok(Math.hypot(lx - fx, ly - fy) <= 2);

  // Boundary only: the interior pixel (3,2) is never visited.
  assert.ok(!contour.some(([x, y]) => x === 3 && y === 2));
});

test('splitOnJumps breaks a walk where it would have to leap', () => {
  const points = [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [40, 0], // jump
    [41, 0],
    [42, 0],
    [43, 0],
  ];
  const pieces = splitOnJumps(points, 5, 4);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].length, 4);
  assert.equal(pieces[1].length, 4);
});

test('splitOnJumps drops fragments too short to build', () => {
  const pieces = splitOnJumps([[0, 0], [1, 0], [50, 0]], 5, 4);
  assert.equal(pieces.length, 0);
});

test('shapeToPaths gives one path per piece, in angstrom', () => {
  const paths = shapeToPaths(TWO_BLOBS.mask, TWO_BLOBS.width, TWO_BLOBS.height, {
    style: 'outline',
    scale: 3.8,
    pointSpacing: 3.8,
    minResidues: 3,
  });

  assert.equal(paths.length, 2, 'two separate blobs give two chain pieces');
  // Scaled out of pixel space.
  assert.ok(paths[0].every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  assert.ok(Math.max(...paths[0].map(([x]) => x)) > 3, 'coordinates should be in angstrom');

  // Reading order: the left blob comes first.
  assert.ok(paths[0][0][0] < paths[1][0][0]);
});

test('an empty mask yields no paths rather than throwing', () => {
  const empty = new Uint8Array(40);
  assert.deepEqual(shapeToPaths(empty, 8, 5, {}), []);
});

test('shapeRows gives alternating runs long enough to build as strands', () => {
  const rows = shapeRows(SQUARE.mask, SQUARE.width, SQUARE.height, { rowStep: 1, minRun: 2 });
  assert.equal(rows.length, 4, 'four filled rows in the square');

  // Alternating: the first runs left to right, the second right to left.
  assert.ok(rows[0].from < rows[0].to);
  assert.ok(rows[1].from > rows[1].to);

  // Each run ends near where the next begins, so the turn between them is short.
  for (let i = 1; i < rows.length; i += 1) {
    const gap = Math.abs(rows[i].from - rows[i - 1].to);
    assert.ok(gap <= 1, `turn between rows spans ${gap} px`);
  }
});

test('shapeRows splits a row that crosses two separate limbs', () => {
  // Like the legs of an "A": one row, two runs.
  const legs = maskFrom([
    '..........',
    '.##....##.',
    '.##....##.',
  ]);
  const rows = shapeRows(legs.mask, legs.width, legs.height, { rowStep: 1, minRun: 1 });
  assert.equal(rows.length, 4, 'two rows x two limbs');
});

test('shapeRows drops runs too short to be an element', () => {
  const speck = maskFrom(['.#...', '.###.']);
  const rows = shapeRows(speck.mask, speck.width, speck.height, { rowStep: 1, minRun: 2 });
  assert.equal(rows.length, 1, 'the single-pixel row is not buildable');
});

test('maskBounds finds the ink, not the canvas', () => {
  const bounds = maskBounds(SQUARE.mask, SQUARE.width, SQUARE.height);
  assert.deepEqual(bounds, { minX: 1, maxX: 6, minY: 1, maxY: 4 });
  assert.equal(maskBounds(new Uint8Array(20), 5, 4), null);
});

test('orderRuns walks limbs instead of crossing between them', () => {
  // Two legs, three rows each: a strict row order would alternate left/right.
  const runs = [
    { from: 0, to: 3, y: 0 },
    { from: 20, to: 23, y: 0 },
    { from: 0, to: 3, y: 1 },
    { from: 20, to: 23, y: 1 },
    { from: 0, to: 3, y: 2 },
    { from: 20, to: 23, y: 2 },
  ];

  const ordered = orderRuns(runs, 4);

  // Total travel between consecutive runs must beat the naive row order.
  const travel = (list) => {
    let sum = 0;
    for (let i = 1; i < list.length; i += 1) {
      sum += Math.hypot(list[i].from - list[i - 1].to, (list[i].y - list[i - 1].y) * 4);
    }
    return sum;
  };
  assert.ok(
    travel(ordered) < travel(runs) / 2,
    `ordered travel ${travel(ordered).toFixed(1)} should be far below ${travel(runs).toFixed(1)}`,
  );

  // Every run is still present exactly once.
  assert.equal(ordered.length, runs.length);
  const key = (r) => `${Math.min(r.from, r.to)}:${r.y}`;
  assert.deepEqual(new Set(ordered.map(key)).size, 6);

  // One leg is finished before the other is started.
  const sides = ordered.map((r) => (Math.min(r.from, r.to) < 10 ? 'L' : 'R'));
  const switches = sides.filter((s, i) => i > 0 && s !== sides[i - 1]).length;
  assert.equal(switches, 1, `crossed between legs ${switches} times`);
});

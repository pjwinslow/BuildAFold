/**
 * Turning an arbitrary 2D shape into chain paths.
 *
 * Given a binary mask — a letter, a logo, anything — this produces ordered
 * point paths that cover it, which the existing sketch lifter then fits to real
 * backbone torsions. Nothing here knows about fonts, canvases or proteins; it
 * works on a mask and returns polylines, which is what makes it testable.
 *
 * Two ways to cover a shape:
 *
 *  - **fill** walks back and forth across it, row by row. The rows read as
 *    extended runs and the turns as tight loops, so the result is compact and
 *    broadly protein-like, in the manner of a beta-meander.
 *  - **outline** follows the boundary. Thinner and less protein-like, but the
 *    silhouette survives much better at small sizes.
 *
 * Neither can promise one continuous path: a letter like "i" is two pieces, and
 * a row across "A" crosses two legs. Rather than fake a connection, paths are
 * split wherever the walk would have to jump, and the caller joins the pieces
 * with ordinary linkers.
 */

/** Label 8-connected components. Returns `{labels, count}`; 0 means outside. */
export function labelComponents(mask, width, height) {
  const labels = new Int32Array(width * height);
  let count = 0;
  const queue = [];

  for (let start = 0; start < labels.length; start += 1) {
    if (!mask[start] || labels[start]) continue;
    count += 1;
    labels[start] = count;
    queue.length = 0;
    queue.push(start);

    while (queue.length) {
      const index = queue.pop();
      const x = index % width;
      const y = (index - x) / width;

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbour = ny * width + nx;
          if (mask[neighbour] && !labels[neighbour]) {
            labels[neighbour] = count;
            queue.push(neighbour);
          }
        }
      }
    }
  }

  return { labels, count };
}

/** Horizontal runs of set pixels in one row, optionally restricted to a label. */
export function rowRuns(mask, width, y, { labels = null, label = 0 } = {}) {
  const runs = [];
  let start = -1;

  for (let x = 0; x <= width; x += 1) {
    const index = y * width + x;
    const inside =
      x < width && mask[index] && (!labels || labels[index] === label);

    if (inside && start < 0) start = x;
    if (!inside && start >= 0) {
      runs.push([start, x - 1]);
      start = -1;
    }
  }
  return runs;
}

/** Bounding box of a labelled component. */
function boundsOf(labels, width, height, label) {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (labels[y * width + x] !== label) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Boustrophedon fill: sweep rows, alternating direction, emitting points along
 * each run of the shape.
 *
 * @returns {number[][]} points in mask pixel coordinates, in visiting order
 */
export function fillPath(mask, width, height, options = {}) {
  const { rowStep = 5, pointStep = 4, labels = null, label = 0 } = options;

  const bounds = labels
    ? boundsOf(labels, width, height, label)
    : { minX: 0, maxX: width - 1, minY: 0, maxY: height - 1 };
  if (bounds.maxY < bounds.minY) return [];

  const path = [];
  // Counts rows that actually contain the shape. Empty rows must not flip the
  // sweep direction, or a gap in the middle of a shape reverses everything
  // after it and turns the walk into a series of jumps.
  let rowIndex = 0;

  for (let y = bounds.minY; y <= bounds.maxY; y += rowStep) {
    const runs = rowRuns(mask, width, y, { labels, label });
    if (!runs.length) continue;

    const leftToRight = rowIndex % 2 === 0;
    rowIndex += 1;

    // Alternate direction each row so consecutive rows join at their near ends.
    const ordered = leftToRight ? runs : [...runs].reverse();

    for (const [from, to] of ordered) {
      const first = leftToRight ? from : to;
      const last = leftToRight ? to : from;
      const span = Math.abs(last - first);
      const steps = Math.max(1, Math.round(span / pointStep));

      for (let s = 0; s <= steps; s += 1) {
        const t = steps === 0 ? 0 : s / steps;
        path.push([first + (last - first) * t, y]);
      }
    }
  }

  return path;
}

const MOORE = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/**
 * Moore boundary trace of one component, walking its outer contour once.
 *
 * @returns {number[][]} boundary points in mask pixel coordinates
 */
export function outlinePath(mask, width, height, options = {}) {
  const { labels = null, label = 0, pointStep = 3 } = options;
  const inside = (x, y) =>
    x >= 0 &&
    y >= 0 &&
    x < width &&
    y < height &&
    mask[y * width + x] &&
    (!labels || labels[y * width + x] === label);

  // Start at the first set pixel in raster order; it is on the boundary.
  let startX = -1;
  let startY = -1;
  for (let y = 0; y < height && startY < 0; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (inside(x, y)) {
        startX = x;
        startY = y;
        break;
      }
    }
  }
  if (startY < 0) return [];

  const contour = [[startX, startY]];
  let x = startX;
  let y = startY;
  let direction = 0;
  const limit = width * height * 4;

  for (let guard = 0; guard < limit; guard += 1) {
    let moved = false;
    // Scan neighbours starting just behind the direction we arrived from.
    for (let turn = 0; turn < MOORE.length; turn += 1) {
      const d = (direction + 6 + turn) % MOORE.length;
      const nx = x + MOORE[d][0];
      const ny = y + MOORE[d][1];
      if (!inside(nx, ny)) continue;
      x = nx;
      y = ny;
      direction = d;
      contour.push([x, y]);
      moved = true;
      break;
    }
    if (!moved) break;
    if (x === startX && y === startY) break;
  }

  // Thin the contour to roughly one point per `pointStep` pixels.
  const thinned = [];
  let last = null;
  for (const point of contour) {
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) >= pointStep) {
      thinned.push(point);
      last = point;
    }
  }
  return thinned;
}

/**
 * Split a visiting order wherever it would have to jump, so each piece is a
 * path something can actually be built along.
 *
 * @param {number[][]} points
 * @param {number} maxStep largest gap treated as continuous
 * @param {number} minLength drop fragments shorter than this
 */
export function splitOnJumps(points, maxStep, minLength = 4) {
  const pieces = [];
  let current = [];

  for (const point of points) {
    const previous = current[current.length - 1];
    if (previous && Math.hypot(point[0] - previous[0], point[1] - previous[1]) > maxStep) {
      if (current.length >= minLength) pieces.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length >= minLength) pieces.push(current);

  return pieces;
}

/**
 * Cover a shape with chain paths.
 *
 * @param {Uint8Array|number[]} mask row-major, non-zero means inside
 * @param {number} width
 * @param {number} height
 * @param {object} options
 * @param {'fill'|'outline'} [options.style='fill']
 * @param {number} [options.scale=1] angstrom per mask pixel
 * @param {number} [options.rowSpacing=5] angstrom between fill rows
 * @param {number} [options.pointSpacing=3.8] angstrom between points
 * @returns {number[][][]} paths, each a list of `[x, y]` in angstrom
 */
export function shapeToPaths(mask, width, height, options = {}) {
  const {
    style = 'fill',
    scale = 1,
    rowSpacing = 5,
    pointSpacing = 3.8,
    minResidues = 6,
  } = options;

  const rowStep = Math.max(1, Math.round(rowSpacing / scale));
  const pointStep = Math.max(1, Math.round(pointSpacing / scale));
  const { labels, count } = labelComponents(mask, width, height);

  const paths = [];
  for (let label = 1; label <= count; label += 1) {
    const pixels =
      style === 'outline'
        ? outlinePath(mask, width, height, { labels, label, pointStep })
        : fillPath(mask, width, height, { labels, label, rowStep, pointStep });

    // A jump of more than two rows is a genuine discontinuity, not a turn.
    const maxStep = Math.max(rowStep, pointStep) * 2.5;
    for (const piece of splitOnJumps(pixels, maxStep, minResidues)) {
      paths.push(
        piece.map(([x, y]) => [x * scale, y * scale]),
      );
    }
  }

  // Left to right, then top to bottom: the order the shape is read in.
  paths.sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1]);
  return paths;
}

/**
 * Decompose a shape into horizontal runs suitable for building as strands.
 *
 * This is the structural alternative to tracing a path through the shape. A
 * plane-filling curve is close to unrealisable in backbone torsion space — the
 * chain cannot stay flat, and the fitter correctly refuses to follow it — so
 * rather than force it, each row becomes a straight extended element and the
 * turns between rows become ordinary linkers. A filled shape then comes out as
 * a beta sheet, which is both protein-like and far truer to the outline.
 *
 * Runs alternate direction row by row, so each one ends where the next begins
 * and the connecting turn is short.
 *
 * @returns {Array<{from: number, to: number, y: number, row: number}>}
 *          in mask pixel coordinates, `from`/`to` ordered along the run
 */
export function shapeRows(mask, width, height, options = {}) {
  const { rowStep = 5, labels = null, label = 0, minRun = 2 } = options;

  const bounds = labels
    ? boundsOf(labels, width, height, label)
    : { minX: 0, maxX: width - 1, minY: 0, maxY: height - 1 };
  if (bounds.maxY < bounds.minY) return [];

  const rows = [];
  let rowIndex = 0;

  for (let y = bounds.minY; y <= bounds.maxY; y += rowStep) {
    const runs = rowRuns(mask, width, y, { labels, label }).filter(
      ([from, to]) => to - from >= minRun,
    );
    if (!runs.length) continue;

    const leftToRight = rowIndex % 2 === 0;
    rowIndex += 1;

    for (const [from, to] of leftToRight ? runs : [...runs].reverse()) {
      rows.push({
        from: leftToRight ? from : to,
        to: leftToRight ? to : from,
        y,
        row: rowIndex - 1,
      });
    }
  }

  return rows;
}

/** Bounding box of every set pixel, used to scale a shape to a real size. */
export function maskBounds(mask, width, height) {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < minX ? null : { minX, maxX, minY, maxY };
}

/**
 * Order runs so the chain walks the shape instead of ping-ponging across it.
 *
 * Taking rows strictly in order looks right on a solid shape but falls apart on
 * anything with limbs: on an "A", consecutive rows alternate between the two
 * legs, so the chain crosses the whole letter between every pair of strands and
 * the connecting loops end up longer than the strands themselves.
 *
 * A greedy nearest-neighbour walk fixes it — down one leg, across, up the other
 * — and directly minimises the thing that was going wrong, which is total
 * linker length.
 *
 * @param {Array<{from: number, to: number, y: number}>} runs
 * @param {number} [rowAspect] weight on vertical distance, in run-units per row
 * @returns {Array} the same runs, reordered and reoriented
 */
export function orderRuns(runs, rowAspect = 1) {
  if (runs.length < 2) return [...runs];

  const remaining = runs.map((run) => ({ ...run }));
  const distance = (x1, y1, x2, y2) => Math.hypot(x2 - x1, (y2 - y1) * rowAspect);

  // Start at the topmost run, leftmost to break ties.
  let startIndex = 0;
  for (let i = 1; i < remaining.length; i += 1) {
    const a = remaining[i];
    const b = remaining[startIndex];
    if (a.y < b.y || (a.y === b.y && Math.min(a.from, a.to) < Math.min(b.from, b.to))) {
      startIndex = i;
    }
  }

  const ordered = [remaining.splice(startIndex, 1)[0]];
  let [cursorX, cursorY] = [ordered[0].to, ordered[0].y];

  while (remaining.length) {
    let best = 0;
    let bestCost = Infinity;
    let flip = false;

    remaining.forEach((run, index) => {
      const atFrom = distance(cursorX, cursorY, run.from, run.y);
      const atTo = distance(cursorX, cursorY, run.to, run.y);
      const cost = Math.min(atFrom, atTo);
      if (cost < bestCost) {
        bestCost = cost;
        best = index;
        flip = atTo < atFrom; // enter from whichever end is nearer
      }
    });

    const run = remaining.splice(best, 1)[0];
    if (flip) {
      const { from, to } = run;
      run.from = to;
      run.to = from;
    }
    ordered.push(run);
    cursorX = run.to;
    cursorY = run.y;
  }

  return ordered;
}

/**
 * Greedy nearest-neighbour ordering for arbitrary 2D segments.
 *
 * The same idea as `orderRuns`, but for strokes rather than rows: visit
 * whichever segment starts nearest to where the last one finished, flipping it
 * if its far end is closer. On a letter this keeps the connecting loops short —
 * the crossbar of an "A" is picked up from whichever leg ends beside it.
 *
 * @param {Array<{a: number[], b: number[]}>} segments
 * @returns {Array} the same segments, reordered and reoriented
 */
export function orderSegments(segments) {
  if (segments.length < 2) return segments.map((s) => ({ ...s }));

  const copy = (s) => ({ ...s, a: [...s.a], b: [...s.b] });
  const gap = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);

  const travel = (list) => {
    let sum = 0;
    for (let i = 1; i < list.length; i += 1) sum += gap(list[i - 1].b, list[i].a);
    return sum;
  };

  /** One greedy walk from a chosen first segment and orientation. */
  const walkFrom = (startIndex, flipStart) => {
    const remaining = segments.map(copy);
    const first = remaining.splice(startIndex, 1)[0];
    if (flipStart) [first.a, first.b] = [first.b, first.a];

    const ordered = [first];
    let cursor = first.b;

    while (remaining.length) {
      let best = 0;
      let bestCost = Infinity;
      let flip = false;

      remaining.forEach((segment, index) => {
        const atA = gap(cursor, segment.a);
        const atB = gap(cursor, segment.b);
        const cost = Math.min(atA, atB);
        if (cost < bestCost) {
          bestCost = cost;
          best = index;
          flip = atB < atA;
        }
      });

      const segment = remaining.splice(best, 1)[0];
      if (flip) [segment.a, segment.b] = [segment.b, segment.a];
      ordered.push(segment);
      cursor = segment.b;
    }
    return ordered;
  };

  // Greedy is sensitive to where it starts: forcing a particular first stroke
  // can throw away a free join, such as the shared apex of an "A". Try every
  // starting segment in both directions and keep the shortest walk.
  let best = segments.map(copy);
  let bestTravel = travel(best);

  const starts = Math.min(segments.length, 60); // keep this cheap on long words
  for (let index = 0; index < starts; index += 1) {
    for (const flip of [false, true]) {
      const candidate = walkFrom(index, flip);
      const cost = travel(candidate);
      if (cost < bestTravel) {
        bestTravel = cost;
        best = candidate;
      }
    }
  }

  // Never return a worse order than the one handed in.
  return best;
}

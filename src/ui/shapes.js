/**
 * Shape mode: type something, get a backbone shaped like it.
 *
 * Text is rasterised with the canvas 2D API, thresholded into a binary mask,
 * and handed to the shape coverer. Everything downstream is the machinery the
 * sketch tool already uses, so what comes out is a real torsion-space backbone
 * rather than a wire bent into the shape of a letter.
 *
 * Disconnected pieces — the letters of a word, the dot of an "i" — become
 * separate blocks joined by ordinary linkers, because one chain cannot jump.
 */

import {
  shapeToPaths,
  shapeRows,
  maskBounds,
  labelComponents,
  orderRuns,
} from '../geometry/shape.js';

const FONT_STACK = '"Helvetica Neue", Helvetica, Arial, sans-serif';

/**
 * Rasterise text into a binary mask.
 *
 * @returns {{mask: Uint8Array, width: number, height: number}}
 */
export function textMask(text, { pixelHeight = 180, weight = 'bold' } = {}) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });

  const font = `${weight} ${pixelHeight}px ${FONT_STACK}`;
  context.font = font;
  const metrics = context.measureText(text);

  const padding = Math.round(pixelHeight * 0.15);
  canvas.width = Math.max(1, Math.ceil(metrics.width) + padding * 2);
  canvas.height = Math.ceil(pixelHeight * 1.4) + padding * 2;

  // Resizing a canvas resets its context, so the font has to be set again.
  context.font = font;
  context.textBaseline = 'middle';
  context.fillStyle = '#fff';
  context.fillText(text, padding, canvas.height / 2);

  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const mask = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = data[i * 4 + 3] > 128 ? 1 : 0;
  }

  return { mask, width: canvas.width, height: canvas.height };
}

/**
 * Cover a shape with Cα paths in angstrom, laid out in the xy-plane.
 *
 * @param {{mask: Uint8Array, width: number, height: number}} raster
 * @param {object} options
 * @param {number} options.heightAngstroms how tall the finished shape should be
 * @returns {number[][][]} paths of `[x, y, z]` points
 */
export function rasterToPaths(raster, options = {}) {
  const {
    heightAngstroms = 70,
    style = 'fill',
    rowSpacing = 5,
    pointSpacing = 3.8,
  } = options;

  const scale = heightAngstroms / raster.height;
  const paths = shapeToPaths(raster.mask, raster.width, raster.height, {
    style,
    scale,
    rowSpacing,
    pointSpacing,
  });

  // Centre the whole shape on the origin, and flip y: canvas y grows downward.
  const all = paths.flat();
  if (!all.length) return [];
  const xs = all.map(([x]) => x);
  const ys = all.map(([, y]) => y);
  const centreX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centreY = (Math.min(...ys) + Math.max(...ys)) / 2;

  return paths.map((path) => path.map(([x, y]) => [x - centreX, centreY - y, 0]));
}

/** Convenience: text straight to paths. */
export function textToPaths(text, options = {}) {
  return rasterToPaths(textMask(text, options), options);
}

/**
 * Decompose a shape into strand blocks: one per horizontal run, alternating
 * direction so the turns between them are short.
 *
 * Rows sit at beta-sheet spacing, so a filled shape is built as a sheet rather
 * than as a curve threaded through the outline. That is both more protein-like
 * and much closer to the shape, because a straight element can lie exactly
 * along a row whereas a fitted curve cannot stay flat at all.
 *
 * @returns {Array<{nResidues: number, position: number[], direction: number[]}>}
 */
export function textToStrandBlocks(text, options = {}) {
  const {
    heightAngstroms = 70,
    rowSpacingAngstroms = 4.8,
    risePerResidue = 3.3,
    // Four is the shortest run worth a strand of its own. Below that the
    // fragment contributes little to the silhouette but still costs two turns,
    // and the turns are what crowd and clash.
    minResidues = 4,
  } = options;

  const raster = textMask(text, options);
  const bounds = maskBounds(raster.mask, raster.width, raster.height);
  if (!bounds) return [];

  // Scale from the ink itself, so the letters come out the requested height.
  const scale = heightAngstroms / Math.max(1, bounds.maxY - bounds.minY);
  const rowStep = Math.max(1, Math.round(rowSpacingAngstroms / scale));

  const { labels, count } = labelComponents(raster.mask, raster.width, raster.height);
  const centreX = ((bounds.minX + bounds.maxX) / 2) * scale;
  const centreY = ((bounds.minY + bounds.maxY) / 2) * scale;

  const blocks = [];
  for (let label = 1; label <= count; label += 1) {
    const rows = shapeRows(raster.mask, raster.width, raster.height, {
      rowStep,
      labels,
      label,
      minRun: Math.ceil(minResidues * risePerResidue / scale),
    });

    // Walk the shape's limbs rather than its rows, so the turns stay short.
    // Row positions are already in pixels, the same units as the run ends, so
    // vertical and horizontal distance compare directly.
    for (const run of orderRuns(rows)) {
      const fromX = run.from * scale;
      const toX = run.to * scale;
      const span = Math.abs(toX - fromX);
      const nResidues = Math.max(minResidues, Math.round(span / risePerResidue) + 1);

      blocks.push({
        nResidues,
        // Canvas y grows downward; the scene's does not.
        position: [(fromX + toX) / 2 - centreX, centreY - run.y * scale, 0],
        direction: [Math.sign(toX - fromX) || 1, 0, 0],
      });
    }
  }

  return blocks;
}

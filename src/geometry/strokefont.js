/**
 * A stroke font: each character as the few lines you would draw it with.
 *
 * Rasterising a letter and covering it row by row produces dozens of elements
 * and a letter-shaped sheet. But a letter is not a filled region — it is a
 * handful of strokes, and that is the decomposition that matches how a protein
 * is built. An "N" is three strokes, so it should be three helices.
 *
 * Coordinates are in a unit box: x from 0 to 1 across the character, y from 0
 * at the baseline to 1 at cap height. A stroke is a polyline; each of its
 * segments becomes one structural element.
 */

/** @type {Record<string, number[][][]>} */
export const STROKES = {
  A: [[[0, 0], [0.5, 1]], [[0.5, 1], [1, 0]], [[0.19, 0.38], [0.81, 0.38]]],
  B: [
    [[0, 0], [0, 1]],
    [[0, 1], [0.75, 0.88], [0.75, 0.62], [0, 0.5]],
    [[0, 0.5], [0.88, 0.37], [0.88, 0.13], [0, 0]],
  ],
  C: [[[0.95, 0.82], [0.55, 1], [0.1, 0.72], [0.1, 0.28], [0.55, 0], [0.95, 0.18]]],
  D: [[[0, 0], [0, 1]], [[0, 1], [0.7, 0.86], [0.92, 0.5], [0.7, 0.14], [0, 0]]],
  E: [[[0, 0], [0, 1]], [[0, 1], [0.9, 1]], [[0, 0.5], [0.72, 0.5]], [[0, 0], [0.9, 0]]],
  F: [[[0, 0], [0, 1]], [[0, 1], [0.9, 1]], [[0, 0.52], [0.72, 0.52]]],
  G: [
    [[0.95, 0.82], [0.55, 1], [0.1, 0.72], [0.1, 0.28], [0.55, 0], [0.95, 0.2], [0.95, 0.45]],
    [[0.95, 0.45], [0.55, 0.45]],
  ],
  H: [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, 0.5], [1, 0.5]]],
  I: [[[0.5, 0], [0.5, 1]]],
  J: [[[0.82, 1], [0.82, 0.25], [0.45, 0], [0.08, 0.22]]],
  K: [[[0, 0], [0, 1]], [[0.92, 1], [0, 0.45]], [[0.26, 0.61], [0.96, 0]]],
  L: [[[0, 1], [0, 0]], [[0, 0], [0.86, 0]]],
  M: [[[0, 0], [0, 1]], [[0, 1], [0.5, 0.38]], [[0.5, 0.38], [1, 1]], [[1, 1], [1, 0]]],
  N: [[[0, 0], [0, 1]], [[0, 1], [1, 0]], [[1, 0], [1, 1]]],
  O: [[[0.5, 1], [0.9, 0.78], [0.9, 0.22], [0.5, 0], [0.1, 0.22], [0.1, 0.78], [0.5, 1]]],
  P: [[[0, 0], [0, 1]], [[0, 1], [0.85, 0.87], [0.85, 0.61], [0, 0.49]]],
  Q: [
    [[0.5, 1], [0.9, 0.78], [0.9, 0.22], [0.5, 0], [0.1, 0.22], [0.1, 0.78], [0.5, 1]],
    [[0.58, 0.26], [1, -0.04]],
  ],
  R: [[[0, 0], [0, 1]], [[0, 1], [0.85, 0.87], [0.85, 0.61], [0, 0.49]], [[0.34, 0.49], [0.95, 0]]],
  S: [
    [[0.9, 0.84], [0.5, 1], [0.13, 0.84], [0.13, 0.6], [0.87, 0.4], [0.87, 0.16], [0.5, 0], [0.1, 0.16]],
  ],
  T: [[[0, 1], [1, 1]], [[0.5, 1], [0.5, 0]]],
  U: [[[0, 1], [0, 0.26], [0.36, 0], [0.64, 0], [1, 0.26], [1, 1]]],
  V: [[[0, 1], [0.5, 0]], [[0.5, 0], [1, 1]]],
  W: [[[0, 1], [0.25, 0]], [[0.25, 0], [0.5, 0.62]], [[0.5, 0.62], [0.75, 0]], [[0.75, 0], [1, 1]]],
  X: [[[0, 0], [1, 1]], [[0, 1], [1, 0]]],
  Y: [[[0, 1], [0.5, 0.52]], [[1, 1], [0.5, 0.52]], [[0.5, 0.52], [0.5, 0]]],
  Z: [[[0, 1], [1, 1]], [[1, 1], [0, 0]], [[0, 0], [1, 0]]],

  0: [[[0.5, 1], [0.9, 0.78], [0.9, 0.22], [0.5, 0], [0.1, 0.22], [0.1, 0.78], [0.5, 1]]],
  1: [[[0.22, 0.8], [0.5, 1]], [[0.5, 1], [0.5, 0]]],
  2: [[[0.1, 0.82], [0.5, 1], [0.9, 0.82], [0.9, 0.6], [0.1, 0]], [[0.1, 0], [0.95, 0]]],
  3: [[[0.1, 0.9], [0.55, 1], [0.9, 0.82], [0.5, 0.54]], [[0.5, 0.54], [0.92, 0.3], [0.5, 0], [0.08, 0.12]]],
  4: [[[0.72, 0], [0.72, 1]], [[0.72, 1], [0.05, 0.32]], [[0.05, 0.32], [1, 0.32]]],
  5: [[[0.9, 1], [0.15, 1]], [[0.15, 1], [0.12, 0.56]], [[0.12, 0.56], [0.6, 0.62], [0.9, 0.38], [0.6, 0.02], [0.1, 0.12]]],
  6: [[[0.85, 0.9], [0.45, 1], [0.12, 0.6], [0.12, 0.2], [0.5, 0], [0.86, 0.2], [0.86, 0.42], [0.45, 0.52], [0.12, 0.38]]],
  7: [[[0, 1], [1, 1]], [[1, 1], [0.35, 0]]],
  8: [[[0.5, 0.52], [0.88, 0.72], [0.5, 1], [0.12, 0.72], [0.5, 0.52]], [[0.5, 0.52], [0.9, 0.28], [0.5, 0], [0.1, 0.28], [0.5, 0.52]]],
  9: [[[0.15, 0.1], [0.55, 0], [0.88, 0.4], [0.88, 0.8], [0.5, 1], [0.14, 0.8], [0.14, 0.58], [0.55, 0.48], [0.88, 0.62]]],
};

/** Characters this font can draw. */
export const SUPPORTED = Object.keys(STROKES);

/**
 * Lay out text as straight segments in angstrom, centred on the origin.
 *
 * Every polyline is broken into its individual segments, because each segment
 * is one structural element: a straight run a helix or strand can lie along.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.capHeight=32] height of a capital, in angstrom
 * @param {number} [options.widthRatio=0.62] character width relative to height
 * @param {number} [options.tracking=0.3] gap between characters, in widths
 * @param {number} [options.minLength=6] drop segments shorter than this
 * @returns {Array<{a: number[], b: number[], char: string}>}
 */
export function textSegments(text, options = {}) {
  const {
    capHeight = 32,
    widthRatio = 0.62,
    tracking = 0.3,
    minLength = 6,
  } = options;

  const charWidth = capHeight * widthRatio;
  const advance = charWidth * (1 + tracking);
  const segments = [];

  let cursor = 0;
  for (const raw of text.toUpperCase()) {
    if (raw === ' ') {
      cursor += advance;
      continue;
    }
    const strokes = STROKES[raw];
    if (!strokes) continue; // unsupported characters are skipped, not guessed at

    for (const stroke of strokes) {
      for (let i = 0; i + 1 < stroke.length; i += 1) {
        const a = [cursor + stroke[i][0] * charWidth, stroke[i][1] * capHeight];
        const b = [cursor + stroke[i + 1][0] * charWidth, stroke[i + 1][1] * capHeight];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= minLength) {
          segments.push({ a, b, char: raw });
        }
      }
    }
    cursor += advance;
  }

  if (!segments.length) return [];

  // Centre the finished word on the origin.
  const xs = segments.flatMap((s) => [s.a[0], s.b[0]]);
  const ys = segments.flatMap((s) => [s.a[1], s.b[1]]);
  const centreX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centreY = (Math.min(...ys) + Math.max(...ys)) / 2;

  return segments.map((segment) => ({
    char: segment.char,
    a: [segment.a[0] - centreX, segment.a[1] - centreY],
    b: [segment.b[0] - centreX, segment.b[1] - centreY],
  }));
}

import test from 'node:test';
import assert from 'node:assert/strict';

import { textSegments, STROKES, SUPPORTED } from '../src/geometry/strokefont.js';
import { orderSegments } from '../src/geometry/shape.js';

const length = (s) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);

test('a letter is a handful of elements, not dozens', () => {
  // The point of the stroke font: an N is three strokes.
  assert.equal(textSegments('N').length, 3);
  assert.equal(textSegments('H').length, 3);
  assert.equal(textSegments('A').length, 3);
  assert.equal(textSegments('X').length, 2);
  assert.equal(textSegments('T').length, 2);
  assert.equal(textSegments('I').length, 1);

  // Even the curviest letters stay small.
  for (const char of SUPPORTED) {
    const count = textSegments(char).length;
    assert.ok(count <= 9, `${char} decomposes into ${count} elements`);
  }
});

test('segments are sized for real elements', () => {
  const segments = textSegments('N', { capHeight: 32 });
  for (const segment of segments) {
    assert.ok(length(segment) >= 6, 'no stub segments');
    assert.ok(length(segment) <= 50, 'nothing absurdly long');
  }

  // The uprights of an N span the cap height.
  const tallest = Math.max(...segments.map(length));
  assert.ok(Math.abs(tallest - 32) < 6, `tallest stroke was ${tallest.toFixed(1)} A`);
});

test('cap height scales the whole letter', () => {
  const small = textSegments('H', { capHeight: 20 });
  const large = textSegments('H', { capHeight: 60 });
  assert.equal(small.length, large.length);
  assert.ok(Math.max(...large.map(length)) > Math.max(...small.map(length)) * 2.5);
});

test('text is centred on the origin', () => {
  const segments = textSegments('AB');
  const xs = segments.flatMap((s) => [s.a[0], s.b[0]]);
  const ys = segments.flatMap((s) => [s.a[1], s.b[1]]);
  assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2) < 1e-9);
  assert.ok(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2) < 1e-9);
});

test('words lay out left to right without overlapping', () => {
  const ab = textSegments('AB');
  const aOnly = ab.filter((s) => s.char === 'A');
  const bOnly = ab.filter((s) => s.char === 'B');
  assert.ok(aOnly.length && bOnly.length);
  assert.ok(Math.max(...aOnly.flatMap((s) => [s.a[0], s.b[0]])) <
            Math.min(...bOnly.flatMap((s) => [s.a[0], s.b[0]])) + 1e-6);
});

test('unsupported characters are skipped rather than guessed at', () => {
  assert.deepEqual(textSegments('@@@'), []);
  assert.equal(textSegments('A@B').filter((s) => s.char === '@').length, 0);
  assert.ok(textSegments('A B').length > 0, 'spaces just advance the cursor');
});

test('lower case is drawn as capitals', () => {
  assert.equal(textSegments('n').length, textSegments('N').length);
});

test('every defined stroke is a usable polyline', () => {
  for (const [char, strokes] of Object.entries(STROKES)) {
    assert.ok(strokes.length >= 1, `${char} has no strokes`);
    for (const stroke of strokes) {
      assert.ok(stroke.length >= 2, `${char} has a stroke with one point`);
      for (const [x, y] of stroke) {
        assert.ok(Number.isFinite(x) && Number.isFinite(y), `${char} has a bad point`);
        assert.ok(x >= -0.1 && x <= 1.1, `${char} x out of the unit box: ${x}`);
        assert.ok(y >= -0.1 && y <= 1.1, `${char} y out of the unit box: ${y}`);
      }
    }
  }
});

test('orderSegments shortens the walk and keeps every segment', () => {
  const segments = textSegments('A');
  const ordered = orderSegments(segments);
  assert.equal(ordered.length, segments.length);

  const travel = (list) => {
    let sum = 0;
    for (let i = 1; i < list.length; i += 1) {
      sum += Math.hypot(list[i].a[0] - list[i - 1].b[0], list[i].a[1] - list[i - 1].b[1]);
    }
    return sum;
  };
  assert.ok(
    travel(ordered) <= travel(segments) + 1e-9,
    'ordering must never be worse than the order it was given',
  );
  assert.ok(travel(ordered) < travel(segments), 'on an A it should be strictly better');

  // Every original segment appears exactly once, in some orientation.
  const key = (s) => [s.a, s.b].map((p) => p.map((v) => v.toFixed(4)).join(',')).sort().join('|');
  assert.deepEqual(
    new Set(ordered.map(key)),
    new Set(segments.map(key)),
    'segments must be preserved, only reordered and reoriented',
  );
});

test('orderSegments leaves an already optimal order alone', () => {
  // Three segments laid end to end: nothing to improve.
  const chain = [
    { a: [0, 0], b: [10, 0] },
    { a: [10, 0], b: [10, 10] },
    { a: [10, 10], b: [20, 10] },
  ];
  const ordered = orderSegments(chain);
  const travel = (list) => {
    let sum = 0;
    for (let i = 1; i < list.length; i += 1) {
      sum += Math.hypot(list[i].a[0] - list[i - 1].b[0], list[i].a[1] - list[i - 1].b[1]);
    }
    return sum;
  };
  assert.equal(travel(ordered), 0);
});

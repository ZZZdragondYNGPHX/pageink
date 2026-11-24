import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scribbleHits, scribbleRegion, eraseStrokeInRegion } from '../src/scribble';
import { normalizePreferences } from '../src/preferences';
import type { Element } from '../src/model';
import type { ScenePoint } from '../src/geometry';
const zigzag = Array.from({ length: 61 }, (_, i) => {
  const run = Math.floor(i / 10), t = i % 10 / 10;
  return [(run % 2 ? 1 - t : t) * 120, i * .6] as ScenePoint;
});
const ink = (points: ScenePoint[], extra = {}) => ({ id: 'ink', type: 'freedraw', x: 0, y: 0, angle: 0, points, ...extra }) as unknown as Extract<Element, { type: 'freedraw' }>;

test('deliberate repeated scribbles recognise at different angles and zoom levels', () => {
  for (const angle of [0, .4, Math.PI / 2, Math.PI]) for (const zoom of [.5, 1, 2]) {
    const points = zigzag.map(([x, y]) => [(x * Math.cos(angle) - y * Math.sin(angle)) / zoom, (x * Math.sin(angle) + y * Math.cos(angle)) / zoom] as ScenePoint);
    assert.ok(scribbleRegion(points, zoom, 900));
  }
});
test('two reversals recognise short, narrow and sparsely sampled scribbles without changing raw points', () => {
  const gestures: ScenePoint[][] = [
    zigzag.slice(0, 31),
    [[0, 0], [120, 2], [0, 4], [120, 6]],
    [[0, 0], [20, 2], [0, 4], [20, 6]],
  ];
  for (const gesture of gestures) for (const angle of [0, .4, Math.PI / 2]) for (const zoom of [.5, 1, 2]) {
    const points = gesture.map(([x, y]) => [(x * Math.cos(angle) - y * Math.sin(angle)) / zoom, (x * Math.sin(angle) + y * Math.cos(angle)) / zoom] as ScenePoint);
    const original = structuredClone(points);
    const region = scribbleRegion(points, zoom, 300);
    assert.ok(region, 'Three sweeps should erase even with narrow spacing or few samples');
    assert.deepEqual(points, original);
  }
  assert.ok(scribbleRegion(gestures[2], 1, 60));
  assert.equal(scribbleRegion(gestures[2], 1, 30), null);
});
test('ordinary letters, circles, underlines, slow hatching and short zigzags remain ink', () => {
  assert.equal(scribbleRegion(zigzag, 1, 4000), null);
  for (const points of [
    [[0, 0], [120, 2], [0, 4]], // Only one reversal.
    [[0, 40], [20, 0], [40, 40], [60, 0], [80, 40]], // M/W letter.
    [[0, 0], [80, 0], [0, 40], [80, 40]], // Z letter.
    [[0, 0], [120, .5], [0, 1], [120, 1.5]], // Degenerate envelope.
  ] as ScenePoint[][]) assert.equal(scribbleRegion(points, 1, 300), null);
  assert.equal(scribbleRegion(zigzag.slice(0, 25), 1, 300), null);
  assert.equal(scribbleRegion(Array.from({ length: 61 }, (_, i) => [i * 2, 0]), 1, 500), null);
  assert.equal(scribbleRegion(Array.from({ length: 121 }, (_, i) => [50 * Math.cos(i / 120 * Math.PI * 8), 50 * Math.sin(i / 120 * Math.PI * 8)]), 1, 1200), null);
  assert.equal(scribbleRegion(zigzag.map(([x, y]) => [x / 20, y / 20]), 1, 900), null);
});
test('only covered handwriting is erased, preserving objects, locked ink and crossing long lines', () => {
  const region = [[0, 0], [100, 0], [100, 50], [0, 50]] as ScenePoint[];
  const inside = ink([[10, 10], [80, 40]]);
  assert.equal(scribbleHits(inside, region), true);
  assert.equal(scribbleHits(ink([[-500, 25], [500, 25]]), region), false);
  assert.equal(scribbleHits(ink([[-100, 25], [150, 25]]), region), false);
  assert.equal(scribbleHits(ink([[-10, 25], [110, 25]]), region), true);
  assert.equal(scribbleHits(ink([[10, 10]], { locked: true }), region), false);
  assert.equal(scribbleHits({ ...inside, type: 'image' } as unknown as Element, region), false);
  assert.equal(scribbleHits({ ...inside, x: 200 } as Element, region), false);
  assert.equal(scribbleHits(ink([[10, 10]], { isDeleted: true }), region), false);
  assert.deepEqual(inside.points, [[10, 10], [80, 40]]);
});
test('older writing preferences receive scribble default and explicit opt-out persists', () => {
  assert.equal(normalizePreferences({ pen: { pressure: true } }).pen.scribble, true);
  assert.equal(normalizePreferences({ pen: { scribble: false } }).pen.scribble, false);
});
test('sensitive scribble recognises natural CJK/square scribbles and erases everything inside the scribbled region', () => {
  // Brisk 4-sweep square scribble over a single CJK character (height ≈ span, slightly shorter middle sweeps).
  const cjkScribble: ScenePoint[] = [
    [0, 0], [40, 8], [8, 16], [36, 24], [4, 32], [38, 38],
  ];
  const region = scribbleRegion(cjkScribble, 1, 450);
  assert.ok(region && region.length >= 3);

  // eraseStrokeInRegion deletes enclosed strokes whole and slices long crossing strokes cleanly at the region boundary.
  const boxRegion: ScenePoint[] = [[0, 0], [100, 0], [100, 50], [0, 50]];
  const enclosed = ink([[10, 10], [80, 40]]);
  assert.equal(eraseStrokeInRegion(enclosed, boxRegion).length, 0);

  const crossing = ink([[-200, 25], [300, 25]], { simulatePressure: false, pressures: [0.2, 0.8] });
  const remaining = eraseStrokeInRegion(crossing, boxRegion);
  assert.equal(remaining.length, 2);
  // Left surviving piece ends at x=0; right surviving piece starts at x=100.
  assert.ok(Math.abs(remaining[0].x + remaining[0].width - 0) < 1e-6);
  assert.ok(Math.abs(remaining[1].x - 100) < 1e-6);

  // 50% covered long line (1000 units, middle 500 inside scribble) keeps both 250-unit outside halves!
  const halfCovered = ink([[0, 25], [1000, 25]]);
  const halves = eraseStrokeInRegion(halfCovered, [[250, 0], [750, 0], [750, 50], [250, 50]]);
  assert.equal(halves.length, 2);
  assert.ok(Math.abs(halves[0].width - 250) < 1e-6);
  assert.ok(Math.abs(halves[1].x - 750) < 1e-6 && Math.abs(halves[1].width - 250) < 1e-6);

  // Locked ink and non-ink shapes stay untouched.
  assert.equal(eraseStrokeInRegion(ink([[10, 10], [80, 40]], { locked: true }), boxRegion)[0].id, 'ink');
  assert.equal(eraseStrokeInRegion({ ...enclosed, type: 'rectangle' } as unknown as Element, boxRegion).length, 1);
});

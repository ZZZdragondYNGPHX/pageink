import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scribbleHits, scribbleRegion } from '../src/scribble';
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
test('ordinary letters, circles, underlines, slow hatching and short zigzags remain ink', () => {
  assert.equal(scribbleRegion(zigzag, 1, 4000), null);
  assert.equal(scribbleRegion(zigzag.slice(0, 35), 1, 900), null);
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

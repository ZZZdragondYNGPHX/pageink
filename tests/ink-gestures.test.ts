import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closedLoopPolygon, hitStrokePath, recognizeShape } from '../src/ink-gestures';
import type { Element } from '../src/model';
import type { ScenePoint } from '../src/geometry';

const circlePoints = (cx: number, cy: number, rx: number, ry: number, steps = 40, jitter = 0): ScenePoint[] =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    const w = jitter ? 1 + jitter * Math.sin(i * 1.7) : 1;
    return [cx + Math.cos(a) * rx * w, cy + Math.sin(a) * ry * w];
  });

const rectPoints = (x: number, y: number, w: number, h: number): ScenePoint[] => {
  const pts: ScenePoint[] = [];
  const edge = (a: ScenePoint, b: ScenePoint, n = 10) => {
    for (let i = 0; i < n; i++) pts.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
  };
  edge([x, y], [x + w, y]);
  edge([x + w, y], [x + w, y + h]);
  edge([x + w, y + h], [x, y + h]);
  edge([x, y + h], [x, y]);
  pts.push([x, y]);
  return pts;
};

test('closedLoopPolygon recognises closed and self-intersecting loops while rejecting open lines', () => {
  assert.ok(closedLoopPolygon(circlePoints(100, 100, 50, 40), 1));
  // Self-intersecting loop with crossing tails.
  const loopWithTails: ScenePoint[] = [
    [0, 60], [30, 50], [60, 10], [130, 10], [150, 70], [100, 120], [30, 90], [25, 40], [10, 0],
  ];
  const poly = closedLoopPolygon(loopWithTails, 1);
  assert.ok(poly && poly.length >= 4);
  // Straight line and tiny mark are rejected.
  assert.equal(closedLoopPolygon([[0, 0], [50, 1], [100, 0], [150, 2], [200, 0], [250, 1]], 1), null);
  assert.equal(closedLoopPolygon(circlePoints(0, 0, 5, 5), 1), null);
});

test('hitStrokePath detects hits near stroke segments including rotated strokes', () => {
  const stroke = {
    id: 's1', type: 'freedraw', x: 0, y: 0, width: 100, height: 0, angle: 0, strokeWidth: 2, isDeleted: false,
    points: [[0, 0], [100, 0]],
  } as unknown as Element;
  assert.equal(hitStrokePath(stroke, [50, 6], 10), true);
  assert.equal(hitStrokePath(stroke, [50, 30], 10), false);
  const rotated = { ...stroke, angle: Math.PI / 2 } as unknown as Element;
  assert.equal(hitStrokePath(rotated, [50, 20], 10), true);
  assert.equal(hitStrokePath(rotated, [10, 0], 5), false);
});

test('recognizeShape snaps lines, arrows, circles, rectangles and diamonds cleanly', () => {
  // Nearly horizontal line snaps flat.
  const line = recognizeShape([[0, 0], [40, 1], [80, 2], [120, 3]], 1);
  assert.equal(line?.kind, 'line');
  if (line?.kind === 'line') assert.ok(Math.abs(line.end[1] - line.start[1]) < 1e-6);

  // Single-stroke arrow.
  const arrow = recognizeShape([[0, 50], [40, 50], [80, 50], [120, 50], [105, 38], [95, 30]], 1);
  assert.equal(arrow?.kind, 'arrow');

  // Near-circle snaps to perfect circle.
  const circle = recognizeShape(circlePoints(100, 100, 52, 48), 1);
  assert.equal(circle?.kind, 'ellipse');
  if (circle?.kind === 'ellipse') assert.ok(Math.abs(circle.width - circle.height) < 1e-6);

  // Rectangle & diamond.
  const rect = recognizeShape(rectPoints(10, 20, 140, 90), 1);
  assert.equal(rect?.kind, 'rectangle');

  const diamondPts: ScenePoint[] = [];
  const dVerts: ScenePoint[] = [[100, 0], [200, 80], [100, 160], [0, 80], [100, 0]];
  for (let i = 0; i < 4; i++) {
    for (let s = 0; s < 8; s++) {
      diamondPts.push([
        dVerts[i][0] + (dVerts[i + 1][0] - dVerts[i][0]) * s / 8,
        dVerts[i][1] + (dVerts[i + 1][1] - dVerts[i][1]) * s / 8,
      ]);
    }
  }
  diamondPts.push(dVerts[0]);
  assert.equal(recognizeShape(diamondPts, 1)?.kind, 'diamond');

  // Highlighter lineOnly ignores closed shapes, keeps straight lines.
  assert.equal(recognizeShape(circlePoints(100, 100, 50, 50), 1, { lineOnly: true }), null);
  assert.equal(recognizeShape([[0, 0], [50, 0], [100, 0]], 1, { lineOnly: true })?.kind, 'line');

  // Rough freeform lasso loop around content yields null for shape snap so Circle-to-Lasso wins.
  assert.equal(recognizeShape(circlePoints(100, 100, 60, 50, 40, 0.22), 1, { enclosesContent: true }), null);
});

test('hitStrokePath rejects distant candidates without iterating or allocating world points', () => {
  const points = new Proxy([[0, 0], [100, 0]], { get(target, key, receiver) {
    if (key === 'map' || key === Symbol.iterator) throw Error('world points were visited');
    return Reflect.get(target, key, receiver);
  } });
  const stroke = { type: 'freedraw', x: 0, y: 0, width: 100, height: 0, angle: Math.PI / 3, strokeWidth: 2, points } as unknown as Element;
  assert.equal(hitStrokePath(stroke, [5000, 5000], 10), false);
});

test('hitStrokePath conservative rejection retains offset, rotated and singleton strokes', () => {
  const stroke = { type: 'freedraw', x: 10, y: 20, width: 80, height: 0, angle: Math.PI, strokeWidth: 2, points: [[-40, 30], [40, 30]] } as unknown as Element;
  assert.equal(hitStrokePath(stroke, [10, 50], 1), true);
  assert.equal(hitStrokePath({ ...stroke, width: 0, points: [[-40, 30]] } as unknown as Element, [-30, 50], 1), true);
});

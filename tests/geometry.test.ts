import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eraseStroke, eraseStrokeSegment, eraseStrokePath, eraseLinePath, isHighlighterElement, cloneElements, constrainMargins, lassoHits, bounds, removeElements } from '../src/geometry';
import { Element, newPage } from '../src/model';
const stroke = { id: 'a', type: 'freedraw', x: 0, y: 0, width: 100, height: 0, angle: 0, strokeWidth: 2, isDeleted: false,
  points: [[0, 0], [100, 0]], pressures: [.2, .8], simulatePressure: false, version: 1, groupIds: [] } as unknown as Element;
test('local eraser cuts crossing segments even without a sample inside the circle', () => {
  const pieces = eraseStroke(stroke, [50, 0], 9, false);
  assert.equal(pieces.length, 2);
  assert.ok(Math.abs(pieces[0].width - 36.75) < 1e-10); assert.ok(Math.abs(pieces[1].x - 63.25) < 1e-10);
  assert.ok(Math.abs((pieces[0] as any).pressures[1] - .4205) < 1e-10);
  assert.equal(eraseStroke(stroke, [50, 0], 9, true).length, 0);
  assert.equal(eraseStroke(stroke, [50, 100], 9, false)[0], stroke);
});
test('eraser preserves non-ink objects and does not mutate source', () => {
  const image = { ...stroke, type: 'image' } as Element;
  assert.equal(eraseStroke(image, [50, 0], 200, false)[0], image);
  const locked = { ...stroke, locked: true }; assert.equal(eraseStroke(locked, [50, 0], 200, false)[0], locked);
  eraseStroke(stroke, [50, 0], 9, false); assert.equal((stroke as any).points.length, 2);
});
test('shrinking margins cannot crop existing ink', () => {
  const p = newPage(); const ink = { ...stroke, x: -60, y: -30 };
  const result = constrainMargins(p, { top: 0, right: 0, left: 0, bottom: 0 }, [ink]);
  assert.equal(result.left, 64.25); assert.equal(result.top, 34.25);
});
test('editable copies remap object and binding identities independently', () => {
  const a = { ...stroke, boundElements: [{ id: 'b', type: 'arrow' }] } as Element;
  const b = { ...stroke, id: 'b', type: 'arrow', startBinding: { elementId: 'a', focus: 0, gap: 0 } } as unknown as Element;
  const copies = cloneElements([a, b]);
  assert.notEqual(copies[0].id, a.id); assert.equal(copies[0].boundElements![0].id, copies[1].id);
  assert.equal((copies[1] as any).startBinding.elementId, copies[0].id);
});
test('rotated negative-coordinate ink retains correct bounds, erase and lasso geometry', () => {
  const e = { ...stroke, points: [[0, 0], [-100, 0]], angle: Math.PI / 2 } as unknown as Element;
  const b = bounds([e])!; assert.equal(b.x, -54.25); assert.equal(b.y, -54.25);
  assert.equal(eraseStroke(e, [-50, 0], 9, true).length, 0);
  assert.equal(lassoHits(e, [[-55, -5], [-45, -5], [-45, 5], [-55, 5]]), true);
  assert.equal(lassoHits(e, [[30, 30], [40, 30], [40, 40], [30, 40]]), false);
});
test('long strokes can be cut without argument-stack overflow', () => {
  const e = { ...stroke, width: 150000, points: Array.from({length:150001}, (_,i) => [i,0]), pressures: [] } as unknown as Element;
  const pieces = eraseStroke(e, [10,0], 2, false); assert.equal(pieces.length,2);
  assert.ok((pieces[1] as any).points.length > 140000);
});
test('deleting a container removes its bound text and detaches surviving arrows', () => {
  const shape={...stroke,type:'rectangle'},text={...stroke,id:'t',type:'text',containerId:'a'},arrow={...stroke,id:'b',type:'arrow',startBinding:{elementId:'a'}};
  const remaining=removeElements([shape,text,arrow] as Element[],new Set(['a']));
  assert.equal(remaining.length,1);assert.equal((remaining[0] as any).startBinding,null);assert.equal(remaining[0].version,2);
});
test('capsule segment and path eraser cut cleanly in a single pass with AABB culling', () => {
  // Fast vertical sweep from y=-40 to y=40 across x=50 cuts horizontal stroke [0,0]->[100,0] in one pass.
  const pieces = eraseStrokeSegment(stroke, [50, -40], [50, 40], 9, false);
  assert.equal(pieces.length, 2);
  assert.ok(Math.abs(pieces[0].width - 36.75) < 1e-9);
  assert.ok(Math.abs(pieces[1].x - 63.25) < 1e-9);
  // Whole-stroke mode returns empty immediately on sweep intersection and preserves untouched strokes.
  assert.equal(eraseStrokeSegment(stroke, [50, -40], [50, 40], 9, true).length, 0);
  assert.equal(eraseStrokeSegment(stroke, [50, 50], [100, 80], 9, true)[0], stroke);
  // Multi-segment coalesced path cuts twice in one batch.
  const triple = eraseStrokePath(stroke, [[25, -20], [25, 20], [75, 20], [75, -20]], 4, false);
  assert.equal(triple.length, 3);
  assert.equal(eraseStrokePath(stroke, [[0, 200], [100, 200]], 4, false)[0], stroke);
  // Highlighter identity uses explicit inkKind tag (surviving opacity edits and snapped lines) with legacy opacity fallback.
  const penLowOpacity = { ...stroke, opacity: 35, customData: { inkKind: 'pen' as const } } as Element;
  const hiHighOpacity = { ...stroke, opacity: 70, customData: { inkKind: 'highlighter' as const } } as Element;
  const hiLine = { ...stroke, type: 'line', opacity: 35, customData: { inkKind: 'highlighter' as const } } as Element;
  const legacyHi = { ...stroke, opacity: 35 } as Element;
  assert.equal(isHighlighterElement(penLowOpacity), false);
  assert.equal(isHighlighterElement(hiHighOpacity), true);
  assert.equal(isHighlighterElement(hiLine), true);
  assert.equal(isHighlighterElement(legacyHi), true);
  // Partial eraser cuts a snapped highlighter line into two shorter line segments; whole mode deletes it.
  const cutLine = eraseLinePath(hiLine, [[50, -10], [50, 10]], 4, false);
  assert.equal(cutLine.length, 2);
  assert.equal(cutLine[0].type, 'line');
  assert.equal(cutLine[0].customData?.inkKind, 'highlighter');
  assert.equal(eraseLinePath(hiLine, [[50, -10], [50, 10]], 4, true).length, 0);
  assert.equal(eraseLinePath(hiLine, [[50, 50], [60, 50]], 4, false)[0], hiLine);
});

test('frozen local point bounds are reused while mutable and replaced points remain live', () => {
  let visits = 0;
  const samples = [[0, 0], [100, 0]] as [number, number][];
  Object.defineProperty(samples, Symbol.iterator, { value: function* () { visits++; yield* [samples[0], samples[1]]; } });
  for (const point of samples) Object.freeze(point);
  Object.freeze(samples);
  const frozen = { ...stroke, points: samples } as unknown as Element;
  const initial = bounds([frozen]);
  const cachedVisits = visits;
  assert.deepEqual(bounds([frozen]), initial);
  assert.equal(eraseStrokePath(frozen, [[5000, 5000]], 10, false)[0], frozen);
  assert.equal(visits, cachedVisits);
  const mutable = { ...stroke, points: [[0, 0], [100, 0]] } as unknown as Element;
  const first = bounds([mutable])!;
  (mutable as any).points[1][0] = 200;
  assert.equal(bounds([mutable])!.width, first.width + 100);
  const replaced = { ...frozen, points: [[0, 0], [300, 0]] } as unknown as Element;
  assert.equal(bounds([replaced])!.width, initial!.width + 200);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eraseStroke, cloneElements, constrainMargins, lassoHits, bounds, removeElements } from '../src/geometry';
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InkSpatialIndex, InkRenderMap } from '../src/spatial';
import type { Element } from '../src/model';
const element = (id: string, x = 0, index = id) => ({ id, index, x, y: 0, width: 100, height: 100, angle: Math.PI / 3, strokeWidth: 2, isDeleted: false, type: 'rectangle' }) as unknown as Element;
test('spatial candidates retain rotated and large objects, exclude distant objects, preserve order', () => {
  const a = element('a'), b = element('b'), far = element('z', 10000);
  const big = { ...element('c'), width: 100000 };
  const index = new InkSpatialIndex([b, far, big, a]);
  assert.deepEqual(index.query({ x: -50, y: -50, width: 200, height: 200 }).map(e => e.id), ['a', 'b', 'c']);
});
test('spatial index tracks in-place moves and deletion without ghost candidates', () => {
  const e = element('a'); const index = new InkSpatialIndex([e]);
  Object.assign(e, { x: 10000 }); index.update(e);
  assert.equal(index.query({ x: 0, y: 0, width: 100, height: 100 }).length, 0);
  assert.equal(index.query({ x: 10000, y: 0, width: 100, height: 100 })[0], e);
  Object.assign(e, { isDeleted: true }); index.update(e);
  assert.equal(index.query({ x: 10000, y: 0, width: 100, height: 100 }).length, 0);
});
test('render projection preserves offscreen authority and excludes only active objects', () => {
  const a = element('a'), b = element('b', 10000); const source = new Map([[a.id, a], [b.id, b]]);
  const map = new InkRenderMap(source, ['a', undefined, 'missing']);
  assert.equal(map.size, 1); assert.equal(map.get('a'), undefined); assert.equal(map.get('b'), b);
  assert.deepEqual([...map], [['b', b]]); assert.equal(source.size, 2);
});

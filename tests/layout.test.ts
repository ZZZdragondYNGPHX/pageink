import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutPages, placementAt, PageScene, PAGE_GAP } from '../src/layout';
import { newPage, newManifest, Element } from '../src/model';
import { Session } from '../src/session';
import { DocumentStore, FileIO } from '../src/storage';

const el = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'rectangle', x, y, width: 10, height: 10, angle: 0, strokeWidth: 1, version: 1, isDeleted: false, groupIds: [], index: null, ...extra }) as unknown as Element;

test('pages stack below each other, centred, with page one at its own coordinates', () => {
  const a = newPage(), b = newPage({ width: 400, height: 600, margins: { top: 10, right: 20, bottom: 10, left: 20 } });
  const layout = layoutPages([a, b]);
  assert.deepEqual([layout.placements[0].x, layout.placements[0].y], [0, 0]);
  const second = layout.placements[1];
  assert.equal(second.paper.y, Math.round(a.height + PAGE_GAP));
  assert.equal(Math.round(second.paper.x + second.paper.width / 2), Math.round(a.width / 2));
  assert.equal(second.x - second.paper.x, 20);
  assert.equal(placementAt(layout, -5000).page.id, a.id);
  assert.equal(placementAt(layout, a.height + PAGE_GAP / 2 - 1).page.id, a.id);
  assert.equal(placementAt(layout, a.height + PAGE_GAP / 2 + 1).page.id, b.id);
  assert.equal(placementAt(layout, 1e9).page.id, b.id);
});

test('scene round trip keeps page-local data; moved ink changes page, untouched legacy ink stays', () => {
  const a = newPage(), b = newPage(), layout = layoutPages([a, b]);
  const legacy = el('legacy', 100, a.height + 300, { index: 'a1' }); // drawn outside page one by an older version
  const surfaces: Record<string, Element[]> = { [a.id]: [el('a1', 5, 5, { index: 'a0' }), legacy], [b.id]: [el('b1', 7, 9, { index: 'a0' })] };
  const scene = new PageScene(layout), built = scene.build(id => surfaces[id]);
  assert.equal(built.length, 3);
  const b1 = built.find(e => e.id === 'b1')!;
  assert.equal(b1.y, 9 + layout.placements[1].y);
  let parts = scene.partition(built);
  assert.deepEqual(parts.get(a.id)!.map(e => [e.id, e.x, e.y]), [['a1', 5, 5], ['legacy', 100, a.height + 300]]);
  assert.deepEqual(parts.get(b.id)!.map(e => [e.id, e.x, e.y]), [['b1', 7, 9]]);
  const moved = { ...built.find(e => e.id === 'a1')!, y: layout.placements[1].y + 50, version: 2 } as Element;
  parts = scene.partition(built.map(e => e.id === 'a1' ? moved : e));
  assert.deepEqual(parts.get(a.id)!.map(e => e.id), ['legacy']);
  assert.deepEqual(parts.get(b.id)!.map(e => [e.id, e.y]).sort(), [['a1', 50], ['b1', 9]]);
});

test('groups and bound text stay together; deleted elements are not persisted', () => {
  const a = newPage(), b = newPage(), layout = layoutPages([a, b]), scene = new PageScene(layout);
  scene.build(() => []);
  const top = layout.placements[1].y;
  const box = el('box', 10, top - 60, { groupIds: ['g'], boundElements: [{ id: 'label', type: 'text' }] });
  const label = el('label', 12, top - 58, { type: 'text', containerId: 'box', groupIds: ['g'] });
  const partner = el('partner', 10, top + 200, { groupIds: ['g'] });
  const gone = el('gone', 0, 0, { isDeleted: true });
  const parts = scene.partition([box, label, partner, gone]);
  const owners = new Set(['box', 'label', 'partner'].map(id => [...parts].find(([, list]) => list.some(e => e.id === id))![0]));
  assert.equal(owners.size, 1);
  assert.ok(![...parts.values()].flat().some(e => e.id === 'gone'));
});

test('duplicate identities across pages are separated without touching other references', () => {
  const a = newPage(), b = newPage(), scene = new PageScene(layoutPages([a, b]));
  const built = scene.build(id => id === a.id ? [el('same', 0, 0)] : [el('same', 0, 0), el('arrow', 0, 0, { type: 'arrow', startBinding: { elementId: 'same' } })]);
  assert.equal(new Set(built.map(e => e.id)).size, 3);
  const arrow = built.find(e => e.type === 'arrow') as any;
  assert.notEqual(arrow.startBinding.elementId, 'same');
  assert.ok(built.some(e => e.id === arrow.startBinding.elementId));
});

test('scene merges pages by fractional index so stored order stays valid', () => {
  const a = newPage(), b = newPage(), scene = new PageScene(layoutPages([a, b]));
  const built = scene.build(id => id === a.id ? [el('a-old', 0, 0, { index: 'a0' }), el('a-new', 0, 0, { index: 'a3' })] : [el('b', 0, 0, { index: 'a1' })]);
  assert.deepEqual(built.map(e => e.id), ['a-old', 'b', 'a-new']);
});

test('moving ink between pages is one undo step that restores both pages', () => {
  const session = new Session(new DocumentStore({} as FileIO, 'x', newManifest('Test', 'pages')));
  session.change('p1', [el('ink', 0, 0)], false); session.change('p2', [], false);
  session.changeMany(new Map([['p1', []], ['p2', [el('ink', 0, 20, { version: 2 })]]])); clearTimeout(session.timer);
  const step = session.bodyHistory.undo()!;
  assert.deepEqual(step.parts.map(p => [p.surface, p.elements.map(e => e.y)]).sort(), [['p1', [0]], ['p2', []]]);
  assert.equal(session.bodyHistory.canUndo, false);
});

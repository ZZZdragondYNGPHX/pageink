import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/session';
import { DocumentStore, FileIO } from '../src/storage';
import { newManifest, Element } from '../src/model';
import { snapshotElement } from '../src/element-snapshot';

test('freehand snapshots share immutable points and retain replaced geometry independently', () => {
  const element = { id: 'ink', type: 'freedraw', version: 1, points: [[0, 0], [20, 10]], pressures: [.5, .5], customData: { label: 'original' } } as unknown as Element;
  const snapshot = snapshotElement(element) as any;
  assert.equal(snapshot.points, (element as any).points);
  assert.throws(() => { snapshot.points[1][0] = 90; }, TypeError);
  (element as any).points = [[0, 0], [40, 20]];
  (element as any).customData.label = 'edited';
  assert.equal(snapshot.points[1][0], 20); assert.equal(snapshot.customData.label, 'original');
});
test('history snapshots survive later in-place kernel mutations', async () => {
  const session = new Session(new DocumentStore({} as FileIO, 'x', newManifest('Test', 'pages')));
  const initial = { id: 'a', version: 1, x: 10, type: 'rectangle' } as Element;
  session.change('p', [initial]); clearTimeout(session.timer);
  (initial as any).x = 20; (initial as any).version = 2;
  session.change('p', [initial]); clearTimeout(session.timer);
  const undo = session.bodyHistory.undo()!;
  assert.equal(undo.elements[0].x, 10); assert.equal(session.surfaces.get('p')![0].x, 20);
});
test('scratch and body timelines stay independent; body history preserves page identity', () => {
  const session = new Session(new DocumentStore({} as FileIO, 'x', newManifest('Test', 'pages')));
  const e = (id: string) => ({ id, version: 1, x: 0, type: 'rectangle' }) as Element;
  session.change('page-a', [e('a')]); session.change('scratch', [e('s')]); session.change('page-b', [e('b')]);
  clearTimeout(session.timer);
  assert.equal(session.bodyHistory.undo()?.surface, 'page-b');
  assert.equal(session.bodyHistory.undo()?.surface, 'page-a');
  assert.equal(session.scratchHistory.undo()?.surface, 'scratch');
});

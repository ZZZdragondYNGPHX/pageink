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

function autosaveSession() {
  const store = new DocumentStore({} as FileIO, 'x', newManifest('Test', 'pages'));
  const session = new Session(store), commits: Map<string, readonly Element[]>[] = [];
  session.keepers.add(() => true);
  store.commit = async (batch, metadata) => { commits.push(new Map(batch)); return metadata!; };
  return { session, store, commits };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('autosave waits three idle minutes, batches strokes and leaves undo immediate', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { session, commits } = autosaveSession();
  for (let i = 1; i <= 10; i++) {
    session.change('p', [{ id: 'a', version: i, type: 'rectangle' } as Element]);
    t.mock.timers.tick(1000); await settle();
  }
  assert.equal(commits.length, 0); assert.equal(session.bodyHistory.canUndo, true);
  t.mock.timers.tick(178999); await settle(); assert.equal(commits.length, 0);
  t.mock.timers.tick(1); await settle(); assert.equal(commits.length, 1);
  assert.equal(commits[0].get('p/000000')?.[0].version, 10);
  assert.equal(session.saveState, 'saved');
});
test('continuous writing saves after fifteen minutes at pen-up, then starts a new window', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { session, commits } = autosaveSession();
  for (let i = 1; i <= 15; i++) {
    session.setWriting('body', true);
    session.change('p', [{ id: 'a', version: i, type: 'rectangle' } as Element]);
    t.mock.timers.tick(59900); await settle();
    assert.equal(commits.length, 0);
    session.setWriting('body', false); t.mock.timers.tick(100); await settle();
  }
  assert.equal(commits.length, 1);
  session.change('p', [{ id: 'a', version: 16, type: 'rectangle' } as Element]);
  t.mock.timers.tick(179999); await settle(); assert.equal(commits.length, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(commits.length, 2);
});
test('explicit flush persists immediately and a slow commit preserves subsequent edits', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { session, store, commits } = autosaveSession();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const commit = store.commit.bind(store);
  store.commit = async (...args) => { await gate; return commit(...args); };
  session.change('p', [{ id: 'a', version: 1, type: 'rectangle' } as Element]);
  const saving = session.flush(); await settle();
  session.change('p', [{ id: 'a', version: 2, type: 'rectangle' } as Element]);
  release(); await saving;
  assert.equal(session.saveState, 'pending'); assert.equal(session.dirty.size, 1);
  await session.flush(); assert.equal(commits.length, 2);
  assert.equal(commits[1].get('p/000000')?.[0].version, 2); assert.equal(session.saveState, 'saved');
  t.mock.timers.tick(900000); await settle(); assert.equal(commits.length, 2);
});
test('failed autosave retains dirty data and manual retry succeeds', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { session, store } = autosaveSession(), commit = store.commit.bind(store);
  store.commit = async () => { throw Error('disk full'); };
  session.metadataChanged(); t.mock.timers.tick(180000); await settle();
  assert.equal(session.saveState, 'failed'); assert.equal(session.metadataDirty, true);
  store.commit = commit; await session.flush(); assert.equal(session.saveState, 'saved');
});

test('a stroke crossing the fifteen-minute limit waits for both body and scratch pen-up', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { session, commits } = autosaveSession();
  session.change('p', [{ id: 'a', version: 1, type: 'rectangle' } as Element]);
  session.setWriting('body', true); session.setWriting('scratch', true);
  t.mock.timers.tick(900001); await settle(); assert.equal(commits.length, 0);
  session.setWriting('body', false);
  t.mock.timers.tick(1000); await settle(); assert.equal(commits.length, 0);
  session.change('scratch', [{ id: 's', version: 1, type: 'rectangle' } as Element]);
  session.setWriting('scratch', false);
  t.mock.timers.tick(0); await settle(); assert.equal(commits.length, 1);
  assert.equal(commits[0].get('p/000000')?.[0].id, 'a');
  assert.equal(commits[0].get('scratch/000000')?.[0].id, 's');
});

test('freehand snapshots share frozen raw samples while isolating editable custom data', () => {
  const raw = [[0, 0], [12, -3]] as [number, number][], rawPressures = [.2, .8];
  const element = { type: 'freedraw', points: [[0, 0], [10, -2]], pressures: [.2, .8], customData: { inkRawPoints: raw, inkRawPressures: rawPressures, nested: { label: 'original' } } } as unknown as Element;
  const first = snapshotElement(element), second = snapshotElement(element);
  assert.equal(first.customData!.inkRawPoints, raw);
  assert.equal(second.customData!.inkRawPoints, raw);
  assert.equal(first.customData!.inkRawPressures, rawPressures);
  assert.ok(Object.isFrozen(raw)); assert.ok(Object.isFrozen(raw[1])); assert.ok(Object.isFrozen(rawPressures));
  assert.throws(() => { raw[1][0] = 99; }, TypeError);
  assert.throws(() => { rawPressures[0] = 1; }, TypeError);
  (element.customData!.nested as { label: string }).label = 'edited';
  assert.deepEqual(first.customData!.nested, { label: 'original' });
  assert.notEqual(first.customData, second.customData);
  assert.equal(snapshotElement({ ...element, customData: undefined }).customData, undefined);
  const shallowFrozen = Object.freeze([[1, 2] as [number, number]]);
  snapshotElement({ ...element, customData: { inkRawPoints: shallowFrozen } });
  assert.ok(Object.isFrozen(shallowFrozen[0]));
});

test('session append reuses committed prefix and snapshots only new objects across undo and reorder', () => {
  const session = new Session(new DocumentStore({} as FileIO, 'x', newManifest('Test', 'pages')));
  const a = { id: 'a', version: 1, x: 1, type: 'rectangle' } as Element;
  session.change('p', [a]);
  const previous = session.surfaces.get('p')!;
  const b = { ...a, id: 'b', x: 2 };
  session.change('p', [...previous, b]);
  const after = session.surfaces.get('p')!;
  assert.equal(after[0], previous[0]); assert.notEqual(after[1], b);
  session.change('p', [after[1], after[0]]);
  assert.equal(session.surfaces.get('p')![0], after[1]);
  assert.deepEqual(session.bodyHistory.undo()!.elements, after);
  assert.deepEqual(session.bodyHistory.undo()!.elements, previous);
  assert.deepEqual(session.bodyHistory.redo()!.elements, after);
  clearTimeout(session.timer);
});

for (const method of ['changeMany', 'editContent'] as const) {
  test(`${method} rejects unloaded pages before changing any content, dirty blocks or history`, async () => {
    const { session, store } = autosaveSession();
    const a = { id: 'a', version: 1, x: 10, type: 'rectangle' } as Element;
    const b = { ...a, id: 'b', x: 20 };
    session.manifest.chunks['page-b/000000'] = 'stored-b';
    store.readSurface = async id => id === 'page-a' ? [a] : [b];
    await session.load('page-a');
    const original = session.surfaces.get('page-a');
    const tracker = session.trackers.get('page-a');
    const dirty = new Map(session.dirty), revisions = new Map(session.revisions);
    const historyRevision = session.bodyHistory.revision;
    const groups = new Map([['page-a', [{ ...a, version: 2, x: 30 }]], ['page-b', [{ ...b, version: 2, x: 40 }]]]);
    assert.throws(() => session[method](groups), /编辑前必须加载/);
    assert.equal(session.surfaces.get('page-a'), original);
    assert.equal(session.trackers.get('page-a'), tracker);
    assert.deepEqual(session.dirty, dirty); assert.deepEqual(session.revisions, revisions);
    assert.equal(session.bodyHistory.revision, historyRevision);
    assert.equal(session.saveState, 'saved'); assert.equal(session.timer, undefined);
    await session.load('page-b');
    try {
      session[method](groups);
      assert.equal(session.dirty.size, 2);
      const undo = session.bodyHistory.undo()!;
      assert.equal(undo.parts.length, 2);
      session.changeMany(new Map(undo.parts.map(part => [part.surface, part.elements])), false);
      assert.deepEqual(session.surfaces.get('page-a'), [a]);
      assert.deepEqual(session.surfaces.get('page-b'), [b]);
      assert.equal(session.bodyHistory.canUndo, false);
    } finally { clearTimeout(session.timer); }
  });
}

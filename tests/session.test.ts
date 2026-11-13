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

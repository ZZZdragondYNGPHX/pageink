import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetInkJournal, recordInkMutation, inkSnapshotChanges, inkSceneRevision } from '../src/kernel-journal';
import type { Element } from '../src/model';
test('snapshot journal invalidates replacements and retains changed/deleted objects', () => {
  const a = {id:'a', version:1} as Element, source = new Map([['a', a]]), retained = new Map<string,Element>();
  const scene = {getElementsMapIncludingDeleted: () => source};
  resetInkJournal(scene); assert.equal(inkSnapshotChanges(source, retained), null);
  assert.deepEqual(inkSnapshotChanges(source, retained), []);
  const changed = {...a,version:2,isDeleted:true}; source.set('a', changed); recordInkMutation(scene, changed);
  assert.deepEqual(inkSnapshotChanges(source, retained), [changed]);
  assert.deepEqual(inkSnapshotChanges(retained, retained), []);
  resetInkJournal(scene); assert.equal(inkSnapshotChanges(source, retained), null);
});
test('render revision survives journal consumption and invalidates a replacement of the same map', () => {
  const source = new Map<string, Element>(), retained = new Map<string, Element>();
  const scene = { getElementsMapIncludingDeleted: () => source };
  resetInkJournal(scene); const initial = inkSceneRevision(source);
  recordInkMutation(scene, { id: 'a' } as Element);
  const changed = inkSceneRevision(source); assert.ok(changed > initial);
  inkSnapshotChanges(source, retained); assert.equal(inkSceneRevision(source), changed);
  resetInkJournal(scene); assert.ok(inkSceneRevision(source) > changed);
  const replacement = new Map<string, Element>();
  resetInkJournal({ getElementsMapIncludingDeleted: () => replacement });
  assert.ok(inkSceneRevision(replacement) > inkSceneRevision(source));
});
test('empty scenes skipped by unchanged replacement still track their first stroke', () => {
  const source = new Map<string, Element>(), retained = new Map<string, Element>();
  const scene = { getElementsMapIncludingDeleted: () => source };
  const empty = inkSceneRevision(source);
  const stroke = { id: 'first', version: 1 } as Element;
  source.set(stroke.id, stroke); recordInkMutation(scene, stroke);
  assert.ok(inkSceneRevision(source) > empty);
  assert.equal(inkSnapshotChanges(source, retained), null);
  Object.assign(stroke, { version: 2 }); recordInkMutation(scene, stroke);
  assert.deepEqual(inkSnapshotChanges(source, retained), [stroke]);
});

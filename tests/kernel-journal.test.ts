import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetInkJournal, recordInkMutation, inkSnapshotChanges } from '../src/kernel-journal';
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

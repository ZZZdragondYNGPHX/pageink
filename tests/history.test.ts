import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../src/history';
import type { Element } from '../src/model';
const e = (id:string, version=1) => ({id, version}) as Element;
test('range history reconstructs reorder, delete, edit and append across pages', () => {
  const h = new History(), a=e('a'), b=e('b'), c=e('c'), newer=e('a',2);
  h.push('p1',[],[a,b,c]); h.push('p2',[],[e('d')]);
  h.push('p1',[a,b,c],[c,a,b]); h.push('p1',[c,a,b],[c,newer]);
  assert.deepEqual(h.undo()?.elements,[c,a,b]); assert.deepEqual(h.undo()?.elements,[a,b,c]);
  assert.equal(h.undo()?.surface,'p2'); assert.deepEqual(h.undo()?.elements,[]);
  assert.deepEqual(h.redo()?.elements,[a,b,c]); h.redo(); h.redo();
  assert.deepEqual(h.redo()?.elements,[c,newer]);
});

test('history skips equivalent copies in one prefix pass and preserves edits after that prefix', () => {
  const h = new History(), a = e('a'), b = e('b'), c = e('c');
  h.push('p', [], [a, b]);
  const revision = h.revision;
  h.push('p', [a, b], [{ ...a }, { ...b }]);
  assert.equal(h.revision, revision);
  const next = [{ ...a }, e('b', 2), c];
  h.push('p', [a, b], next);
  assert.deepEqual(h.undo()!.elements, [a, b]);
  assert.deepEqual(h.redo()!.elements, next);
});

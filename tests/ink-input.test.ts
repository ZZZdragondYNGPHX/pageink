import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preserveInkSamples, inkPointerSamples } from '../src/ink-input';

const event = (x: number, pressure = .5, coalesced: PointerEvent[] = []) => ({ clientX: x, pressure, getCoalescedEvents: () => coalesced }) as PointerEvent;
const scheduler = (consume: (event: PointerEvent) => void) => {
  let latest: PointerEvent | undefined;
  return Object.assign((event: PointerEvent) => { latest = event; }, {
    flush: () => { if (latest) { const next = latest; latest = undefined; consume(next); } },
    cancel: () => { latest = undefined; },
  });
};

test('one frame update retains all delivered and coalesced positions and pressures in order', () => {
  const first = event(1, .2), coalesced = [event(2, .3), event(3, .4)], last = event(3, .4, coalesced);
  const received: number[][] = []; let updates = 0;
  const handler = preserveInkSamples(scheduler, native => {
    updates++;
    assert.equal(native, last);
    received.push(...inkPointerSamples(native).map(p => [p.clientX, p.pressure]));
  });
  handler(first); handler(last);
  assert.equal(updates, 0);
  handler.flush(); assert.equal(updates, 1);
  assert.deepEqual(received, [[1, .2], [2, .3], [3, .4]]);
  handler.flush(); assert.equal(updates, 1);
  assert.deepEqual(inkPointerSamples(last), [last]);
});

test('pen-up flushes the final batch; cancellation and a thrown update retain no old samples', () => {
  const received: number[][] = [];
  const handler = preserveInkSamples(scheduler, native => received.push(inkPointerSamples(native).map(p => p.clientX)));
  handler(event(1)); handler.cancel(); handler.flush(); assert.deepEqual(received, []);
  handler(event(2)); handler(event(3)); handler.flush(); assert.deepEqual(received, [[2, 3]]);
  const failed = event(4), throwing = preserveInkSamples(scheduler, () => { throw Error('failed update'); });
  throwing(failed); assert.throws(() => throwing.flush(), /failed update/);
  assert.deepEqual(inkPointerSamples(failed), [failed]);
});
test('other pointer IDs cannot mix a palm or mouse sample into the active stroke', () => {
  const received: number[] = [];
  const handler = preserveInkSamples(scheduler, native => received.push(...inkPointerSamples(native).map(p => p.clientX)), 7);
  handler({ ...event(1), pointerId: 7 } as PointerEvent);
  handler({ ...event(500), pointerId: 8 } as PointerEvent);
  handler({ ...event(2), pointerId: 7 } as PointerEvent);
  handler.flush(); assert.deepEqual(received, [1, 2]);
});

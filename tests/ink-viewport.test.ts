import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearInkViewport, commitInkViewport, deferInkViewport, recordInkRenderCost, setInkGestureActive, shouldDeferInkViewport, type InkRasterView } from '../src/ink-viewport';

const canvas = () => ({
  isConnected: true, dataset: {} as Record<string, string>,
  style: { transform: '', transformOrigin: '', removeProperty(name: string) { if (name === 'transform') this.transform = ''; } },
}) as unknown as HTMLCanvasElement;
const view = (): InkRasterView => ({ source: {}, revision: 1, key: 'size/theme/grid', zoom: 1, scrollX: 20, scrollY: -30 });

test('viewport preview keeps scene coordinates aligned and redraws only the latest settled view', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const target = canvas(), base = view(), calls: string[] = [];
  commitInkViewport(target, base);
  assert.equal(deferInkViewport(target, { ...base, zoom: 2, scrollX: 10, scrollY: 40 }, () => calls.push('old')), true);
  assert.equal(target.style.transform, 'matrix(2, 0, 0, 2, -20, 140)');
  context.mock.timers.tick(100);
  assert.equal(deferInkViewport(target, { ...base, zoom: .5, scrollX: 40, scrollY: -10 }, () => calls.push('latest')), true);
  assert.equal(target.style.transform, 'matrix(0.5, 0, 0, 0.5, 10, 10)');
  context.mock.timers.tick(119); assert.deepEqual(calls.slice(), []);
  context.mock.timers.tick(1); assert.deepEqual(calls, ['latest']);
  assert.equal(target.style.transform, '');
  assert.equal(target.dataset.inkViewportPreview, undefined);
  assert.equal(deferInkViewport(target, base, () => calls.push('loop')), false);
});

test('edits, scene replacements, backing size and theme changes invalidate the preview immediately', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const change of [{ revision: 2 }, { source: {} }, { key: 'different' }]) {
    const target = canvas(), base = view(); let calls = 0;
    commitInkViewport(target, base);
    deferInkViewport(target, { ...base, zoom: 2 }, () => calls++);
    assert.equal(deferInkViewport(target, { ...base, zoom: 2, ...change }, () => calls++), false);
    assert.equal(target.style.transform, '');
    context.mock.timers.tick(200); assert.equal(calls, 0);
  }
});

test('returning to the original view or removing the canvas cancels deferred work', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const target = canvas(), base = view(); let calls = 0;
  commitInkViewport(target, base);
  deferInkViewport(target, { ...base, zoom: 2 }, () => calls++);
  assert.equal(deferInkViewport(target, base, () => calls++), false);
  context.mock.timers.tick(200); assert.equal(calls, 0);
  deferInkViewport(target, { ...base, zoom: 2 }, () => calls++);
  Object.defineProperty(target, 'isConnected', { value: false });
  context.mock.timers.tick(200); assert.equal(calls, 0);
  clearInkViewport(target);
});
test('settled redraw holds one visible snapshot and releases its backing on completion or an edit', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const globals = globalThis as { createEl?: unknown };
  const previousCreateEl = globals.createEl;
  try {
    for (const complete of [true, false]) {
      const target = canvas(), base = view(), classes = new Set<string>();
      const snapshot = { width: 0, height: 0, style: { width: '', height: '', transform: '', removeProperty() { this.transform = ''; } }, className: '',
        attributes: {} as Record<string, string>, removed: false,
        setAttribute(name: string, value: string) { this.attributes[name] = value; },
        getContext() { return { drawImage() {} }; }, remove() { this.removed = true; } };
      globals.createEl = () => snapshot;
      Object.assign(target, { width: 400, height: 300, parentElement: {},
        ownerDocument: {}, after() {},
        classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } });
      commitInkViewport(target, base);
      deferInkViewport(target, { ...base, zoom: 2 }, () => {});
      context.mock.timers.tick(120);
      assert.equal(snapshot.width, 400); assert.equal(snapshot.height, 300);
      assert.equal(snapshot.attributes['aria-hidden'], 'true');
      assert.equal(snapshot.style.transform, 'matrix(2, 0, 0, 2, 0, 0)');
      assert.equal(classes.has('ink-viewport-redraw'), true);
      if (complete) {
        // A second gesture interrupts a still-pending crisp redraw, using the
        // original bitmap's coordinates rather than drifting from the last view.
        const latest = { ...base, zoom: 3, scrollX: 10 }; let redrawn = 0;
        assert.equal(deferInkViewport(target, latest, () => {
          redrawn++;
          assert.equal(deferInkViewport(target, latest, () => redrawn++), false);
        }), true);
        assert.equal(snapshot.style.transform, 'matrix(3, 0, 0, 3, -30, 0)');
        context.mock.timers.tick(120); assert.equal(redrawn, 1);
        commitInkViewport(target, latest);
      }
      else deferInkViewport(target, { ...base, revision: 2 }, () => {});
      assert.equal(snapshot.width, 0); assert.equal(snapshot.height, 0);
      assert.equal(snapshot.removed, true); assert.equal(classes.has('ink-viewport-redraw'), false);
      clearInkViewport(target);
    }
  } finally {
    if (previousCreateEl === undefined) delete globals.createEl;
    else globals.createEl = previousCreateEl;
  }
});
test('ordinary scenes render live without scroll cutoff; dense scenes defer only within a bounded pan shift', () => {
  const target = canvas(), base = view();
  commitInkViewport(target, base);
  recordInkRenderCost(target, 3);
  // Moderate scene: panning and zooming render live (no cutoff/truncation).
  assert.equal(shouldDeferInkViewport(target, { ...base, scrollY: base.scrollY - 200 }, 200, 1000, 800), false);
  assert.equal(shouldDeferInkViewport(target, { ...base, zoom: 1.5 }, 200, 1000, 800), false);
  // Single-frame heavy scene (<2000): small pan defers, >22% shift forces refresh.
  assert.equal(shouldDeferInkViewport(target, { ...base, scrollY: base.scrollY - 80 }, 1500, 1000, 800), true);
  assert.equal(shouldDeferInkViewport(target, { ...base, scrollY: base.scrollY - 260 }, 1500, 1000, 800), false);
  // Progressive mega-scene (>=2000): stays deferred during continuous scroll so progressive redraws aren't repeatedly cleared.
  assert.equal(shouldDeferInkViewport(target, { ...base, scrollY: base.scrollY - 260 }, 2500, 1000, 800), true);
  // Active pinch gesture defers zoom redraws even on light scenes so pinch stays locked to GPU transform.
  setInkGestureActive(target, true);
  assert.equal(shouldDeferInkViewport(target, { ...base, zoom: 1.5 }, 120, 1000, 800), true);
  assert.equal(shouldDeferInkViewport(target, { ...base, scrollY: base.scrollY - 200 }, 120, 1000, 800), false);
  setInkGestureActive(target, false);
  assert.equal(shouldDeferInkViewport(target, { ...base, zoom: 1.5 }, 120, 1000, 800), false);
  // Slow render cost (>10ms) also enables bounded deferral.
  recordInkRenderCost(target, 25);
  recordInkRenderCost(target, 25);
  assert.equal(shouldDeferInkViewport(target, { ...base, scrollY: base.scrollY - 60 }, 400, 1000, 800), true);
  clearInkViewport(target);
});

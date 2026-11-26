import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { preserveInkSamples, inkPointerSamples, stabilizeInkPoint, stabilizedRawPoints } from '../src/ink-input';
import type { Element } from '../src/model';

// Execute the checked patched bodies against controlled scene/input boundaries.
// This catches runtime regressions that a successful string match cannot detect.
const patched = (async () => {
  const { kernelPatch } = await import(new URL('../scripts/kernel-patch.mjs', import.meta.url).href);
  const loaders: { filter: RegExp; load: (args: { path: string }) => Promise<{ contents: string }> }[] = [];
  kernelPatch.setup({
    onLoad: ({ filter }: { filter: RegExp }, load: typeof loaders[number]['load']) => loaders.push({ filter, load }),
    onResolve: () => {},
  });
  const load = async (file: string) => {
    const path = resolve(`node_modules/@excalidraw/excalidraw/dist/dev/${file}`);
    return (await loaders.find(item => item.filter.test(path))!.load({ path })).contents;
  };
  return { core: await load('chunk-4FTI6OG3.js'), app: await load('index.js') };
})();

function between(source: string, start: string, end: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing patched body: ${start}`);
  return source.slice(from, to);
}

test('kernel append updates scene indexes and journals locally, with fallback for unsafe batches', async () => {
  const { core } = await patched;
  const body = between(core, '  inkAppend(items) {', '\n  inkErase(patches) {');
  const synced: Element[][] = [], spatial: Element[] = [], journal: Element[] = [], mapped: Element[] = [];
  const Scene = new Function('syncMovedIndices', 'arrayToMap', '_Scene', 'updateInkElement', 'recordInkMutation', 'isFrameLikeElement', `return class { ${body} }`)(
    (tail: Element[]) => synced.push(tail),
    (items: Element[]) => new Map(items.map(e => [e.id, e])),
    { mapElementToScene: (e: Element) => mapped.push(e) },
    (_scene: unknown, e: Element) => spatial.push(e),
    (_scene: unknown, e: Element) => journal.push(e),
    (e: Element) => e.type === 'frame' || e.type === 'magicframe',
  );
  const old = { id: 'old', type: 'freedraw' } as Element, a = { id: 'a', type: 'freedraw' } as Element, b = { id: 'b', type: 'rectangle' } as Element;
  const scene = Object.assign(new Scene(), {
    elements: [old], nonDeletedElements: [old], elementsMap: new Map([[old.id, old]]), nonDeletedElementsMap: new Map([[old.id, old]]),
    updates: 0, replaced: null as Element[] | null,
    triggerUpdate() { this.updates++; },
    replaceAllElements(elements: Element[]) { this.replaced = elements; },
  });
  const original = scene.elements;
  scene.inkAppend([a, b]);
  assert.deepEqual(scene.elements, [old, a, b]);
  assert.deepEqual(original, [old]);
  assert.deepEqual(scene.nonDeletedElements, scene.elements);
  assert.equal(scene.elementsMap.get('a'), a); assert.equal(scene.nonDeletedElementsMap.get('b'), b);
  assert.deepEqual(synced, [[old, a, b]]);
  assert.deepEqual(mapped, [a, b]); assert.deepEqual(spatial, mapped); assert.deepEqual(journal, mapped);
  assert.equal(scene.updates, 1); assert.equal(scene.replaced, null);
  scene.inkAppend([]); assert.equal(scene.updates, 1);
  for (const unsafe of [
    [a], [{ id: 'new', isDeleted: true }], [{ id: 'new', frameId: 'f' }],
    [{ id: 'new', containerId: 'label' }],
    [{ id: 'new', startBinding: { elementId: 'a' } }], [{ id: 'new', endBinding: { elementId: 'b' } }],
    [{ id: 'new', boundElements: [{ id: 'label', type: 'text' }] }],
    [{ id: 'new', type: 'frame' }], [{ id: 'new' }, { id: 'new' }],
  ]) {
    scene.inkAppend(unsafe);
    assert.deepEqual(scene.replaced, [...scene.elements, ...unsafe]);
    assert.equal(scene.updates, 1);
  }
});

test('kernel pen-up preserves raw move samples and down/up-only endpoints without DOM reads', async () => {
  const { app } = await patched;
  const start = app.indexOf('        const rawEndDx = pointerCoords.x - newElement2.x;');
  const end = app.indexOf('\n        });', start) + '\n        });'.length;
  assert.ok(start >= 0 && end > start);
  const commit = new Function('newElement2', 'points', 'pointerCoords', 'pointerDownState', 'childEvent', 'stabilizedRawPoints', 'pointFrom', 'mutateElement', app.slice(start, end));
  const finish = (stroke: Record<string, unknown>, x: number, y: number, level: number) => {
    commit(stroke, stroke.points, { x, y }, { inkStabilizeLevel: level }, { pressure: 0 }, stabilizedRawPoints, (x: number, y: number) => [x, y], Object.assign);
    return stroke as unknown as Extract<Element, { type: 'freedraw' }>;
  };
  const stroke = { x: 10, y: 20, points: [[0, 0]], pressures: [.2], customData: { inkKind: 'pen' } };
  stabilizeInkPoint(stroke, 1, 10, 5); stabilizeInkPoint(stroke, 1, 10, 5);
  const committed = finish(stroke, 40, 35, 1);
  assert.deepEqual(committed.customData!.inkRawPoints, [[0, 0], [10, 5], [10, 5], [30, 15]]);
  assert.deepEqual(committed.lastCommittedPoint, [30, 15]);
  assert.equal(committed.customData!.inkKind, 'pen');
  const tap = finish({ x: 10, y: 20, points: [[0, 0]], pressures: [.5] }, 10, 20, 2);
  assert.deepEqual(tap.customData!.inkRawPoints, [[0, 0], [0, 0]]);
  assert.deepEqual(tap.lastCommittedPoint, [.0001, .0001]);
  const plain = finish({ x: 0, y: 0, points: [[0, 0]], pressures: [.5] }, 30, 40, 0);
  assert.equal(plain.customData, undefined);
});

test('kernel point size scans once, caches frozen points and handles long or empty paths', async () => {
  const { core } = await patched;
  const bounds = between(core, 'var inkFrozenPointBounds = new WeakMap();', '\nvar getFreeDrawElementAbsoluteCoords');
  const size = between(core, 'var getSizeFromPoints = (points) => {', '\nvar rescalePoints');
  const measure = new Function(`${bounds}\n${size}\nreturn getSizeFromPoints;`)();
  const points = Array.from({ length: 200000 }, (_, i) => [i - 100000, i % 10]);
  assert.deepEqual(measure(points), { width: 199999, height: 9 });
  let scans = 0;
  const frozen = [[-5, 10], [20, -30]];
  Object.defineProperty(frozen, Symbol.iterator, { value: function* () { scans++; yield* [frozen[0], frozen[1]]; } });
  Object.freeze(frozen);
  assert.deepEqual(measure(frozen), { width: 25, height: 40 });
  measure(frozen); assert.equal(scans, 1);
  points[0] = [-200000, -50]; assert.equal(measure(points).width, 299999);
  assert.deepEqual(measure([]), { width: -Infinity, height: -Infinity });
});

test('kernel SVG export keeps its original stroke geometry and serialization', async () => {
  const { core } = await patched;
  const upstream = await readFile(resolve('node_modules/@excalidraw/excalidraw/dist/dev/chunk-4FTI6OG3.js'), 'utf8');
  const start = 'function getFreeDrawSvgPath(element) {', end = '\n// scene/Shape.ts';
  assert.equal(between(core, start, end), between(upstream, start, end));
});

test('static renderer reuses owner sets on append and skips ownership work during viewport deferral', async () => {
  const { core } = await patched;
  const body = between(core, 'var inkStaticRaster = new WeakMap();', '\nvar renderStaticSceneThrottled');
  let sets = 0, defer = false, renders = 0;
  const released: object[] = [];
  class CountedSet<T> extends Set<T> { constructor(values?: readonly T[]) { super(values); sets++; } }
  const noop = () => {};
  const deps = {
    Set: CountedSet, cancelAnimationFrame: noop,
    discardInkViewport: noop, clearInkViewport: noop, commitInkViewport: noop, stageInkViewport: noop,
    shouldDeferInkViewport: () => defer, deferInkViewport: () => true, inkSceneRevision: () => 1,
    releaseInkElementCanvas: (element: object) => released.push(element),
    pathsCache: new WeakMap(), ShapeCache: new WeakMap(), recordInkRenderCost: noop,
    _renderStaticSceneUncached: () => renders++, renderElement: () => renders++, performance,
    CustomEvent: class {},
  };
  const render = new Function('deps', `const { ${Object.keys(deps).join(', ')} } = deps;\n${body}\nreturn _renderStaticScene;`)(deps);
  const context = { setTransform: noop, save: noop, restore: noop };
  const canvas = { width: 800, height: 600, classList: { contains: () => true }, dataset: {}, dispatchEvent: noop, getContext: () => context };
  const a = { id: 'a', type: 'freedraw', versionNonce: 1 }, b = { id: 'b', type: 'freedraw', versionNonce: 2 };
  const config = { canvas, visibleElements: [a], appState: { width: 800, height: 600, zoom: { value: 1 }, scrollX: 0, scrollY: 0 }, renderConfig: {}, scale: 1, allElementsMap: new Map() };
  render(config); assert.equal(sets, 1); assert.equal(renders, 1);
  render({ ...config, visibleElements: [a, b] });
  assert.equal(sets, 1); assert.equal(renders, 2); assert.deepEqual(released, []);
  defer = true;
  render({ ...config, visibleElements: [] });
  assert.equal(sets, 1); assert.equal(renders, 2); assert.deepEqual(released, []);
  defer = false;
  render(config);
  assert.equal(sets, 2); assert.deepEqual(released, [b]);
  // Cancelled transient strokes (never entering visibleElements) must be released when cleared.
  const cancelled = { id: 'c', type: 'freedraw', versionNonce: 3 };
  render({ ...config, appState: { ...config.appState, newElement: cancelled } });
  render({ ...config, appState: { ...config.appState, newElement: null } });
  assert.deepEqual(released, [b, cancelled]);
});

test('kernel inkSyncRaw flushes queued coalesced moves before committing raw points and version', async () => {
  const { app } = await patched;
  const start = app.indexOf('inkSyncRaw: () => {');
  const end = app.indexOf('inkAppend:', start);
  assert.ok(start >= 0 && end > start);
  const fnBody = app.slice(start + 'inkSyncRaw: '.length, end).trim().replace(/,\s*$/, '');
  let mutated = 0;
  const stroke = { id: 'live', type: 'freedraw', version: 1, points: [[0, 0]], pressures: [0.5], customData: { inkKind: 'pen' } as Record<string, unknown> };
  const owner = { state: { newElement: stroke, activeTool: { type: 'freedraw' } }, inkMoveFlush: null as (() => void) | null };
  const scheduleBody = between(app, '    const scheduleMove = this.state.activeTool.type === "freedraw"', '\n    return scheduleMove((event) => {');
  const scheduler = (consume: (event: PointerEvent) => void) => {
    let pending: PointerEvent | undefined;
    return Object.assign((event: PointerEvent) => { pending = event; }, {
      flush() { if (pending) { const event = pending; pending = undefined; consume(event); } },
      cancel() { pending = undefined; },
    });
  };
  const createMove = new Function('preserveInkSamples', 'withBatchedUpdatesThrottled', 'pointerDownState', 'consume', `${scheduleBody}\nreturn scheduleMove(consume);`);
  const down = { inkPointerId: 7, inkMoveFlush: null as (() => void) | null };
  const move = createMove.call(owner, preserveInkSamples, scheduler, down, (event: PointerEvent) => {
    for (const sample of inkPointerSamples(event)) {
      stroke.points.push(stabilizeInkPoint(stroke, 1, sample.clientX, sample.clientY));
      stroke.pressures.push(sample.pressure);
    }
  });
  move({ pointerId: 7, getCoalescedEvents: () => [
    { clientX: 12, clientY: 8, pressure: .3 }, { clientX: 24, clientY: 16, pressure: .8 },
  ] });
  assert.equal(stroke.points.length, 1);
  const syncRaw = new Function('stabilizedRawPoints', 'mutateElement', `return (function() { return (${fnBody}); }).call(this);`).call(
    owner,
    stabilizedRawPoints,
    (el: Record<string, unknown>, updates: Record<string, unknown>, informMutation: boolean) => { assert.equal(informMutation, false); assert.equal(stroke.points.length, 3); Object.assign(el, updates); el.version = Number(el.version) + 1; mutated++; },
  );
  syncRaw();
  assert.equal(mutated, 1);
  assert.deepEqual(stroke.customData.inkRawPoints, [[0, 0], [12, 8], [24, 16]]);
  assert.equal(stroke.version, 2);
  assert.deepEqual(stroke.pressures, [.5, .3, .8]);
  syncRaw();
  assert.equal(mutated, 1);
  const second = createMove.call(owner, preserveInkSamples, scheduler, { inkPointerId: 8 }, () => {});
  const secondFlush = owner.inkMoveFlush;
  move.cancel(); assert.equal(owner.inkMoveFlush, secondFlush);
  const upBody = between(app, '  onPointerUpFromPointerDownHandler(pointerDownState) {', '      const {\n        newElement: newElement2,');
  const Up = new Function('withBatchedUpdates', `return class { ${upBody} }); } }`)((fn: unknown) => fn);
  const upOwner = Object.assign(new Up(), owner, { removePointer() {} });
  const up = upOwner.onPointerUpFromPointerDownHandler({ ...down, eventListeners: { onMove: move } });
  up({ type: 'pointerup', pointerId: 99 }); assert.equal(upOwner.inkMoveFlush, secondFlush);
  up({ type: 'pointerup', pointerId: 7 }); assert.equal(upOwner.inkMoveFlush, secondFlush);
  const secondDown = { inkPointerId: 8, inkMoveFlush: secondFlush, eventListeners: { onMove: second } };
  const secondUp = upOwner.onPointerUpFromPointerDownHandler(secondDown);
  secondUp({ type: 'pointercancel', pointerId: 8 }); assert.equal(upOwner.inkMoveFlush, null);
  second.cancel(); assert.equal(owner.inkMoveFlush, null);
  owner.state.activeTool.type = 'rectangle';
  createMove.call(owner, preserveInkSamples, scheduler, {}, () => {});
  assert.equal(owner.inkMoveFlush, null);
});

// Real isolated Obsidian host; generated ink and mouse input, no device claims.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { launch, shot } from './obsidian.mjs';

const label = process.argv[2] ?? 'current';
const { page, close } = await launch();
const hostWindow = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio, userAgent: navigator.userAgent }));
const results = [], errors = [], soak = {};
let failure = null;
const sha256 = createHash('sha256').update(await readFile(new URL('../dist/main.js', import.meta.url))).digest('hex');
const sourceMap = new TraceMap(JSON.parse(await readFile(new URL('../dist/main.js.map', import.meta.url), 'utf8')));
page.on('pageerror', error => errors.push(error.message));
const root = () => page.locator('.workspace-leaf.mod-active .ink-workspace');
const ready = async () => {
  await page.waitForFunction(() => window.app.workspace.activeLeaf.view.session?.flushers.has('body'));
  await root().locator('.ink-canvas-status').waitFor({ state: 'hidden' });
};
const settled = async () => {
  await page.waitForTimeout(250);
  await page.waitForFunction(() => !document.querySelector('.workspace-leaf.mod-active canvas.static[data-ink-render-state="drawing"], .workspace-leaf.mod-active canvas.static[data-ink-viewport-preview]'), undefined, { timeout: 120000 });
};
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.floor(sorted.length * .5)] ?? 0, p95: sorted[Math.floor(sorted.length * .95)] ?? 0, max: sorted.at(-1) ?? 0 };
};
const hotspots = profile => {
  const weights = new Map();
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node);
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) weights.set(profile.samples[i], (weights.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));
  return profile.nodes.map(n => {
    const frame = n.callFrame;
    const source = frame.url.includes('pageink') && frame.lineNumber >= 0 ? originalPositionFor(sourceMap, { line: frame.lineNumber + 1, column: frame.columnNumber }) : {};
    const stack = []; let parent = parents.get(n.id);
    while (parent && stack.length < 5) {
      const call = parent.callFrame;
      const original = call.url.includes('pageink') && call.lineNumber >= 0 ? originalPositionFor(sourceMap, { line: call.lineNumber + 1, column: call.columnNumber }) : {};
      stack.push(`${original.source || call.functionName}:${original.line || call.lineNumber + 1}`); parent = parents.get(parent.id);
    }
    return { function: source.name || frame.functionName || '(anonymous)', ms: (weights.get(n.id) ?? 0) / 1000, source: source.source || frame.url.split('/').at(-1), line: source.line || frame.lineNumber + 1, stack };
  }).sort((a, b) => b.ms - a.ms).slice(0, 20);
};
try {
  await page.evaluate(async () => {
    const app = window.app;
    app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse();
    await app.plugins.plugins.pageink.create('pages');
  });
  await ready();
  const box = await root().locator('.ink-canvas-area').boundingBox();
  await page.mouse.move(box.x + 300, box.y + 180);
  await page.mouse.down(); await page.mouse.move(box.x + 340, box.y + 195, { steps: 10 }); await page.mouse.up();
  await settled();
  await page.evaluate(() => {
    const canvas = document.querySelector('.workspace-leaf.mod-active canvas.interactive');
    let fiber = canvas[Object.keys(canvas).find(key => key.startsWith('__reactFiber$'))];
    while (fiber && !(fiber.stateNode?.scene && fiber.stateNode?.updateScene)) fiber = fiber.return;
    if (!fiber) throw Error('Cannot locate the pinned editing kernel');
    window.stressKernel = fiber.stateNode;
    window.stressSeed = structuredClone(window.stressKernel.getSceneElements()[0]);
    window.stressMetrics = null;
    new PerformanceObserver(list => {
      if (window.stressMetrics) window.stressMetrics.longTasks.push(...list.getEntries().map(e => e.duration));
    }).observe({ type: 'longtask' });
    canvas.addEventListener('pointerdown', () => {
      if (!window.stressMetrics) return;
      const started = performance.now(), metrics = window.stressMetrics;
      requestAnimationFrame(() => metrics.down.push(performance.now() - started));
    }, true);
    canvas.addEventListener('pointermove', event => {
      if (!event.buttons || !window.stressMetrics) return;
      const started = performance.now(), metrics = window.stressMetrics;
      requestAnimationFrame(() => metrics.move.push(performance.now() - started));
    }, true);
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  const cases = [
    { total: 100, packed: false },
    { total: 1000, packed: false },
    { total: 10000, packed: false },
    { total: 50000, packed: false },
    { total: 10000, packed: true },
  ];
  if (process.env.PAGEINK_STRESS_QUICK) cases.splice(0, cases.length, { total: 1000, packed: false }, { total: 10000, packed: true });
  for (const fixture of cases) {
    await page.evaluate(({ total, packed }) => {
      const kernel = window.stressKernel, seed = window.stressSeed;
      const points = Array.from({ length: 48 }, (_, i) => [i * .45, Math.sin(i * .32) * 3 + i * .1]);
      const columns = packed ? 100 : 20, dx = packed ? 5 : 28, dy = packed ? 6 : 23;
      const elements = Array.from({ length: total }, (_, i) => ({
        ...seed, id: `stress-${total}-${packed ? 'packed' : 'spread'}-${i}`, index: null, version: 1, versionNonce: i + 1,
        x: 48 + (i % columns) * dx, y: 80 + Math.floor(i / columns) * dy,
        width: 21.15, height: 10, points: points.map(p => [...p]),
        pressures: points.map(() => .5), lastCommittedPoint: null,
      }));
      kernel.updateScene({ elements, captureUpdate: 'NEVER', appState: { zoom: { value: 1 }, scrollX: 100, scrollY: 0, selectedElementIds: {} } });
    }, fixture);
    await settled();
    await page.evaluate(async () => { await window.app.workspace.activeLeaf.view.session.flushers.get('body')(); });
    await page.waitForTimeout(650);
    await cdp.send('Profiler.start');
    await page.evaluate(() => {
      const metrics = window.stressMetrics = { frames: [], longTasks: [], down: [], move: [] };
      let previous = performance.now();
      const sample = now => {
        if (window.stressMetrics !== metrics) return;
        metrics.frames.push(now - previous); previous = now; requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const zoomStart = Date.now();
    await page.evaluate(async () => {
      const kernel = window.stressKernel;
      for (let i = 0; i < 90; i++) {
        await new Promise(requestAnimationFrame);
        const zoom = 1 + Math.sin(i / 89 * Math.PI * 4) * .45;
        kernel.updateScene({ appState: { zoom: { value: zoom }, scrollX: 330 / zoom - 230, scrollY: 280 / zoom - 280 } });
      }
    });
    await settled();
    const zoomMs = Date.now() - zoomStart;
    const zoom = await page.evaluate(() => { const data = window.stressMetrics; window.stressMetrics = null; return data; });
    const { profile } = await cdp.send('Profiler.stop');
    const hot = hotspots(profile);
    if (label !== 'baseline' && fixture.packed) {
      await page.evaluate(() => window.stressKernel.updateScene({ appState: { zoom: { value: 1.2 }, scrollX: 100, scrollY: 0 } }));
      await page.waitForTimeout(150);
      await page.evaluate(() => window.stressKernel.updateScene({ appState: { zoom: { value: 1.3 }, scrollX: 100, scrollY: 0 } }));
      await page.waitForTimeout(30);
      await page.evaluate(() => window.stressKernel.updateScene({ appState: { zoom: { value: 1.2 }, scrollX: 100, scrollY: 0 } }));
      await settled();
      assert.equal(await root().locator('.ink-viewport-snapshot').count(), 0);
      soak.interruptedRedrawResumesAtSameZoom = true;
    }
    await page.evaluate(() => {
      window.stressKernel.updateScene({ appState: { zoom: { value: 1 }, scrollX: 100, scrollY: 0 } });
    });
    await settled();
    await page.evaluate(() => {
      const e = window.stressKernel.getSceneElements()[0];
      window.stressRaw = JSON.stringify([e.id, e.x, e.y, e.angle, e.points, e.pressures, e.lastCommittedPoint]);
    });
    await cdp.send('Profiler.start');
    await page.evaluate(() => { window.stressMetrics = { frames: [], longTasks: [], down: [], move: [] }; });
    const writingStart = Date.now();
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(box.x + 320, box.y + 190 + i * 17);
      await page.mouse.down();
      await page.mouse.move(box.x + 470, box.y + 200 + i * 17, { steps: 48 });
      await page.mouse.up();
    }
    await settled();
    const writingMs = Date.now() - writingStart;
    const writing = await page.evaluate(async total => {
      const data = window.stressMetrics; window.stressMetrics = null;
      const kernel = window.stressKernel;
      if (kernel.getSceneElements().length !== total + 6) throw Error('Stress writing lost or erased elements');
      const e = kernel.getSceneElements()[0];
      if (window.stressRaw !== JSON.stringify([e.id, e.x, e.y, e.angle, e.points, e.pressures, e.lastCommittedPoint])) throw Error('Stress changed existing raw ink');
      const session = window.app.workspace.activeLeaf.view.session;
      await session.flushers.get('body')();
      return data;
    }, fixture.total);
    const writingProfile = await cdp.send('Profiler.stop');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const result = { ...fixture, zoomMs, zoomFrames: summary(zoom.frames), zoomLongTasks: summary(zoom.longTasks), writingMs, pointerDownToRAF: summary(writing.down), pointerMoveToRAF: summary(writing.move), writingLongTasks: summary(writing.longTasks), heapMB: heap.usedSize / 1024 ** 2, hot, writingHot: hotspots(writingProfile.profile) };
    results.push(result); console.log(JSON.stringify({ ...result, hot: undefined, writingHot: undefined }));
    await shot(page, `performance-${label}-${fixture.total}-${fixture.packed ? 'packed' : 'spread'}`);
  }
  if (label !== 'baseline') {
    const penFrames = 600, penSamples = penFrames * 4;
    await page.evaluate(() => {
      window.app.plugins.plugins.pageink.prefs.update({ pen: { pressure: true } });
      const target = document.querySelector('.workspace-leaf.mod-active canvas.interactive');
      target.addEventListener('pointerdown', event => { window.stressPenId = event.pointerId; }, { once: true, capture: true });
    });
    await root().locator('.ink-editor-pages[data-pressure="physical"]').waitFor();
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', pointerType: 'pen', button: 'left', buttons: 1, clickCount: 1, force: .5, x: box.x + 300, y: box.y + 190 });
    const simulated = await page.evaluate(async penFrames => {
      const target = document.querySelector('.workspace-leaf.mod-active canvas.interactive');
      const box = target.getBoundingClientRect(), kernel = window.stressKernel;
      const before = kernel.getSceneElements().length, frames = [], longTasks = [], expected = [];
      const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)));
      observer.observe({ type: 'longtask' });
      const emit = sample => {
        const position = sample === 182 ? 181 : sample; // A stationary pressure change must survive too.
        const event = new PointerEvent('pointermove', {
          bubbles: true, pointerId: window.stressPenId, pointerType: 'pen', isPrimary: true, button: -1, buttons: 1,
          pressure: .25 + .5 * (sample % 35) / 34, clientX: box.x + 300 + position * .1, clientY: box.y + 190 + Math.sin(position / 10) * 5,
        });
        expected.push(event.pressure); target.dispatchEvent(event);
      };
      let previous = performance.now();
      for (let frame = 0; frame < penFrames; frame++) {
        await new Promise(requestAnimationFrame);
        const now = performance.now(); frames.push(now - previous); previous = now;
        if (frame === 30) for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) target.dispatchEvent(new PointerEvent(type, {
          bubbles: true, pointerId: window.stressPenId + 100, pointerType: 'touch', isPrimary: true, buttons: 1, clientX: box.x + 700, clientY: box.y + 500,
        }));
        for (let sample = 1; sample <= 4; sample++) emit(frame * 4 + sample);
      }
      const session = window.app.workspace.activeLeaf.view.session;
      if (session.surfaces.get(session.manifest.pages[0].id).length !== before - 1) throw Error('Active pen stroke was committed before pen-up');
      observer.disconnect();
      window.stressExpectedPressure = expected;
      return { frames, longTasks, before };
    }, penFrames);
    const endX = box.x + 300 + penSamples * .1, endY = box.y + 190 + Math.sin(penSamples / 10) * 5;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', pointerType: 'pen', buttons: 1, force: .5, x: endX, y: endY });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', pointerType: 'pen', button: 'left', buttons: 0, clickCount: 1, force: 0, x: endX, y: endY });
    await settled();
    const samples = await page.evaluate(async ({ before, penSamples }) => {
      await window.app.workspace.activeLeaf.view.session.flushers.get('body')();
      const elements = window.stressKernel.getSceneElements(), stroke = elements.at(-1);
      if (elements.length !== before || stroke.points.length < penSamples || stroke.pressures.length !== stroke.points.length) throw Error(`High-rate pen input: got ${elements.length} strokes / ${stroke.points.length} points / ${stroke.pressures.length} pressures`);
      if (JSON.stringify(stroke.pressures.slice(1, penSamples + 1)) !== JSON.stringify(window.stressExpectedPressure)) throw Error('High-rate pressure samples were dropped or reordered');
      return stroke.points.length;
    }, { before: simulated.before, penSamples });
    soak.simulatedPen = { samplesPerFrame: 4, nominalRateHzAt60FPS: 240, durationMs: simulated.frames.reduce((sum, frame) => sum + frame, 0), samples, pressureSamplesPreserved: true, frames: summary(simulated.frames), finalFrames: summary(simulated.frames.slice(-120)), longTasks: summary(simulated.longTasks) };
    await root().getByRole('group', { name: '编辑历史' }).getByRole('button', { name: '撤销', exact: true }).click();
    await page.waitForFunction(count => window.stressKernel.getSceneElements().length === count, simulated.before - 1);
    await settled();
    await page.evaluate(async count => {
      const session = window.app.workspace.activeLeaf.view.session;
      await session.flushers.get('body')();
      if (window.stressKernel.getSceneElements().length !== count) throw Error('One undo did not remove only the high-rate stroke');
    }, simulated.before - 1);
    await root().getByRole('group', { name: '编辑历史' }).getByRole('button', { name: '重做', exact: true }).click();
    await page.waitForFunction(count => window.stressKernel.getSceneElements().length === count, simulated.before);
    await settled();
    const saved = await page.evaluate(async () => {
      const app = window.app, view = app.workspace.activeLeaf.view;
      await view.session.flush();
      const elements = await view.session.read(view.session.manifest.pages[0].id);
      const raw = elements.map(e => [e.id, e.x, e.y, e.angle, e.points, e.pressures, e.lastCommittedPoint]);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(raw))))).join(',');
      return { path: view.file.path, hash, count: elements.length };
    });
    await page.evaluate(async path => {
      const app = window.app;
      window.stressKernel = null;
      await app.workspace.activeLeaf.detach(); await app.plugins.plugins.pageink.openPath(path);
    }, saved.path);
    await ready(); await settled();
    const reopened = await page.evaluate(async () => {
      const session = window.app.workspace.activeLeaf.view.session;
      await session.flushers.get('body')();
      const elements = await session.read(session.manifest.pages[0].id);
      const raw = elements.map(e => [e.id, e.x, e.y, e.angle, e.points, e.pressures, e.lastCommittedPoint]);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(raw))))).join(',');
      return { hash, count: elements.length };
    });
    assert.equal(reopened.count, saved.count); assert.equal(reopened.hash, saved.hash);
    assert.equal(await root().locator('.ink-viewport-snapshot').count(), 0);
    soak.persistence = { strokes: reopened.count, rawGeometryHashPreserved: true, oneStepUndoRedo: true, settledSnapshotReleased: true };
    await page.evaluate(() => {
      const canvas = document.querySelector('.workspace-leaf.mod-active canvas.interactive');
      let fiber = canvas[Object.keys(canvas).find(key => key.startsWith('__reactFiber$'))];
      while (fiber && !(fiber.stateNode?.scene && fiber.stateNode?.updateScene)) fiber = fiber.return;
      window.stressKernel = fiber.stateNode;
      const elements = window.stressKernel.getSceneElements(), seed = elements[0];
      const background = { ...seed, id: 'stress-background', type: 'rectangle', index: null, x: 80, y: 120, width: 160, height: 80,
        version: 1, versionNonce: 98765, backgroundColor: '#cadbfd', fillStyle: 'solid', roundness: null };
      window.stressKernel.updateScene({ elements: [background, ...elements] });
    });
    await settled();
    const mixedFrames = await page.evaluate(async () => {
      const frames = []; let previous = performance.now();
      for (let i = 0; i < 50; i++) {
        await new Promise(requestAnimationFrame);
        const now = performance.now(); frames.push(now - previous); previous = now;
        const zoom = 1 + Math.sin(i / 49 * Math.PI) * .3 + i / 49 * .1;
        window.stressKernel.updateScene({ appState: { zoom: { value: zoom }, scrollX: 330 / zoom - 230, scrollY: 280 / zoom - 280 } });
      }
      return frames;
    });
    await settled();
    await page.mouse.move(box.x + 320, box.y + 240); await page.mouse.down();
    await page.mouse.move(box.x + 430, box.y + 245, { steps: 24 }); await page.mouse.up();
    await settled();
    await page.evaluate(async count => {
      const session = window.app.workspace.activeLeaf.view.session;
      await session.flushers.get('body')();
      const elements = await session.read(session.manifest.pages[0].id);
      if (elements.length !== count + 2 || !elements.some(e => e.id === 'stress-background' && e.type === 'rectangle')) throw Error('Mixed scene lost its shape or appended ink');
    }, saved.count);
    soak.mixedScene = { originalInk: saved.count, zoomFrames: summary(mixedFrames), shapeAndNewInkPreserved: true };
    console.log(JSON.stringify({ soak }));
  }
  assert.deepEqual(errors, []);
} catch (error) {
  failure = error.message;
  console.error(error); process.exitCode = 1;
  console.error(await page.evaluate(() => {
    const session = window.app.workspace.activeLeaf.view.session, history = session?.bodyHistory;
    const part = step => step.parts.map(p => ({ start: p.start, before: p.before.length, after: p.after.length,
      beforeLast: p.before.at(-1) && [p.before.at(-1).id, p.before.at(-1).version, p.before.at(-1).points?.length],
      afterLast: p.after.at(-1) && [p.after.at(-1).id, p.after.at(-1).version, p.after.at(-1).points?.length] }));
    return { kernel: window.stressKernel?.getSceneElements().length, surface: session?.surfaces.get(session.manifest.pages[0].id)?.length,
      newElement: window.stressKernel?.state.newElement?.id, undo: history?.undoStack.slice(-3).map(part), redo: history?.redoStack.slice(-3).map(part) };
  }).then(JSON.stringify).catch(() => 'Host closed'));
  await shot(page, `performance-${label}-failure`).catch(() => {});
}
finally {
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL(`../artifacts/performance-${label}.json`, import.meta.url), JSON.stringify({ date: new Date().toISOString(), sha256, host: 'Obsidian on Linux; generated 48-point strokes; native browser mouse/pen input plus scripted pen bursts', display: process.env.PAGEINK_VIRTUAL_DISPLAY ? 'Xvfb virtual display; no physical device/GPU claim' : 'Shared desktop', hostWindow, results, soak, errors, failure }, null, 2));
  await close();
}

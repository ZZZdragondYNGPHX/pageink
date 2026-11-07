import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
/** Centralized upstream 0.18.1 patch: equal pressure from the first rendered sample. */
export const kernelPatch = {
  name: 'drawing-pressure-adapter',
  setup(build) {
    build.onLoad({ filter: /excalidraw[\\/]dist[\\/]dev[\\/]chunk-AWQI2HM3\.js$/ }, async () => ({
      contents: 'const define_import_meta_env_default = { PKG_NAME: "@excalidraw/excalidraw", PKG_VERSION: "0.18.1", DEV: false, PROD: true, MODE: "production", VITE_APP_ENABLE_TRACKING: "false" }; export { define_import_meta_env_default };',
      loader: 'js',
    }));
    build.onLoad({ filter: /excalidraw[\\/]dist[\\/]dev[\\/]chunk-4FTI6OG3\.js$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      contents = `import { snapshotElement } from ${JSON.stringify(resolve('src/element-snapshot.ts'))};\n` + contents;
      contents = `import { MIN_INK_ZOOM } from ${JSON.stringify(resolve('src/viewport.ts'))};\n` + contents;
      const minZoom = 'var MIN_ZOOM = 0.1;';
      if (contents.split(minZoom).length !== 2) throw Error('Upstream overview zoom floor patch mismatch');
      contents = contents.replace(minZoom, 'var MIN_ZOOM = MIN_INK_ZOOM;');
      const deepCopy = 'var deepCopyElement = (val) => {\n  return _deepCopyElement(val);\n};';
      if (contents.split(deepCopy).length !== 2) throw Error('Upstream freehand immutable snapshot patch mismatch');
      contents = contents.replace(deepCopy, 'var deepCopyElement = (val) => val.type === "freedraw" ? snapshotElement(val) : _deepCopyElement(val);');
      const restoreInk = '        points: element.points,\n        lastCommittedPoint: null,\n        simulatePressure: element.simulatePressure,';
      if (contents.split(restoreInk).length !== 2) throw Error('Upstream completed stroke restore patch mismatch');
      contents = contents.replace(restoreInk, '        points: element.points,\n        lastCommittedPoint: element.lastCommittedPoint ?? null,\n        simulatePressure: element.simulatePressure,');
      const pointBounds = 'var getBoundsFromPoints = (points) => {';
      if (contents.split(pointBounds).length !== 2) throw Error('Upstream immutable point bounds patch mismatch');
      contents = contents.replace(pointBounds, 'var inkFrozenPointBounds = new WeakMap();\n' + pointBounds + '\n  const cached = inkFrozenPointBounds.get(points); if (cached) return cached;');
      const boundsReturn = '  return [minX, minY, maxX, maxY];\n};\nvar getFreeDrawElementAbsoluteCoords';
      if (contents.split(boundsReturn).length !== 2) throw Error('Upstream point bounds return patch mismatch');
      contents = contents.replace(boundsReturn, '  const result = [minX, minY, maxX, maxY];\n  if (Object.isFrozen(points)) inkFrozenPointBounds.set(points, result);\n  return result;\n};\nvar getFreeDrawElementAbsoluteCoords');
      const staticScene = 'var _renderStaticScene = ({';
      if (contents.split(staticScene).length !== 2) throw Error('Upstream static ink renderer patch mismatch');
      contents = contents.replace(staticScene, 'var _renderStaticSceneUncached = ({');
      const staticThrottle = 'var renderStaticSceneThrottled = throttleRAF(';
      if (contents.split(staticThrottle).length !== 2) throw Error('Upstream static renderer wrapper mismatch');
      contents = contents.replace(staticThrottle, `
var inkStaticRaster = new WeakMap();
var inkVisibleRasterOwners = new WeakMap();
function inkRasterStatus(canvas, pending) {
  if (canvas.dataset.inkRenderState === (pending ? "drawing" : "ready")) return;
  canvas.dataset.inkRenderState = pending ? "drawing" : "ready";
  canvas.dispatchEvent(new CustomEvent("ink-render-status", {bubbles: true, detail: pending}));
}
var _renderStaticScene = (config) => {
  const {canvas, visibleElements: elements, appState: state, renderConfig, scale} = config;
  if (canvas?.classList.contains("static") && !renderConfig.isExporting) {
    const next = new Set(elements);
    if (state.newElement) next.add(state.newElement);
    for (const element of inkVisibleRasterOwners.get(canvas) ?? []) {
      if (!next.has(element)) releaseInkElementCanvas(element);
    }
    inkVisibleRasterOwners.set(canvas, next);
  }
  const eligible = canvas && canvas.classList.contains("static") && !renderConfig.isExporting && elements.length >= 256 &&
    !state.frameToHighlight && !state.openDialog && !state.editingGroupId && !state.selectedElementsAreBeingDragged && !renderConfig.pendingFlowchartNodes?.size &&
    elements.every(e => e.type === "freedraw" && !e.frameId && !e.link && !e.boundElements?.length);
  if (!eligible) {
    if (canvas) { cancelAnimationFrame(inkStaticRaster.get(canvas)?.frame); inkStaticRaster.delete(canvas); inkRasterStatus(canvas, false); }
    return _renderStaticSceneUncached(config);
  }
  const key = JSON.stringify([canvas.width, canvas.height, scale, state.zoom.value, state.scrollX, state.scrollY,
    state.theme, state.viewBackgroundColor, state.gridSize, state.gridStep, renderConfig.renderGrid, state.shouldCacheIgnoreZoom]);
  const previous = inkStaticRaster.get(canvas);
  const append = previous && previous.key === key && elements.length >= previous.ids.length &&
    previous.ids.every((id, i) => elements[i].id === id && elements[i].versionNonce === previous.versions[i]);
  if (elements.length >= 2000) {
    if (append && elements.length === previous.ids.length) return;
    if (previous) cancelAnimationFrame(previous.frame);
    if (!append) _renderStaticSceneUncached({...config, visibleElements: []});
    const entry = {key, ids: elements.map(e => e.id), versions: elements.map(e => e.versionNonce),
      cursor: append ? previous.cursor ?? previous.ids.length : 0, frame: 0};
    inkStaticRaster.set(canvas, entry);
    inkRasterStatus(canvas, true);
    const draw = () => {
      if (!canvas.isConnected || inkStaticRaster.get(canvas) !== entry) return;
      const started = performance.now(), context = canvas.getContext("2d");
      context.setTransform(scale * state.zoom.value, 0, 0, scale * state.zoom.value, 0, 0);
      // Dense static ink uses its full vector path on the shared canvas. Per-element
      // canvases cause disposal stalls on document switches and stale raster edges.
      const inkConfig = {...renderConfig, inkDirectFreeDraw: true};
      do {
        const element = elements[entry.cursor++];
        context.save();
        renderElement(element, config.elementsMap, config.allElementsMap, config.rc, context, inkConfig, state);
        context.restore();
        if (state.zoom.value < 0.1) { pathsCache.delete(element); ShapeCache.delete(element); }
      } while (entry.cursor < elements.length && performance.now() - started < 4);
      if (entry.cursor < elements.length) entry.frame = requestAnimationFrame(draw);
      else inkRasterStatus(canvas, false);
    };
    entry.frame = requestAnimationFrame(draw);
    return;
  }
  if (previous) cancelAnimationFrame(previous.frame);
  if (append) {
    if (elements.length === previous.ids.length) return;
    const context = canvas.getContext("2d");
    context.setTransform(scale * state.zoom.value, 0, 0, scale * state.zoom.value, 0, 0);
    for (let i = previous.ids.length; i < elements.length; i++) {
      context.save();
      renderElement(elements[i], config.elementsMap, config.allElementsMap, config.rc, context, {...renderConfig, inkDirectFreeDraw: true}, state);
      context.restore();
    }
  } else _renderStaticSceneUncached({...config, renderConfig: {...renderConfig, inkDirectFreeDraw: true}});
  inkStaticRaster.set(canvas, {key, ids: elements.map(e => e.id), versions: elements.map(e => e.versionNonce)});
  inkRasterStatus(canvas, false);
};
` + staticThrottle);
      const freeDrawRender = '    case "freedraw": {\n      ShapeCache.generateElementShape(element, null);\n      if (renderConfig.isExporting) {';
      if (contents.split(freeDrawRender).length !== 2) throw Error('Upstream direct overview ink patch mismatch');
      contents = contents.replace(freeDrawRender, freeDrawRender.replace('if (renderConfig.isExporting)', 'if (renderConfig.isExporting || renderConfig.inkDirectFreeDraw)'));
      const invalidateRaster = '  elementWithCanvasCache.delete(element);';
      if (contents.split(invalidateRaster).length !== 2) throw Error('Upstream raster invalidation patch mismatch');
      contents = contents.replace(invalidateRaster, '  releaseInkElementCanvas(element);');
      const rasterCache = 'var elementWithCanvasCache = /* @__PURE__ */ new WeakMap();';
      if (contents.split(rasterCache).length !== 2) throw Error('Upstream raster ownership patch mismatch');
      contents = contents.replace(rasterCache, rasterCache + `
function releaseInkElementCanvas(element) {
  const cached = elementWithCanvasCache.get(element);
  if (!cached) return;
  // Dropping a WeakMap entry does not immediately release native/GPU backing
  // stores. Reclaim both upstream surfaces before replacing or hiding them.
  cached.canvas.width = cached.canvas.height = 0;
  cached.boundTextCanvas.width = cached.boundTextCanvas.height = 0;
  elementWithCanvasCache.delete(element);
}
`);
      const fontAssetStart = '    const assetUrl = uri.replace(/^\\/+/, "");';
      const fontAssetEnd = '    return urls;';
      if (contents.split(fontAssetStart).length !== 2 || contents.split('window.EXCALIDRAW_ASSET_PATH').length !== 5) throw Error('Upstream bundled font path patch mismatch');
      const assetStart = contents.indexOf(fontAssetStart), assetEnd = contents.indexOf(fontAssetEnd, assetStart);
      if (assetEnd < assetStart) throw Error('Upstream bundled font return patch mismatch');
      contents = contents.slice(0, assetStart) + '    return [inkAssetUrl(uri)];' + contents.slice(assetEnd + fontAssetEnd.length);
      const fontFaceCreation = 'this.fontFace = new FontFace(family, sources, {\n      display: "swap",\n      style: "normal",\n      weight: "400",\n      ...descriptors\n    });';
      if (contents.split(fontFaceCreation).length !== 2) throw Error('Upstream owned font lifecycle patch mismatch');
      contents = contents.replace(fontFaceCreation, fontFaceCreation + '\n    trackInkFontFace(this.fontFace);');
      contents = `import { inkAssetUrl, trackInkFontFace } from ${JSON.stringify(resolve('src/kernel-assets.ts'))};\n` + contents;
      contents = `import { resetInkScene, updateInkElement } from ${JSON.stringify(resolve('src/spatial.ts'))};\n` + contents;
      contents = `import { resetInkJournal, recordInkMutation, inkSnapshotChanges } from ${JSON.stringify(resolve('src/kernel-journal.ts'))};\n` + contents;
      const from = 'var getFontFamilyString = ({\n  fontFamily\n}) => {';
      if (contents.split(from).length !== 2) throw Error('Upstream font family patch mismatch');
      contents = contents.replace(from, from + '\n  if (fontFamily === 2) return "Ink Notebook Sans";');
      const selected = 'var getSelectedElements = (elements, appState, opts) => {';
      if (contents.split(selected).length !== 2) throw Error('Upstream selection patch mismatch');
      contents = contents.replace(selected, selected + '\n  if (Object.keys(appState.selectedElementIds).length === 0) return [];');
      const anySelected = '  const ret = (elements, appState) => {';
      if (contents.split(anySelected).length !== 2) throw Error('Upstream any selection patch mismatch');
      contents = contents.replace(anySelected, anySelected + '\n    if (!Object.values(appState.selectedElementIds).some(Boolean)) return false;');
      const capture = '__publicField(this, "captureIncrement", (elements, appState) => {';
      if (contents.split(capture).length !== 2) throw Error('Upstream external history patch mismatch');
      // Session owns body cross-page history and independent scratch history. Keep the kernel
      // snapshot (used by edits) but avoid calculating/retaining a second unused undo timeline.
      contents = contents.replace(capture, capture + '\n      return this.updateSnapshot(elements, appState);');
      const snapshot = '__publicField(this, "updateSnapshot", (elements, appState) => {';
      if (contents.split(snapshot).length !== 2) throw Error('Upstream snapshot patch mismatch');
      // No kernel history retains old Snapshot maps in external-history mode. Reuse that map,
      // cloning only changed elements, while still retaining tombstones and observed app state.
      contents = contents.replace(snapshot, snapshot + `
      const retained = this.snapshot.elements;
      let inkChanged = false;
      if (elements) {
        const delta = inkSnapshotChanges(elements, retained);
        for (const next of delta ?? elements.values()) {
          const id = next.id;
          const previous = retained.get(id);
          if (!previous || previous.versionNonce !== next.versionNonce) {
            retained.set(id, deepCopyElement(next)); inkChanged = true;
          }
        }
        if (delta === null) for (const [id, previous] of retained) {
          if (!elements.has(id) && !previous.isDeleted) {
            retained.set(id, newElementWith(previous, { isDeleted: true })); inkChanged = true;
          }
        }
      }
      const observed = appState ? getObservedAppState(appState) : this.snapshot.appState;
      const stateChanged = this.snapshot.detectChangedAppState(observed);
      if (inkChanged || stateChanged) this.snapshot = new Snapshot(retained, observed, { didElementsChange: inkChanged, didAppStateChange: stateChanged });
      return;
`);
      const insert = '  insertElementAtIndex(element, index) {';
      if (contents.split(insert).length !== 2) throw Error('Upstream append patch mismatch');
      contents = contents.replace(insert, insert + `
    if (index === this.elements.length && element.type === "freedraw" && !element.frameId && !element.isDeleted) {
      const tail = this.elements.length ? [this.elements[this.elements.length - 1], element] : [element];
      syncMovedIndices(tail, arrayToMap([element]));
      this.elements = [...this.elements, element];
      this.nonDeletedElements = [...this.nonDeletedElements, element];
      this.elementsMap.set(element.id, element);
      this.nonDeletedElementsMap.set(element.id, element);
      _Scene.mapElementToScene(element, this);
      updateInkElement(this, element);
      recordInkMutation(this, element);
      this.triggerUpdate();
      return;
    }
`);
      const inkErase = `
  inkErase(patches) {
    const inserted = [], next = [];
    for (const element of this.elements) {
      const pieces = patches.get(element.id);
      if (!pieces) { next.push(element); continue; }
      mutateElement(element, { isDeleted: true }, false);
      this.nonDeletedElementsMap.delete(element.id);
      next.push(element);
      for (const piece of pieces) {
        next.push(piece); inserted.push(piece);
        this.elementsMap.set(piece.id, piece); this.nonDeletedElementsMap.set(piece.id, piece);
        _Scene.mapElementToScene(piece, this); updateInkElement(this, piece); recordInkMutation(this, piece);
      }
    }
    syncMovedIndices(next, arrayToMap(inserted));
    this.elements = next; this.nonDeletedElements = next.filter(element => !element.isDeleted);
    this.triggerUpdate();
  }
`;
      contents = contents.replace(insert, inkErase + insert);
      const replaceAll = '    const nextFrameLikes = [];\n    validateIndicesThrottled(_nextElements);';
      if (contents.split(replaceAll).length !== 2) throw Error('Upstream unchanged scene patch mismatch');
      contents = contents.replace(replaceAll, `
    if (_nextElements.length === this.elements.length && _nextElements.every((element, i) => element === this.elements[i] && this.nonDeletedElementsMap.has(element.id) === !element.isDeleted)) {
      this.triggerUpdate(); return;
    }
` + replaceAll);
      for (const [from, to] of [
        ['this.nonDeletedElementsMap = nonDeletedElements.elementsMap;', 'this.nonDeletedElementsMap = nonDeletedElements.elementsMap; resetInkScene(this); resetInkJournal(this);'],
        ['  element.updated = getUpdatedTimestamp();\n  if (informMutation)', '  element.updated = getUpdatedTimestamp();\n  updateInkElement(Scene_default.getScene(element), element); recordInkMutation(Scene_default.getScene(element), element);\n  if (informMutation)'],
      ]) { if (contents.split(from).length !== 2) throw Error(`Upstream spatial patch mismatch: ${from}`); contents = contents.replace(from, to); }
      return { contents, loader: 'js' };
    });
    build.onResolve({ filter: /^@excalidraw\/excalidraw$/ }, () => ({ path: resolve('node_modules/@excalidraw/excalidraw/dist/dev/index.js') }));
    build.onLoad({ filter: /excalidraw[\\/]dist[\\/]dev[\\/]index\.js$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      contents = `import { queryInkScene, InkRenderMap, getInkEmbeds } from ${JSON.stringify(resolve('src/spatial.ts'))};\n` + contents;
      const selectionVisibility = 'isSomeElementSelected(getNonDeletedElements(elements), appState)';
      if (contents.split(selectionVisibility).length !== 13) throw Error('Upstream empty selection UI patch mismatch');
      contents = contents.replaceAll(selectionVisibility, '(Object.values(appState.selectedElementIds).some(Boolean) && ' + selectionVisibility + ')');
      const replacements = [
        ['  const editingTextElement = appState.editingTextElement;\n  const nonDeletedElements = getNonDeletedElements(elements);', '  const editingTextElement = appState.editingTextElement;\n  if (!editingTextElement && !Object.values(appState.selectedElementIds).some(Boolean)) return typeof defaultValue === "function" ? defaultValue(false) : defaultValue;\n  const nonDeletedElements = getNonDeletedElements(elements);'],
        ['clamp(roundToStep(adjustedZoomValue, ZOOM_STEP, "floor"), minZoom, maxZoom)', 'clamp(adjustedZoomValue < ZOOM_STEP ? adjustedZoomValue : roundToStep(adjustedZoomValue, ZOOM_STEP, "floor"), minZoom, maxZoom)'],
        ['const scaledWidth = props.appState.width * props.scale;', 'const scaledWidth = Math.floor(props.appState.width * props.scale);'],
        ['const scaledHeight = props.appState.height * props.scale;', 'const scaledHeight = Math.floor(props.appState.height * props.scale);'],
        ['const selections = [];\n      for (const element of elementsMap.values()) {', 'const selections = [];\n      const selectionCandidates = new Set(selectedElements);\n      for (const id of renderConfig.remoteSelectedElementIds.keys()) { const e = elementsMap.get(id); if (e) selectionCandidates.add(e); }\n      for (const element of selectionCandidates) {'],
        ['const container = opts?.parentSelector ? excalidrawContainer?.querySelector(opts.parentSelector) : document.body;', 'const portalHost = opts?.parentSelector ? null : document.createElement("div");\n    if (portalHost) { portalHost.className = "ink-kernel-portal"; document.body.appendChild(portalHost); }\n    const container = portalHost || excalidrawContainer?.querySelector(opts.parentSelector);'],
        ['container.removeChild(div2);', 'container.removeChild(div2);\n      portalHost?.remove();'],
        ['getSceneElements: this.getSceneElements,', 'getSceneElements: this.getSceneElements,\n        inkQuery: (rect) => queryInkScene(this.scene, rect),\n        inkErase: (patches) => this.scene.inkErase(patches),'],
        ['const embeddableElements = this.scene.getNonDeletedElements().filter(', 'const embeddableElements = getInkEmbeds(this.scene).filter('],
        ['this.scene.getNonDeletedElements().filter((element) => {\n        if (isEmbeddableElement(element))', 'getInkEmbeds(this.scene).filter((element) => {\n        if (isEmbeddableElement(element))'],
        // Freehand creation never reads transform originals; copying every point on pointerdown
        // caused 383–715 ms stalls at 50k strokes. Keep the full snapshot for transform tools.
        ['originalElements: this.scene.getNonDeletedElements().reduce((acc, element) => {', 'originalElements: (this.state.activeTool.type === "freedraw" || this.state.activeTool.type === "hand" ? [] : this.scene.getNonDeletedElements()).reduce((acc, element) => {'],
        ['hitElement(x, y, element, considerBoundingBox = true) {', 'hitElement(x, y, element, considerBoundingBox = true) {\n    if (element.type === "freedraw" && !inkStrokeHitPossible(element, x, y, this.getElementHitThreshold())) return false;'],
        ['const elements = (includeBoundTextElement && includeLockedElements ? this.scene.getNonDeletedElements() : this.scene.getNonDeletedElements().filter(', 'const hitPad = this.getElementHitThreshold();\n    const candidates = queryInkScene(this.scene, { x: x - hitPad, y: y - hitPad, width: hitPad * 2, height: hitPad * 2 });\n    const elements = (includeBoundTextElement && includeLockedElements ? candidates : candidates.filter('],
        ['const simulatePressure = event.pressure === 0.5;', 'const simulatePressure = !inkFixedPressure(event) && event.pointerType !== "pen" && event.pressure === 0.5;'],
        ['pressures: simulatePressure ? [] : [event.pressure]', 'pressures: simulatePressure ? [] : [inkSamplePressure(event)], customData: { inkFixedWidth: inkFixedPressure(event) }'],
        ['[...newElement2.pressures, event.pressure]', '[...newElement2.pressures, newElement2.customData?.inkFixedWidth ? 0.5 : event.pressure]'],
        ['[...newElement2.pressures, childEvent.pressure]', '[...newElement2.pressures, newElement2.customData?.inkFixedWidth ? 0.5 : childEvent.pressure]'],
        ['for (const element of elementsMap.values()) {\n          if (isElementInViewport(', 'for (const element of queryInkScene(this.scene, { x: -scrollX, y: -scrollY, width: width / zoom.value, height: height / zoom.value })) {\n          if (elementsMap.has(element.id) && isElementInViewport('],
        ['const elementsMap = getRenderableElements({\n            elements,\n            editingTextElement,\n            newElementId,\n            pendingImageElementId\n          });', 'const elementsMap = new InkRenderMap(this.scene.getNonDeletedElementsMap(), [editingTextElement?.id, newElementId, pendingImageElementId]);'],
      ];
      for (const [from, to] of replacements) {
        if (contents.split(from).length !== 2) throw Error(`Upstream pressure patch mismatch: ${from}`);
        contents = contents.replace(from, to);
      }
      contents += '\nfunction inkFixedPressure(event) { return event.target?.closest?.(".ink-editor")?.dataset.pressure === "fixed"; }\nfunction inkSamplePressure(event) { return inkFixedPressure(event) ? 0.5 : event.pressure; }\n';
      contents += `
const inkStrokeBounds = new WeakMap();
function inkStrokeHitPossible(e, x, y, threshold) {
  // Conservative O(1) rejection before scanning point bounds. Local points span width/height;
  // rotation about the center adds at most one extra diagonal around the original origin.
  const first = e.points[0] || [0, 0];
  const radius = 2 * Math.hypot(e.width, e.height) + Math.hypot(first[0], first[1]) + threshold + e.strokeWidth * 2;
  if (x < e.x - radius || x > e.x + radius || y < e.y - radius || y > e.y + radius) return false;
  let cached = inkStrokeBounds.get(e);
  if (!cached || cached.version !== e.version) {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const cos = Math.cos(e.angle), sin = Math.sin(e.angle), cx = e.width / 2, cy = e.height / 2;
    for (const p of e.points) {
      const px = e.x + cx + (p[0] - cx) * cos - (p[1] - cy) * sin;
      const py = e.y + cy + (p[0] - cx) * sin + (p[1] - cy) * cos;
      left = Math.min(left, px); top = Math.min(top, py); right = Math.max(right, px); bottom = Math.max(bottom, py);
    }
    cached = { version: e.version, left, top, right, bottom }; inkStrokeBounds.set(e, cached);
  }
  const pad = threshold + e.strokeWidth * 2;
  return x >= cached.left - pad && x <= cached.right + pad && y >= cached.top - pad && y <= cached.bottom + pad;
}
`;
      return { contents, loader: 'js' };
    });
  },
};

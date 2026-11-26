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
      contents = `import { strokeOutlineToPath2D } from ${JSON.stringify(resolve('src/ink-input.ts'))};\n` + contents;
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
      const freeDrawShape = `function generateFreeDrawShape(element) {
  const svgPathData = getFreeDrawSvgPath(element);
  const path = new Path2D(svgPathData);
  pathsCache.set(element, path);
  return path;
}`;
      const svgStart = contents.indexOf('function getFreeDrawSvgPath(element) {');
      const svgEnd = contents.indexOf('\nfunction med(A, B)', svgStart);
      const svgBody = contents.slice(svgStart, svgEnd);
      if (contents.split(freeDrawShape).length !== 2 || contents.split('function getFreeDrawSvgPath(element) {').length !== 2 || svgEnd < svgStart || svgBody.split('return getSvgPathFromStroke2(getStroke(inputPoints, options));').length !== 2) throw Error('Upstream direct freehand path patch mismatch');
      contents = contents.replace(freeDrawShape, svgBody.replace('function getFreeDrawSvgPath(element)', 'function generateFreeDrawShape(element)').replace('return getSvgPathFromStroke2(getStroke(inputPoints, options));', 'const path = strokeOutlineToPath2D(getStroke(inputPoints, options));\n  pathsCache.set(element, path);\n  return path;'));
      const pointSize = `var getSizeFromPoints = (points) => {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys)
  };
};`;
      if (contents.split(pointSize).length !== 2) throw Error('Upstream single-pass point size patch mismatch');
      contents = contents.replace(pointSize, `var getSizeFromPoints = (points) => {
  const box = inkFrozenPointBounds.get(points) ?? getBoundsFromPoints(points);
  return { width: box[2] - box[0], height: box[3] - box[1] };
};`);
      const staticScene = 'var _renderStaticScene = ({';
      if (contents.split(staticScene).length !== 2) throw Error('Upstream static ink renderer patch mismatch');
      contents = contents.replace(staticScene, 'var _renderStaticSceneUncached = ({');
      const staticThrottle = 'var renderStaticSceneThrottled = throttleRAF(';
      if (contents.split(staticThrottle).length !== 2) throw Error('Upstream static renderer wrapper mismatch');
      contents = contents.replace(staticThrottle, `
var inkStaticRaster = new WeakMap();
var inkVisibleRasterOwners = new WeakMap();
var inkTransientRasterOwner = new WeakMap();
function releaseInkStaticScene(canvas) {
  if (!canvas) return;
  cancelAnimationFrame(inkStaticRaster.get(canvas)?.frame);
  inkStaticRaster.delete(canvas);
  discardInkViewport(canvas);
  for (const element of inkVisibleRasterOwners.get(canvas) ?? []) {
    releaseInkElementCanvas(element); pathsCache.delete(element); ShapeCache.delete(element);
  }
  const transient = inkTransientRasterOwner.get(canvas);
  if (transient) { releaseInkElementCanvas(transient); pathsCache.delete(transient); ShapeCache.delete(transient); }
  inkVisibleRasterOwners.delete(canvas);
  inkTransientRasterOwner.delete(canvas);
  canvas.width = canvas.height = 0;
}
function inkRasterStatus(canvas, pending) {
  if (canvas.dataset.inkRenderState === (pending ? "drawing" : "ready")) return;
  canvas.dataset.inkRenderState = pending ? "drawing" : "ready";
  canvas.dispatchEvent(new CustomEvent("ink-render-status", {bubbles: true, detail: pending}));
}
var _renderStaticScene = (config) => {
  const {canvas, visibleElements: elements, appState: state, renderConfig, scale} = config;
  const supportsPreview = canvas && canvas.classList.contains("static") && !renderConfig.isExporting &&
    !state.frameToHighlight && !state.openDialog && !state.editingGroupId && !state.selectedElementsAreBeingDragged && !renderConfig.pendingFlowchartNodes?.size &&
    !state.isResizing && !state.isRotating && !elements.some(e => e.type === "iframe" || e.type === "embeddable");
  const viewport = supportsPreview ? {source: config.allElementsMap, revision: inkSceneRevision(config.allElementsMap),
    key: JSON.stringify([canvas.width, canvas.height, scale, state.theme, state.viewBackgroundColor, state.gridSize, state.gridStep, renderConfig.renderGrid, state.frameRendering]),
    zoom: state.zoom.value, scrollX: state.scrollX, scrollY: state.scrollY} : null;
  const canPreview = supportsPreview && !state.newElement && !state.editingTextElement;
  if (canPreview && shouldDeferInkViewport(canvas, viewport, elements.length, state.width, state.height) && deferInkViewport(canvas, viewport, () => _renderStaticScene(config), 50)) {
    const pending = inkStaticRaster.get(canvas);
    if (pending) { cancelAnimationFrame(pending.frame); pending.frame = 0; }
    return;
  }
  if (canvas) { if (canPreview) clearInkViewport(canvas); else discardInkViewport(canvas); }
  const plainInk = e => e.type === "freedraw" && !e.frameId && !e.link && !e.boundElements?.length;
  // Text/images can finish loading without a geometry mutation. Always let the
  // upstream renderer refresh them; viewport-only previews remain safe.
  const eligible = supportsPreview && elements.every(e =>
    (e.type === "freedraw" || e.type === "rectangle" || e.type === "ellipse" || e.type === "diamond" || e.type === "line" || e.type === "arrow") &&
    !e.frameId && !e.link && !e.boundElements?.length);
  const simple = eligible && elements.every(plainInk);
  const key = viewport ? JSON.stringify([viewport.key, state.zoom.value, state.scrollX, state.scrollY, state.shouldCacheIgnoreZoom]) : null;
  const previous = inkStaticRaster.get(canvas);
  let append = eligible && previous && previous.key === key && elements.length >= previous.ids.length &&
    previous.ids.every((id, i) => elements[i].id === id && elements[i].versionNonce === previous.versions[i]);
  if (append) for (let i = previous.ids.length; i < elements.length; i++) {
    if (!plainInk(elements[i])) { append = false; break; }
  }
  if (canvas?.classList.contains("static") && !renderConfig.isExporting) {
    let owners = inkVisibleRasterOwners.get(canvas);
    if (append && owners) {
      for (let i = previous.ids.length; i < elements.length; i++) owners.add(elements[i]);
    } else {
      const next = new Set(elements);
      for (const element of owners ?? []) {
        if (!next.has(element) && element !== state.newElement) { releaseInkElementCanvas(element); pathsCache.delete(element); ShapeCache.delete(element); }
      }
      owners = next;
      inkVisibleRasterOwners.set(canvas, next);
    }
    const prevTransient = inkTransientRasterOwner.get(canvas);
    if (prevTransient && prevTransient !== state.newElement && !owners.has(prevTransient)) {
      releaseInkElementCanvas(prevTransient); pathsCache.delete(prevTransient); ShapeCache.delete(prevTransient);
    }
    if (state.newElement) inkTransientRasterOwner.set(canvas, state.newElement);
    else inkTransientRasterOwner.delete(canvas);
  }
  if (!eligible) {
    if (canvas) { cancelAnimationFrame(inkStaticRaster.get(canvas)?.frame); inkStaticRaster.delete(canvas); inkRasterStatus(canvas, false); }
    const renderStart = performance.now();
    _renderStaticSceneUncached({...config, renderConfig: {...renderConfig, inkDirectFreeDraw: true}});
    if (canvas) recordInkRenderCost(canvas, performance.now() - renderStart);
    if (canPreview) commitInkViewport(canvas, viewport);
    return;
  }
  if (simple && elements.length >= 2000) {
    if (append && elements.length === previous.ids.length && (previous.cursor >= elements.length || previous.frame)) return;
    if (previous) cancelAnimationFrame(previous.frame);
    if (!append) _renderStaticSceneUncached({...config, visibleElements: []});
    const entry = {key, ids: elements.map(e => e.id), versions: elements.map(e => e.versionNonce),
      cursor: append ? previous.cursor ?? previous.ids.length : 0, frame: 0};
    inkStaticRaster.set(canvas, entry);
    inkRasterStatus(canvas, true);
    const draw = () => {
      if (!canvas.isConnected) { releaseInkStaticScene(canvas); return; }
      if (inkStaticRaster.get(canvas) !== entry) return;
      const started = performance.now(), context = canvas.getContext("2d"); let drawn = 0;
      context.setTransform(scale * state.zoom.value, 0, 0, scale * state.zoom.value, 0, 0);
      // Dense static ink uses its full vector path on the shared canvas. Per-element
      // canvases cause disposal stalls on document switches and stale raster edges.
      const inkConfig = {...renderConfig, inkDirectFreeDraw: true};
      do {
        const element = elements[entry.cursor++];
        context.save();
        renderElement(element, config.elementsMap, config.allElementsMap, config.rc, context, inkConfig, state);
        context.restore();
        drawn++;
        if (state.zoom.value < 0.1) { pathsCache.delete(element); ShapeCache.delete(element); }
      } while (entry.cursor < elements.length && drawn < 512 && performance.now() - started < 3);
      if (entry.cursor < elements.length) entry.frame = requestAnimationFrame(draw);
      else { commitInkViewport(canvas, viewport); inkRasterStatus(canvas, false); }
    };
    // Paint the first chunk immediately and stage the viewport so scrolling during the
    // initial progressive pass reuses the partial bitmap via transform instead of clearing it repeatedly.
    draw();
    if (entry.cursor < elements.length && canPreview) stageInkViewport(canvas, viewport);
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
  } else {
    const renderStart = performance.now();
    _renderStaticSceneUncached({...config, renderConfig: {...renderConfig, inkDirectFreeDraw: true}});
    recordInkRenderCost(canvas, performance.now() - renderStart);
  }
  inkStaticRaster.set(canvas, {key, ids: elements.map(e => e.id), versions: elements.map(e => e.versionNonce)});
  commitInkViewport(canvas, viewport);
  inkRasterStatus(canvas, false);
};
` + staticThrottle);
      const freeDrawRender = '    case "freedraw": {\n      ShapeCache.generateElementShape(element, null);\n      if (renderConfig.isExporting) {';
      if (contents.split(freeDrawRender).length !== 2) throw Error('Upstream direct overview ink patch mismatch');
      contents = contents.replace(freeDrawRender, freeDrawRender.replace('if (renderConfig.isExporting)', 'if (renderConfig.isExporting || renderConfig.inkDirectFreeDraw || appState.newElement?.id === element.id)'));
      const lineDirectRender = '    case "line":\n    case "arrow":\n    case "image":\n    case "text":\n    case "iframe":\n    case "embeddable": {\n      ShapeCache.generateElementShape(element, renderConfig);\n      if (renderConfig.isExporting) {';
      if (contents.split(lineDirectRender).length !== 2) throw Error('Upstream highlighter line direct render patch mismatch');
      contents = contents.replace(lineDirectRender, lineDirectRender.replace('if (renderConfig.isExporting)', 'if (renderConfig.isExporting || (renderConfig.inkDirectFreeDraw && element.type === "line" && element.customData?.inkKind === "highlighter"))'));
      const drawFree = '    case "freedraw": {\n      context.save();\n      context.fillStyle = element.strokeColor;';
      if (contents.split(drawFree).length !== 2) throw Error('Upstream highlighter multiply freedraw patch mismatch');
      contents = contents.replace(drawFree, '    case "freedraw": {\n      context.save();\n      if (appState?.theme !== "dark" && (element.customData?.inkKind === "highlighter" || (element.customData?.inkKind !== "pen" && element.opacity <= 50))) context.globalCompositeOperation = "multiply";\n      context.fillStyle = element.strokeColor;');
      const drawLine = '    case "arrow":\n    case "line": {\n      context.lineJoin = "round";\n      context.lineCap = "round";\n      ShapeCache.get(element).forEach((shape) => {\n        rc.draw(shape);\n      });\n      break;\n    }';
      if (contents.split(drawLine).length !== 2) throw Error('Upstream highlighter multiply line patch mismatch');
      contents = contents.replace(drawLine, '    case "arrow":\n    case "line": {\n      const hiMul = appState?.theme !== "dark" && element.type === "line" && element.customData?.inkKind === "highlighter";\n      if (hiMul) { context.save(); context.globalCompositeOperation = "multiply"; }\n      context.lineJoin = "round";\n      context.lineCap = "round";\n      ShapeCache.get(element).forEach((shape) => {\n        rc.draw(shape);\n      });\n      if (hiMul) context.restore();\n      break;\n    }');
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
      contents = `import { resetInkJournal, recordInkMutation, inkSnapshotChanges, inkSceneRevision } from ${JSON.stringify(resolve('src/kernel-journal.ts'))};\n` + contents;
      contents = `import { discardInkViewport, clearInkViewport, commitInkViewport, stageInkViewport, deferInkViewport, shouldDeferInkViewport, recordInkRenderCost } from ${JSON.stringify(resolve('src/ink-viewport.ts'))};\n` + contents;
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
      const inkAppend = `
  inkAppend(items) {
    if (!items.length) return;
    const ids = new Set();
    if (items.some(element => {
      if (element.isDeleted || element.frameId || element.boundElements?.length || element.containerId || element.startBinding || element.endBinding || isFrameLikeElement(element) || this.elementsMap.has(element.id) || ids.has(element.id)) return true;
      ids.add(element.id); return false;
    })) {
      this.replaceAllElements([...this.elements, ...items]); return;
    }
    const tail = this.elements.length ? [this.elements[this.elements.length - 1], ...items] : [...items];
    syncMovedIndices(tail, arrayToMap(items));
    this.elements = [...this.elements, ...items];
    this.nonDeletedElements = [...this.nonDeletedElements, ...items];
    for (const element of items) {
      this.elementsMap.set(element.id, element); this.nonDeletedElementsMap.set(element.id, element);
      _Scene.mapElementToScene(element, this); updateInkElement(this, element); recordInkMutation(this, element);
    }
    this.triggerUpdate();
  }
`;
      contents = contents.replace(insert, inkAppend + insert);
      const inkErase = `
  inkErase(patches) {
    const inserted = [], next = [], nonDeleted = [];
    let needsGlobalReindex = false;
    const prevElements = this.elements;
    for (let i = 0; i < prevElements.length; i++) {
      const element = prevElements[i];
      const pieces = patches.get(element.id);
      if (!pieces) {
        next.push(element);
        if (!element.isDeleted) nonDeleted.push(element);
        continue;
      }
      mutateElement(element, { isDeleted: true }, false);
      this.nonDeletedElementsMap.delete(element.id);
      next.push(element);
      if (pieces.length) {
        let keys = null;
        if (!needsGlobalReindex && element.index) {
          const hasNext = i + 1 < prevElements.length;
          const upper = hasNext ? prevElements[i + 1].index : null;
          if (!hasNext || (upper && element.index < upper)) {
            try { keys = generateNKeysBetween(element.index, upper, pieces.length); } catch { keys = null; }
          }
        }
        if (!keys) needsGlobalReindex = true;
        for (let k = 0; k < pieces.length; k++) {
          const piece = keys ? { ...pieces[k], index: keys[k] } : pieces[k];
          next.push(piece); nonDeleted.push(piece); inserted.push(piece);
          this.elementsMap.set(piece.id, piece); this.nonDeletedElementsMap.set(piece.id, piece);
          _Scene.mapElementToScene(piece, this); updateInkElement(this, piece); recordInkMutation(this, piece);
        }
      }
    }
    if (needsGlobalReindex && inserted.length) syncMovedIndices(next, arrayToMap(inserted));
    this.elements = next; this.nonDeletedElements = nonDeleted;
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
      contents += '\nexport { releaseInkStaticScene };\n';
      return { contents, loader: 'js' };
    });
    build.onResolve({ filter: /^@excalidraw\/excalidraw$/ }, () => ({ path: resolve('node_modules/@excalidraw/excalidraw/dist/dev/index.js') }));
    build.onLoad({ filter: /excalidraw[\\/]dist[\\/]dev[\\/]index\.js$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      contents = `import { queryInkScene, InkRenderMap, getInkEmbeds } from ${JSON.stringify(resolve('src/spatial.ts'))};\n` + contents;
      contents = `import { inkSceneRevision, inkHostChanges } from ${JSON.stringify(resolve('src/kernel-journal.ts'))};\n` + contents;
      contents = 'import { releaseInkStaticScene } from "./chunk-4FTI6OG3.js";\n' + contents;
      contents = `import { preserveInkSamples, inkPointerSamples, stabilizeInkPoint, stabilizedRawPoints } from ${JSON.stringify(resolve('src/ink-input.ts'))};\n` + contents;
      // Safari pinch events must only reach the canvas where the gesture started.
      for (const gesture of ['gesturestart', 'gesturechange', 'gestureend']) {
        const listener = `        document,\n        "${gesture}"`;
        if (contents.split(listener).length !== 2) throw Error(`Upstream scoped ${gesture} listener patch mismatch`);
        contents = contents.replace(listener, `        this.excalidrawContainerRef.current,\n        "${gesture}"`);
      }
      const selectionVisibility = 'isSomeElementSelected(getNonDeletedElements(elements), appState)';
      if (contents.split(selectionVisibility).length !== 13) throw Error('Upstream empty selection UI patch mismatch');
      contents = contents.replaceAll(selectionVisibility, '(Object.values(appState.selectedElementIds).some(Boolean) && ' + selectionVisibility + ')');
      const replacements = [
        ['      origin,\n      withCmdOrCtrl: event[KEYS.CTRL_OR_CMD],', '      origin,\n      inkPointerId: event.pointerId,\n      inkStabilizeLevel: Number(this.excalidrawContainerRef.current?.closest?.(".ink-editor")?.dataset.stabilize || 0),\n      withCmdOrCtrl: event[KEYS.CTRL_OR_CMD],'],
        ['onPointerMoveFromPointerDownHandler(pointerDownState) {\n    return withBatchedUpdatesThrottled((event) => {', 'onPointerMoveFromPointerDownHandler(pointerDownState) {\n    const scheduleMove = this.state.activeTool.type === "freedraw" ? consume => {\n      const move = preserveInkSamples(withBatchedUpdatesThrottled, consume, pointerDownState.inkPointerId);\n      const flush = () => move.flush();\n      pointerDownState.inkMoveFlush = this.inkMoveFlush = flush;\n      const cancel = move.cancel;\n      move.cancel = () => {\n        cancel();\n        if (this.inkMoveFlush === flush) this.inkMoveFlush = null;\n      };\n      return move;\n    } : withBatchedUpdatesThrottled;\n    return scheduleMove((event) => {'],
        ['onPointerUpFromPointerDownHandler(pointerDownState) {\n    return withBatchedUpdates((childEvent) => {', 'onPointerUpFromPointerDownHandler(pointerDownState) {\n    return withBatchedUpdates((childEvent) => {\n      if (pointerDownState.inkMoveFlush && (childEvent.type === "pointerup" || childEvent.type === "pointercancel") && childEvent.pointerId !== pointerDownState.inkPointerId) return;'],
        ['        pointerDownState.eventListeners.onMove.flush();\n      }', '        pointerDownState.eventListeners.onMove.flush();\n      }\n      if (pointerDownState.inkMoveFlush && this.inkMoveFlush === pointerDownState.inkMoveFlush) this.inkMoveFlush = null;'],
        ['this.renderer.destroy();', 'releaseInkStaticScene(this.canvas);\n    this.renderer.destroy();'],
        ['  const editingTextElement = appState.editingTextElement;\n  const nonDeletedElements = getNonDeletedElements(elements);', '  const editingTextElement = appState.editingTextElement;\n  if (!editingTextElement && !Object.values(appState.selectedElementIds).some(Boolean)) return typeof defaultValue === "function" ? defaultValue(false) : defaultValue;\n  const nonDeletedElements = getNonDeletedElements(elements);'],
        ['clamp(roundToStep(adjustedZoomValue, ZOOM_STEP, "floor"), minZoom, maxZoom)', 'clamp(adjustedZoomValue < ZOOM_STEP ? adjustedZoomValue : roundToStep(adjustedZoomValue, ZOOM_STEP, "floor"), minZoom, maxZoom)'],
        ['      width: props.appState.width * props.scale,\n      height: props.appState.height * props.scale,\n      ref: props.handleCanvasRef,', '      width: Math.floor(props.appState.width * props.scale),\n      height: Math.floor(props.appState.height * props.scale),\n      ref: props.handleCanvasRef,'],
        ['      width: props.appState.width * props.scale,\n      height: props.appState.height * props.scale,\n      ref: canvasRef', '      width: Math.floor(props.appState.width * props.scale),\n      height: Math.floor(props.appState.height * props.scale),\n      ref: canvasRef'],
        ['const scaledWidth = props.appState.width * props.scale;', 'const scaledWidth = Math.floor(props.appState.width * props.scale);'],
        ['const scaledHeight = props.appState.height * props.scale;', 'const scaledHeight = Math.floor(props.appState.height * props.scale);'],
        ['const selections = [];\n      for (const element of elementsMap.values()) {', 'const selections = [];\n      const selectionCandidates = new Set(selectedElements);\n      for (const id of renderConfig.remoteSelectedElementIds.keys()) { const e = elementsMap.get(id); if (e) selectionCandidates.add(e); }\n      for (const element of selectionCandidates) {'],
        ['const container = opts?.parentSelector ? excalidrawContainer?.querySelector(opts.parentSelector) : document.body;', 'const portalHost = opts?.parentSelector ? null : document.createElement("div");\n    if (portalHost) { portalHost.className = "ink-kernel-portal"; document.body.appendChild(portalHost); }\n    const container = portalHost || excalidrawContainer?.querySelector(opts.parentSelector);'],
        ['container.removeChild(div2);', 'container.removeChild(div2);\n      portalHost?.remove();'],
        ['getSceneElements: this.getSceneElements,', `getSceneElements: this.getSceneElements,
        inkRevision: () => inkSceneRevision(this.scene.getElementsMapIncludingDeleted()),
        inkChanges: () => inkHostChanges(this.scene.getElementsMapIncludingDeleted()),
        inkSyncRaw: () => {
          this.inkMoveFlush?.();
          const live = this.state.newElement;
          if (!live || live.type !== "freedraw") return;
          const raw = stabilizedRawPoints(live);
          if (!raw || live.customData?.inkRawPoints?.length === raw.length) return;
          mutateElement(live, { customData: { ...live.customData, inkRawPoints: raw } }, false);
        },
        inkAppend: (elements) => this.scene.inkAppend(elements),
        inkQuery: (rect) => queryInkScene(this.scene, rect),
        inkErase: (patches) => this.scene.inkErase(patches),
        inkRebind: (elements, changedIds) => {
          // Work on detached copies: source projections and their arrows enter one host undo step.
          // The upstream binding code mutates arrows and their labels, never handwriting.
          const next = elements.map(e => e.type === "arrow" || e.type === "text" ? deepCopyElement(e) : e);
          const map = new Map(next.filter(e => !e.isDeleted).map(e => [e.id, e]));
          for (const id of changedIds) { const e = map.get(id); if (e) updateBoundElements(e, map); }
          return next;
        },`],
        ['const embeddableElements = this.scene.getNonDeletedElements().filter(', 'const embeddableElements = getInkEmbeds(this.scene).filter('],
        ['this.scene.getNonDeletedElements().filter((element) => {\n        if (isEmbeddableElement(element))', 'getInkEmbeds(this.scene).filter((element) => {\n        if (isEmbeddableElement(element))'],
        // Freehand creation never reads transform originals; copying every point on pointerdown
        // caused 383–715 ms stalls at 50k strokes. Keep the full snapshot for transform tools.
        ['originalElements: this.scene.getNonDeletedElements().reduce((acc, element) => {', 'originalElements: (this.state.activeTool.type === "freedraw" || this.state.activeTool.type === "hand" ? [] : this.scene.getNonDeletedElements()).reduce((acc, element) => {'],
        ['hitElement(x, y, element, considerBoundingBox = true) {', 'hitElement(x, y, element, considerBoundingBox = true) {\n    if (element.type === "freedraw" && !inkStrokeHitPossible(element, x, y, this.getElementHitThreshold())) return false;'],
        ['const elements = (includeBoundTextElement && includeLockedElements ? this.scene.getNonDeletedElements() : this.scene.getNonDeletedElements().filter(', 'const hitPad = this.getElementHitThreshold();\n    const candidates = queryInkScene(this.scene, { x: x - hitPad, y: y - hitPad, width: hitPad * 2, height: hitPad * 2 });\n    const elements = (includeBoundTextElement && includeLockedElements ? candidates : candidates.filter('],
        ['const simulatePressure = event.pressure === 0.5;', 'const simulatePressure = !inkFixedPressure(event) && event.pointerType !== "pen" && event.pressure === 0.5;'],
        ['pressures: simulatePressure ? [] : [event.pressure]', 'pressures: simulatePressure ? [] : [inkSamplePressure(event)], customData: { inkFixedWidth: inkFixedPressure(event), ...(inkToolKind(event) ? { inkKind: inkToolKind(event) } : {}) }'],
        ['[...newElement2.pressures, event.pressure]', '[...newElement2.pressures, newElement2.customData?.inkFixedWidth ? 0.5 : event.pressure]'],
        ['[...newElement2.pressures, childEvent.pressure]', '[...newElement2.pressures, newElement2.customData?.inkFixedWidth ? 0.5 : childEvent.pressure]'],
        ['        let dx = pointerCoords.x - newElement2.x;\n        let dy = pointerCoords.y - newElement2.y;\n        if (dx === points[0][0] && dy === points[0][1]) {\n          dy += 1e-4;\n          dx += 1e-4;\n        }\n        const pressures = newElement2.simulatePressure ? [] : [...newElement2.pressures, newElement2.customData?.inkFixedWidth ? 0.5 : childEvent.pressure];\n        mutateElement(newElement2, {\n          points: [...points, pointFrom(dx, dy)],\n          pressures,\n          lastCommittedPoint: pointFrom(dx, dy)\n        });', '        const rawEndDx = pointerCoords.x - newElement2.x;\n        const rawEndDy = pointerCoords.y - newElement2.y;\n        let dx = rawEndDx;\n        let dy = rawEndDy;\n        if (dx === points[0][0] && dy === points[0][1]) {\n          dy += 1e-4;\n          dx += 1e-4;\n        }\n        const pressures = newElement2.simulatePressure ? [] : [...newElement2.pressures, newElement2.customData?.inkFixedWidth ? 0.5 : childEvent.pressure];\n        const stabEnd = pointerDownState.inkStabilizeLevel;\n        const prevRaw = stabilizedRawPoints(newElement2) ?? newElement2.customData?.inkRawPoints ?? ((stabEnd === 1 || stabEnd === 2) ? [[points[0][0], points[0][1]]] : null);\n        mutateElement(newElement2, {\n          points: [...points, pointFrom(dx, dy)],\n          pressures,\n          lastCommittedPoint: pointFrom(dx, dy),\n          ...(prevRaw ? { customData: { ...newElement2.customData, inkRawPoints: [...prevRaw, [rawEndDx, rawEndDy]] } } : {})\n        });'],
        ['for (const element of elementsMap.values()) {\n          if (isElementInViewport(', 'for (const element of queryInkScene(this.scene, { x: -scrollX, y: -scrollY, width: width / zoom.value, height: height / zoom.value })) {\n          if (elementsMap.has(element.id) && isElementInViewport('],
        ['const elementsMap = getRenderableElements({\n            elements,\n            editingTextElement,\n            newElementId,\n            pendingImageElementId\n          });', 'const elementsMap = new InkRenderMap(this.scene.getNonDeletedElementsMap(), [editingTextElement?.id, newElementId, pendingImageElementId]);'],
      ];
      for (const [from, to] of replacements) {
        if (contents.split(from).length !== 2) throw Error(`Upstream pressure patch mismatch: ${from}`);
        contents = contents.replace(from, to);
      }
      const freeDownBinding = `      const boundElement = getHoveredElementForBinding(
        pointerDownState.origin,
        this.scene.getNonDeletedElements(),
        this.scene.getNonDeletedElementsMap(),
        this.state.zoom
      );
      this.setState({
        newElement: element,`;
      if (contents.split(freeDownBinding).length !== 2) throw Error('Upstream freehand binding scan patch mismatch');
      contents = contents.replace(freeDownBinding, freeDownBinding.replace('const boundElement = getHoveredElementForBinding(', 'const boundElement = elementType === "freedraw" ? null : getHoveredElementForBinding('));
      const freeMove = `        if (newElement2.type === "freedraw") {
          const points = newElement2.points;
          const dx = pointerCoords.x - newElement2.x;
          const dy = pointerCoords.y - newElement2.y;
          const lastPoint = points.length > 0 && points[points.length - 1];
          const discardPoint = lastPoint && lastPoint[0] === dx && lastPoint[1] === dy;
          if (!discardPoint) {
            const pressures = newElement2.simulatePressure ? newElement2.pressures : [...newElement2.pressures, newElement2.customData?.inkFixedWidth ? 0.5 : event.pressure];
            mutateElement(
              newElement2,
              {
                points: [...points, pointFrom(dx, dy)],
                pressures
              },
              false
            );
            this.setState({
              newElement: newElement2
            });
          }
        } else if (isLinearElement(newElement2)) {`;
      if (contents.split(freeMove).length !== 2) throw Error('Upstream full pen sample batch patch mismatch');
      contents = contents.replace(freeMove, `        if (newElement2.type === "freedraw") {
          const points = [...newElement2.points];
          const pressures = newElement2.simulatePressure ? newElement2.pressures : [...newElement2.pressures];
          const stabilize = pointerDownState.inkStabilizeLevel;
          const stabilizeLevel = stabilize === 1 || stabilize === 2 ? stabilize : 0;
          for (const sample of inkPointerSamples(event)) {
            const coords = viewportCoordsToSceneCoords(sample, this.state);
            const rawDx = coords.x - newElement2.x, rawDy = coords.y - newElement2.y;
            const [dx, dy] = stabilizeInkPoint(newElement2, stabilizeLevel, rawDx, rawDy, points[0]?.[0] ?? 0, points[0]?.[1] ?? 0);
            const pressure = newElement2.customData?.inkFixedWidth ? 0.5 : sample.pressure;
            const last = points[points.length - 1];
            if (last && last[0] === dx && last[1] === dy && (newElement2.simulatePressure || pressures[pressures.length - 1] === pressure)) continue;
            points.push(pointFrom(dx, dy));
            if (!newElement2.simulatePressure) pressures.push(pressure);
          }
          if (points.length !== newElement2.points.length) {
            mutateElement(newElement2, {points, pressures}, false);
            this.setState({newElement: newElement2});
          }
        } else if (isLinearElement(newElement2)) {`);
      contents += '\nfunction inkFixedPressure(event) { return event.target?.closest?.(".ink-editor")?.dataset.pressure === "fixed"; }\nfunction inkSamplePressure(event) { return inkFixedPressure(event) ? 0.5 : event.pressure; }\nfunction inkToolKind(event) { const k = event.target?.closest?.(".ink-editor")?.dataset.inkKind; return k === "pen" || k === "highlighter" ? k : undefined; }\n';
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

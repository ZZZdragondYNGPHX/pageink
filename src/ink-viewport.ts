/** Reuse the completed shared ink canvas while its viewport is moving.
 * Geometry changes invalidate immediately; the settled view is always redrawn.
 */
export interface InkRasterView {
  source: object;
  revision: number;
  key: string;
  zoom: number;
  scrollX: number;
  scrollY: number;
}
interface Preview { view: InkRasterView; timer?: number }
const previews = new WeakMap<HTMLCanvasElement, Preview>();
const snapshots = new WeakMap<HTMLCanvasElement, { canvas: HTMLCanvasElement; view: InkRasterView }>();
const forcedRedraw = new WeakSet<HTMLCanvasElement>();
const activeZoomGestures = new WeakSet<HTMLCanvasElement>();
const renderCosts = new WeakMap<HTMLCanvasElement, number>();

export function setInkGestureActive(canvas: HTMLCanvasElement | null | undefined, active: boolean) {
  if (!canvas) return;
  if (active) activeZoomGestures.add(canvas);
  else activeZoomGestures.delete(canvas);
}

const PAN_LIVE_ELEMENTS = 1200;
const ZOOM_LIVE_ELEMENTS = 600;
const PROGRESSIVE_ELEMENTS = 2000;
const LIVE_RENDER_BUDGET_MS = 10;
const MAX_DEFERRED_SHIFT_RATIO = 0.22;

export function recordInkRenderCost(canvas: HTMLCanvasElement, ms: number) {
  const prev = renderCosts.get(canvas);
  renderCosts.set(canvas, prev === undefined ? ms : prev * 0.6 + ms * 0.4);
}

/** Only defer static redraws when the scene is genuinely heavy; ordinary scrolling renders live with zero edge clipping. */
export function shouldDeferInkViewport(canvas: HTMLCanvasElement, view: InkRasterView, visibleCount: number, viewportWidth = 0, viewportHeight = 0): boolean {
  if (forcedRedraw.has(canvas)) return false;
  const previous = previews.get(canvas) ?? (snapshots.has(canvas) ? { view: snapshots.get(canvas)!.view } : undefined);
  if (!previous) return false;
  const base = previous.view;
  if (base.source !== view.source || base.revision !== view.revision || base.key !== view.key) return false;
  if (base.zoom === view.zoom && base.scrollX === view.scrollX && base.scrollY === view.scrollY) return false;
  const sameZoom = base.zoom === view.zoom;
  if (!sameZoom && activeZoomGestures.has(canvas)) return true;
  const cost = renderCosts.get(canvas) ?? 0;
  if (visibleCount < (sameZoom ? PAN_LIVE_ELEMENTS : ZOOM_LIVE_ELEMENTS) && cost < LIVE_RENDER_BUDGET_MS) return false;
  // For single-frame heavy scenes (<2000 elements), force a synchronous refresh once panning exposes >22%
  // of the viewport. Multi-frame progressive scenes (>=2000) must stay deferred until settle so continuous
  // scrolling never repeatedly clears and restarts progressive drawing at 512 strokes.
  if (sameZoom && visibleCount < PROGRESSIVE_ELEMENTS && viewportWidth > 0 && viewportHeight > 0) {
    const dx = Math.abs((view.scrollX - base.scrollX) * view.zoom);
    const dy = Math.abs((view.scrollY - base.scrollY) * view.zoom);
    if (dx > viewportWidth * MAX_DEFERRED_SHIFT_RATIO || dy > viewportHeight * MAX_DEFERRED_SHIFT_RATIO) return false;
  }
  return true;
}

export function discardInkViewport(canvas: HTMLCanvasElement) {
  clearInkViewport(canvas);
  const held = snapshots.get(canvas);
  if (held) { held.canvas.width = held.canvas.height = 0; held.canvas.remove(); snapshots.delete(canvas); canvas.classList.remove('ink-viewport-redraw'); }
}

function holdInkViewport(canvas: HTMLCanvasElement, view: InkRasterView) {
  if (!canvas.ownerDocument || !canvas.parentElement || snapshots.has(canvas)) return;
  const snapshot = createEl('canvas');
  snapshot.width = canvas.width; snapshot.height = canvas.height;
  snapshot.getContext('2d')!.drawImage(canvas, 0, 0);
  snapshot.className = 'excalidraw__canvas ink-viewport-snapshot';
  snapshot.setAttribute('aria-hidden', 'true');
  snapshot.style.width = canvas.style.width; snapshot.style.height = canvas.style.height;
  snapshot.style.transform = canvas.style.transform;
  canvas.after(snapshot);
  canvas.classList.add('ink-viewport-redraw');
  snapshots.set(canvas, { canvas: snapshot, view });
}

export function clearInkViewport(canvas: HTMLCanvasElement) {
  const previous = previews.get(canvas);
  window.clearTimeout(previous?.timer);
  previews.delete(canvas);
  canvas.style.removeProperty('transform');
  delete canvas.dataset.inkViewportPreview;
}

export function commitInkViewport(canvas: HTMLCanvasElement, view: InkRasterView) {
  discardInkViewport(canvas);
  previews.set(canvas, { view });
}

/** Register a progressive pass's viewport for transform reuse without discarding any held snapshot. */
export function stageInkViewport(canvas: HTMLCanvasElement, view: InkRasterView) {
  if (!previews.has(canvas)) previews.set(canvas, { view });
}

export function deferInkViewport(canvas: HTMLCanvasElement, view: InkRasterView, redraw: () => void, delayMs = 120): boolean {
  let previous = previews.get(canvas);
  const held = snapshots.get(canvas);
  if (held && (held.view.source !== view.source || held.view.revision !== view.revision || held.view.key !== view.key)) discardInkViewport(canvas);
  if (forcedRedraw.has(canvas)) return false;
  if (!previous && snapshots.has(canvas)) {
    previous = { view: snapshots.get(canvas)!.view };
    previews.set(canvas, previous);
  }
  if (!previous) { clearInkViewport(canvas); return false; }
  if (previous.view.source !== view.source || previous.view.revision !== view.revision || previous.view.key !== view.key) {
    discardInkViewport(canvas);
    return false;
  }
  const base = previous.view;
  if (base.zoom === view.zoom && base.scrollX === view.scrollX && base.scrollY === view.scrollY) {
    window.clearTimeout(previous.timer);
    canvas.style.removeProperty('transform');
    if (held) held.canvas.style.removeProperty('transform');
    delete canvas.dataset.inkViewportPreview;
    return false;
  }
  const ratio = view.zoom / base.zoom;
  const dx = (view.scrollX - base.scrollX) * view.zoom, dy = (view.scrollY - base.scrollY) * view.zoom;
  canvas.style.transform = `matrix(${ratio}, 0, 0, ${ratio}, ${dx}, ${dy})`;
  const snapshot = snapshots.get(canvas);
  if (snapshot) snapshot.canvas.style.transform = canvas.style.transform;
  canvas.dataset.inkViewportPreview = 'true';
  window.clearTimeout(previous.timer);
  previous.timer = window.setTimeout(() => {
    if (canvas.isConnected) holdInkViewport(canvas, base);
    clearInkViewport(canvas);
    if (canvas.isConnected) {
      forcedRedraw.add(canvas);
      try { redraw(); } finally { forcedRedraw.delete(canvas); }
    }
  }, delayMs);
  return true;
}

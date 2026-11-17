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

export function discardInkViewport(canvas: HTMLCanvasElement) {
  clearInkViewport(canvas);
  const held = snapshots.get(canvas);
  if (held) { held.canvas.width = held.canvas.height = 0; held.canvas.remove(); snapshots.delete(canvas); canvas.classList.remove('ink-viewport-redraw'); }
}

function holdInkViewport(canvas: HTMLCanvasElement, view: InkRasterView) {
  if (!canvas.ownerDocument || !canvas.parentElement || snapshots.has(canvas)) return;
  const snapshot = canvas.ownerDocument.createElement('canvas');
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

export function deferInkViewport(canvas: HTMLCanvasElement, view: InkRasterView, redraw: () => void): boolean {
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
  }, 120);
  return true;
}

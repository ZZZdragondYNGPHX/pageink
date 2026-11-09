import { useSyncExternalStore } from 'react';
import type { Rect } from './model';
import { MIN_INK_ZOOM } from './viewport';

/** Kernel viewport: screen = (scene + scroll) * zoom. Width/height are CSS pixels. */
export interface View { scrollX: number; scrollY: number; zoom: number; width: number; height: number }
export const MAX_ZOOM = 8;

export class ViewStore {
  private view: View = { scrollX: 0, scrollY: 0, zoom: 1, width: 0, height: 0 };
  private listeners = new Set<() => void>();
  get = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  set(next: Partial<View>) {
    const merged = { ...this.view, ...next };
    if (merged.scrollX === this.view.scrollX && merged.scrollY === this.view.scrollY && merged.zoom === this.view.zoom && merged.width === this.view.width && merged.height === this.view.height) return;
    this.view = merged;
    for (const listener of this.listeners) listener();
  }
}
export function useView<T>(store: ViewStore, select: (view: View) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

export const clampZoom = (zoom: number, min = MIN_INK_ZOOM) => Math.max(min, Math.min(MAX_ZOOM, zoom));
export const sceneViewport = (v: View): Rect => ({ x: -v.scrollX, y: -v.scrollY, width: v.width / v.zoom, height: v.height / v.zoom });
export const toScreen = (v: View, x: number, y: number): [number, number] => [(x + v.scrollX) * v.zoom, (y + v.scrollY) * v.zoom];
export const toScene = (v: View, x: number, y: number): [number, number] => [x / v.zoom - v.scrollX, y / v.zoom - v.scrollY];

/** Zoom while keeping the scene point under the screen point (sx, sy) fixed. */
export function zoomAround(v: View, zoom: number, sx = v.width / 2, sy = v.height / 2): Pick<View, 'zoom' | 'scrollX' | 'scrollY'> {
  const next = clampZoom(zoom), [x, y] = toScene(v, sx, sy);
  return { zoom: next, scrollX: sx / next - x, scrollY: sy / next - y };
}

/** Keeps a paged document in view: centred when narrower than the screen, edges bounded otherwise. */
export function clampToDocument(v: View, doc: Rect, padding = 24, tail = 0): Pick<View, 'scrollX' | 'scrollY'> {
  if (!v.width || !v.height) return { scrollX: v.scrollX, scrollY: v.scrollY };
  const pad = padding / v.zoom, vw = v.width / v.zoom, vh = v.height / v.zoom;
  const left = doc.x - pad, right = doc.x + doc.width + pad, top = doc.y - pad, bottom = doc.y + doc.height + pad + tail / v.zoom;
  let x = -v.scrollX, y = -v.scrollY;
  x = right - left <= vw ? (left + right) / 2 - vw / 2 : Math.max(left, Math.min(x, right - vw));
  y = bottom - top <= vh ? Math.max(bottom - vh, Math.min(y, top)) : Math.max(top, Math.min(y, bottom - vh));
  return { scrollX: -x, scrollY: -y };
}

/** Fit `rect` into the view with a screen-pixel margin, never above `maxZoom`. */
export function fitRect(v: View, rect: Rect, margin = 32, maxZoom = MAX_ZOOM): Pick<View, 'zoom' | 'scrollX' | 'scrollY'> {
  const zoom = clampZoom(Math.min(maxZoom, (v.width - margin * 2) / Math.max(1, rect.width), (v.height - margin * 2) / Math.max(1, rect.height)));
  return { zoom, scrollX: v.width / zoom / 2 - (rect.x + rect.width / 2), scrollY: v.height / zoom / 2 - (rect.y + rect.height / 2) };
}

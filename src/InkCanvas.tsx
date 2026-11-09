import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Excalidraw, CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, AppState } from '@excalidraw/excalidraw/types';
import { Element, Page, Rect } from './model';
import { bounds, cloneElements, eraseStroke, lassoHits, polygonBounds, ScenePoint } from './geometry';
import { Session } from './session';
import { PdfService } from './pdf';
import { layoutPages, PageLayout, PageScene, PagePlacement, placementAt, toSceneRect } from './layout';
import { GridLayer, PageOverlay, PaperLayer } from './PaperLayer';
import { View, ViewStore, clampToDocument, clampZoom, fitRect, sceneViewport, toScene, zoomAround } from './view';
import type { ViewMemory } from './host';

export type KernelTool = 'freedraw' | 'selection' | 'hand' | 'text' | 'rectangle' | 'ellipse' | 'diamond' | 'line' | 'arrow';
export type MarqueePurpose = 'select' | 'capture' | 'bookmark';
export interface CanvasTool {
  kernel: KernelTool; color: string; width: number; opacity: number; fontSize: number; pressure: boolean;
  erase?: { whole: boolean; radius: number };
  marquee?: { shape: 'rect' | 'lasso'; purpose: MarqueePurpose };
}
export interface SelectionInfo { ids: string[]; rect: Rect; busy: boolean; source?: { document: string; page: string; polygon: ScenePoint[] } }
export type ZoomAction = 'in' | 'out' | 'actual' | 'fitWidth' | 'fitPage' | 'fitAll';
export interface CanvasHandle {
  api: ExcalidrawImperativeAPI;
  views: ViewStore;
  flush(): Promise<void>;
  /** Reloads the scene from the session (after undo/redo or a page layout change). */
  rebuild(): Promise<void>;
  layout(): PageLayout;
  /** Page under the centre of the viewport. */
  currentPage(): PagePlacement;
  reveal(pageId: string, rect?: Rect, flash?: boolean): void;
  zoom(action: ZoomAction): void;
  /** Scene-coordinate centre of the visible area. */
  center(): ScenePoint;
  /** Adds independent copies centred at `at` (default: view centre) and selects them. */
  insert(elements: readonly Element[], at?: ScenePoint): Promise<void>;
  selected(): Element[];
  replaceSelected(update: (element: Element) => Element | null): Promise<void>;
  clearSelection(): void;
  memory(): ViewMemory;
}
type Kind = 'pages' | 'canvas' | 'scratch';
interface Props {
  session: Session; pdf?: PdfService; kind: Kind;
  /** Changes whenever page geometry or paper appearance changes. */
  pagesKey: string;
  tool: CanvasTool; fingerDraws: boolean; theme: 'light' | 'dark';
  readOnly?: boolean;
  initialView?: ViewMemory;
  onReady: (handle: CanvasHandle) => void;
  onError: (message: string) => void;
  onSelection?: (selection: SelectionInfo | null) => void;
  onMarquee?: (points: ScenePoint[], purpose: MarqueePurpose) => void;
  onGesture?: (gesture: 'undo' | 'redo') => void;
  onAddPage?: () => void;
  onViewChange?: () => void;
}
const SCRATCH_PAGE: Page = { id: 'scratch', width: 1, height: 1, margins: { top: 0, right: 0, bottom: 0, left: 0 }, template: 'blank' };
const NEVER = CaptureUpdateAction.NEVER;
export const selectedContent = (api: ExcalidrawImperativeAPI) => {
  const ids = api.getAppState().selectedElementIds;
  return api.getSceneElements().filter(e => ids[e.id] || e.type === 'text' && e.containerId && ids[e.containerId]);
};

export const InkCanvas = React.memo(React.forwardRef<CanvasHandle, Props>(function InkCanvas(props, forwarded) {
  const { session, pdf, kind } = props;
  const scene = useRef<PageScene>();
  const pages = (): readonly Page[] => kind === 'pages' ? session.manifest.pages : kind === 'canvas' ? [session.manifest.pages[0]] : [SCRATCH_PAGE];
  const geometryKey = kind === 'pages' ? session.manifest.pages.map(p => `${p.id}:${p.width}x${p.height}:${p.margins.top},${p.margins.right},${p.margins.bottom},${p.margins.left}`).join('|') : kind;
  const layout = useMemo(() => layoutPages(pages()), [geometryKey, props.pagesKey]);
  const latest = useRef(props); latest.current = props;
  // Coordinates map through the layout the kernel scene was built with, until the next rebuild.
  const layoutRef = useRef(layout); layoutRef.current = scene.current?.layout ?? layout;
  const root = useRef<HTMLDivElement>(null);
  const views = useMemo(() => new ViewStore(), []);
  const [initial, setInitial] = useState<{ elements: Element[]; appState: Partial<AppState> } | null>(null);
  const [loadError, setLoadError] = useState(''), [attempt, setAttempt] = useState(0);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const ready = useRef(false), [isReady, setIsReady] = useState(false);
  const [renderPending, setRenderPending] = useState(false);
  const [flash, setFlash] = useState<{ rect: Rect; token: string } | null>(null);
  const [marqueePath, setMarqueePath] = useState<ScenePoint[] | null>(null);
  const busy = useRef(false), timer = useRef<ReturnType<typeof setTimeout>>();
  const owner = kind === 'scratch' ? 'scratch' : 'body';

  // ---------- loading ----------
  useEffect(() => {
    let active = true; setLoadError('');
    (async () => {
      const surfaces = new Map<string, readonly Element[]>();
      for (const p of layout.placements) surfaces.set(p.page.id, await session.load(p.page.id));
      await session.loadFiles([...surfaces.values()].flat());
      const pageScene = new PageScene(layout), elements = pageScene.build(id => surfaces.get(id) ?? []);
      if (!active) return;
      scene.current = pageScene;
      setInitial({ elements, appState: initialViewport(elements) });
    })().catch(error => { if (active) { setLoadError((error as Error).message); latest.current.onError((error as Error).message); } });
    return () => { active = false; };
  }, [attempt]);
  useEffect(() => {
    const keep = kind === 'pages' ? (id: string) => session.manifest.pages.some(p => p.id === id) : kind === 'canvas' ? (id: string) => id === session.manifest.pages[0].id : (id: string) => id === 'scratch';
    session.keepers.add(keep);
    return () => { session.keepers.delete(keep); };
  }, []);
  useEffect(() => {
    const element = root.current!;
    const status = (event: Event) => setRenderPending((event as CustomEvent<boolean>).detail);
    element.addEventListener('ink-render-status', status);
    const observer = new ResizeObserver(entries => views.set({ width: entries[0].contentRect.width, height: entries[0].contentRect.height }));
    observer.observe(element);
    return () => { element.removeEventListener('ink-render-status', status); observer.disconnect(); };
  }, []);

  function initialViewport(elements: readonly Element[]): Partial<AppState> {
    const width = root.current?.clientWidth || 800, height = root.current?.clientHeight || 600;
    const view: View = { scrollX: 0, scrollY: 0, zoom: 1, width, height }, memory = latest.current.initialView;
    if (kind === 'pages') {
      const target = memory?.page ? layout.byId.get(memory.page) : undefined;
      if (target && memory) {
        const zoom = clampZoom(memory.zoom, 0.1);
        return state({ zoom, scrollX: -(target.paper.x + memory.dx), scrollY: -(target.paper.y + memory.dy) });
      }
      const zoom = clampZoom(Math.min(1.25, (width - 48) / layout.maxWidth), 0.1), first = layout.placements[0].paper;
      return state({ zoom, ...clampToDocument({ ...view, zoom, scrollX: -(first.x + first.width / 2 - width / zoom / 2), scrollY: -(first.y - 20 / zoom) }, layout.bounds) });
    }
    if (memory) return state({ zoom: clampZoom(memory.zoom), scrollX: -memory.dx, scrollY: -memory.dy });
    const content = bounds(elements);
    if (content) return state(fitRect(view, content, 48, 1));
    return state(kind === 'scratch' ? { zoom: 1, scrollX: 24, scrollY: 24 } : { zoom: 1, scrollX: width / 2, scrollY: height / 2 });
  }
  const state = (v: Pick<View, 'zoom' | 'scrollX' | 'scrollY'>): Partial<AppState> => ({ zoom: { value: v.zoom as any }, scrollX: v.scrollX, scrollY: v.scrollY });

  // ---------- persistence ----------
  async function flush(record = true) {
    if (!api || !ready.current || !scene.current) return;
    try {
      await session.acceptFiles(api.getFiles());
      session.changeMany(scene.current.partition(api.getSceneElementsIncludingDeleted()), record);
    } catch (error) { latest.current.onError((error as Error).message); throw error; }
  }
  /** Records kernel normalisation (restore, re-indexing) without creating an undo step. */
  function absorb() { if (api && scene.current) session.changeMany(scene.current.partition(api.getSceneElementsIncludingDeleted()), false); }
  async function rebuild() {
    if (!api || !scene.current) return;
    const next = layoutPages(pages());
    busy.current = true;
    try {
      const missing = next.placements.filter(p => !session.surfaces.has(p.page.id));
      for (const p of missing) await session.load(p.page.id);
      if (missing.length) await session.loadFiles([...session.surfaces.values()].flat());
    } finally { busy.current = false; }
    const elements = scene.current.build(id => session.surfaces.get(id) ?? [], next);
    layoutRef.current = next;
    api.addFiles(Object.values(session.files));
    api.updateScene({ elements, captureUpdate: NEVER });
    scene.current.settle(api.getSceneElements());
    absorb();
    if (kind === 'pages') clampView();
  }
  useEffect(() => { if (ready.current && kind === 'pages' && scene.current && scene.current.layout !== layout && geometryKey !== geometryOf(scene.current.layout)) void rebuild(); }, [geometryKey]);

  // ---------- ready ----------
  useEffect(() => {
    if (!api || !initial) return;
    let done = false; const started = performance.now();
    const check = () => {
      if (done || api.getAppState().isLoading) return;
      if (api.getSceneElements().length !== initial.elements.length && performance.now() - started < 1200) return;
      done = true; ready.current = true;
      api.addFiles(Object.values(session.files));
      scene.current!.settle(api.getSceneElements());
      absorb();
      session.flushers.set(owner, () => flush());
      const s = api.getAppState();
      views.set({ scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value });
      setIsReady(true);
      latest.current.onReady(handle);
    };
    const unsubscribe = api.onChange(check); check();
    const fallback = setInterval(check, 300);
    let frame = 0;
    const pointerUp = api.onPointerUp(() => { clearTimeout(timer.current); cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { clearTimeout(timer.current); void flush().catch(() => {}); }); });
    // The parent flushes before closing. Reading an already-unmounted engine here can return an
    // empty scene and must never be persisted as a deletion.
    return () => { unsubscribe(); pointerUp(); clearInterval(fallback); clearTimeout(timer.current); cancelAnimationFrame(frame); if (session.flushers.get(owner)) session.flushers.delete(owner); for (const id of [...session.surfaces.keys()]) session.releaseSurface(id); };
  }, [api, initial]);

  // ---------- tool ----------
  const tool = props.tool;
  useEffect(() => {
    if (api && isReady) api.setActiveTool({ type: tool.kernel, locked: tool.kernel !== 'selection' && tool.kernel !== 'hand' } as any);
  }, [api, isReady, tool.kernel]);
  useEffect(() => {
    if (!api || !isReady) return;
    api.updateScene({ appState: { currentItemStrokeColor: tool.color, currentItemStrokeWidth: tool.width, currentItemOpacity: tool.opacity, currentItemFontSize: tool.fontSize,
      currentItemRoughness: 0, currentItemFontFamily: 2, currentItemBackgroundColor: 'transparent', penMode: !props.fingerDraws }, captureUpdate: NEVER });
  }, [api, isReady, tool.kernel, tool.color, tool.width, tool.opacity, tool.fontSize, props.fingerDraws]);

  // ---------- viewport ----------
  function clampView() {
    if (!api || kind !== 'pages') return false;
    const s = api.getAppState(), v = { ...views.get(), scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value };
    const next = clampToDocument(v, layoutRef.current.bounds, 24, latest.current.onAddPage ? 96 : 0);
    if (Math.abs(next.scrollX - v.scrollX) < .5 && Math.abs(next.scrollY - v.scrollY) < .5) return false;
    api.updateScene({ appState: { scrollX: next.scrollX, scrollY: next.scrollY }, captureUpdate: NEVER });
    return true;
  }
  function setView(next: Pick<View, 'zoom' | 'scrollX' | 'scrollY'>) {
    if (!api) return;
    api.updateScene({ appState: state(next) as any, captureUpdate: NEVER });
    clampView();
  }
  const onScroll = (scrollX: number, scrollY: number, zoom: { value: number }) => {
    if (ready.current && clampView()) return;
    views.set({ scrollX, scrollY, zoom: zoom.value });
    if (ready.current) latest.current.onViewChange?.();
  };
  function currentPage() { const v = views.get(), area = sceneViewport(v); return placementAt(layoutRef.current, area.y + area.height / 2); }
  function zoom(action: ZoomAction) {
    const v = views.get(), l = layoutRef.current;
    if (action === 'in' || action === 'out') return setView(zoomAround(v, v.zoom * (action === 'in' ? 1.25 : 0.8)));
    if (action === 'actual') return setView(zoomAround(v, 1));
    if (kind === 'pages' && action === 'fitWidth') {
      const zoomValue = clampZoom((v.width - 48) / l.maxWidth, 0.1), next = zoomAround(v, zoomValue);
      return setView({ ...next, scrollX: -(l.bounds.x + l.bounds.width / 2 - v.width / zoomValue / 2) });
    }
    if (kind === 'pages' && action === 'fitPage') return setView(fitRect(v, currentPage().paper, 24));
    const content = bounds(api?.getSceneElements() ?? []);
    if (content) setView(fitRect(v, content, 48, kind === 'pages' ? 2 : 1.5));
  }
  function reveal(pageId: string, rect?: Rect, highlight = false) {
    const target = layoutRef.current.byId.get(pageId); if (!target) return;
    const v = views.get();
    if (rect) {
      const area = toSceneRect(rect, target);
      setView(fitRect(v, { x: area.x - 24, y: area.y - 24, width: area.width + 48, height: area.height + 48 }, 32, Math.max(v.zoom, 1.25)));
      if (highlight) setFlash({ rect: area, token: String(performance.now()) });
    } else setView({ zoom: v.zoom, scrollX: v.scrollX, scrollY: -(target.paper.y - 20 / v.zoom) });
  }
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 1600); return () => clearTimeout(t); }, [flash]);

  // ---------- selection reporting ----------
  const selectionFrame = useRef(0), lastSelection = useRef<unknown>(null), hadSelection = useRef(false);
  const onKernelChange = (_elements: readonly unknown[], appState: AppState) => {
    if (!ready.current) return;
    if (!appState.editingTextElement && !appState.newElement && !appState.isResizing && !appState.isRotating && !appState.selectedElementsAreBeingDragged) {
      clearTimeout(timer.current); timer.current = setTimeout(() => void flush().catch(() => {}), 500);
    }
    const any = Object.values(appState.selectedElementIds).some(Boolean);
    if (!any && !hadSelection.current && lastSelection.current === appState.selectedElementIds) return;
    lastSelection.current = appState.selectedElementIds;
    cancelAnimationFrame(selectionFrame.current);
    selectionFrame.current = requestAnimationFrame(reportSelection);
  };
  function reportSelection() {
    if (!api) return;
    const s = api.getAppState(), selected = s.editingTextElement ? [] : selectedContent(api), rect = bounds(selected);
    hadSelection.current = !!rect;
    if (!rect) { latest.current.onSelection?.(null); return; }
    const source = selected.length === 1 && selected[0].type === 'image' ? selected[0].customData?.source : undefined;
    latest.current.onSelection?.({ ids: selected.map(e => e.id), rect, busy: !!(s.selectedElementsAreBeingDragged || s.isResizing || s.isRotating), source });
  }
  useEffect(() => () => cancelAnimationFrame(selectionFrame.current), []);

  // ---------- editing helpers ----------
  async function insert(elements: readonly Element[], at?: ScenePoint) {
    if (!api || !elements.length) return;
    const box = bounds(elements)!, [cx, cy] = at ?? center();
    const copies = cloneElements(elements, cx - (box.x + box.width / 2), cy - (box.y + box.height / 2)).map(e => ({ ...e, index: null }) as unknown as Element);
    api.addFiles(Object.values(session.files));
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...copies], appState: { selectedElementIds: Object.fromEntries(copies.filter(e => !(e.type === 'text' && e.containerId)).map(e => [e.id, true])) as any }, captureUpdate: NEVER });
    await flush();
  }
  async function replaceSelected(update: (element: Element) => Element | null) {
    if (!api) return;
    const ids = new Set(selectedContent(api).map(e => e.id));
    const next: Element[] = [];
    for (const e of api.getSceneElementsIncludingDeleted()) {
      if (!ids.has(e.id)) { next.push(e); continue; }
      const result = update(e);
      if (result) next.push(result === e ? e : { ...result, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 30), updated: Date.now() } as Element);
    }
    const kept = new Set(next.map(e => e.id));
    // Detach bindings to removed elements so the remaining scene stays consistent.
    const consistent = next.map(e => {
      const copy = e as any; let changed = false; const patch: any = {};
      if (copy.boundElements?.some((b: any) => !kept.has(b.id))) { patch.boundElements = copy.boundElements.filter((b: any) => kept.has(b.id)); changed = true; }
      for (const key of ['startBinding', 'endBinding']) if (copy[key] && !kept.has(copy[key].elementId)) { patch[key] = null; changed = true; }
      return changed ? { ...e, ...patch, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 30) } as Element : e;
    });
    api.updateScene({ elements: consistent, appState: kept.size === next.length && [...ids].every(id => kept.has(id)) ? undefined : { selectedElementIds: {} as any }, captureUpdate: NEVER });
    await flush();
  }
  function center(): ScenePoint { const v = views.get(); return toScene(v, v.width / 2, v.height / 2); }
  function memory(): ViewMemory {
    const v = views.get(), area = sceneViewport(v);
    if (kind !== 'pages') return { dx: area.x, dy: area.y, zoom: v.zoom };
    const page = placementAt(layoutRef.current, area.y + Math.min(area.height / 2, 40 / v.zoom));
    return { page: page.page.id, dx: area.x - page.paper.x, dy: area.y - page.paper.y, zoom: v.zoom };
  }
  const handle: CanvasHandle = {
    get api() { return api!; }, views, flush: () => flush(), rebuild, layout: () => layoutRef.current, currentPage, reveal, zoom, center, insert,
    selected: () => api ? selectedContent(api) : [], replaceSelected, memory,
    clearSelection: () => api?.updateScene({ appState: { selectedElementIds: {} as any }, captureUpdate: NEVER }),
  };
  useImperativeHandle(forwarded, () => handle);

  // ---------- pointer input ----------
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ fingers: number; started: number; travel: number; samples: { t: number; x: number; y: number }[] } | null>(null);
  const inertia = useRef(0);
  const penDown = useRef(false), erasing = useRef(false), lastErase = useRef<ScenePoint>();
  const marquee = useRef<{ id: number; points: ScenePoint[] } | null>(null);
  const eraserCursor = useRef<HTMLDivElement>(null);
  const local = (event: React.PointerEvent): ScenePoint => { const box = root.current!.getBoundingClientRect(); return [event.clientX - box.left, event.clientY - box.top]; };
  const scenePoint = (event: React.PointerEvent): ScenePoint => { const s = api!.getAppState(), [x, y] = local(event); return [x / s.zoom.value - s.scrollX, y / s.zoom.value - s.scrollY]; };
  const drawsWith = (event: React.PointerEvent) => event.pointerType !== 'touch' || props.fingerDraws;

  function erase(event: React.PointerEvent) {
    if (!api || !tool.erase) return;
    const point = scenePoint(event), radius = tool.erase.radius / api.getAppState().zoom.value;
    const from = lastErase.current ?? point; lastErase.current = point;
    const steps = Math.max(1, Math.ceil(Math.hypot(point[0] - from[0], point[1] - from[1]) / (radius / 2)));
    const candidates = (api as any).inkQuery({ x: Math.min(from[0], point[0]) - radius, y: Math.min(from[1], point[1]) - radius, width: Math.abs(point[0] - from[0]) + radius * 2, height: Math.abs(point[1] - from[1]) + radius * 2 }) as Element[];
    const patches = new Map<string, Element[]>();
    for (const e of candidates) {
      if (e.type !== 'freedraw') continue;
      let pieces: Element[] = [e];
      for (let i = 1; i <= steps && pieces.length; i++) {
        const sample: ScenePoint = [from[0] + (point[0] - from[0]) * i / steps, from[1] + (point[1] - from[1]) * i / steps];
        pieces = pieces.flatMap(piece => eraseStroke(piece, sample, radius, tool.erase!.whole));
      }
      if (pieces.length !== 1 || pieces[0] !== e) patches.set(e.id, pieces);
    }
    if (patches.size) (api as any).inkErase(patches);
  }
  function lassoSelect(points: ScenePoint[]) {
    if (!api) return;
    const selected: Record<string, true> = {};
    const candidates = (api as any).inkQuery(polygonBounds(points)) as Element[];
    for (const e of candidates) if (lassoHits(e, points)) selected[e.id] = true;
    // Bring grouped and bound objects into the same operation, preserving editing relationships.
    const groups = new Set(candidates.filter(e => selected[e.id]).flatMap(e => e.groupIds));
    for (const e of api.getSceneElements()) {
      if (e.groupIds.some(g => groups.has(g))) selected[e.id] = true;
      if (e.type === 'text' && e.containerId && selected[e.id]) selected[e.containerId] = true;
    }
    api.updateScene({ appState: { selectedElementIds: selected as any }, captureUpdate: NEVER });
  }
  function insideSelection(event: React.PointerEvent) {
    if (!api) return false;
    const rect = bounds(selectedContent(api)); if (!rect) return false;
    const s = api.getAppState(), pad = 28 / s.zoom.value, [x, y] = scenePoint(event);
    return x > rect.x - pad && x < rect.x + rect.width + pad && y > rect.y - pad * 1.6 && y < rect.y + rect.height + pad;
  }
  function panBy(dx: number, dy: number) {
    if (!api) return;
    const s = api.getAppState();
    api.updateScene({ appState: { scrollX: s.scrollX + dx / s.zoom.value, scrollY: s.scrollY + dy / s.zoom.value }, captureUpdate: NEVER });
  }
  function startInertia(vx: number, vy: number) {
    cancelAnimationFrame(inertia.current);
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, now - last); last = now;
      const decay = Math.pow(0.94, dt / 16);
      vx *= decay; vy *= decay;
      if (Math.hypot(vx, vy) < 0.03) return;
      panBy(vx * dt, vy * dt);
      inertia.current = requestAnimationFrame(step);
    };
    inertia.current = requestAnimationFrame(step);
  }
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    cancelAnimationFrame(inertia.current);
    if (busy.current) { event.stopPropagation(); event.preventDefault(); return; }
    if (event.pointerType === 'touch' && !props.fingerDraws) {
      // Fingers navigate (Pencil writes); with finger drawing on, the kernel handles touch itself.
      event.stopPropagation(); event.preventDefault();
      if (penDown.current) return; // palm while writing
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      event.currentTarget.setPointerCapture(event.pointerId);
      const g = gesture.current;
      if (!g) gesture.current = { fingers: 1, started: performance.now(), travel: 0, samples: [{ t: performance.now(), x: event.clientX, y: event.clientY }] };
      else g.fingers = Math.max(g.fingers, touches.current.size);
      return;
    }
    penDown.current = event.pointerType === 'pen';
    if (penDown.current) { touches.current.clear(); gesture.current = null; }
    if (!api || !drawsWith(event) || event.button > 0) return;
    if (tool.erase) {
      event.stopPropagation(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      erasing.current = true; lastErase.current = undefined; erase(event); return;
    }
    if (tool.marquee) {
      if (tool.marquee.purpose === 'select' && insideSelection(event)) return;
      event.stopPropagation(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      if (tool.marquee.purpose === 'select') handle.clearSelection();
      marquee.current = { id: event.pointerId, points: [local(event)] }; setMarqueePath([...marquee.current.points]);
    }
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (tool.erase && event.pointerType !== 'touch' && eraserCursor.current) {
      const [x, y] = local(event), r = tool.erase.radius;
      Object.assign(eraserCursor.current.style, { display: 'block', width: `${r * 2}px`, height: `${r * 2}px`, transform: `translate(${x - r}px, ${y - r}px)` });
    }
    const old = touches.current.get(event.pointerId);
    if (old) {
      event.stopPropagation();
      if (!api) return;
      const g = gesture.current!, s = api.getAppState(), peers = [...touches.current.entries()].filter(([id]) => id !== event.pointerId);
      g.travel += Math.hypot(event.clientX - old.x, event.clientY - old.y);
      if (peers.length) {
        const other = peers[0][1], distance = Math.hypot(old.x - other.x, old.y - other.y), nextDistance = Math.hypot(event.clientX - other.x, event.clientY - other.y);
        const zoomValue = clampZoom(s.zoom.value * nextDistance / Math.max(1, distance), kind === 'pages' ? 0.1 : undefined);
        const box = root.current!.getBoundingClientRect();
        const ox = (old.x + other.x) / 2 - box.left, oy = (old.y + other.y) / 2 - box.top, nx = (event.clientX + other.x) / 2 - box.left, ny = (event.clientY + other.y) / 2 - box.top;
        api.updateScene({ appState: { zoom: { value: zoomValue as any }, scrollX: s.scrollX + nx / zoomValue - ox / s.zoom.value, scrollY: s.scrollY + ny / zoomValue - oy / s.zoom.value }, captureUpdate: NEVER });
      } else {
        panBy(event.clientX - old.x, event.clientY - old.y);
        g.samples.push({ t: performance.now(), x: event.clientX, y: event.clientY }); if (g.samples.length > 6) g.samples.shift();
      }
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      return;
    }
    if (erasing.current) { event.stopPropagation(); erase(event); return; }
    if (marquee.current?.id === event.pointerId) {
      event.stopPropagation();
      const p = local(event), m = marquee.current;
      m.points = tool.marquee?.shape === 'rect' ? [m.points[0], p] : [...m.points, p];
      setMarqueePath(tool.marquee?.shape === 'rect' ? rectPath(m.points[0], p) : m.points);
    }
  };
  const finishTouch = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation(); touches.current.delete(event.pointerId);
    const g = gesture.current; if (!g || touches.current.size) return;
    gesture.current = null;
    const duration = performance.now() - g.started;
    if (event.type === 'pointerup' && duration < 300 && g.travel < 14 && g.fingers >= 2) { latest.current.onGesture?.(g.fingers === 2 ? 'undo' : 'redo'); return; }
    if (g.fingers === 1 && g.samples.length > 2) {
      const first = g.samples[0], last = g.samples[g.samples.length - 1], dt = last.t - first.t;
      if (dt > 0 && performance.now() - last.t < 60) startInertia((last.x - first.x) / dt, (last.y - first.y) / dt);
    }
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (touches.current.has(event.pointerId)) return finishTouch(event);
    if (event.pointerType === 'pen') penDown.current = false;
    if (erasing.current) { event.stopPropagation(); erasing.current = false; void flush().catch(() => {}); return; }
    const m = marquee.current;
    if (m?.id === event.pointerId) {
      event.stopPropagation(); marquee.current = null; setMarqueePath(null);
      if (!api || !tool.marquee) return;
      const s = api.getAppState();
      const screen = tool.marquee.shape === 'rect' ? (m.points.length > 1 ? rectPath(m.points[0], m.points[1]) : []) : m.points;
      const points = screen.map(([x, y]) => [x / s.zoom.value - s.scrollX, y / s.zoom.value - s.scrollY] as ScenePoint);
      if (points.length < 3 || polygonBounds(screen).width < 3 && polygonBounds(screen).height < 3) return;
      if (tool.marquee.purpose === 'select') lassoSelect(points);
      else latest.current.onMarquee?.(points, tool.marquee.purpose);
    }
  };
  const onPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (touches.current.has(event.pointerId)) return finishTouch(event);
    penDown.current = false;
    if (erasing.current) { erasing.current = false; void flush().catch(() => {}); }
    if (marquee.current?.id === event.pointerId) { marquee.current = null; setMarqueePath(null); }
  };
  useEffect(() => () => cancelAnimationFrame(inertia.current), []);

  const dark = props.theme === 'dark' && kind !== 'pages';
  const marqueeMode = tool.marquee ? ` is-marquee` : '';
  return <div ref={root} className={`ink-editor ink-editor-${kind}${tool.erase ? ' is-erasing' : ''}${marqueeMode}${dark ? ' is-dark' : ''}`} data-pressure={tool.pressure ? 'physical' : 'fixed'}
    onPointerLeave={() => { if (eraserCursor.current) eraserCursor.current.style.display = 'none'; }}
    onPointerDownCapture={onPointerDown} onPointerMoveCapture={onPointerMove} onPointerUpCapture={onPointerUp} onPointerCancelCapture={onPointerCancel}>
    {kind === 'pages' ? <PaperLayer layout={layout} views={views} pdf={pdf} sourceIssue={session.sourceIssue}/> : <GridLayer views={views} template={kind === 'canvas' ? session.manifest.pages[0].template : 'blank'} dark={dark}/>}
    {initial ? <Excalidraw langCode="zh-CN" excalidrawAPI={setApi} theme={dark ? 'dark' : 'light'} viewModeEnabled={props.readOnly ?? false}
      initialData={{ elements: initial.elements, files: { ...session.files }, appState: { viewBackgroundColor: 'transparent', currentItemRoughness: 0, penMode: !props.fingerDraws, ...initial.appState } }}
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, changeViewBackgroundColor: false, clearCanvas: false, toggleTheme: false } }}
      handleKeyboardGlobally={false} detectScroll={false} onScrollChange={onScroll} onChange={onKernelChange}/>
      : <div className="ink-canvas-status" role="status">{loadError ? <><span>{loadError}</span><button type="button" onClick={() => setAttempt(n => n + 1)}>重试</button></> : <span className="ink-spinner" aria-label="正在载入"/>}</div>}
    {initial && !isReady && <div className="ink-canvas-status is-cover" role="status"><span className="ink-spinner" aria-label="正在准备"/></div>}
    {kind === 'pages' && isReady && <PageOverlay layout={layout} views={views} onAddPage={props.onAddPage} flash={flash}/>}
    {kind !== 'pages' && flash && isReady && <PageOverlay layout={layout} views={views} flash={flash}/>}
    {marqueePath && <svg className="ink-marquee" aria-hidden="true"><polygon points={marqueePath.map(p => p.join(',')).join(' ')}/></svg>}
    {renderPending && <div className="ink-render-status" role="status"><span className="ink-spinner"/>正在绘制</div>}
    {tool.erase && <div ref={eraserCursor} className="ink-eraser-cursor" aria-hidden="true"/>}
  </div>;
}), (a, b) => a.session === b.session && a.pdf === b.pdf && a.kind === b.kind && a.pagesKey === b.pagesKey && a.fingerDraws === b.fingerDraws && a.theme === b.theme && a.readOnly === b.readOnly &&
  a.tool.kernel === b.tool.kernel && a.tool.color === b.tool.color && a.tool.width === b.tool.width && a.tool.opacity === b.tool.opacity && a.tool.fontSize === b.tool.fontSize && a.tool.pressure === b.tool.pressure &&
  a.tool.erase?.whole === b.tool.erase?.whole && a.tool.erase?.radius === b.tool.erase?.radius && a.tool.marquee?.shape === b.tool.marquee?.shape && a.tool.marquee?.purpose === b.tool.marquee?.purpose && !!a.onAddPage === !!b.onAddPage);

const rectPath = (a: ScenePoint, b: ScenePoint): ScenePoint[] => [a, [b[0], a[1]], b, [a[0], b[1]]];
const geometryOf = (layout: PageLayout) => layout.placements.map(({ page: p }) => `${p.id}:${p.width}x${p.height}:${p.margins.top},${p.margins.right},${p.margins.bottom},${p.margins.left}`).join('|');

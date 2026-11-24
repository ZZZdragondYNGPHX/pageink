import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Excalidraw, CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, AppState } from '@excalidraw/excalidraw/types';
import type { LocalPoint } from '@excalidraw/math';
import { Element, Page, Rect, MutableElement } from './model';
import type { InkApi } from './kernel-api';
import { bounds, cloneElements, eraseLinePath, eraseStrokePath, isHighlighterElement, lassoHits, polygonBounds, polygonContains, ScenePoint } from './geometry';
import { Session } from './session';
import { PdfService } from './pdf';
import { layoutPages, PageLayout, PageScene, PagePlacement, placementAt, toSceneRect } from './layout';
import { GridLayer, PageOverlay, PaperLayer } from './PaperLayer';
import { View, ViewStore, clampToDocument, clampZoom, fitRect, sceneViewport, toScene, toScreen, zoomAround } from './view';
import type { ViewMemory } from './host';
import { cardReference } from './cards';
import { scribbleRegion, eraseStrokeInRegion } from './scribble';
import { closedLoopPolygon, hitStrokePath, recognizeShape, RecognizedShape, strokeWorldPoints } from './ink-gestures';
import { createTapeElement, findTapeAt, isTapeElement, isTapeRevealed } from './tape';
import { createRulerLineElement, projectAlongRulerEdge, rulerEdgeProjection, RulerState } from './ruler';
import type { LassoFilter } from './preferences';

export type KernelTool = 'freedraw' | 'selection' | 'hand' | 'text' | 'rectangle' | 'ellipse' | 'diamond' | 'line' | 'arrow';
export type MarqueePurpose = 'select' | 'capture' | 'bookmark';
export interface CanvasTool {
  kernel: KernelTool; color: string; width: number; opacity: number; fontSize: number; pressure: boolean;
  inkKind?: 'pen' | 'highlighter';
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
  fillColor?: string;
  stabilize?: 0 | 1 | 2;
  erase?: { whole: boolean; radius: number; highlighterOnly?: boolean };
  tape?: { color: string; height: number };
  space?: boolean;
  scribble?: boolean;
  circleLasso?: boolean;
  holdToShape?: boolean;
  marquee?: { shape: 'rect' | 'lasso'; purpose: MarqueePurpose; filter?: LassoFilter };
}
export interface SelectionInfo {
  ids: string[];
  rect: Rect;
  busy: boolean;
  canGroup: boolean;
  grouped: boolean;
  locked: boolean;
  allImages: boolean;
  hasStrokeWidth: boolean;
  hasStrokeStyle: boolean;
  hasFill: boolean;
  hasTape: boolean;
  tapeRevealed: boolean;
  strokeColor?: string;
  strokeWidth?: number;
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
  backgroundColor?: string;
  opacity?: number;
  source?: { document: string; page: string; polygon: ScenePoint[] };
}
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
  /** Appends already-positioned scene elements without changing selection (used by Zoom Window). */
  appendElements(elements: readonly Element[]): Promise<void>;
  /** Erases along an explicit scene-coordinate path (used by Zoom Window). */
  eraseScenePath(path: readonly ScenePoint[], radius: number, whole: boolean, highlighterOnly?: boolean): Promise<void>;
  elements(pageId?: string): readonly Element[];
  pageOf(element: Element): string | undefined;
  selected(): Element[];
  replaceSelected(update: (element: Element) => Element | null): Promise<void>;
  transformScene(update: (elements: readonly Element[]) => { elements: Element[]; changed: boolean }, nextSelection?: Record<string, true>): Promise<boolean>;
  selectIds(ids: readonly string[]): void;
  clearSelection(): void;
  memory(): ViewMemory;
}
type Kind = 'pages' | 'canvas' | 'scratch';
interface Props {
  session: Session; pdf?: PdfService; kind: Kind;
  /** Changes whenever page geometry or paper appearance changes. */
  pagesKey: string;
  tool: CanvasTool; fingerDraws: boolean; zoomLock?: boolean; nightPaper?: boolean; gridSnap?: boolean; ruler?: RulerState | null; theme: 'light' | 'dark';
  readOnly?: boolean;
  initialView?: ViewMemory;
  onReady: (handle: CanvasHandle) => void;
  onError: (message: string) => void;
  onSelection?: (selection: SelectionInfo | null) => void;
  onMarquee?: (points: ScenePoint[], purpose: MarqueePurpose) => void;
  onGesture?: (gesture: 'undo' | 'redo') => void;
  onAddPage?: () => void;
  onViewChange?: () => void;
  onCardEdit?: (element: Element) => void;
  onScribble?: () => void;
  onEraseEnd?: () => void;
  onInsertSpace?: (pageId: string, sceneY: number, deltaY: number) => void;
  onToggleTape?: (id: string) => void;
}
const SCRATCH_PAGE: Page = { id: 'scratch', width: 1, height: 1, margins: { top: 0, right: 0, bottom: 0, left: 0 }, template: 'blank' };
const NEVER = CaptureUpdateAction.NEVER;
export const selectedContent = (api: ExcalidrawImperativeAPI): Element[] => {
  const ids = api.getAppState().selectedElementIds;
  const elements: readonly Element[] = api.getSceneElements();
  return elements.filter(e => ids[e.id] || e.type === 'text' && e.containerId && ids[e.containerId]);
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
  const [lassoFlash, setLassoFlash] = useState<{ points: ScenePoint[]; token: string } | null>(null);
  const [spaceBand, setSpaceBand] = useState<{ y: number; dy: number; sceneDy: number } | null>(null);
  const [tapePreview, setTapePreview] = useState<{ left: number; top: number; width: number; height: number; color: string } | null>(null);
  const [rulerLine, setRulerLine] = useState<{ x1: number; y1: number; x2: number; y2: number; color: string; width: number; opacity: number } | null>(null);
  const [penLassoActive, setPenLassoActive] = useState(false);
  const penLassoRef = useRef(false);
  const lockedZoom = useRef<number | null>(null);
  const busy = useRef(false), timer = useRef<number>();
  const flushedRevision = useRef<number>();
  const owner = kind === 'scratch' ? 'scratch' : 'body';
  const setPenLasso = (active: boolean) => {
    if (penLassoRef.current === active) return;
    penLassoRef.current = active;
    setPenLassoActive(active);
  };

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
    const onWheel = (event: WheelEvent) => {
      if (latest.current.zoomLock && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); }
    };
    element.addEventListener('ink-render-status', status);
    element.addEventListener('wheel', onWheel, { capture: true, passive: false });
    let frame = 0;
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect, previous = views.get();
      const fit = Math.min(1.25, (previous.width - 48) / layoutRef.current.maxWidth);
      const followsWidth = kind === 'pages' && ready.current && previous.width > 48 && Math.abs(previous.zoom - fit) < 0.02;
      views.set({ width, height });
      window.cancelAnimationFrame(frame);
      if (api && followsWidth && width > 48 && Math.abs(width - previous.width) > 1) frame = window.requestAnimationFrame(() => {
        const v = views.get(), zoom = clampZoom(Math.min(1.25, (v.width - 48) / layoutRef.current.maxWidth), 0.1);
        setView({ ...zoomAround(v, zoom), scrollX: -(layoutRef.current.bounds.x + layoutRef.current.bounds.width / 2 - v.width / zoom / 2) });
      });
    });
    observer.observe(element);
    return () => { element.removeEventListener('ink-render-status', status); element.removeEventListener('wheel', onWheel, true); observer.disconnect(); window.cancelAnimationFrame(frame); };
  }, [api]);

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
  const state = (v: Pick<View, 'zoom' | 'scrollX' | 'scrollY'>): Pick<AppState, 'zoom' | 'scrollX' | 'scrollY'> => ({ zoom: { value: v.zoom as AppState['zoom']['value'] }, scrollX: v.scrollX, scrollY: v.scrollY });

  // ---------- persistence ----------
  function sanitizeOrphanedRefs(elements: readonly Element[]): readonly Element[] {
    let changed = false;
    const assets = session.manifest.assets;
    const next = elements.map(e => {
      if (e.isDeleted || !e.customData) return e;
      const badText = e.customData.pageinkText && !assets[e.customData.pageinkText.snapshotAsset];
      const badCard = e.customData.pageinkCard?.kind === 'ink' && !assets[e.customData.pageinkCard.archiveAsset];
      if (!badText && !badCard) return e;
      changed = true;
      const data = { ...e.customData };
      if (badText) delete data.pageinkText;
      if (badCard) delete data.pageinkCard;
      return { ...e, customData: Object.keys(data).length ? data : undefined };
    });
    return changed ? next : elements;
  }
  async function flush(record = true) {
    if (!api || !ready.current || !scene.current) return;
    try {
      await session.acceptFiles(api.getFiles());
      const revision = (api as InkApi).inkRevision();
      if (revision === flushedRevision.current) return;
      const raw = api.getSceneElementsIncludingDeleted();
      const safe = sanitizeOrphanedRefs(raw);
      if (safe !== raw) api.updateScene({ elements: safe, captureUpdate: NEVER });
      session.changeMany(scene.current.partition(safe), record);
      flushedRevision.current = (api as InkApi).inkRevision();
    } catch (error) { latest.current.onError((error as Error).message); throw error; }
  }
  /** Records kernel normalisation (restore, re-indexing) without creating an undo step. */
  function absorb() {
    if (api && scene.current) {
      session.changeMany(scene.current.partition(api.getSceneElementsIncludingDeleted()), false);
      flushedRevision.current = (api as InkApi).inkRevision();
    }
  }
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
      session.flushers.set(owner, () => { finishScribble(); return flush(); });
      const s = api.getAppState();
      views.set({ scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value });
      if (latest.current.zoomLock) lockedZoom.current = s.zoom.value;
      setIsReady(true);
      latest.current.onReady(handle);
    };
    const unsubscribe = api.onChange(check); check();
    const fallback = window.setInterval(() => { check(); if (done) window.clearInterval(fallback); }, 300);
    let active = true;
    const pointerUp = api.onPointerUp((_tool, _state, event) => {
      if (gestureClaimed.current === event.pointerId) {
        gestureClaimed.current = null;
        scribble.current = null;
        session.setWriting(owner, false);
        return;
      }
      if (scribble.current?.id === event.pointerId) scribble.current.finished = true;
      window.clearTimeout(timer.current);
      // The kernel finalises geometry after its pointer-up emitter. A microtask
      // sees the completed stroke before the next input event can start another.
      window.queueMicrotask(() => {
        if (!active || api.getAppState().newElement) return;
        const erased = finishScribble();
        if (!erased) rememberClosedLoop();
        window.clearTimeout(timer.current); session.setWriting(owner, false); void flush().catch(() => {});
      });
    });
    // The parent flushes before closing. Reading an already-unmounted engine here can return an
    // empty scene and must never be persisted as a deletion.
    return () => { active = false; unsubscribe(); pointerUp(); window.clearInterval(fallback); window.clearTimeout(timer.current); session.setWriting(owner, false); if (session.flushers.get(owner)) session.flushers.delete(owner); for (const id of [...session.surfaces.keys()]) session.releaseSurface(id); };
  }, [api, initial]);

  // ---------- tool ----------
  const tool = props.tool;
  useEffect(() => {
    setPenLasso(false);
  }, [tool.kernel, tool.inkKind, props.readOnly]);
  const effectiveKernel: KernelTool = penLassoActive && tool.kernel === 'freedraw' ? 'selection' : tool.kernel;
  useEffect(() => {
    if (api && isReady) api.setActiveTool({ type: effectiveKernel, locked: effectiveKernel !== 'selection' && effectiveKernel !== 'hand' });
  }, [api, isReady, effectiveKernel]);
  useEffect(() => {
    if (!api || !isReady) return;
    api.updateScene({ appState: { currentItemStrokeColor: tool.color, currentItemStrokeWidth: tool.width, currentItemOpacity: tool.opacity, currentItemFontSize: tool.fontSize,
      currentItemRoughness: 0, currentItemFontFamily: 2, currentItemStrokeStyle: tool.strokeStyle ?? 'solid', currentItemBackgroundColor: tool.fillColor ?? 'transparent', currentItemFillStyle: 'solid',
      gridModeEnabled: !!props.gridSnap, gridSize: 24, penMode: !props.fingerDraws }, captureUpdate: NEVER });
  }, [api, isReady, tool.kernel, tool.color, tool.width, tool.opacity, tool.fontSize, tool.strokeStyle, tool.fillColor, props.gridSnap, props.fingerDraws]);

  // ---------- viewport ----------
  useEffect(() => {
    lockedZoom.current = props.zoomLock ? views.get().zoom : null;
  }, [props.zoomLock]);
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
    if (latest.current.zoomLock) lockedZoom.current = next.zoom;
    api.updateScene({ appState: state(next), captureUpdate: NEVER });
    clampView();
  }
  const onScroll = (scrollX: number, scrollY: number, zoom: { value: number }) => {
    if (ready.current && latest.current.zoomLock && lockedZoom.current !== null && Math.abs(zoom.value - lockedZoom.current) > 0.001) {
      const v = views.get();
      api?.updateScene({ appState: state({ zoom: lockedZoom.current, scrollX: v.scrollX, scrollY: v.scrollY }), captureUpdate: NEVER });
      return;
    }
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
  useEffect(() => { if (!flash) return; const t = window.setTimeout(() => setFlash(null), 1600); return () => window.clearTimeout(t); }, [flash]);
  useEffect(() => { if (!lassoFlash) return; const t = window.setTimeout(() => setLassoFlash(null), 650); return () => window.clearTimeout(t); }, [lassoFlash]);

  // ---------- selection reporting ----------
  const selectionFrame = useRef(0), lastSelection = useRef<unknown>(null), hadSelection = useRef(false);
  const onKernelChange = (_elements: readonly unknown[], appState: AppState) => {
    if (!ready.current) return;
    window.clearTimeout(timer.current);
    if (!appState.editingTextElement && !appState.newElement && !appState.isResizing && !appState.isRotating && !appState.selectedElementsAreBeingDragged) {
      timer.current = window.setTimeout(() => void flush().catch(() => {}), 500);
    }
    const any = Object.values(appState.selectedElementIds).some(Boolean);
    if (!any && penLassoRef.current) setPenLasso(false);
    if (!any && !hadSelection.current && lastSelection.current === appState.selectedElementIds) return;
    lastSelection.current = appState.selectedElementIds;
    window.cancelAnimationFrame(selectionFrame.current);
    selectionFrame.current = window.requestAnimationFrame(reportSelection);
  };
  function reportSelection() {
    if (!api) return;
    const s = api.getAppState(), selected = s.editingTextElement ? [] : selectedContent(api), rect = bounds(selected);
    hadSelection.current = !!rect;
    if (!rect) { if (penLassoRef.current) setPenLasso(false); latest.current.onSelection?.(null); return; }
    const source = selected.length === 1 && selected[0].type === 'image' ? selected[0].customData?.source : undefined;
    const firstOuter = selected[0]?.groupIds[selected[0].groupIds.length - 1];
    const alreadySingleGroup = !!(firstOuter && selected.every(e => e.groupIds[e.groupIds.length - 1] === firstOuter));
    const singlePage = kind !== 'pages' || new Set(selected.map(e => pageOfElement(e))).size <= 1;
    const nonImages = selected.filter(e => e.type !== 'image');
    const styleSample = nonImages[0];
    const strokeStyleSample = selected.find(e => ['rectangle', 'ellipse', 'diamond', 'line', 'arrow'].includes(e.type));
    const fillSample = selected.find(e => ['rectangle', 'ellipse', 'diamond'].includes(e.type));
    const tapeItems = selected.filter(isTapeElement);
    latest.current.onSelection?.({
      ids: selected.map(e => e.id),
      rect,
      busy: !!(s.selectedElementsAreBeingDragged || s.isResizing || s.isRotating),
      canGroup: selected.length >= 2 && !alreadySingleGroup && singlePage,
      grouped: selected.some(e => e.groupIds.length > 0),
      locked: selected.every(e => e.locked),
      allImages: nonImages.length === 0,
      hasStrokeWidth: selected.some(e => e.type !== 'image' && e.type !== 'text'),
      hasStrokeStyle: !!strokeStyleSample,
      hasFill: !!fillSample,
      hasTape: tapeItems.length > 0,
      tapeRevealed: tapeItems.length > 0 && tapeItems.every(isTapeRevealed),
      strokeColor: styleSample?.strokeColor,
      strokeWidth: styleSample?.strokeWidth,
      strokeStyle: strokeStyleSample?.strokeStyle,
      backgroundColor: fillSample?.backgroundColor,
      opacity: selected[0]?.opacity,
      source: source?.polygon ? { ...source, polygon: source.polygon } : undefined,
    });
  }
  useEffect(() => () => window.cancelAnimationFrame(selectionFrame.current), []);

  // ---------- editing helpers ----------
  async function insert(elements: readonly Element[], at?: ScenePoint) {
    if (!api || !elements.length) return;
    const box = bounds(elements)!, [cx, cy] = at ?? center();
    const copies = cloneElements(elements, cx - (box.x + box.width / 2), cy - (box.y + box.height / 2)).map(e => ({ ...e, index: null }));
    api.addFiles(Object.values(session.files));
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...copies], appState: { selectedElementIds: Object.fromEntries(copies.filter(e => !(e.type === 'text' && e.containerId)).map(e => [e.id, true])) }, captureUpdate: NEVER });
    await flush();
  }
  async function appendElements(elements: readonly Element[]) {
    if (!api || !elements.length) return;
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...elements], captureUpdate: NEVER });
    await flush();
  }
  async function eraseScenePath(path: readonly ScenePoint[], radius: number, whole: boolean, highlighterOnly = false) {
    if (!api || !path.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of path) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    const candidates = (api as InkApi).inkQuery({ x: minX - radius, y: minY - radius, width: maxX - minX + radius * 2, height: maxY - minY + radius * 2 });
    const patches = new Map<string, Element[]>();
    for (const e of candidates) {
      if (e.locked) continue;
      if (e.type === 'line' && (isHighlighterElement(e) || (!highlighterOnly && e.customData?.inkKind === 'pen'))) {
        const pieces = eraseLinePath(e, path, radius, whole);
        if (pieces.length !== 1 || pieces[0] !== e) patches.set(e.id, pieces);
        continue;
      }
      if (e.type !== 'freedraw') continue;
      if (highlighterOnly && !isHighlighterElement(e)) continue;
      const pieces = eraseStrokePath(e, path, radius, whole);
      if (pieces.length !== 1 || pieces[0] !== e) patches.set(e.id, pieces);
    }
    if (patches.size) {
      (api as InkApi).inkErase(patches);
      await flush();
    }
  }
  async function replaceSelected(update: (element: Element) => Element | null) {
    if (!api) return;
    const ids = new Set(selectedContent(api).map(e => e.id));
    const next: Element[] = [];
    for (const e of api.getSceneElementsIncludingDeleted()) {
      if (!ids.has(e.id)) { next.push(e); continue; }
      const result = update(e);
      if (result) next.push(result === e ? e : { ...result, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 30), updated: Date.now() });
    }
    const kept = new Set(next.map(e => e.id));
    // Detach bindings to removed elements so the remaining scene stays consistent.
    const consistent = next.map(e => {
      const copy: MutableElement = { ...e }; let changed = false;
      if (copy.boundElements?.some(b => !kept.has(b.id))) { copy.boundElements = copy.boundElements.filter(b => kept.has(b.id)); changed = true; }
      if ('startBinding' in copy) for (const key of ['startBinding', 'endBinding'] as const) if (copy[key] && !kept.has(copy[key].elementId)) { copy[key] = null; changed = true; }
      return changed ? { ...copy, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 30) } : e;
    });
    api.updateScene({ elements: consistent, appState: kept.size === next.length && [...ids].every(id => kept.has(id)) ? undefined : { selectedElementIds: {} }, captureUpdate: NEVER });
    await flush();
  }
  async function transformScene(update: (elements: readonly Element[]) => { elements: Element[]; changed: boolean }, nextSelection?: Record<string, true>) {
    if (!api) return false;
    const result = update(api.getSceneElementsIncludingDeleted());
    if (!result.changed) return false;
    api.updateScene({ elements: result.elements, appState: nextSelection ? { selectedElementIds: nextSelection } : undefined, captureUpdate: NEVER });
    await flush();
    return true;
  }
  function selectIds(ids: readonly string[]) {
    if (!api) return;
    const set = new Set(ids), selected: Record<string, true> = {};
    for (const e of api.getSceneElements()) {
      if (set.has(e.id) && !(e.type === 'text' && e.containerId && set.has(e.containerId))) selected[e.id] = true;
    }
    api.updateScene({ appState: { selectedElementIds: selected }, captureUpdate: NEVER });
    if (Object.keys(selected).length && latest.current.tool.kernel === 'freedraw') setPenLasso(true);
  }
  function center(): ScenePoint { const v = views.get(); return toScene(v, v.width / 2, v.height / 2); }
  function memory(): ViewMemory {
    const v = views.get(), area = sceneViewport(v);
    if (kind !== 'pages') return { dx: area.x, dy: area.y, zoom: v.zoom };
    const page = placementAt(layoutRef.current, area.y + Math.min(area.height / 2, 40 / v.zoom));
    return { page: page.page.id, dx: area.x - page.paper.x, dy: area.y - page.paper.y, zoom: v.zoom };
  }
  function pageOfElement(e: Element): string | undefined {
    if (!scene.current) return undefined;
    const ownerPage = scene.current.pageOf(e.id);
    if (ownerPage) return ownerPage;
    const box = bounds([e]);
    return placementAt(scene.current.layout, box ? box.y + box.height / 2 : e.y).page.id;
  }
  function sceneElements(pageId?: string): readonly Element[] {
    if (!api) return [];
    const live = api.getSceneElements();
    if (!pageId || !scene.current) return live;
    return live.filter(e => pageOfElement(e) === pageId);
  }
  const handle: CanvasHandle = {
    get api() { return api!; }, views, flush: () => flush(), rebuild, layout: () => layoutRef.current, currentPage, reveal, zoom, center, insert, appendElements, eraseScenePath,
    elements: sceneElements, pageOf: pageOfElement,
    selected: () => api ? selectedContent(api) : [], replaceSelected, transformScene, selectIds, memory,
    clearSelection: () => { setPenLasso(false); api?.updateScene({ appState: { selectedElementIds: {} }, captureUpdate: NEVER }); },
  };
  useImperativeHandle(forwarded, () => handle);

  // ---------- pointer input ----------
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ fingers: number; started: number; travel: number; samples: { t: number; x: number; y: number }[] } | null>(null);
  const inertia = useRef(0);
  const penDown = useRef(false), erasing = useRef<number | null>(null), lastErase = useRef<ScenePoint>();
  const spaceDrag = useRef<{ id: number; startScreenY: number; sceneY: number; pageId: string; deltaSceneY: number } | null>(null);
  const tapeDrag = useRef<{ id: number; startScreen: ScenePoint; startScene: ScenePoint; curScreen: ScenePoint; curScene: ScenePoint; hitTapeId?: string; color: string; height: number } | null>(null);
  const rulerDrag = useRef<{ id: number; edge: -1 | 1; ruler: RulerState; startScreen: [number, number]; curScreen: [number, number]; startScene: ScenePoint; color: string; width: number; opacity: number; inkKind: 'pen' | 'highlighter' } | null>(null);
  const eraseQueue = useRef<ScenePoint[]>([]), eraseFrame = useRef(0);
  const scribble = useRef<{ id: number; started: number; zoom: number; finished: boolean; previous?: string } | null>(null);
  const recentLoop = useRef<{ id: string; versionNonce: number; polygon: ScenePoint[]; time: number } | null>(null);
  const loopHold = useRef<{ id: number; start: ScenePoint; loopId: string; polygon: ScenePoint[]; timer: number } | null>(null);
  const drawHold = useRef<{ id: number; last: ScenePoint; anchor: ScenePoint; travel: number; timer: number } | null>(null);
  const gestureClaimed = useRef<number | null>(null);
  const marquee = useRef<{ id: number; points: ScenePoint[] } | null>(null);
  const eraserCursor = useRef<HTMLDivElement>(null);
  const local = (event: React.PointerEvent): ScenePoint => { const box = root.current!.getBoundingClientRect(); return [event.clientX - box.left, event.clientY - box.top]; };
  const localClient = (clientX: number, clientY: number): ScenePoint => { const box = root.current!.getBoundingClientRect(); return [clientX - box.left, clientY - box.top]; };
  const scenePoint = (event: React.PointerEvent): ScenePoint => { const s = api!.getAppState(), [x, y] = local(event); return [x / s.zoom.value - s.scrollX, y / s.zoom.value - s.scrollY]; };
  const sceneFromClient = (clientX: number, clientY: number): ScenePoint => { const s = api!.getAppState(), [x, y] = localClient(clientX, clientY); return [x / s.zoom.value - s.scrollX, y / s.zoom.value - s.scrollY]; };
  const drawsWith = (event: React.PointerEvent) => event.pointerType !== 'touch' || props.fingerDraws;

  function cancelHolds() {
    if (loopHold.current) { window.clearTimeout(loopHold.current.timer); loopHold.current = null; }
    if (drawHold.current) { window.clearTimeout(drawHold.current.timer); drawHold.current = null; }
  }

  function flashLassoPolygon(scenePolygon: readonly ScenePoint[]) {
    const v = views.get();
    setLassoFlash({ points: scenePolygon.map(([x, y]) => toScreen(v, x, y)), token: String(performance.now()) });
  }

  function finishScribble(): boolean {
    const g = scribble.current;
    if (!api || !g?.finished) return false;
    scribble.current = null;
    const elements = api.getSceneElements(), stroke = elements[elements.length - 1];
    if (!stroke || stroke.type !== 'freedraw' || stroke.id === g.previous) return false;
    // Recognise from the kernel's completed samples, including coalesced input.
    // The derived 2px path avoids jitter and never changes the stored stroke.
    const points: ScenePoint[] = [];
    for (const [x, y] of stroke.points) {
      const point: ScenePoint = [stroke.x + x, stroke.y + y], previous = points[points.length - 1];
      if (!previous || Math.hypot(point[0] - previous[0], point[1] - previous[1]) * g.zoom >= 2) points.push(point);
    }
    const region = scribbleRegion(points, g.zoom, performance.now() - g.started);
    if (!region) return false;
    const candidates = (api as InkApi).inkQuery(polygonBounds(region));
    const patches = new Map<string, Element[]>();
    for (const e of candidates) {
      if (e.id === stroke.id) continue;
      const remaining = eraseStrokeInRegion(e, region);
      if (remaining.length !== 1 || remaining[0] !== e) patches.set(e.id, remaining);
    }
    if (!patches.size) return false; // An ordinary mark on blank paper remains ink.
    // Remove the gesture itself before recording: undo restores only the original handwriting.
    patches.set(stroke.id, []); (api as InkApi).inkErase(patches);
    latest.current.onScribble?.();
    return true;
  }

  function rememberClosedLoop() {
    if (!api || !latest.current.tool.circleLasso || latest.current.tool.kernel !== 'freedraw') return;
    const elements = api.getSceneElements(), stroke = elements[elements.length - 1];
    if (!stroke || stroke.type !== 'freedraw' || stroke.locked) return;
    const poly = closedLoopPolygon(strokeWorldPoints(stroke), api.getAppState().zoom.value);
    if (poly) recentLoop.current = { id: stroke.id, versionNonce: stroke.versionNonce, polygon: poly, time: performance.now() };
  }

  function flushErase() {
    eraseFrame.current = 0;
    const batch = eraseQueue.current;
    if (!api || !latest.current.tool.erase || !batch.length) { eraseQueue.current = []; return; }
    eraseQueue.current = [];
    const activeErase = latest.current.tool.erase;
    const radius = activeErase.radius / api.getAppState().zoom.value;
    const path: ScenePoint[] = lastErase.current ? [lastErase.current, ...batch] : batch;
    lastErase.current = batch[batch.length - 1];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of path) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    const candidates = (api as InkApi).inkQuery({ x: minX - radius, y: minY - radius, width: maxX - minX + radius * 2, height: maxY - minY + radius * 2 });
    const patches = new Map<string, Element[]>();
    for (const e of candidates) {
      if (e.locked) continue;
      if (e.type === 'line' && (isHighlighterElement(e) || (!activeErase.highlighterOnly && e.customData?.inkKind === 'pen'))) {
        const pieces = eraseLinePath(e, path, radius, activeErase.whole);
        if (pieces.length !== 1 || pieces[0] !== e) patches.set(e.id, pieces);
        continue;
      }
      if (e.type !== 'freedraw') continue;
      if (activeErase.highlighterOnly && !isHighlighterElement(e)) continue;
      const pieces = eraseStrokePath(e, path, radius, activeErase.whole);
      if (pieces.length !== 1 || pieces[0] !== e) patches.set(e.id, pieces);
    }
    if (patches.size) (api as InkApi).inkErase(patches);
  }

  function queueErase(event: React.PointerEvent, immediate = false) {
    if (!api || !tool.erase) return;
    const coalesced = event.nativeEvent.getCoalescedEvents?.();
    if (coalesced?.length) {
      for (const sample of coalesced) eraseQueue.current.push(sceneFromClient(sample.clientX, sample.clientY));
    } else {
      eraseQueue.current.push(scenePoint(event));
    }
    if (immediate) {
      window.cancelAnimationFrame(eraseFrame.current);
      flushErase();
    } else if (!eraseFrame.current) {
      eraseFrame.current = window.requestAnimationFrame(flushErase);
    }
  }

  function lassoMatches(e: Element, filter?: LassoFilter): boolean {
    if (!filter || filter === 'all') return true;
    if (filter === 'highlighter') return isHighlighterElement(e);
    return e.type === 'freedraw' && !isHighlighterElement(e);
  }

  function lassoSelect(points: ScenePoint[], filter?: LassoFilter, excludeIds?: ReadonlySet<string>): number {
    if (!api) return 0;
    const selected: Record<string, true> = {};
    const candidates = (api as InkApi).inkQuery(polygonBounds(points));
    for (const e of candidates) {
      if (excludeIds?.has(e.id)) continue;
      if (lassoMatches(e, filter) && lassoHits(e, points)) selected[e.id] = true;
    }
    if (!Object.keys(selected).length) {
      api.updateScene({ appState: { selectedElementIds: {} }, captureUpdate: NEVER });
      return 0;
    }
    // Bring grouped and bound objects into the same operation, preserving editing relationships.
    const groups = new Set(candidates.filter(e => selected[e.id]).flatMap(e => e.groupIds));
    for (const e of api.getSceneElements()) {
      if (excludeIds?.has(e.id)) continue;
      if (e.groupIds.some(g => groups.has(g))) selected[e.id] = true;
      if (e.type === 'text' && e.containerId && selected[e.id]) selected[e.containerId] = true;
    }
    api.updateScene({ appState: { selectedElementIds: selected }, captureUpdate: NEVER });
    return Object.keys(selected).length;
  }

  function triggerCircleLasso(pointerId: number, removeIds: string[], polygon: ScenePoint[]) {
    if (!api) return;
    const exclude = new Set(removeIds);
    const candidates = (api as InkApi).inkQuery(polygonBounds(polygon));
    const hasHits = candidates.some(e => !exclude.has(e.id) && lassoHits(e, polygon));
    if (!hasHits) return;
    gestureClaimed.current = pointerId;
    scribble.current = null;
    recentLoop.current = null;
    cancelHolds();
    api.updateScene({ appState: { newElement: null }, captureUpdate: NEVER });
    const patches = new Map<string, Element[]>();
    for (const id of removeIds) patches.set(id, []);
    if (patches.size) (api as InkApi).inkErase(patches);
    const count = lassoSelect(polygon, 'all', exclude);
    if (count > 0) {
      setPenLasso(true);
      flashLassoPolygon(polygon);
      void flush().catch(() => {});
    }
  }

  function triggerDrawHold(pointerId: number) {
    if (!api) return;
    const live = api.getAppState().newElement;
    if (!live || live.type !== 'freedraw') return;
    const activeTool = latest.current.tool;
    const zoom = api.getAppState().zoom.value;
    const worldPts = strokeWorldPoints(live);
    const closed = closedLoopPolygon(worldPts, zoom);
    const exclude = new Set([live.id]);
    const enclosesContent = !!(closed && (api as InkApi).inkQuery(polygonBounds(closed)).some(e => !exclude.has(e.id) && lassoHits(e, closed)));
    const shape = activeTool.holdToShape ? recognizeShape(worldPts, zoom, { lineOnly: activeTool.inkKind === 'highlighter', enclosesContent }) : null;
    if (shape) {
      gestureClaimed.current = pointerId;
      scribble.current = null;
      cancelHolds();
      const created = createShapeElement(shape, live, activeTool.inkKind);
      // Commit the raw hand-drawn stroke to history first so Undo restores the original raw points & pressures.
      api.updateScene({ appState: { newElement: null }, captureUpdate: NEVER });
      void flush().then(() => {
        if (!ready.current || !api.getSceneElementsIncludingDeleted().some(e => e.id === live.id && !e.isDeleted)) return;
        const remaining = api.getSceneElementsIncludingDeleted().filter(e => e.id !== live.id);
        api.updateScene({ elements: [...remaining, ...created], captureUpdate: NEVER });
        return flush();
      }).catch(() => {});
      return;
    }
    if (activeTool.circleLasso && closed && enclosesContent) {
      triggerCircleLasso(pointerId, [live.id], closed);
    }
  }

  function findClosedLoopAt(pt: ScenePoint, zoom: number): { id: string; polygon: ScenePoint[] } | null {
    if (!api) return null;
    const tol = 16 / zoom;
    const recent = recentLoop.current;
    if (recent && performance.now() - recent.time < 15000) {
      const el = api.getSceneElements().find(e => e.id === recent.id && !e.isDeleted && !e.locked);
      if (el && el.versionNonce === recent.versionNonce) {
        if (hitStrokePath(el, pt, tol) || polygonContains(recent.polygon, pt)) {
          return { id: el.id, polygon: recent.polygon };
        }
      } else {
        recentLoop.current = null;
      }
    }
    const nearby = (api as InkApi).inkQuery({ x: pt[0] - tol, y: pt[1] - tol, width: tol * 2, height: tol * 2 });
    for (let i = nearby.length - 1; i >= 0; i--) {
      const e = nearby[i];
      if (e.type !== 'freedraw' || e.locked || !hitStrokePath(e, pt, tol)) continue;
      const poly = closedLoopPolygon(strokeWorldPoints(e), zoom);
      if (poly) return { id: e.id, polygon: poly };
    }
    return null;
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
    window.cancelAnimationFrame(inertia.current);
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, now - last); last = now;
      const decay = Math.pow(0.94, dt / 16);
      vx *= decay; vy *= decay;
      if (Math.hypot(vx, vy) < 0.03) return;
      panBy(vx * dt, vy * dt);
      inertia.current = window.requestAnimationFrame(step);
    };
    inertia.current = window.requestAnimationFrame(step);
  }
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    window.cancelAnimationFrame(inertia.current);
    if (busy.current) { event.stopPropagation(); event.preventDefault(); return; }
    if (event.pointerType === 'touch' && penDown.current) { event.stopPropagation(); event.preventDefault(); return; }
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
    if (props.readOnly) return;
    cancelHolds();
    gestureClaimed.current = null;
    finishScribble();
    window.clearTimeout(timer.current);
    session.setWriting(owner, true);
    if (tool.scribble && tool.kernel === 'freedraw' && !penLassoRef.current && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const elements = api.getSceneElements();
      scribble.current = { id: event.pointerId, started: performance.now(), zoom: api.getAppState().zoom.value, finished: false, previous: elements[elements.length - 1]?.id };
    }
    if (tool.space) {
      event.stopPropagation(); event.preventDefault();
      if (spaceDrag.current) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      const [, sy] = local(event), [, sceneY] = scenePoint(event);
      const pageId = kind === 'pages' ? placementAt(layoutRef.current, sceneY).page.id : pages()[0].id;
      spaceDrag.current = { id: event.pointerId, startScreenY: sy, sceneY, pageId, deltaSceneY: 0 };
      setSpaceBand({ y: sy, dy: 0, sceneDy: 0 });
      return;
    }
    if (tool.tape) {
      event.stopPropagation(); event.preventDefault();
      if (tapeDrag.current) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      const startScreen = local(event), startScene = scenePoint(event);
      const hit = findTapeAt(api.getSceneElements(), startScene);
      tapeDrag.current = { id: event.pointerId, startScreen, startScene, curScreen: startScreen, curScene: startScene, hitTapeId: hit?.id, color: tool.tape.color, height: tool.tape.height };
      return;
    }
    if (tool.erase) {
      event.stopPropagation(); event.preventDefault();
      if (erasing.current !== null) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      erasing.current = event.pointerId; lastErase.current = undefined; eraseQueue.current = []; queueErase(event, true); return;
    }
    if (tool.marquee) {
      if (tool.marquee.purpose === 'select' && insideSelection(event)) return;
      event.stopPropagation(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      if (tool.marquee.purpose === 'select') handle.clearSelection();
      marquee.current = { id: event.pointerId, points: [local(event)] }; setMarqueePath([...marquee.current.points]);
      return;
    }
    if (props.ruler && tool.kernel === 'freedraw' && !penLassoRef.current && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const hit = rulerEdgeProjection(local(event), props.ruler);
      if (hit) {
        event.stopPropagation(); event.preventDefault();
        if (rulerDrag.current) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        scribble.current = null;
        const s = api.getAppState();
        const startScene: ScenePoint = [hit.projected[0] / s.zoom.value - s.scrollX, hit.projected[1] / s.zoom.value - s.scrollY];
        const snapRuler = { ...props.ruler };
        rulerDrag.current = {
          id: event.pointerId, edge: hit.edge, ruler: snapRuler,
          startScreen: hit.projected, curScreen: hit.projected, startScene,
          color: tool.color, width: tool.width, opacity: tool.opacity, inkKind: tool.inkKind ?? 'pen',
        };
        setRulerLine({ x1: hit.projected[0], y1: hit.projected[1], x2: hit.projected[0], y2: hit.projected[1], color: tool.color, width: Math.max(1.5, tool.width * s.zoom.value), opacity: tool.opacity / 100 });
        return;
      }
    }
    if (tool.kernel === 'freedraw' && !penLassoRef.current && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const screenPt = local(event);
      if (tool.circleLasso) {
        const hitLoop = findClosedLoopAt(scenePoint(event), api.getAppState().zoom.value);
        if (hitLoop) {
          const pointerId = event.pointerId;
          const t = window.setTimeout(() => {
            if (loopHold.current?.id !== pointerId || !api) return;
            const liveId = api.getAppState().newElement?.id;
            const removeIds = liveId && liveId !== hitLoop.id ? [hitLoop.id, liveId] : [hitLoop.id];
            triggerCircleLasso(pointerId, removeIds, hitLoop.polygon);
          }, 340);
          loopHold.current = { id: pointerId, start: screenPt, loopId: hitLoop.id, polygon: hitLoop.polygon, timer: t };
        }
      }
      if (tool.holdToShape || tool.circleLasso) {
        drawHold.current = { id: event.pointerId, last: screenPt, anchor: screenPt, travel: 0, timer: 0 };
      }
    }
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' && penDown.current) { event.stopPropagation(); return; }
    const stroke = scribble.current;
    if (stroke?.id === event.pointerId && !stroke.finished && performance.now() - stroke.started > 3500) scribble.current = null;
    if (tool.erase && event.pointerType !== 'touch' && eraserCursor.current) {
      const [x, y] = local(event), r = tool.erase.radius;
      eraserCursor.current.classList.add('is-visible');
      Object.assign(eraserCursor.current.style, { width: `${r * 2}px`, height: `${r * 2}px`, transform: `translate(${x - r}px, ${y - r}px)` });
    }
    const old = touches.current.get(event.pointerId);
    if (old) {
      event.stopPropagation();
      cancelHolds();
      if (!api) return;
      const g = gesture.current!, s = api.getAppState(), peers = [...touches.current.entries()].filter(([id]) => id !== event.pointerId);
      g.travel += Math.hypot(event.clientX - old.x, event.clientY - old.y);
      if (peers.length) {
        const other = peers[0][1], distance = Math.hypot(old.x - other.x, old.y - other.y), nextDistance = Math.hypot(event.clientX - other.x, event.clientY - other.y);
        const zoomValue = props.zoomLock ? s.zoom.value : clampZoom(s.zoom.value * nextDistance / Math.max(1, distance), kind === 'pages' ? 0.1 : undefined);
        const box = root.current!.getBoundingClientRect();
        const ox = (old.x + other.x) / 2 - box.left, oy = (old.y + other.y) / 2 - box.top, nx = (event.clientX + other.x) / 2 - box.left, ny = (event.clientY + other.y) / 2 - box.top;
        api.updateScene({ appState: { zoom: { value: zoomValue as AppState['zoom']['value'] }, scrollX: s.scrollX + nx / zoomValue - ox / s.zoom.value, scrollY: s.scrollY + ny / zoomValue - oy / s.zoom.value }, captureUpdate: NEVER });
      } else {
        const lockHorizontal = props.zoomLock && kind === 'pages' && layoutRef.current.maxWidth * s.zoom.value <= views.get().width - 16;
        panBy(lockHorizontal ? 0 : event.clientX - old.x, event.clientY - old.y);
        g.samples.push({ t: performance.now(), x: lockHorizontal ? old.x : event.clientX, y: event.clientY }); if (g.samples.length > 6) g.samples.shift();
      }
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      return;
    }
    if (spaceDrag.current?.id === event.pointerId) {
      event.stopPropagation();
      const [, sy] = local(event), dy = sy - spaceDrag.current.startScreenY;
      const zoom = api?.getAppState().zoom.value ?? 1;
      spaceDrag.current.deltaSceneY = dy / zoom;
      setSpaceBand({ y: spaceDrag.current.startScreenY, dy, sceneDy: dy / zoom });
      return;
    }
    if (tapeDrag.current?.id === event.pointerId) {
      event.stopPropagation();
      const curScreen = local(event), curScene = scenePoint(event);
      const td = tapeDrag.current;
      td.curScreen = curScreen; td.curScene = curScene;
      const dx = Math.abs(curScreen[0] - td.startScreen[0]), dy = Math.abs(curScreen[1] - td.startScreen[1]);
      if (Math.hypot(dx, dy) >= 6) {
        const zoom = api?.getAppState().zoom.value ?? 1;
        const minH = td.height * zoom;
        const h = Math.max(minH, dy);
        const top = dy >= minH ? Math.min(td.startScreen[1], curScreen[1]) : td.startScreen[1] - h / 2;
        setTapePreview({ left: Math.min(td.startScreen[0], curScreen[0]), top, width: Math.max(12, dx), height: h, color: td.color });
      }
      return;
    }
    if (rulerDrag.current?.id === event.pointerId) {
      event.stopPropagation();
      const rd = rulerDrag.current;
      const proj = projectAlongRulerEdge(local(event), rd.ruler, rd.edge);
      rd.curScreen = proj;
      const zoom = api?.getAppState().zoom.value ?? 1;
      setRulerLine({ x1: rd.startScreen[0], y1: rd.startScreen[1], x2: proj[0], y2: proj[1], color: rd.color, width: Math.max(1.5, rd.width * zoom), opacity: rd.opacity / 100 });
      return;
    }
    if (erasing.current !== null) {
      event.stopPropagation();
      if (erasing.current === event.pointerId) queueErase(event);
      return;
    }
    if (marquee.current?.id === event.pointerId) {
      event.stopPropagation();
      const p = local(event), m = marquee.current;
      m.points = tool.marquee?.shape === 'rect' ? [m.points[0], p] : [...m.points, p];
      setMarqueePath(tool.marquee?.shape === 'rect' ? rectPath(m.points[0], p) : m.points);
      return;
    }
    if (loopHold.current?.id === event.pointerId) {
      const cur = local(event);
      if (Math.hypot(cur[0] - loopHold.current.start[0], cur[1] - loopHold.current.start[1]) > 8) {
        window.clearTimeout(loopHold.current.timer); loopHold.current = null;
      }
    }
    if (drawHold.current?.id === event.pointerId && gestureClaimed.current !== event.pointerId) {
      const cur = local(event), h = drawHold.current;
      h.travel += Math.hypot(cur[0] - h.last[0], cur[1] - h.last[1]);
      h.last = cur;
      if (Math.hypot(cur[0] - h.anchor[0], cur[1] - h.anchor[1]) > 5) {
        h.anchor = cur;
        window.clearTimeout(h.timer);
        if (h.travel >= 24) {
          const pointerId = event.pointerId;
          h.timer = window.setTimeout(() => { if (drawHold.current?.id === pointerId) triggerDrawHold(pointerId); }, 450);
        }
      }
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
      if (dt > 0 && performance.now() - last.t < 60) {
        const v = views.get();
        const lockHorizontal = props.zoomLock && kind === 'pages' && layoutRef.current.maxWidth * v.zoom <= v.width - 16;
        startInertia(lockHorizontal ? 0 : (last.x - first.x) / dt, (last.y - first.y) / dt);
      }
    }
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' && penDown.current) { event.stopPropagation(); return; }
    if (touches.current.has(event.pointerId)) return finishTouch(event);
    if (event.pointerType === 'pen') penDown.current = false;
    cancelHolds();
    session.setWriting(owner, false);
    if (spaceDrag.current?.id === event.pointerId) {
      event.stopPropagation();
      const drag = spaceDrag.current;
      spaceDrag.current = null; setSpaceBand(null);
      if (Math.abs(drag.deltaSceneY) >= 4) latest.current.onInsertSpace?.(drag.pageId, drag.sceneY, drag.deltaSceneY);
      return;
    }
    if (tapeDrag.current?.id === event.pointerId) {
      event.stopPropagation();
      const td = tapeDrag.current;
      tapeDrag.current = null; setTapePreview(null);
      const endScreen = local(event), endScene = scenePoint(event);
      const dist = Math.hypot(endScreen[0] - td.startScreen[0], endScreen[1] - td.startScreen[1]);
      if (dist < 6) {
        if (td.hitTapeId) latest.current.onToggleTape?.(td.hitTapeId);
      } else {
        const dx = Math.abs(endScene[0] - td.startScene[0]), dy = Math.abs(endScene[1] - td.startScene[1]);
        const h = Math.max(td.height, dy);
        const x = Math.min(td.startScene[0], endScene[0]);
        const y = dy >= td.height ? Math.min(td.startScene[1], endScene[1]) : td.startScene[1] - h / 2;
        const tape = createTapeElement(x, y, Math.max(20, dx), h, td.color);
        void appendElements([tape]).catch(() => {});
      }
      return;
    }
    if (rulerDrag.current?.id === event.pointerId) {
      event.stopPropagation();
      const rd = rulerDrag.current;
      rulerDrag.current = null; setRulerLine(null);
      const proj = projectAlongRulerEdge(local(event), rd.ruler, rd.edge);
      if (api && Math.hypot(proj[0] - rd.startScreen[0], proj[1] - rd.startScreen[1]) >= 2) {
        const s = api.getAppState();
        const endScene: ScenePoint = [proj[0] / s.zoom.value - s.scrollX, proj[1] / s.zoom.value - s.scrollY];
        const line = createRulerLineElement(rd.startScene, endScene, { color: rd.color, width: rd.width, opacity: rd.opacity, inkKind: rd.inkKind });
        void appendElements([line]).catch(() => {});
      }
      return;
    }
    if (erasing.current !== null) {
      event.stopPropagation();
      if (erasing.current === event.pointerId) {
        erasing.current = null;
        window.cancelAnimationFrame(eraseFrame.current); flushErase();
        void flush().catch(() => {});
        latest.current.onEraseEnd?.();
      }
      return;
    }
    const m = marquee.current;
    if (m?.id === event.pointerId) {
      event.stopPropagation(); marquee.current = null; setMarqueePath(null);
      if (!api || !tool.marquee) return;
      const s = api.getAppState();
      const screen = tool.marquee.shape === 'rect' ? (m.points.length > 1 ? rectPath(m.points[0], m.points[1]) : []) : m.points;
      const points = screen.map(([x, y]) => [x / s.zoom.value - s.scrollX, y / s.zoom.value - s.scrollY] as ScenePoint);
      if (points.length < 3 || polygonBounds(screen).width < 3 && polygonBounds(screen).height < 3) return;
      if (tool.marquee.purpose === 'select') lassoSelect(points, tool.marquee.filter);
      else latest.current.onMarquee?.(points, tool.marquee.purpose);
    }
  };
  const onPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' && penDown.current) { event.stopPropagation(); return; }
    if (touches.current.has(event.pointerId)) return finishTouch(event);
    penDown.current = false;
    cancelHolds();
    gestureClaimed.current = null;
    scribble.current = null; session.setWriting(owner, false);
    if (spaceDrag.current?.id === event.pointerId) { spaceDrag.current = null; setSpaceBand(null); }
    if (tapeDrag.current?.id === event.pointerId) { tapeDrag.current = null; setTapePreview(null); }
    if (rulerDrag.current?.id === event.pointerId) { rulerDrag.current = null; setRulerLine(null); }
    if (erasing.current === event.pointerId) {
      erasing.current = null;
      window.cancelAnimationFrame(eraseFrame.current); flushErase();
      void flush().catch(() => {});
    }
    if (marquee.current?.id === event.pointerId) { marquee.current = null; setMarqueePath(null); }
  };
  useEffect(() => () => { window.cancelAnimationFrame(inertia.current); window.cancelAnimationFrame(eraseFrame.current); cancelHolds(); }, []);

  const dark = props.theme === 'dark' && kind !== 'pages';
  const nightPaper = kind === 'pages' && !!props.nightPaper;
  const marqueeMode = tool.marquee ? ` is-marquee` : '';
  return <div ref={root} className={`ink-editor ink-editor-${kind}${tool.erase ? ' is-erasing' : ''}${tool.space ? ' is-space' : ''}${marqueeMode}${dark ? ' is-dark' : ''}${nightPaper ? ' is-night-paper' : ''}`} data-pressure={tool.pressure ? 'physical' : 'fixed'} data-ink-kind={tool.inkKind ?? ''} data-stabilize={tool.stabilize ?? 0}
    onDoubleClickCapture={event => {
      if (!api || props.readOnly || !latest.current.onCardEdit || tool.marquee || tool.erase || tool.kernel !== 'selection') return;
      const box = root.current!.getBoundingClientRect(), s = api.getAppState(), x = (event.clientX - box.left) / s.zoom.value - s.scrollX, y = (event.clientY - box.top) / s.zoom.value - s.scrollY;
      const card = [...api.getSceneElements()].reverse().find(e => {
        if (!cardReference(e)) return false;
        const dx = x - e.x - e.width / 2, dy = y - e.y - e.height / 2;
        return Math.abs(dx * Math.cos(e.angle) + dy * Math.sin(e.angle)) <= e.width / 2 && Math.abs(-dx * Math.sin(e.angle) + dy * Math.cos(e.angle)) <= e.height / 2;
      });
      if (card) { event.stopPropagation(); event.preventDefault(); latest.current.onCardEdit(card); }
    }}
    onPointerLeave={() => { eraserCursor.current?.classList.remove('is-visible'); }}
    onPointerDownCapture={onPointerDown} onPointerMoveCapture={onPointerMove} onPointerUpCapture={onPointerUp} onPointerCancelCapture={onPointerCancel}>
    {kind === 'pages' ? <PaperLayer layout={layout} views={views} pdf={pdf} sourceIssue={session.sourceIssue}/> : <GridLayer views={views} template={kind === 'canvas' ? session.manifest.pages[0].template : 'blank'} dark={dark}/>}
    {initial ? <Excalidraw langCode="zh-CN" excalidrawAPI={setApi} theme={dark ? 'dark' : 'light'} viewModeEnabled={props.readOnly ?? false} gridModeEnabled={!!props.gridSnap}
      initialData={{ elements: initial.elements, files: { ...session.files }, appState: { viewBackgroundColor: 'transparent', currentItemRoughness: 0, gridModeEnabled: !!props.gridSnap, gridSize: 24, penMode: !props.fingerDraws, ...initial.appState } }}
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, changeViewBackgroundColor: false, clearCanvas: false, toggleTheme: false } }}
      handleKeyboardGlobally={false} detectScroll={false} onScrollChange={onScroll} onChange={onKernelChange}/>
      : <div className="ink-canvas-status" role="status">{loadError ? <><span>{loadError}</span><button type="button" onClick={() => setAttempt(n => n + 1)}>重试</button></> : <span className="ink-spinner" aria-label="正在载入"/>}</div>}
    {initial && !isReady && <div className="ink-canvas-status is-cover" role="status"><span className="ink-spinner" aria-label="正在准备"/></div>}
    {kind === 'pages' && isReady && <PageOverlay layout={layout} views={views} onAddPage={props.onAddPage} flash={flash}/>}
    {kind !== 'pages' && flash && isReady && <PageOverlay layout={layout} views={views} flash={flash}/>}
    {marqueePath && <svg className="ink-marquee" aria-hidden="true"><polygon points={marqueePath.map(p => p.join(',')).join(' ')}/></svg>}
    {spaceBand && <div className="ink-space-overlay" aria-hidden="true">
      <div className="ink-space-line" style={{ top: spaceBand.y }}/>
      <div className={`ink-space-band${spaceBand.dy < 0 ? ' is-negative' : ''}`} style={{ top: Math.min(spaceBand.y, spaceBand.y + spaceBand.dy), height: Math.abs(spaceBand.dy) }}/>
      <span className="ink-space-badge" style={{ top: spaceBand.y + spaceBand.dy }}>{spaceBand.sceneDy >= 0 ? `+${Math.round(spaceBand.sceneDy)}` : `${Math.round(spaceBand.sceneDy)}`} px</span>
    </div>}
    {tapePreview && <div className="ink-tape-preview" aria-hidden="true" style={{ left: tapePreview.left, top: tapePreview.top, width: tapePreview.width, height: tapePreview.height, background: tapePreview.color }}/>}
    {rulerLine && <svg className="ink-marquee" aria-hidden="true"><line x1={rulerLine.x1} y1={rulerLine.y1} x2={rulerLine.x2} y2={rulerLine.y2} stroke={rulerLine.color} strokeWidth={rulerLine.width} strokeOpacity={rulerLine.opacity} strokeLinecap="round"/></svg>}
    {lassoFlash && <svg key={lassoFlash.token} className="ink-marquee ink-lasso-flash" aria-hidden="true"><polygon points={lassoFlash.points.map(p => p.join(',')).join(' ')}/></svg>}
    {penLassoActive && <div className="ink-mode-hint ink-pen-lasso-hint" role="status">套索已选中，拖动或使用操作栏；点空白处继续书写<button type="button" onClick={() => handle.clearSelection()}>继续书写</button></div>}
    {renderPending && <div className="ink-render-status" role="status"><span className="ink-spinner"/>正在绘制</div>}
    {tool.erase && <div ref={eraserCursor} className="ink-eraser-cursor" aria-hidden="true"/>}
  </div>;
}), (a, b) => a.session === b.session && a.pdf === b.pdf && a.kind === b.kind && a.pagesKey === b.pagesKey && a.fingerDraws === b.fingerDraws && a.zoomLock === b.zoomLock && a.nightPaper === b.nightPaper && a.gridSnap === b.gridSnap &&
  a.ruler?.x === b.ruler?.x && a.ruler?.y === b.ruler?.y && a.ruler?.angle === b.ruler?.angle && a.ruler?.length === b.ruler?.length && a.theme === b.theme && a.readOnly === b.readOnly &&
  a.tool.kernel === b.tool.kernel && a.tool.inkKind === b.tool.inkKind && a.tool.space === b.tool.space && a.tool.tape?.color === b.tool.tape?.color && a.tool.tape?.height === b.tool.tape?.height && a.tool.color === b.tool.color && a.tool.width === b.tool.width && a.tool.opacity === b.tool.opacity && a.tool.fontSize === b.tool.fontSize && a.tool.pressure === b.tool.pressure &&
  a.tool.strokeStyle === b.tool.strokeStyle && a.tool.fillColor === b.tool.fillColor && a.tool.stabilize === b.tool.stabilize &&
  a.tool.scribble === b.tool.scribble && a.tool.circleLasso === b.tool.circleLasso && a.tool.holdToShape === b.tool.holdToShape &&
  a.tool.erase?.whole === b.tool.erase?.whole && a.tool.erase?.radius === b.tool.erase?.radius && a.tool.erase?.highlighterOnly === b.tool.erase?.highlighterOnly &&
  a.tool.marquee?.shape === b.tool.marquee?.shape && a.tool.marquee?.purpose === b.tool.marquee?.purpose && a.tool.marquee?.filter === b.tool.marquee?.filter && !!a.onAddPage === !!b.onAddPage);

function createShapeElement(shape: RecognizedShape, template: { strokeColor: string; strokeWidth: number; opacity: number }, inkKind?: 'pen' | 'highlighter'): Element[] {
  const customData = inkKind ? { inkKind } : undefined;
  const style = { strokeColor: template.strokeColor, strokeWidth: template.strokeWidth, opacity: template.opacity, roughness: 0, backgroundColor: 'transparent', ...(customData ? { customData } : {}) };
  if (shape.kind === 'line' || shape.kind === 'arrow') {
    const dx = shape.end[0] - shape.start[0], dy = shape.end[1] - shape.start[1];
    const points: LocalPoint[] = [[0, 0] as LocalPoint, [dx, dy] as LocalPoint];
    return convertToExcalidrawElements([{ type: shape.kind, x: shape.start[0], y: shape.start[1], width: Math.abs(dx), height: Math.abs(dy), points, ...style }]);
  }
  return convertToExcalidrawElements([{ type: shape.kind, x: shape.x, y: shape.y, width: Math.max(4, shape.width), height: Math.max(4, shape.height), ...style }]);
}
const rectPath = (a: ScenePoint, b: ScenePoint): ScenePoint[] => [a, [b[0], a[1]], b, [a[0], b[1]]];
const geometryOf = (layout: PageLayout) => layout.placements.map(({ page: p }) => `${p.id}:${p.width}x${p.height}:${p.margins.top},${p.margins.right},${p.margins.bottom},${p.margins.left}`).join('|');

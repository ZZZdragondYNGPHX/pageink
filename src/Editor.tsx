import React, { useEffect, useRef, useState } from 'react';
import { Excalidraw, CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, AppState } from '@excalidraw/excalidraw/types';
import { Element, Page, Rect, pageRect, uid } from './model';
import { eraseStroke } from './geometry';
import { Session } from './session';
import { PdfService } from './pdf';
import { paperStyle } from './templates';
import { MIN_INK_ZOOM } from './viewport';
export type Tool = 'freedraw' | 'highlighter' | 'erase' | 'wholeErase' | 'selection' | 'text' | 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'hand' | 'image';
export interface EditorHandle { api: ExcalidrawImperativeAPI; flush: () => Promise<void> }
export function selectedContent(api: ExcalidrawImperativeAPI) {
  const ids = api.getAppState().selectedElementIds;
  return api.getSceneElements().filter(e => ids[e.id] || e.type === 'text' && e.containerId && ids[e.containerId]);
}
export type InkAPI = ExcalidrawImperativeAPI & { inkQuery(rect: Rect): Element[]; inkErase(patches: Map<string, Element[]>): void };
interface Props {
  session: Session; surface: string; page?: Page; pdf?: PdfService;
  tool: Tool; color: string; width: number; pressure: boolean;
  onReady: (handle: EditorHandle) => void; onError: (message: string) => void;
}
export const Editor = React.memo(function Editor(props: Props) {
  const { session, surface, page, pdf } = props;
  const [initial, setInitial] = useState<readonly Element[] | null>(null);
  const [loadError, setLoadError] = useState(''), [attempt, setAttempt] = useState(0);
  const [renderPending, setRenderPending] = useState(false);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const ready = useRef(false), [readyVisible, setReadyVisible] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const root = useRef<HTMLDivElement>(null), paper = useRef<HTMLCanvasElement>(null), detail = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  const latest = useRef(props); latest.current = props;
  const erasing = useRef(false), timer = useRef<ReturnType<typeof setTimeout>>();
  const touching = useRef(new Map<number, { x: number; y: number }>());
  const penDown = useRef(false);
  const eraserCursor = useRef<HTMLDivElement>(null);
  const lastErasePoint = useRef<[number, number]>();
  useEffect(() => {
    const element = root.current!;
    const listener = (event: Event) => setRenderPending((event as CustomEvent<boolean>).detail);
    element.addEventListener('ink-render-status', listener);
    return () => element.removeEventListener('ink-render-status', listener);
  }, []);
  useEffect(() => { const observer = new ResizeObserver(entries => setViewport({ width: entries[0].contentRect.width, height: entries[0].contentRect.height })); observer.observe(root.current!); return () => observer.disconnect(); }, []);
  useEffect(() => { let active = true; setLoadError(''); session.load(surface).then(async e => { await session.loadFiles(e); if (active) setInitial(e); }).catch(e => { if (active) { setLoadError(e.message); props.onError(e.message); } }); return () => { active = false; }; }, [surface, attempt]);
  async function flush() {
    if (!api || !ready.current) return;
    try {
      await session.acceptFiles(api.getFiles());
      const elements: readonly Element[] = api.getSceneElementsIncludingDeleted();
      session.change(surface, elements);
    } catch (e) { props.onError((e as Error).message); throw e; }
  }
  useEffect(() => {
    if (!api) return;
    const initialize = () => {
      if (ready.current || api.getAppState().isLoading || api.getSceneElementsIncludingDeleted().length !== initial?.length) return;
      ready.current = true; api.addFiles(Object.values(session.files));
      if (page) {
        const box = pageRect(page), width = root.current?.clientWidth ?? 800;
        const zoom = Math.min(1, (width - 64) / box.width);
        api.updateScene({ appState: { zoom: { value: zoom as any }, scrollX: page.margins.left + 32 / zoom, scrollY: page.margins.top + 32 / zoom }, captureUpdate: CaptureUpdateAction.NEVER });
      }
      session.flushers.set(surface, flush); setReadyVisible(true); props.onReady({ api, flush });
    };
    const readyUnsub = api.onChange(initialize); initialize();
    let pointerFrame = 0;
    const unsub = api.onPointerUp(() => {
      clearTimeout(timer.current); cancelAnimationFrame(pointerFrame);
      // The kernel's final onChange can run after onPointerUp. Use a separate
      // frame so that callback cannot postpone commit/history readiness by 500 ms.
      pointerFrame = requestAnimationFrame(() => { clearTimeout(timer.current); void flush().catch(() => {}); });
    });
    // The parent flushes before changing surfaces or closing. Reading an already-unmounted
    // engine here can return an empty scene and must never be persisted as a deletion.
    return () => { readyUnsub(); unsub(); clearTimeout(timer.current); cancelAnimationFrame(pointerFrame); session.flushers.delete(surface); session.releaseSurface(surface); };
  }, [api]);
  useEffect(() => {
    if (!api) return;
    const t = props.tool;
    api.setActiveTool({ type: (t === 'highlighter' ? 'freedraw' : t === 'erase' || t === 'wholeErase' ? 'hand' : t) as any });
    api.updateScene({ appState: { currentItemStrokeColor: props.color, currentItemStrokeWidth: t === 'highlighter' ? props.width * 5 : props.width,
      currentItemOpacity: t === 'highlighter' ? 30 : 100, currentItemRoughness: 0, currentItemFontFamily: 2, penMode: true }, captureUpdate: CaptureUpdateAction.NEVER });
  }, [api, readyVisible, props.tool, props.color, props.width]);
  useEffect(() => {
    if (!page?.pdfPage || !pdf || !paper.current) return;
    const abort = new AbortController();
    const canvas = paper.current;
    void pdf.render(page, canvas, Math.min(2, devicePixelRatio), undefined, abort.signal).catch(e => { if (!abort.signal.aborted) props.onError(e.message); });
    return () => abort.abort();
  }, [pdf, page?.id]);
  useEffect(() => {
    if (!page?.pdfPage || !pdf || !detail.current) return;
    const target = detail.current, scale = view.zoom * devicePixelRatio;
    if (scale <= Math.min(2, devicePixelRatio) + .1) { target.style.display = 'none'; return; }
    const x = Math.max(0, -view.x - 32 / view.zoom), y = Math.max(0, -view.y - 32 / view.zoom);
    const width = Math.min(page.width - x, viewport.width / view.zoom + 64 / view.zoom), height = Math.min(page.height - y, viewport.height / view.zoom + 64 / view.zoom);
    if (width <= 0 || height <= 0) { target.style.display = 'none'; return; }
    const abort = new AbortController(), rect = { x, y, width, height };
    const timer = setTimeout(() => void (async () => {
      const rendered = document.createElement('canvas');
      await pdf.render(page, rendered, Math.min(scale, Math.sqrt(8_000_000 / (width * height))), rect, abort.signal);
      abort.signal.throwIfAborted(); target.width = rendered.width; target.height = rendered.height; target.getContext('2d')!.drawImage(rendered, 0, 0);
      Object.assign(target.style, { display: 'block', left: `${page.margins.left + x}px`, top: `${page.margins.top + y}px`, width: `${width}px`, height: `${height}px` });
      rendered.width = rendered.height = 0;
    })().catch(e => { if (!abort.signal.aborted) props.onError(e.message); }), 120);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [pdf, page?.id, page?.margins.left, page?.margins.top, view, viewport]);
  const position = (event: React.PointerEvent): [number, number] => {
    const rect = root.current!.getBoundingClientRect(), state = api!.getAppState();
    return [(event.clientX - rect.left) / state.zoom.value - state.scrollX, (event.clientY - rect.top) / state.zoom.value - state.scrollY];
  };
  const erase = (event: React.PointerEvent) => {
    if (!api) return;
    const point = position(event), radius = 12 / api.getAppState().zoom.value;
    const from = lastErasePoint.current ?? point; lastErasePoint.current = point;
    const steps = Math.max(1, Math.ceil(Math.hypot(point[0] - from[0], point[1] - from[1]) / (radius / 2)));
    const candidates = (api as InkAPI).inkQuery({ x: Math.min(from[0], point[0]) - radius, y: Math.min(from[1], point[1]) - radius, width: Math.abs(point[0] - from[0]) + radius * 2, height: Math.abs(point[1] - from[1]) + radius * 2 });
    const patches = new Map<string, Element[]>();
    for (const e of candidates) {
      if (e.type !== 'freedraw') continue;
      let pieces: Element[] = [e];
      for (let i = 1; i <= steps && pieces.length; i++) {
        const sample: [number, number] = [from[0] + (point[0] - from[0]) * i / steps, from[1] + (point[1] - from[1]) * i / steps];
        pieces = pieces.flatMap(piece => eraseStroke(piece, sample, radius, props.tool === 'wholeErase'));
      }
      if (pieces.length !== 1 || pieces[0] !== e) patches.set(e.id, pieces);
    }
    if (patches.size) (api as InkAPI).inkErase(patches);
  };
  const isErase = props.tool === 'erase' || props.tool === 'wholeErase';
  const rect = page ? pageRect(page) : null;
  return <div className={`ink-editor${isErase ? ' ink-erasing' : ''}`} ref={root} data-pressure={props.pressure ? 'physical' : 'fixed'}
    onPointerLeave={() => { if (eraserCursor.current) eraserCursor.current.style.display = 'none'; }}
    onPointerDownCapture={event => {
      if (event.pointerType === 'touch') { event.stopPropagation(); event.preventDefault(); if (!penDown.current) { touching.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); event.currentTarget.setPointerCapture(event.pointerId); } return; }
      penDown.current = event.pointerType === 'pen';
      if (penDown.current) touching.current.clear();
      if (isErase && api) { event.stopPropagation(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); erasing.current = true; lastErasePoint.current = undefined; erase(event); }
    }}
    onPointerMoveCapture={event => {
      if (isErase && event.pointerType !== 'touch' && eraserCursor.current) {
        const box = root.current!.getBoundingClientRect();
        Object.assign(eraserCursor.current.style, { display: 'block', transform: `translate(${event.clientX - box.left - 12}px, ${event.clientY - box.top - 12}px)` });
      }
      if (event.pointerType === 'touch') {
        event.stopPropagation(); const old = touching.current.get(event.pointerId);
        if (!old || !api || penDown.current) return;
        const state = api.getAppState(), peers = [...touching.current.entries()].filter(([id]) => id !== event.pointerId);
        if (peers.length) {
          const other = peers[0][1], distance = Math.hypot(old.x - other.x, old.y - other.y), nextDistance = Math.hypot(event.clientX - other.x, event.clientY - other.y);
          const zoom = Math.max(MIN_INK_ZOOM, Math.min(8, state.zoom.value * nextDistance / Math.max(1, distance)));
          const box = root.current!.getBoundingClientRect(), x = (old.x + other.x) / 2 - box.left, y = (old.y + other.y) / 2 - box.top;
          api.updateScene({ appState: { zoom: { value: zoom as any }, scrollX: state.scrollX + x / zoom - x / state.zoom.value, scrollY: state.scrollY + y / zoom - y / state.zoom.value }, captureUpdate: CaptureUpdateAction.NEVER });
        } else {
          const continuous = root.current?.closest('.ink-continuous');
          if (continuous) continuous.scrollTop -= event.clientY - old.y;
          else api.updateScene({ appState: { scrollX: state.scrollX + (event.clientX - old.x) / state.zoom.value, scrollY: state.scrollY + (event.clientY - old.y) / state.zoom.value }, captureUpdate: CaptureUpdateAction.NEVER });
        }
        touching.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); return;
      }
      if (erasing.current) { event.stopPropagation(); erase(event); }
    }}
    onPointerUpCapture={event => { if (event.pointerType === 'touch') { event.stopPropagation(); touching.current.delete(event.pointerId); return; } penDown.current = false; if (erasing.current) { event.stopPropagation(); erasing.current = false; void flush().catch(() => {}); } }}
    onPointerCancelCapture={event => { touching.current.delete(event.pointerId); if (event.pointerType === 'touch') return; penDown.current = false; if (erasing.current) { erasing.current = false; void flush().catch(() => {}); } }}>
    {page && rect && <div className={`ink-paper ink-template-${page.template}`} style={{ left: (rect.x + view.x) * view.zoom, top: (rect.y + view.y) * view.zoom,
      width: rect.width, height: rect.height, transform: `scale(${view.zoom})`, transformOrigin: '0 0', ...paperStyle(page.template) }}>
      {page.pdfPage && <canvas ref={paper} style={{ position: 'absolute', left: page.margins.left, top: page.margins.top, width: page.width, height: page.height }} />}
      {page.pdfPage && <canvas ref={detail} style={{ position: 'absolute', display: 'none' }} />}
    </div>}
    {initial ? <Excalidraw langCode="zh-CN" excalidrawAPI={setApi} initialData={{ elements: initial, files: { ...session.files }, appState: { viewBackgroundColor: 'transparent', currentItemRoughness: 0, penMode: true } }}
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, changeViewBackgroundColor: false, clearCanvas: false } }}
      handleKeyboardGlobally={false} detectScroll={true}
      onScrollChange={(x, y, zoom) => setView({ x, y, zoom: zoom.value })}
      onChange={(_elements, state) => { if (ready.current && !state.editingTextElement && !state.newElement && !state.resizingElement) { clearTimeout(timer.current); timer.current = setTimeout(() => void flush().catch(() => {}), 500); } }}
    /> : <div role="status" className="ink-loading">{loadError ? <>{loadError}<button onClick={() => setAttempt(n => n + 1)}>资源到齐后重试读取</button></> : '正在读取笔迹…'}</div>}
    {initial && !readyVisible && <div className="ink-initializing" role="status">正在准备编辑面…</div>}
    {renderPending && <div className="ink-render-status" role="status">正在补绘笔迹，可继续导航…</div>}
    {isErase && <div ref={eraserCursor} className="ink-eraser-cursor" aria-hidden="true" />}
  </div>;
}, (a, b) => a.session === b.session && a.surface === b.surface && a.pdf === b.pdf && a.tool === b.tool && a.color === b.color && a.width === b.width && a.pressure === b.pressure && JSON.stringify(a.page) === JSON.stringify(b.page));

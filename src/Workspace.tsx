import React, { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import { InkCanvas, CanvasHandle, CanvasTool, SelectionInfo, ZoomAction } from './InkCanvas';
import { Session } from './session';
import { PdfService } from './pdf';
import { Element, Margins, Page, Rect, Region, newPage, uid, PageTemplate } from './model';
import { bounds, cloneElements, constrainMargins, polygonBounds, ScenePoint } from './geometry';
import { placementAt, toLocalRect } from './layout';
import { capturePdf } from './capture';
import { pack, pagePng, png, readingPdf, PdfExportOptions } from './export';
import { IconButton, InkIcon } from './InkIcon';
import { Popover, Menu, MenuEntry, radioKeys, Segmented, Swatches, Switch, Toasts, useAnchor, useToasts, LayerContext } from './ui';
import { ToolShelf, SHORTCUTS } from './Toolbar';
import { ToolDock, type WritingSignal } from './ToolDock';
import type { InkApi } from './kernel-api';
import { imageFile, readDataURL } from './binary';
import { BookmarkList, OutlineList, PageList, SearchPanel, SidebarTabs } from './Sidebar';
import { ScratchWindow } from './Scratch';
import { PEN_COLORS, PEN_WIDTHS, Preferences, SHAPE_FILLS, SidebarTab, ToolId } from './preferences';
import { ViewStore, View, useView, toScreen, sceneViewport } from './view';
import { TEMPLATES, paperStyle } from './templates';
import type { WorkspaceActions, WorkspaceHost } from './host';
import type { SearchHit } from './search';
import { toArrayBuffer } from './model';
import { MixedPanel } from './MixedPanel';
import { detachParagraph, moveParagraph, reflowParagraphs, revised, textReference, type TextReference } from './mixed';
import { preserveText, projectParagraph } from './mixed-render';
import type { SourceParagraph } from './mixed-host';
import { cardReference, cardText } from './cards';
import { connectCards, inkCard, refreshTextCards, textCard } from './cards-render';
import { CardEditor, CardsPanel } from './CardsPanel';
import { LayersPanel } from './LayersPanel';
import { groupElements, insertVerticalSpace, LayerOrderAction, reorderElements, restyleElements, setElementsLocked, ungroupElements } from './layers';
import { copyInkClipboard, prepareClipboardForSession, readInkClipboard } from './clipboard';
import { ZoomBoxOverlay, ZoomWindow } from './ZoomWindow';
import { clampZoomBox, zoomBoxSize, ZoomFactor } from './zoom-window';
import { ElementsPanel } from './ElementsPanel';
import { prepareLibraryInsert, type SavedElementItem } from './elements-library';
import { RulerOverlay } from './RulerOverlay';
import type { RulerState } from './ruler';
import { setAllTapesRevealed, toggleTapeElement } from './tape';

export interface WorkspaceProps { session: Session; pdf?: PdfService; host: WorkspaceHost }
type PopoverId = 'export' | 'insert' | 'toolbox' | 'page-settings' | 'zoom' | 'scratch-zoom' | 'jump' | 'page-menu' | 'bookmark-menu' | 'selection-color' | 'selection-layers' | 'selection-more' | 'pdf-text' | 'mixed' | 'cards' | 'layers' | 'elements';
const SHAPE_LABELS: Record<'line' | 'arrow' | 'rectangle' | 'ellipse' | 'diamond', string> = { line: '直线', arrow: '箭头', rectangle: '矩形', ellipse: '椭圆', diamond: '菱形' };

/** Kernel settings for a tool; a pending bookmark marquee temporarily overrides the tool. */
function canvasTool(tool: ToolId, prefs: Preferences, marquee: CanvasTool['marquee'] | null): CanvasTool {
  const base: CanvasTool = { kernel: 'selection', color: prefs.pen.color, width: prefs.pen.width, opacity: 100, fontSize: prefs.text.size, pressure: false };
  if (marquee) return { ...base, kernel: 'hand', marquee };
  switch (tool) {
    case 'pen': return { ...base, kernel: 'freedraw', inkKind: 'pen', pressure: prefs.pen.pressure, stabilize: prefs.pen.stabilize, scribble: prefs.pen.scribble, circleLasso: prefs.pen.circleLasso, holdToShape: prefs.pen.holdToShape, lassoFilter: prefs.lasso.filter };
    case 'highlighter': return { ...base, kernel: 'freedraw', inkKind: 'highlighter', color: prefs.highlighter.color, width: prefs.highlighter.width, opacity: 35, holdToShape: prefs.pen.holdToShape };
    case 'eraser': return { ...base, kernel: 'hand', erase: { whole: prefs.eraser.mode === 'stroke', radius: prefs.eraser.size, highlighterOnly: prefs.eraser.highlighterOnly } };
    case 'lasso': return { ...base, marquee: { shape: 'lasso', purpose: 'select', filter: prefs.lasso.filter } };
    case 'select': return base;
    case 'space': return { ...base, kernel: 'hand', space: true };
    case 'tape': return { ...base, kernel: 'hand', tape: { color: prefs.tape.color, height: prefs.tape.height } };
    case 'hand': return { ...base, kernel: 'hand' };
    case 'text': return { ...base, kernel: 'text', color: prefs.text.color };
    case 'shape': return { ...base, kernel: prefs.shape.kind, color: prefs.shape.color, width: prefs.shape.width, strokeStyle: prefs.shape.strokeStyle, fillColor: prefs.shape.fillColor };
    case 'capture': return { ...base, kernel: 'hand', marquee: { shape: prefs.capture.shape, purpose: 'capture' } };
  }
}

function useDelayed(value: boolean, delay: number) {
  const [shown, setShown] = useState(false);
  useEffect(() => { if (!value) { setShown(false); return; } const t = window.setTimeout(() => setShown(true), delay); return () => window.clearTimeout(t); }, [value]);
  return shown;
}
const EMPTY_VIEWS = new ViewStore();

export function Workspace({ session, pdf, host }: WorkspaceProps) {
  const sidebarId = useId();
  const prefs = useSyncExternalStore(host.prefs.subscribe, host.prefs.get), store = host.prefs;
  const savedElements = useSyncExternalStore(host.elements.subscribe, host.elements.get);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const popOpenRef = useRef<PopoverId | null>(null);
  useEffect(() => {
    const snapshot = () => {
      const m = session.manifest;
      const pKey = m.pages.map(p => `${p.id}:${p.width}x${p.height}:${p.template}:${p.pdfPage ?? 0}:${p.margins.top},${p.margins.right},${p.margins.bottom},${p.margins.left}`).join('|');
      const rKey = m.regions.map(r => `${r.id}:${r.title}:${r.pageId}`).join('|');
      return `${session.saveState}|${session.saveError}|${session.conflictPath}|${session.sourceIssue}|${session.bodyHistory.canUndo ? 1 : 0}${session.bodyHistory.canRedo ? 1 : 0}${session.scratchHistory.canUndo ? 1 : 0}${session.scratchHistory.canRedo ? 1 : 0}|${session.navigation?.token ?? ''}|${m.pdf?.path ?? ''}|${pKey}|${rKey}`;
    };
    let last = snapshot();
    const onSession = () => {
      const next = snapshot();
      const livePop = popOpenRef.current;
      if (next !== last || livePop === 'mixed' || livePop === 'cards' || livePop === 'layers') {
        last = next;
        rerender();
      }
    };
    session.listeners.add(onSession);
    return () => { session.listeners.delete(onSession); };
  }, [session]);
  useEffect(() => {
    const doc = area.current!.ownerDocument, win = doc.defaultView!;
    const save = () => { void session.flush().catch(() => {}); };
    const hidden = () => { if (doc.visibilityState === 'hidden') save(); };
    doc.addEventListener('visibilitychange', hidden); win.addEventListener('pagehide', save);
    return () => { doc.removeEventListener('visibilitychange', hidden); win.removeEventListener('pagehide', save); };
  }, [session]);
  const manifest = session.manifest, paged = manifest.mode === 'pages';
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [bodyLayer, setBodyLayer] = useState<HTMLDivElement | null>(null);
  const topRightAnchor = useRef<HTMLSpanElement>(null);
  const area = useRef<HTMLDivElement>(null), [areaSize, setAreaSize] = useState({ width: 800, height: 600 });
  const [tool, setToolState] = useState<ToolId>(() => prefs.tool === 'capture' && !pdf ? 'pen' : prefs.tool);
  const [marquee, setMarquee] = useState<CanvasTool['marquee'] | null>(null);
  const [sidebar, setSidebar] = useState(() => paged ? prefs.sidebar.pages && window.innerWidth >= 960 : prefs.sidebar.canvas);
  const [tab, setTab] = useState<SidebarTab>(() => !paged && prefs.sidebar.tab === 'pages' ? 'bookmarks' : prefs.sidebar.tab);
  const [scratchOpen, setScratchOpen] = useState(false);
  const scratchOpenRef = useRef(false); scratchOpenRef.current = scratchOpen;
  const [zoomWindowOpen, setZoomWindowOpen] = useState(false);
  const zoomWindowOpenRef = useRef(false); zoomWindowOpenRef.current = zoomWindowOpen;
  const [zoomFactor, setZoomFactor] = useState<ZoomFactor>(2);
  const [zoomAutoAdvance, setZoomAutoAdvance] = useState(true);
  const [zoomBox, setZoomBox] = useState<Rect>({ x: 40, y: 60, width: 320, height: 90 });
  const liveZoomBox = useRef<Rect>(zoomBox);
  const zoomPaintRef = useRef<(() => void) | null>(null);
  const zoomBoxSyncRef = useRef<((next: Rect) => void) | null>(null);
  const [ruler, setRuler] = useState<RulerState | null>(null);
  const liveRuler = useRef<RulerState | null>(ruler);
  useEffect(() => { liveZoomBox.current = zoomBox; }, [zoomBox]);
  useEffect(() => { liveRuler.current = ruler; }, [ruler]);
  const [exportTile, setExportTile] = useState(true);
  const [focus, setFocus] = useState(false);
  const [reading, setReading] = useState(false);
  const readingRef = useRef(false); readingRef.current = reading;
  const [compact, setCompact] = useState(false);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [scratchSelection, setScratchSelection] = useState<SelectionInfo | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [theme, setTheme] = useState(host.theme());
  const [views, setViews] = useState<ViewStore>(EMPTY_VIEWS);
  const [scratchViews, setScratchViews] = useState<ViewStore>(EMPTY_VIEWS);
  const [resolving, setResolving] = useState(false);
  const [textBusy, setTextBusy] = useState(false);
  const textTask = useRef(false);
  const [editingCard, setEditingCard] = useState<{ root: Element; source: SourceParagraph; reference: TextReference } | null>(null);
  const [paper, setPaper] = useState<NonNullable<PdfExportOptions['paper']>>('original');
  const [pdfText, setPdfText] = useState({ page: 1, text: '', loading: false });
  const writingMaskRef = useRef({ body: false, scratch: false, zoom: false });
  const writingListenersRef = useRef(new Set<() => void>());
  const writingSignal = useMemo<WritingSignal>(() => ({
    get: () => writingMaskRef.current.body || writingMaskRef.current.scratch || writingMaskRef.current.zoom,
    subscribe: listener => { writingListenersRef.current.add(listener); return () => { writingListenersRef.current.delete(listener); }; },
  }), []);
  const setSurfaceWriting = (surface: 'body' | 'scratch' | 'zoom', active: boolean) => {
    const cur = writingMaskRef.current;
    if (cur[surface] === active) return;
    const before = cur.body || cur.scratch || cur.zoom;
    cur[surface] = active;
    const after = cur.body || cur.scratch || cur.zoom;
    if (before !== after) for (const fn of writingListenersRef.current) fn();
  };
  const pop = useAnchor<PopoverId>();
  popOpenRef.current = pop.open;
  const initialBodyView = useMemo(() => host.loadView(), [session]);
  const initialScratchView = useMemo(() => host.loadView('scratch'), [session]);
  const toast = useToasts();
  const body = useRef<CanvasHandle | null>(null), scratch = useRef<CanvasHandle | null>(null), scratchReady = useRef<CanvasHandle | null>(null);
  const scratchWaiters = useRef<{ resolve: (handle: CanvasHandle) => void; reject: (error: Error) => void }[]>([]);
  const mounted = useRef(true);
  const bodyQueue = useRef(Promise.resolve()), scratchQueue = useRef(Promise.resolve());
  const marginsSeq = useRef(0), marginsSeqByPage = useRef(new Map<string, number>()), pdfTextSeq = useRef(0);
  const exporting = useRef(false), capturing = useRef(false), libraryBusy = useRef(false), clipboardBusy = useRef(false), pdfTextBusy = useRef(false);
  const scratchSessionAbort = useRef<AbortController | null>(null);
  const savingShown = useDelayed(session.saveState === 'saving', 700);

  useEffect(() => () => {
    mounted.current = false;
    scratchReady.current = null;
    scratchSessionAbort.current?.abort();
    for (const waiter of scratchWaiters.current.splice(0)) waiter.reject(new DOMException('已关闭', 'AbortError'));
  }, []);
  useEffect(() => {
    if (!scratchOpen) {
      scratchSessionAbort.current?.abort();
      scratchSessionAbort.current = null;
    } else if (!scratchSessionAbort.current || scratchSessionAbort.current.signal.aborted) {
      scratchSessionAbort.current = new AbortController();
    }
  }, [scratchOpen]);
  useEffect(() => {
    if (!layer || (!marquee && !ruler && !zoomWindowOpen)) return;
    const doc = layer.ownerDocument, win = doc.defaultView;
    if (!win) return;
    const onGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      if (layer.querySelector('.ink-popover, .ink-card-editor') || doc.querySelector('.modal-container')) return;
      const leaf = layer.closest('.workspace-leaf');
      if (leaf && !leaf.classList.contains('mod-active')) return;
      const active = doc.activeElement as HTMLElement | null;
      if (active && active !== doc.body && !layer.contains(active)) return;
      if (active?.closest('input, textarea, select, [contenteditable=true]')) return;
      event.preventDefault(); event.stopPropagation();
      if (marquee) setMarquee(null);
      else if (ruler) setRuler(null);
      else if (zoomWindowOpen) setZoomWindowOpen(false);
    };
    win.addEventListener('keydown', onGlobalEscape);
    return () => win.removeEventListener('keydown', onGlobalEscape);
  }, [layer, marquee, ruler, zoomWindowOpen]);

  const enqueue = <T,>(surface: 'body' | 'scratch', task: () => Promise<T>): Promise<T> => {
    const ref = surface === 'scratch' ? scratchQueue : bodyQueue;
    const next = ref.current.catch(() => {}).then(task);
    ref.current = next.then(() => undefined, () => undefined);
    return next;
  };

  useEffect(() => host.onThemeChange(() => setTheme(host.theme())), []);
  useEffect(() => {
    const element = area.current!; const observer = new ResizeObserver(entries => setAreaSize({ width: entries[0].contentRect.width, height: entries[0].contentRect.height }));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!layer) return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width <= 760));
    observer.observe(layer); return () => observer.disconnect();
  }, [layer]);
  const report = (error: unknown) => { if ((error as Error)?.name !== 'AbortError') toast.show({ kind: 'error', message: (error as Error).message }); };
  const run = (task: () => unknown) => { void Promise.resolve().then(task).catch(report); };
  const runText = (task: () => Promise<unknown>) => {
    if (textTask.current) return;
    textTask.current = true; setTextBusy(true);
    run(async () => { try { await task(); } finally { textTask.current = false; setTextBusy(false); } });
  };

  // ---------- tools ----------
  const lastDrawTool = useRef<ToolId>(['pen', 'highlighter', 'shape', 'text'].includes(tool) ? tool : 'pen');
  const setTool = (next: ToolId) => {
    if (['pen', 'highlighter', 'shape', 'text'].includes(next)) lastDrawTool.current = next;
    // Keep body in read-only reading mode when switching tools for the open scratchpad (read live ref for memoized callbacks).
    if (!scratchOpenRef.current) setReading(false);
    setMarquee(null); setToolState(next);
    if (next !== 'capture') store.update({ tool: next });
  };
  const onEraseEnd = () => {
    if (store.get().eraser.autoReturn) setTool(lastDrawTool.current);
  };
  const bodyTool = useMemo(() => canvasTool(reading ? 'hand' : tool, prefs, reading ? null : marquee), [tool, prefs, marquee, reading]);
  const scratchTool = useMemo(() => canvasTool(tool === 'capture' ? 'select' : tool, prefs, null), [tool, prefs]);
  const pagesKey = manifest.pages.map(p => [p.id, p.width, p.height, p.template, p.pdfPage ?? 0, p.margins.top, p.margins.right, p.margins.bottom, p.margins.left].join(':')).join('|');
  const currentPageId = useView(views, () => body.current && views !== EMPTY_VIEWS ? body.current.currentPage().page.id : manifest.pages[0].id);
  const currentIndex = Math.max(0, manifest.pages.findIndex(p => p.id === currentPageId));
  const currentPage = manifest.pages[currentIndex];
  const navSeq = useRef(0);
  const syncZoomBoxToPage = (pageId: string, rect?: Rect) => {
    const handle = body.current;
    if (!handle) return;
    const placement = handle.layout().byId.get(pageId);
    if (!placement) return;
    setZoomBox(prev => {
      if (!paged) {
        if (!rect) return prev;
        return { ...prev, x: placement.x + rect.x, y: placement.y + rect.y };
      }
      const x = rect ? placement.x + rect.x : placement.paper.x + Math.min(24, Math.max(0, placement.paper.width - prev.width));
      const y = rect ? placement.y + rect.y : placement.paper.y + 40;
      return clampZoomBox({ ...prev, x, y }, placement.paper);
    });
  };
  const pendingReveal = useRef<{ pageId: string; rect?: Rect; highlight: boolean } | null>(null);
  const revealPage = (pageId: string, rect?: Rect, highlight = false) => {
    navSeq.current++;
    if (!body.current) { pendingReveal.current = { pageId, rect, highlight }; return; }
    pendingReveal.current = null;
    body.current.reveal(pageId, rect, highlight);
    if (zoomWindowOpenRef.current) syncZoomBoxToPage(pageId, rect);
  };
  const goToPage = (id: string, pdfPageNum?: number, pdfTop?: number | null, pdfLeft?: number | null) => {
    const seq = ++navSeq.current;
    if (pdf && pdfPageNum && (pdfTop != null || pdfLeft != null)) {
      run(async () => {
        const y = await pdf.resolvePageY(pdfPageNum, pdfTop ?? null, pdfLeft ?? null);
        if (seq !== navSeq.current) return;
        const page = manifest.pages.find(p => p.id === id);
        if (y !== null && page) {
          revealPage(id, { x: 0, y, width: page.width, height: Math.min(180, Math.max(40, page.height - y)) });
        } else {
          revealPage(id);
        }
      });
    } else {
      revealPage(id);
    }
    if (compact) closeSidebar();
  };
  const toggleReading = () => {
    setMarquee(null); pop.close(); body.current?.clearSelection(); setZoomWindowOpen(false); setRuler(null); setReading(value => !value);
  };
  const toggleRuler = () => {
    setRuler(cur => cur ? null : {
      x: Math.round(areaSize.width / 2),
      y: Math.round(areaSize.height / 2),
      angle: 0,
      length: Math.max(240, Math.min(520, Math.round(areaSize.width * 0.65))),
    });
  };
  const toggleZoomWindow = () => {
    setZoomWindowOpen(open => {
      if (open) return false;
      const handle = body.current;
      if (handle) {
        const v = handle.views.get();
        const areaRect = sceneViewport(v);
        const dim = zoomBoxSize(Math.min(720, areaSize.width), 180, zoomFactor);
        const raw: Rect = {
          x: areaRect.x + Math.max(16, (areaRect.width - dim.width) * 0.25),
          y: areaRect.y + Math.max(16, areaRect.height * 0.25),
          width: dim.width,
          height: dim.height,
        };
        const limit = paged ? handle.currentPage().paper : undefined;
        setZoomBox(clampZoomBox(raw, limit));
      }
      if (!['pen', 'highlighter', 'eraser', 'hand'].includes(tool)) setTool('pen');
      return true;
    });
  };

  // ---------- history ----------
  async function performStep(surface: 'body' | 'scratch', redo: boolean) {
    const handle = surface === 'scratch' ? scratch.current : body.current; if (!handle) return;
    await handle.flush();
    const timeline = surface === 'scratch' ? session.scratchHistory : session.bodyHistory;
    const change = redo ? timeline.redo() : timeline.undo(); if (!change) return;
    if (change.layout) { Object.assign(manifest, structuredClone(change.layout)); session.metadataChanged(); }
    for (const part of change.parts) { await session.load(part.surface); session.change(part.surface, part.elements, false); }
    await handle.rebuild();
    if (surface === 'body' && paged) {
      if (change.parts.length && !change.parts.some(p => p.surface === handle.currentPage().page.id)) {
        revealPage(change.parts[0].surface);
      } else if (change.layout && zoomWindowOpenRef.current) {
        syncZoomBoxToPage(handle.currentPage().page.id);
      }
    }
  }
  const step = (surface: 'body' | 'scratch', redo: boolean) => enqueue(surface, () => performStep(surface, redo));
  const undo = (surface: 'body' | 'scratch' = 'body') => run(() => step(surface, false));
  const redo = (surface: 'body' | 'scratch' = 'body') => run(() => step(surface, true));

  // ---------- pages ----------
  async function applyPagesLayout(edit: () => void, reveal?: string) {
    await body.current?.flush();
    session.editLayout(edit);
    await body.current?.rebuild();
    if (reveal) revealPage(reveal);
    else if (paged && zoomWindowOpenRef.current && body.current) syncZoomBoxToPage(body.current.currentPage().page.id);
  }
  const editPages = (edit: () => void, reveal?: string) => enqueue('body', () => applyPagesLayout(edit, reveal));
  const indexOf = (id: string) => manifest.pages.findIndex(p => p.id === id);
  function addPage(after = manifest.pages[manifest.pages.length - 1].id) {
    run(() => enqueue('body', async () => {
      const idx = indexOf(after);
      const like = manifest.pages[idx] ?? manifest.pages[manifest.pages.length - 1];
      const page = newPage({ width: like.width, height: like.height, margins: like.margins, template: like.pdfPage ? prefs.newTemplate : like.template });
      await applyPagesLayout(() => {
        const latestIdx = indexOf(after);
        manifest.pages.splice((latestIdx >= 0 ? latestIdx : manifest.pages.length - 1) + 1, 0, page);
      }, page.id);
    }));
  }
  function duplicatePage(id: string) {
    run(() => enqueue('body', async () => {
      await body.current?.flush();
      const idx = indexOf(id);
      const source = manifest.pages[idx];
      if (!source) return;
      const copy: Page = { ...structuredClone(source), id: uid() };
      session.change(copy.id, cloneElements(await session.load(id), 0, 0), false);
      await applyPagesLayout(() => {
        const latestIdx = indexOf(id);
        manifest.pages.splice((latestIdx >= 0 ? latestIdx : manifest.pages.length - 1) + 1, 0, copy);
      }, copy.id);
    }));
  }
  function deletePage(id: string) {
    if (manifest.pages.length <= 1) return;
    run(() => enqueue('body', async () => {
      const idx = indexOf(id);
      if (idx < 0 || manifest.pages.length <= 1) return;
      const number = idx + 1;
      await applyPagesLayout(() => { manifest.pages.splice(idx, 1); manifest.regions = manifest.regions.filter(r => r.pageId !== id); });
      toast.show({ kind: 'info', message: `已删除第 ${number} 页`, action: { label: '撤销', run: () => undo() } });
    }));
  }
  const movePage = (id: string, delta: number) => run(() => editPages(() => { const i = indexOf(id); if (i < 0) return; const [page] = manifest.pages.splice(i, 1); manifest.pages.splice(Math.max(0, Math.min(manifest.pages.length, i + delta)), 0, page); }, id));
  const setTemplate = (ids: string[], template: PageTemplate) => run(() => editPages(() => { for (const p of manifest.pages) if (ids.includes(p.id) && !p.pdfPage) p.template = template; }));
  function setMargins(ids: string[], margins: Margins) {
    const seq = ++marginsSeq.current;
    for (const id of ids) marginsSeqByPage.current.set(id, seq);
    run(() => enqueue('body', async () => {
      const currentIds = () => ids.filter(id => marginsSeqByPage.current.get(id) === seq);
      if (!currentIds().length) return;
      await body.current?.flush();
      const targetIds = currentIds();
      if (!targetIds.length) return;
      let clamped = false;
      const next = new Map<string, Margins>();
      for (const p of manifest.pages) if (targetIds.includes(p.id)) {
        const m = constrainMargins(p, margins, (await session.read(p.id)).filter(e => !e.isDeleted));
        if (marginsSeqByPage.current.get(p.id) !== seq) continue;
        clamped ||= (Object.keys(m) as (keyof Margins)[]).some(k => Math.round(m[k]) !== Math.round(margins[k]));
        next.set(p.id, m);
      }
      if (!next.size) return;
      await applyPagesLayout(() => {
        for (const p of manifest.pages) if (next.has(p.id) && marginsSeqByPage.current.get(p.id) === seq) p.margins = next.get(p.id)!;
      });
      if (clamped) toast.show({ kind: 'info', message: '已有笔迹的一侧保留了足够留白，避免裁掉内容' });
    }));
  }

  // ---------- shared text and paragraph anchors ----------
  const mixedElements = session.surfaces.get(currentPageId) ?? [];
  const selectedInk = () => body.current?.selected().filter(e => e.type === 'freedraw').map(e => e.id) ?? [];
  async function applyMixed(pageId: string, change: (elements: readonly Element[]) => Element[]) {
    if (!area.current?.isConnected || session.conflictPath) throw Error('笔记已关闭或正在处理冲突，请重新打开后操作。');
    const page = manifest.pages.find(p => p.id === pageId), handle = body.current;
    if (!page || !handle) throw Error('目标页面已删除，请重新选择。');
    await handle.flush();
    const before = await session.load(pageId);
    let elements = change(before);
    const previousCards = new Map(before.filter(e => cardReference(e)).map(e => [e.id, e]));
    const resized = elements.filter(e => {
      const old = previousCards.get(e.id);
      return old && (old.width !== e.width || old.height !== e.height || old.x !== e.x || old.y !== e.y || old.angle !== e.angle);
    });
    if (resized.length) elements = (handle.api as InkApi).inkRebind(elements, resized.map(e => e.id));
    session.editContent(new Map([[pageId, elements]]), () => {
      // Grow the page's writable margin; following pages move as a whole. Never clip the new text or ink.
      if (paged) { const box = bounds(elements); if (box) page.margins.bottom = Math.max(page.margins.bottom, box.y + box.height + 24 - page.height); }
    });
    await handle.rebuild(); await session.save();
  }
  function insertParagraph() {
    const pageId = currentPageId;
    pop.close();
    runText(async () => {
      const source = await host.text.pick(); if (!source) return;
      if (!area.current?.isConnected) return;
      if (layer && layer.clientWidth <= 760) setSidebar(false);
      const page = manifest.pages.find(p => p.id === pageId); if (!page) throw Error('目标页面已删除，请重新插入。');
      const asset = await preserveText(session, source), width = paged ? Math.max(160, Math.min(560, page.width - 96)) : 480;
      const paragraph = projectParagraph(source, asset, width);
      let placed: Element = paragraph;
      await applyMixed(pageId, elements => {
        const last = elements.filter(e => textReference(e) && !(e.type === 'text' && e.containerId)).sort((a, b) => b.y + b.height - a.y - a.height)[0];
        const centre = body.current!.center();
        const placement = body.current!.layout().byId.get(pageId)!;
        placed = { ...paragraph, x: last?.x ?? (paged ? 48 : centre[0] - placement.x - width / 2), y: last ? last.y + last.height + 40 : paged ? 64 : centre[1] - placement.y - paragraph.height / 2 };
        return [...elements, placed];
      });
      revealPage(pageId, { x: placed.x, y: placed.y, width, height: placed.height });
      setTool('pen'); toast.show({ kind: 'success', message: '文字段落已插入，可在旁边书写', detail: '圈选批注后，在「文字段落」中绑定到对应段落。' });
    });
  }
  function refreshParagraphs() {
    const pageId = currentPageId;
    runText(async () => {
      await body.current?.flush();
      const original = [...await session.load(pageId)], replacements = new Map<string, Element>();
      // Resolve every source before applying anything. A missing block cannot partially reflow the page.
      const updates: { e: Element; reference: TextReference; source: SourceParagraph }[] = [];
      for (const e of original) { const reference = textReference(e); if (reference && !(e.type === 'text' && e.containerId)) updates.push({ e, reference, source: await host.text.read(reference) }); }
      for (const { e, reference, source } of updates) {
        const asset = await preserveText(session, source);
        if (asset !== reference.snapshotAsset || source.path !== reference.path) replacements.set(e.id, projectParagraph(source, asset, reference.width, e));
      }
      await applyMixed(pageId, current => {
        for (const { e } of updates) if (!current.some(now => now.id === e.id && now.version === e.version)) throw Error('更新期间段落已变化，请重试。');
        return reflowParagraphs(current, replacements);
      });
      toast.show({ kind: 'success', message: replacements.size ? '文字已更新，绑定笔迹已随段落移动' : '文字已是最新版本', detail: replacements.size ? '段内换行后的批注请检查位置；可撤销本次更新。' : undefined });
    });
  }
  function attachInk(paragraph?: Element) {
    const ids = new Set(selectedInk()), pageId = currentPageId;
    runText(async () => {
      await applyMixed(pageId, elements => {
        if (paragraph && !elements.some(e => e.id === paragraph.id && textReference(e))) throw Error('目标段落已移除。');
        let count = 0;
        const next = elements.map(e => {
          if (e.type !== 'freedraw' || !ids.has(e.id)) return e;
          count++; const customData = { ...e.customData };
          if (paragraph) customData.pageinkAnchor = { version: 1, elementId: paragraph.id };
          else delete customData.pageinkAnchor;
          return revised(e, { customData });
        });
        if (count !== ids.size) throw Error('请只选择本页的笔迹，再绑定到本页段落。');
        return next;
      });
      toast.show({ kind: 'success', message: paragraph ? `已绑定 ${ids.size} 条笔迹` : '已解除所选笔迹的绑定' });
    });
  }
  function reorderParagraph(paragraph: Element, direction: 'up' | 'down') {
    const pageId = currentPageId;
    runText(() => applyMixed(pageId, elements => {
      const refs = elements.filter(e => textReference(e) && !(e.type === 'text' && e.containerId)).sort((a, b) => a.y - b.y), index = refs.findIndex(e => e.id === paragraph.id);
      const other = refs[index + (direction === 'up' ? -1 : 1)]; if (!other) return [...elements];
      const first = direction === 'up' ? other : refs[index], second = direction === 'up' ? refs[index] : other;
      const gap = Math.max(24, second.y - first.y - first.height);
      const next = moveParagraph(elements, second.id, first.x - second.x, first.y - second.y);
      return moveParagraph(next, first.id, second.x - first.x, second.height + gap);
    }));
  }

  // ---------- board cards ----------
  const boardElements = session.surfaces.get(manifest.pages[0].id) ?? [];
  const showCard = (e: Element) => { pop.close(); revealPage(manifest.pages[0].id, e); };
  function insertCard(kind: 'text' | 'ink') {
    pop.close();
    runText(async () => {
      let elements: Element[];
      if (kind === 'text') {
        const source = await host.text.pick(); if (!source) return;
        elements = textCard(source, await preserveText(session, source));
      } else {
        const source = await host.cards.pickInk(); if (!source) return;
        elements = [await inkCard(session, source)];
      }
      if (!area.current?.isConnected || session.conflictPath) throw Error('画板已关闭或出现冲突，请重新插入。');
      setSidebar(false); await body.current?.insert(elements); await session.save(); setTool('select');
    });
  }
  function editCard(root: Element) {
    if (editingCard) return;
    pop.close();
    runText(async () => {
      const ref = cardReference(root);
      if (ref?.kind === 'ink') { await host.cards.openInk(ref); return; }
      const text = cardText(root, body.current?.api.getSceneElements() ?? []), reference = text && textReference(text);
      if (!reference) throw Error('卡片文字已移除，请撤销或重新插入卡片。');
      const source = await host.text.read(reference);
      if (!area.current?.isConnected) return;
      setEditingCard({ root, source, reference });
    });
  }
  async function saveCardDraft(value: string) {
    if (!editingCard || !body.current || !area.current?.isConnected || session.conflictPath) throw Error('画板已关闭或出现冲突，草稿未提交。');
    await body.current.flush();
    if (!(await session.load(manifest.pages[0].id)).some(e => !e.isDeleted && e.id === editingCard.root.id && cardReference(e))) throw Error('卡片已移除，草稿未提交。');
    const source = await host.text.commit(editingCard.reference, editingCard.source, value);
    // The native commit has its own undo. A projection failure must not suggest the source was untouched.
    try {
      const asset = await preserveText(session, source);
      await applyMixed(manifest.pages[0].id, elements => {
        const updates = new Map<string, { source: SourceParagraph; asset: string }>();
        for (const e of elements) {
          const ref = textReference(e);
          if (ref && ref.blockId === source.blockId && [source.path, editingCard.reference.path].includes(ref.path)) updates.set(e.id, { source, asset });
        }
        return refreshTextCards(elements, updates);
      });
    } catch (error) { throw Error(`原文已保存，卡片尚未更新：${(error as Error).message}。请关闭编辑后更新卡片。`); }
  }
  function refreshCard(root: Element) {
    runText(async () => {
      const ref = cardReference(root);
      if (ref?.kind === 'ink') {
        const source = await host.cards.readInk(ref), next = await inkCard(session, source, root);
        await applyMixed(manifest.pages[0].id, elements => {
          const current = elements.find(e => e.id === root.id);
          if (!current || current.version !== root.version) throw Error('更新期间卡片已变化，请重试。');
          return elements.map(e => e.id === root.id ? next : e);
        });
      } else {
        const text = cardText(root, boardElements), reference = text && textReference(text); if (!text || !reference) throw Error('卡片文字已移除。');
        const source = await host.text.read(reference), asset = await preserveText(session, source);
        await applyMixed(manifest.pages[0].id, elements => refreshTextCards(elements, new Map([[text.id, { source, asset }]])));
      }
      toast.show({ kind: 'success', message: '卡片已更新，可撤销本次更新' });
    });
  }
  function recoverCard(root: Element) {
    runText(async () => {
      const ref = cardReference(root); if (ref?.kind !== 'ink') return;
      const asset = manifest.assets[ref.archiveAsset]; if (!asset) throw Error('卡片缺少原件备份。');
      const next = await host.cards.recoverInk(new Uint8Array(await session.store.io.readBinary(asset.path)), ref);
      await applyMixed(manifest.pages[0].id, elements => elements.map(e => e.id === root.id ? revised(e, { customData: { ...e.customData, pageinkCard: next } }) : e));
      toast.show({ kind: 'success', message: '原件已恢复为新笔记，卡片已关联到恢复副本' });
    });
  }
  function groupSelection(ungroup = false, explicitIds?: readonly string[]) {
    const handle = body.current;
    if (!handle) return;
    const ids = new Set(explicitIds ?? handle.selected().map(e => e.id));
    if (!ids.size) return;
    if (paged && !ungroup) {
      const targetElements = handle.elements().filter(e => ids.has(e.id));
      const pages = new Set(targetElements.map(e => handle.pageOf(e)).filter(Boolean));
      if (pages.size > 1) {
        toast.show({ kind: 'info', message: '不能跨页组合对象，请只选择同一页的内容' });
        return;
      }
    }
    run(() => handle.transformScene(elements => ungroup ? ungroupElements(elements, ids) : groupElements(elements, ids)));
  }
  function orderSelection(action: LayerOrderAction, explicitIds?: readonly string[]) {
    const ids = new Set(explicitIds ?? (body.current?.selected().map(e => e.id) ?? []));
    if (!ids.size) return;
    run(() => body.current?.transformScene(elements => reorderElements(elements, ids, action)));
  }
  function lockSelection(locked: boolean, explicitIds?: readonly string[]) {
    const ids = new Set(explicitIds ?? (body.current?.selected().map(e => e.id) ?? []));
    if (!ids.size) return;
    run(() => body.current?.transformScene(elements => setElementsLocked(elements, ids, locked)));
  }
  function unlockAllSelection() {
    const handle = body.current;
    if (!handle) return;
    const scope = handle.elements(paged ? currentPageId : undefined);
    const lockedIds = new Set(scope.filter(e => !e.isDeleted && e.locked).map(e => e.id));
    if (!lockedIds.size) return;
    run(() => handle.transformScene(elements => setElementsLocked(elements, lockedIds, false)));
  }
  function restyleSelection(patch: { strokeColor?: string; strokeWidth?: number; opacity?: number; strokeStyle?: 'solid' | 'dashed' | 'dotted'; backgroundColor?: string }) {
    const ids = new Set(body.current?.selected().map(e => e.id) ?? []);
    if (!ids.size) return;
    run(() => body.current?.transformScene(elements => restyleElements(elements, ids, patch)));
  }
  function handleToggleTape(id: string) {
    run(() => body.current?.transformScene(elements => toggleTapeElement(elements, id)));
  }
  function toggleSelectedTapes() {
    const handle = body.current;
    if (!handle || !selection?.hasTape) return;
    const ids = new Set(selection.ids);
    const nextRevealed = !selection.tapeRevealed;
    run(() => handle.transformScene(elements => setAllTapesRevealed(elements, nextRevealed, ids)));
  }
  function revealAllTapes(revealed: boolean) {
    const useScratch = reading && scratchOpen;
    if (reading && !useScratch) return;
    const handle = useScratch ? scratchReady.current : body.current;
    if (!handle) return;
    const scope = !useScratch && paged ? new Set(handle.elements(currentPageId).map(e => e.id)) : undefined;
    run(async () => {
      let count = 0;
      const changed = await handle.transformScene(elements => {
        const res = setAllTapesRevealed(elements, revealed, scope);
        count = res.count;
        return res;
      });
      if (changed) toast.show({ kind: 'info', message: revealed ? `已揭开 ${count} 条胶带` : `已重新遮盖 ${count} 条胶带` });
      else toast.show({ kind: 'info', message: revealed ? '当前没有可揭开的胶带' : '当前没有可遮盖的胶带' });
    });
  }
  function saveSelectionToLibrary() {
    if (libraryBusy.current) return;
    const useScratch = reading && scratchOpen;
    if (reading && !useScratch) return;
    const handle = useScratch ? scratchReady.current : body.current;
    if (!handle) return;
    const items = handle.selected();
    if (!items.length) return;
    libraryBusy.current = true;
    run(async () => {
      try {
        const saved = await host.elements.add(items, { ...session.files, ...handle.api.getFiles() });
        if (saved) toast.show({ kind: 'success', message: `已将「${saved.name}」存入常用元素库` });
      } finally { libraryBusy.current = false; }
    });
  }
  function insertLibraryItem(item: SavedElementItem) {
    if (libraryBusy.current) return;
    const useScratch = reading && scratchOpen;
    if (reading && !useScratch) return;
    if (!useScratch && !body.current) return;
    pop.close();
    libraryBusy.current = true;
    run(async () => {
      try {
        const handle = useScratch ? await scratchHandle() : body.current;
        if (!handle || !mounted.current) return;
        const prepared = prepareLibraryInsert(item);
        if (Object.keys(prepared.files).length) await session.acceptFiles(prepared.files);
        if (!mounted.current) return;
        await handle.insert(prepared.elements);
        if (!reading) setTool('select');
        toast.show({ kind: 'success', message: `已插入「${item.name}」` });
      } finally { libraryBusy.current = false; }
    });
  }
  function handleInsertSpace(pageId: string, sceneY: number, deltaY: number) {
    const handle = body.current;
    if (!handle) return;
    if (paged) {
      const placement = handle.layout().byId.get(pageId);
      if (!placement) return;
      const localY = sceneY - placement.y;
      run(() => enqueue('body', async () => {
        await handle.flush();
        const before = await session.load(pageId);
        const result = insertVerticalSpace(before, localY, deltaY);
        if (!result.changed) return;
        const page = manifest.pages.find(p => p.id === pageId);
        if (!page) return;
        const nextElements = result.movedIds.length ? (handle.api as InkApi).inkRebind(result.elements, result.movedIds) : result.elements;
        session.editContent(new Map([[pageId, nextElements]]), () => {
          const box = bounds(nextElements);
          if (box) page.margins.bottom = Math.max(page.margins.bottom, box.y + box.height + 24 - page.height);
        });
        await handle.rebuild();
        toast.show({ kind: 'info', message: deltaY >= 0 ? `已插入空白（下移 ${result.movedCount} 项）` : `已收起空隙（上移 ${result.movedCount} 项）`, action: { label: '撤销', run: () => undo() } });
      }));
    } else {
      run(() => enqueue('body', async () => {
        let moved = 0;
        const changed = await handle.transformScene(elements => {
          const result = insertVerticalSpace(elements, sceneY, deltaY);
          moved = result.movedCount;
          if (!result.changed) return result;
          return { ...result, elements: (handle.api as InkApi).inkRebind(result.elements, result.movedIds) };
        });
        if (changed) toast.show({ kind: 'info', message: deltaY >= 0 ? `已插入空白（下移 ${moved} 项）` : `已收起空隙（上移 ${moved} 项）`, action: { label: '撤销', run: () => undo() } });
      }));
    }
  }
  function connectSelection() {
    const selected = body.current?.selected().filter(e => cardReference(e)).sort((a, b) => a.x - b.x) ?? [];
    if (selected.length !== 2) return;
    runText(() => applyMixed(manifest.pages[0].id, elements => {
      const roots = selected.map(e => elements.find(now => now.id === e.id && !now.isDeleted));
      if (!roots[0] || !roots[1]) throw Error('卡片已移除，请重新选择。');
      return (body.current!.api as InkApi).inkRebind(connectCards(elements, roots[0], roots[1]), roots.map(e => e!.id));
    }));
  }

  // ---------- bookmarks & links ----------
  const copyLink = (options: { page?: string; region?: string; embed?: boolean }) => run(async () => {
    await session.flush(); await host.copyLink(options);
    toast.show({ kind: 'success', message: options.embed ? '嵌入代码已复制，粘贴到 Markdown 笔记即可显示预览' : '链接已复制' });
  });
  function addBookmark(sceneRect: Rect) {
    const handle = body.current; if (!handle) return;
    const placement = placementAt(handle.layout(), sceneRect.y + sceneRect.height / 2), local = toLocalRect(sceneRect, placement);
    const region: Region = { x: Math.round(local.x), y: Math.round(local.y), width: Math.max(1, Math.round(local.width)), height: Math.max(1, Math.round(local.height)), id: uid(), pageId: placement.page.id, title: `书签 ${manifest.regions.length + 1}` };
    session.editLayout(() => manifest.regions.push(region));
    setSidebar(true); setTab('bookmarks'); setRenaming(region.id);
  }
  const openRegion = (region: Region) => revealPage(region.pageId, region, true);
  const bookmarkView = () => { if (body.current) addBookmark(sceneViewport(body.current.views.get())); };
  const renameRegion = (region: Region, title: string | null) => {
    setRenaming(null);
    const value = title?.trim();
    if (value && value !== region.title) session.editLayout(() => { const r = manifest.regions.find(item => item.id === region.id); if (r) r.title = value; });
  };

  // ---------- scratch ----------
  const scratchHandle = async (signal?: AbortSignal) => {
    if (!mounted.current) throw new DOMException('已关闭', 'AbortError');
    signal?.throwIfAborted();
    if (!scratchSessionAbort.current || scratchSessionAbort.current.signal.aborted) {
      scratchSessionAbort.current = new AbortController();
    }
    const sessionSignal = scratchSessionAbort.current.signal;
    const guard = new AbortController();
    const propagate = () => guard.abort();
    signal?.addEventListener('abort', propagate, { once: true });
    sessionSignal.addEventListener('abort', propagate, { once: true });
    try {
      const handle = scratchReady.current ?? await new Promise<CanvasHandle>((resolve, reject) => {
        const abort = () => {
          const idx = scratchWaiters.current.indexOf(waiter);
          if (idx >= 0) scratchWaiters.current.splice(idx, 1);
          reject(new DOMException('已取消', 'AbortError'));
        };
        const waiter = {
          resolve: (h: CanvasHandle) => { guard.signal.removeEventListener('abort', abort); resolve(h); },
          reject: (e: Error) => { guard.signal.removeEventListener('abort', abort); reject(e); },
        };
        if (guard.signal.aborted) { abort(); return; }
        guard.signal.addEventListener('abort', abort, { once: true });
        scratchWaiters.current.push(waiter);
      });
      // The editor stays mounted while hidden. Wait for its opened viewport before placing or fitting content.
      const visible = () => { const v = handle.views.get(); return v.width > 0 && v.height > 0; };
      if (!visible()) await new Promise<void>((resolve, reject) => {
        const abort = () => { unsubscribe(); reject(new DOMException('已取消', 'AbortError')); };
        const unsubscribe = handle.views.subscribe(() => {
          if (visible()) { unsubscribe(); guard.signal.removeEventListener('abort', abort); resolve(); }
        });
        if (guard.signal.aborted) { abort(); return; }
        guard.signal.addEventListener('abort', abort, { once: true });
      });
      return handle;
    } finally {
      signal?.removeEventListener('abort', propagate);
      sessionSignal.removeEventListener('abort', propagate);
    }
  };
  async function toScratch(elements: readonly Element[], at?: ScenePoint): Promise<boolean> {
    if (clipboardBusy.current) return false;
    clipboardBusy.current = true;
    try {
      setScratchOpen(true);
      const handle = await scratchHandle();
      await handle.insert(elements, at);
      return true;
    } finally { clipboardBusy.current = false; }
  }
  async function toBody() {
    if (clipboardBusy.current) return;
    const items = scratchReady.current?.selected() ?? []; if (!items.length || !body.current) return;
    clipboardBusy.current = true;
    try {
      await body.current.insert(items); setTool('select');
      toast.show({ kind: 'success', message: `已复制到${paged ? '当前页' : '画布'}，可拖动调整位置` });
    } finally { clipboardBusy.current = false; }
  }

  // ---------- marquee results ----------
  async function capture(points: ScenePoint[]) {
    if (capturing.current) return;
    const handle = body.current; if (!handle) return;
    capturing.current = true;
    const box = polygonBounds(points), placement = placementAt(handle.layout(), box.y + box.height / 2);
    const local = points.map(([x, y]) => [x - placement.x, y - placement.y] as ScenePoint);
    const task = new AbortController();
    const id = toast.show({ kind: 'progress', message: '正在摘录…', cancel: () => task.abort() });
    try {
      await handle.flush();
      const { element } = await capturePdf(session, pdf, placement.page, local, prefs.capture.annotations, task.signal);
      task.signal.throwIfAborted();
      setScratchOpen(true);
      const target = await scratchHandle(task.signal), existing = target.api.getSceneElements();
      const right = existing.reduce((max, e) => Math.max(max, e.x + e.width), -Infinity);
      const top = existing.length ? Math.min(...existing.map(e => e.y)) : 0;
      await target.insert([element], existing.length ? [right + 32 + element.width / 2, top + element.height / 2] : undefined);
      target.zoom('fitAll');
      toast.dismiss(id); toast.show({ kind: 'success', message: '已摘录到草稿纸' });
    } catch (error) { toast.dismiss(id); throw error; }
    finally { capturing.current = false; }
  }
  const onMarquee = (points: ScenePoint[], purpose: string) => run(async () => {
    if (purpose === 'capture') return capture(points);
    if (purpose === 'bookmark') { setMarquee(null); addBookmark(polygonBounds(points)); }
  });

  // ---------- images & clipboard ----------
  async function insertImageBlob(file: Blob, surface: 'body' | 'scratch' = 'body') {
    if (clipboardBusy.current) return;
    if (surface === 'body' && (readingRef.current || !body.current)) return;
    clipboardBusy.current = true;
    try {
      const targetHandle = surface === 'scratch' ? await scratchHandle() : body.current;
      if (!targetHandle || !mounted.current || (surface === 'body' && readingRef.current) || (surface === 'scratch' && !scratchOpenRef.current)) return;
      const dataURL = await readDataURL(file);
      const image = new Image(); image.src = dataURL; await image.decode();
      if (!mounted.current || (surface === 'body' && readingRef.current) || (surface === 'scratch' && !scratchOpenRef.current)) return;
      const v = targetHandle.views.get();
      if (v.width <= 0 || v.height <= 0 || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
      const fit = Math.min(1, (v.width / v.zoom) * 0.6 / image.naturalWidth, (v.height / v.zoom) * 0.6 / image.naturalHeight);
      const at = targetHandle.center();
      const id = uid();
      const imgFile = imageFile(id, dataURL, file.type || 'image/png');
      const elements = convertToExcalidrawElements([{ type: 'image', x: 0, y: 0, width: image.naturalWidth * fit, height: image.naturalHeight * fit, fileId: id as NonNullable<Extract<Element, { type: 'image' }>['fileId']> }]);
      targetHandle.api.addFiles([imgFile]);
      await targetHandle.insert(elements, at);
      if (surface === 'body' && !readingRef.current) setTool('select');
    } finally { clipboardBusy.current = false; }
  }
  function chooseImage() {
    if (readingRef.current && !scratchOpenRef.current) return;
    const input = createEl('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.onchange = () => run(async () => {
      const file = input.files?.[0]; if (!file) return;
      if (readingRef.current && !scratchOpenRef.current) return;
      await insertImageBlob(file, readingRef.current && scratchOpenRef.current ? 'scratch' : 'body');
    });
    input.click();
  }
  function copySelectedToClipboard(surface: 'body' | 'scratch' = 'body') {
    const handle = surface === 'scratch' ? scratchReady.current : body.current;
    if (!handle) return false;
    const items = handle.selected();
    if (!items.length) return false;
    const payload = copyInkClipboard(items, { ...session.files, ...handle.api.getFiles() }, session.manifest.id);
    if (!payload) return false;
    void navigator.clipboard?.writeText?.(payload.token).catch(() => {});
    toast.show({ kind: 'success', message: `已复制 ${payload.elements.length} 项，可在当前或其它笔记中 Ctrl+V 粘贴` });
    return true;
  }
  async function pasteInkFromClipboard(surface: 'body' | 'scratch' = 'body') {
    if (clipboardBusy.current) return false;
    const payload = readInkClipboard();
    if (!payload?.elements.length) return false;
    if (surface === 'body' && !body.current) return false;
    clipboardBusy.current = true;
    try {
      const handle = surface === 'scratch' ? await scratchHandle() : body.current;
      if (!handle || !mounted.current) return false;
      if (Object.keys(payload.files).length) await session.acceptFiles(payload.files);
      if (!mounted.current) return false;
      const elements = prepareClipboardForSession(payload, session.manifest.id);
      await handle.insert(elements);
      if (surface === 'body') setTool('select');
      toast.show({ kind: 'success', message: `已粘贴 ${elements.length} 项` });
      return true;
    } finally { clipboardBusy.current = false; }
  }
  const onPaste = (event: React.ClipboardEvent) => {
    if (resolving || editingCard) return;
    const element = event.target as HTMLElement;
    if (element.closest('input, textarea, select, [contenteditable=true]')) return;
    const surface: 'body' | 'scratch' = element.closest('.ink-scratch') ? 'scratch' : 'body';
    if (reading && surface === 'body') return;
    if (surface === 'body' && !body.current) return;
    const stored = readInkClipboard();
    const plainText = event.clipboardData?.getData('text/plain') ?? '';
    if (stored && plainText === stored.token) {
      event.preventDefault(); event.stopPropagation();
      run(() => pasteInkFromClipboard(surface));
      return;
    }
    const items = event.clipboardData?.items ? [...event.clipboardData.items] : [];
    const imageItem = items.find(item => item.type.startsWith('image/'));
    if (imageItem) {
      const blob = imageItem.getAsFile();
      if (blob) {
        event.preventDefault(); event.stopPropagation();
        run(() => insertImageBlob(blob, surface));
        return;
      }
    }
    const hasExternalClipboard = !!(plainText || items.length || (event.clipboardData?.types?.length ?? 0) > 0);
    if (!hasExternalClipboard && stored) {
      event.preventDefault(); event.stopPropagation();
      run(() => pasteInkFromClipboard(surface));
    }
  };

  // ---------- export ----------
  async function exportDocument(kind: 'pdf' | 'png' | 'package', scope: 'all' | 'page' | 'selection' = 'all') {
    if (exporting.current) { toast.show({ kind: 'info', message: '正在导出中，请稍候或先取消当前导出' }); return; }
    exporting.current = true;
    pop.close();
    const task = new AbortController(), name = host.fileName();
    const label = kind === 'package' ? '备份' : kind === 'pdf' ? 'PDF' : '图片';
    const id = toast.show({ kind: 'progress', message: `正在导出${label}…`, cancel: () => task.abort() });
    try {
      await session.flush();
      task.signal.throwIfAborted();
      let bytes: ArrayBuffer, extension: string, detail = '';
      const progress = (done: number, total: number) => toast.update(id, { message: `正在导出${label} ${done}/${total}` });
      if (kind === 'package') { bytes = toArrayBuffer(await pack(session, progress, task.signal)); extension = 'inkpack'; detail = '包含正文、草稿纸、图片、原 PDF 与引用时的文字原件快照，可恢复编辑'; }
      else if (kind === 'pdf') {
        const options: PdfExportOptions = {
          paper,
          pages: scope === 'page' ? [currentPageId] : undefined,
          selection: scope === 'selection' ? body.current?.selected() : undefined,
          tile: !paged && scope === 'all' && paper !== 'original' && exportTile,
        };
        bytes = toArrayBuffer(await readingPdf(session, progress, task.signal, options)); extension = 'pdf';
      } else {
        const result = scope === 'selection' ? await png(session, body.current?.selected() ?? [], task.signal) : paged ? await pagePng(session, currentPage, pdf, task.signal) : await png(session, await session.read(manifest.pages[0].id), task.signal);
        task.signal.throwIfAborted();
        bytes = await result.blob.arrayBuffer(); extension = 'png';
        if (result.scale < 2) detail = `内容较大，已按 ${result.scale.toFixed(1)} 倍分辨率导出`;
      }
      task.signal.throwIfAborted();
      const suffix = scope === 'page' ? ` 第${currentIndex + 1}页` : scope === 'selection' ? ' 选区' : '';
      const path = await host.saveExport(name + suffix, extension, bytes);
      toast.dismiss(id);
      toast.show({ kind: 'success', message: `已导出到 ${path}`, detail, action: kind === 'package' ? undefined : { label: '打开', run: () => run(() => host.openFile(path)) } });
    } catch (error) { toast.dismiss(id); throw error; }
    finally { exporting.current = false; }
  }

  // ---------- navigation requests (links, embeds, sources) ----------
  const navigationToken = useRef('');
  useEffect(() => {
    const request = session.navigation, handle = body.current;
    if (!request || !handle || request.token === navigationToken.current) return;
    navigationToken.current = request.token;
    if (!manifest.pages.some(p => p.id === request.page)) { toast.show({ kind: 'error', message: '引用的页面已删除或尚未同步。' }); return; }
    const region = request.rect ?? manifest.regions.find(r => r.id === request.region);
    revealPage(request.page, region, !!region);
  });

  // ---------- selection actions ----------
  const selectionActions = {
    duplicate: () => run(async () => { const h = body.current!, items = h.selected(); const r = selection!.rect; await h.insert(items, [r.x + r.width / 2 + 24, r.y + r.height / 2 + 24]); }),
    remove: () => run(() => body.current?.replaceSelected(() => null)),
    recolor: (color: string) => restyleSelection({ strokeColor: color }),
    restyle: restyleSelection,
    group: () => groupSelection(false),
    ungroup: () => groupSelection(true),
    order: (action: LayerOrderAction) => orderSelection(action),
    toggleLock: () => lockSelection(!(selection?.locked ?? false)),
    toScratch: () => run(async () => { if (await toScratch(body.current!.selected())) toast.show({ kind: 'success', message: '已复制到草稿纸' }); }),
    bookmark: () => { if (selection) addBookmark(selection.rect); },
    source: (info: SelectionInfo | null) => run(async () => { const s = info?.source; if (!s?.document || !s.page || !Array.isArray(s.polygon)) return; setScratchOpen(false); await host.openSource(s.document, s.page, polygonBounds(s.polygon)); }),
  };

  // ---------- keyboard ----------
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (resolving) { event.preventDefault(); event.stopPropagation(); return; }
    const element = event.target as HTMLElement;
    if (event.nativeEvent.isComposing || element.closest('input, textarea, select, [contenteditable=true]')) return;
    if (!paged && event.key === 'Enter' && !element.closest('button, [role=dialog]')) {
      const selected = body.current?.selected().filter(e => cardReference(e)) ?? [];
      if (selected.length === 1) { event.preventDefault(); event.stopPropagation(); editCard(selected[0]); return; }
    }
    const key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
    const surface = element.closest('.ink-scratch') ? 'scratch' : 'body';
    // Menus and form-like controls own their arrow/space keys; writing shortcuts belong to the canvas.
    if (element.closest('[role=dialog], [role=tablist], [role=radiogroup]')) return;
    if (reading && surface === 'body' && (mod && ['z', 'y'].includes(key) || key === 'delete' || key === 'backspace')) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (mod && !event.altKey) {
      if (key === 'z') { event.preventDefault(); event.stopPropagation(); event.shiftKey ? redo(surface) : undo(surface); return; }
      if (key === 'y') { event.preventDefault(); event.stopPropagation(); redo(surface); return; }
      if (key === 'f') { event.preventDefault(); event.stopPropagation(); setFocus(false); setSidebar(true); chooseTab('search'); return; }
      if (key === 's') { event.preventDefault(); event.stopPropagation(); run(async () => { await session.flush(); toast.show({ kind: 'success', message: '已保存' }); }); return; }
      if (key === 'c' && !event.shiftKey) {
        if (copySelectedToClipboard(surface)) { event.preventDefault(); event.stopPropagation(); return; }
      }
      if (!reading && surface === 'body' && selection) {
        if (key === 'g') { event.preventDefault(); event.stopPropagation(); groupSelection(event.shiftKey); return; }
        if (event.code === 'BracketRight' || key === ']' || key === '}') { event.preventDefault(); event.stopPropagation(); orderSelection(event.shiftKey ? 'front' : 'forward'); return; }
        if (event.code === 'BracketLeft' || key === '[' || key === '{') { event.preventDefault(); event.stopPropagation(); orderSelection(event.shiftKey ? 'back' : 'backward'); return; }
        if (key === 'l' && event.shiftKey) { event.preventDefault(); event.stopPropagation(); lockSelection(!selection.locked); return; }
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape') {
      if (element.closest('.ink-sidebar')) return;
      if (marquee) { setMarquee(null); event.preventDefault(); event.stopPropagation(); return; }
      if (ruler) { setRuler(null); event.preventDefault(); event.stopPropagation(); return; }
      if (zoomWindowOpen) { setZoomWindowOpen(false); event.preventDefault(); event.stopPropagation(); return; }
      if (selection && surface === 'body') { body.current?.clearSelection(); event.preventDefault(); event.stopPropagation(); return; }
      return;
    }
    if (paged && (event.key === 'PageDown' || event.key === 'PageUp') && body.current) {
      event.preventDefault(); const next = manifest.pages[currentIndex + (event.key === 'PageDown' ? 1 : -1)]; if (next) goToPage(next.id); return;
    }
    if (event.shiftKey || key.length !== 1) return;
    const mapped = SHORTCUTS[key];
    if (/^[a-z0-9]$/.test(key)) { event.preventDefault(); event.stopPropagation(); } // keep the kernel's own tool keys from desynchronising the toolbar
    if (!mapped || event.repeat) return;
    if (mapped === 'image') chooseImage();
    else if (mapped !== 'capture' || pdf) setTool(mapped);
  };

  // ---------- menus ----------
  const menuPage = target ? manifest.pages.find(p => p.id === target) : undefined;
  const menuRegion = target ? manifest.regions.find(r => r.id === target) : undefined;
  const pageMenu = (page: Page, anchor: HTMLElement | null): MenuEntry[] => {
    const i = indexOf(page.id);
    return [
      { icon: 'pageAdd', label: '在后面添加页面', onSelect: () => addPage(page.id) },
      { icon: 'duplicate', label: '复制此页', onSelect: () => duplicatePage(page.id) },
      { icon: 'moveUp', label: '上移', disabled: i === 0, onSelect: () => movePage(page.id, -1) },
      { icon: 'moveDown', label: '下移', disabled: i === manifest.pages.length - 1, onSelect: () => movePage(page.id, 1) },
      'separator',
      { icon: 'sliders', label: '纸张与页边距…', onSelect: () => openSettings(page.id, anchor) },
      { icon: 'link', label: '复制页面链接', onSelect: () => copyLink({ page: page.id }) },
      ...(page.pdfPage && pdf ? [{ icon: 'docText', label: '复制此页文字', onSelect: () => copyPageText(page) } as MenuEntry] : []),
      ...(page.pdfPage && pdf ? [{ icon: 'text', label: '选择此页文字…', onSelect: () => showPageText(page, anchor) } as MenuEntry] : []),
      'separator',
      { icon: 'trash', label: '删除此页', danger: true, disabled: manifest.pages.length <= 1, onSelect: () => deletePage(page.id) },
    ];
  };
  const copyPageText = (page: Page) => {
    if (pdfTextBusy.current) return;
    pdfTextBusy.current = true;
    run(async () => {
      try {
        const text = (await pdf!.text(page)).map(t => t.str + (t.hasEOL ? '\n' : '')).join('').trim();
        if (!mounted.current) return;
        if (!text) { toast.show({ kind: 'info', message: '这一页没有可提取的文字（可能是扫描件）' }); return; }
        await navigator.clipboard.writeText(text); toast.show({ kind: 'success', message: `已复制第 ${indexOf(page.id) + 1} 页文字（${text.length} 字）` });
      } finally { pdfTextBusy.current = false; }
    });
  };
  const showPageText = (page: Page, anchor: HTMLElement | null) => {
    const targetAnchor = anchor?.isConnected ? anchor : topRightAnchor.current;
    if (!targetAnchor) return;
    const seq = ++pdfTextSeq.current;
    const pageNum = indexOf(page.id) + 1;
    setPdfText({ page: pageNum, text: '', loading: true });
    pop.set({ id: 'pdf-text', anchor: targetAnchor });
    run(async () => {
      try {
        const text = (await pdf!.text(page)).map(t => t.str + (t.hasEOL ? '\n' : ' ')).join('').trim();
        if (seq !== pdfTextSeq.current || !mounted.current) return;
        setPdfText({ page: pageNum, text, loading: false });
      } finally {
        if (seq === pdfTextSeq.current && mounted.current) setPdfText(cur => cur.loading ? { ...cur, loading: false } : cur);
      }
    });
  };
  const openSettings = (id: string, anchor: HTMLElement | null) => {
    setTarget(id);
    window.requestAnimationFrame(() => {
      const targetAnchor = anchor?.isConnected ? anchor : topRightAnchor.current;
      if (targetAnchor) pop.set({ id: 'page-settings', anchor: targetAnchor });
    });
  };

  const hasOutline = paged && !!pdf;
  const hasPdfPage = !!(pdf && currentPage?.pdfPage);
  const hasPdfSource = !!manifest.pdf;
  const sidebarVisible = sidebar && !focus;
  const sidebarTab: SidebarTab = (!paged && tab === 'pages') ? 'bookmarks' : (!hasOutline && tab === 'outline') ? (paged ? 'pages' : 'bookmarks') : tab;
  const closeSidebar = (remember = false) => {
    setSidebar(false);
    if (remember) store.update({ sidebar: paged ? { pages: false } : { canvas: false } });
    host.focusSidebarAction?.();
  };
  const toggleSidebar = () => { const next = !sidebar; setSidebar(next); store.update({ sidebar: paged ? { pages: next } : { canvas: next } }); };
  const chooseTab = (next: SidebarTab) => { setTab(next); store.update({ sidebar: { tab: next } }); };

  const openMixed = () => window.requestAnimationFrame(() => {
    const insertBtn = layer?.querySelector<HTMLElement>('[data-anchor="insert"]');
    const anchor = insertBtn?.getClientRects().length ? insertBtn : topRightAnchor.current;
    if (anchor) pop.set({ id: 'mixed', anchor });
  });

  useEffect(() => {
    host.syncChrome?.({ paged, sidebar, reading, scratchOpen, focus, hasPdfPage, hasPdfSource });
  }, [host, paged, sidebar, reading, scratchOpen, focus, hasPdfPage, hasPdfSource]);
  const actionsRef = useRef<WorkspaceActions | null>(null);
  actionsRef.current = {
    exportPdf: () => run(() => exportDocument('pdf')),
    exportPackage: () => run(() => exportDocument('package')),
    openExport: () => window.requestAnimationFrame(() => { if (topRightAnchor.current) pop.set({ id: 'export', anchor: topRightAnchor.current }); }),
    openPageSettings: () => openSettings(paged ? currentPageId : manifest.pages[0].id, topRightAnchor.current),
    openMixed,
    toggleSidebar,
    toggleReading: () => { if (paged) toggleReading(); },
    toggleScratch: () => setScratchOpen(open => !open),
    toggleFocus: () => setFocus(on => { if (!on) setSidebar(false); return !on; }),
    search: () => { setFocus(false); setSidebar(true); chooseTab('search'); },
    copyCurrentLink: () => copyLink({ page: paged ? currentPageId : manifest.pages[0].id }),
    copyCurrentPageText: () => { if (pdf && currentPage?.pdfPage) copyPageText(currentPage); },
    selectCurrentPageText: () => window.requestAnimationFrame(() => { if (pdf && currentPage?.pdfPage) showPageText(currentPage, topRightAnchor.current); }),
    bookmarkCurrentView: () => { if (!paged) bookmarkView(); },
  };
  useEffect(() => host.connect({
    exportPdf: () => actionsRef.current?.exportPdf(),
    exportPackage: () => actionsRef.current?.exportPackage(),
    openExport: () => actionsRef.current?.openExport(),
    openPageSettings: () => actionsRef.current?.openPageSettings(),
    openMixed: () => actionsRef.current?.openMixed(),
    toggleSidebar: () => actionsRef.current?.toggleSidebar(),
    toggleReading: () => actionsRef.current?.toggleReading(),
    toggleScratch: () => actionsRef.current?.toggleScratch(),
    toggleFocus: () => actionsRef.current?.toggleFocus(),
    search: () => actionsRef.current?.search(),
    copyCurrentLink: () => actionsRef.current?.copyCurrentLink(),
    copyCurrentPageText: () => actionsRef.current?.copyCurrentPageText(),
    selectCurrentPageText: () => actionsRef.current?.selectCurrentPageText(),
    bookmarkCurrentView: () => actionsRef.current?.bookmarkCurrentView(),
  }), [host]);

  const saveFailed = !session.conflictPath && session.saveState === 'failed';
  const showSaving = !session.conflictPath && savingShown && !saveFailed;
  const floatingStatus = (saveFailed || showSaving || focus) ? <div className="ink-floating-status">
    {saveFailed && <button type="button" className="ink-save-failed" onClick={() => run(() => session.flush())}><InkIcon name="warning"/>保存失败 · 重试</button>}
    {showSaving && <span className="ink-save-state is-saving" role="status" aria-label="正在保存"><span className="ink-spinner"/><span>正在保存…</span></span>}
    {focus && <IconButton icon="focus" label="退出专注" className="ink-labelled ink-exit-focus" aria-pressed onClick={() => setFocus(false)}><span>退出专注</span></IconButton>}
  </div> : null;

  const dockTool: ToolId = reading && tool === 'capture' ? 'select' : tool;
  const secondaryToolActive = dockTool === 'text' || dockTool === 'shape' || dockTool === 'capture' || dockTool === 'space' || dockTool === 'tape';
  const activeAuxCount = (zoomWindowOpen ? 1 : 0) + (ruler ? 1 : 0) + (prefs.gridSnap ? 1 : 0) + (paged && prefs.nightPaper ? 1 : 0);
  const tools = <ToolDock layer={bodyLayer} visible={!reading || scratchOpen} autoCollapse={prefs.autoCollapseDock} writingSignal={writingSignal} onDrag={pop.close}>
    {!reading && <div className="ink-history-tools" role="group" aria-label="编辑历史">
      <IconButton icon="undo" label="撤销" shortcut="Ctrl+Z" disabled={!session.bodyHistory.canUndo} onClick={() => undo()}/>
      <IconButton icon="redo" label="重做" shortcut="Ctrl+Shift+Z" disabled={!session.bodyHistory.canRedo} onClick={() => redo()}/>
    </div>}
    <ToolShelf tool={dockTool} onTool={setTool} prefs={prefs} store={store} onRevealAllTapes={revealAllTapes}/>
    <div className="ink-dock-end">
      <IconButton icon="plus" label="插入与排版" data-anchor="insert" aria-expanded={pop.open === 'insert' || pop.open === 'mixed' || pop.open === 'cards'} className={`ink-toolbox-trigger${secondaryToolActive ? ' has-active' : ''}`} onClick={event => pop.toggle('insert', event.currentTarget)}>
        {secondaryToolActive && <span className="ink-active-dot" aria-hidden="true"/>}
      </IconButton>
      <IconButton icon="toolbox" label="辅助工具" data-anchor="toolbox" aria-expanded={pop.open === 'toolbox' || pop.open === 'elements' || pop.open === 'layers'} className={`ink-toolbox-trigger${activeAuxCount > 0 ? ' has-active' : ''}`} onClick={event => pop.toggle('toolbox', event.currentTarget)}>
        {activeAuxCount > 0 && <span className="ink-active-dot" aria-hidden="true"/>}
      </IconButton>
    </div>
  </ToolDock>;

  return <LayerContext.Provider value={layer}>
    <div ref={setLayer} tabIndex={-1} className={`ink-workspace ink-mode-${manifest.mode}${focus ? ' is-focus' : ''}${reading ? ' is-reading' : ''}${sidebarVisible ? ' has-sidebar' : ''}`} onKeyDownCapture={onKeyDown} onPasteCapture={onPaste}>
      {session.conflictPath && <div className="ink-banner is-warning" role="alert"><InkIcon name="warning"/><span><strong>这个笔记在别处被修改过。</strong>你的内容已安全保留，自动保存已暂停。两种选择都不会丢失任何一方的内容。</span>
        <span className="ink-banner-actions">{([[true, '继续编辑我的版本（副本）'], [false, '打开外部版本']] as const).map(([copy, label]) =>
          <button key={label} type="button" disabled={resolving} onClick={() => run(async () => { setResolving(true); try { await host.resolveConflict(copy); } finally { setResolving(false); } })}>{label}</button>)}</span></div>}
      {session.sourceIssue && <div className="ink-banner" role="status"><InkIcon name="warning"/><span>原 PDF 暂不可用：{session.sourceIssue} 笔迹不受影响。</span><span className="ink-banner-actions"><button type="button" onClick={() => host.relinkSource()}>重新关联…</button></span></div>}
      <div ref={setBodyLayer} className={`ink-body${scratchOpen && prefs.scratchPlacement === "docked" ? " has-docked-scratch" : ""}`}>
        <span ref={topRightAnchor} className="ink-top-anchor" aria-hidden="true"/>
        {floatingStatus}
        {tools}
        {sidebarVisible && <>
        {compact && <button type="button" className="ink-sidebar-backdrop" aria-label="关闭侧栏" onClick={() => closeSidebar()}/>}
        <aside className="ink-sidebar" id={sidebarId} aria-label="侧栏" onKeyDown={event => {
          if (event.key === 'Escape' && !event.nativeEvent.isComposing && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); closeSidebar(); }
        }}>
          <div className="ink-sidebar-heading">
            <SidebarTabs id={sidebarId} tab={sidebarTab} onTab={chooseTab} paged={paged} hasOutline={hasOutline}/>
            <IconButton icon="close" label="收起侧栏" onClick={() => closeSidebar(true)}/></div>
          <div className="ink-sidebar-panel" id={`${sidebarId}-panel`} role="tabpanel" aria-labelledby={`${sidebarId}-${sidebarTab}`}>
          {paged && sidebarTab === 'pages' && <PageList session={session} pdf={pdf} current={currentPageId} onSelect={goToPage} onAdd={() => addPage()} onMenu={(id, anchor) => { setTarget(id); pop.set({ id: 'page-menu', anchor }); }}/>}
          {hasOutline && sidebarTab === 'outline' && pdf && <OutlineList pdf={pdf} pages={manifest.pages} currentPdfPage={currentPage?.pdfPage} onSelect={goToPage}/>}
          {sidebarTab === 'bookmarks' && <BookmarkList regions={manifest.regions} pageNumber={id => paged ? indexOf(id) + 1 : 0} onOpen={openRegion}
            onMenu={(region, anchor) => { setTarget(region.id); pop.set({ id: 'bookmark-menu', anchor }); }} onSaveView={paged ? undefined : bookmarkView}
            onAdd={() => { setReading(false); setMarquee({ shape: 'rect', purpose: 'bookmark' }); if (compact) setSidebar(false); }}
            renaming={renaming} onRename={renameRegion}/>}
          {sidebarTab === 'search' && <SearchPanel session={session} pdf={pdf} paged={paged} onOpen={(hit: SearchHit) => revealPage(hit.page, hit.rect, !!hit.rect)}/>}
          </div>
        </aside></>}
        <div className="ink-surfaces" ref={area}>
        <main className={`ink-canvas-area${zoomWindowOpen && !reading ? ' has-zoom-window' : ''}`}>
          <InkCanvas session={session} pdf={pdf} kind={paged ? 'pages' : 'canvas'} pagesKey={pagesKey} tool={bodyTool} fingerDraws={prefs.fingerDraws} zoomLock={prefs.zoomLock} nightPaper={paged && prefs.nightPaper} gridSnap={prefs.gridSnap} ruler={reading ? null : ruler} rulerRef={reading ? undefined : liveRuler} theme={theme} readOnly={reading || !!editingCard}
            initialView={initialBodyView} ref={body}
            onReady={handle => {
              body.current = handle;
              setViews(handle.views);
              const pending = pendingReveal.current;
              if (pending) {
                pendingReveal.current = null;
                handle.reveal(pending.pageId, pending.rect, pending.highlight);
                if (zoomWindowOpenRef.current) syncZoomBoxToPage(pending.pageId, pending.rect);
              }
            }}
            onError={message => toast.show({ kind: 'error', message })}
            onSelection={setSelection} onMarquee={onMarquee} onGesture={gesture => gesture === 'undo' ? undo() : redo()}
            onScribble={() => toast.show({ kind: 'info', message: '已涂划擦除', action: { label: '撤销', run: () => undo() } })}
            onShapeRecognized={({ kind, revert }) => toast.show({ kind: 'info', message: `已规整为${SHAPE_LABELS[kind]}`, action: { label: '还原手绘', run: () => { if (!readingRef.current) run(() => enqueue('body', () => revert(() => performStep('body', false)))); } } })}
            onWritingChange={active => setSurfaceWriting('body', active)}
            onEraseEnd={onEraseEnd}
            onInsertSpace={handleInsertSpace}
            onToggleTape={handleToggleTape}
            onCardEdit={!paged ? editCard : undefined}
            onAddPage={paged && !reading ? () => addPage() : undefined}
            onViewChange={() => { if (body.current) host.saveView(body.current.memory()); }}/>
          {ruler && !reading && <RulerOverlay ruler={ruler} liveRef={liveRuler} onChange={setRuler} onClose={() => setRuler(null)}/>}
          {zoomWindowOpen && !reading && body.current && <ZoomBoxOverlay views={views} box={zoomBox} liveRef={liveZoomBox} syncRef={zoomBoxSyncRef} onLiveMove={() => zoomPaintRef.current?.()} autoAdvance={zoomAutoAdvance} onChange={setZoomBox}/>}
          {selection && !selection.busy && !marquee && !reading && !editingCard && <SelectionBar views={views} selection={selection}
            onDuplicate={selectionActions.duplicate} onToggleTape={selection.hasTape ? toggleSelectedTapes : undefined} onRemove={selectionActions.remove} onScratch={selectionActions.toScratch}
            onLayers={anchor => pop.toggle('selection-layers', anchor)}
            onColor={anchor => pop.toggle('selection-color', anchor)}
            onMore={anchor => pop.toggle('selection-more', anchor)}
            onSource={selection.source ? () => selectionActions.source(selection) : undefined}/>}
          {editingCard && <CardEditor root={editingCard.root} source={editingCard.source.path} text={editingCard.source.text} views={views} onSave={saveCardDraft} onClose={() => setEditingCard(null)} bindKeys={(element, submit) => host.text.bindDraftKeys(element, submit)}/>}
          {marquee && <div className="ink-mode-hint" role="status">拖动框选要加书签的区域<button type="button" onClick={() => setMarquee(null)}>取消</button></div>}
          <ViewControls views={views} paged={paged} pageCount={manifest.pages.length} pageIndex={currentIndex}
            zoomLock={prefs.zoomLock} onToggleZoomLock={() => store.update({ zoomLock: !prefs.zoomLock })}
            onZoom={anchor => pop.toggle('zoom', anchor)} onJump={anchor => pop.toggle('jump', anchor)}
            onStep={delta => { const page = manifest.pages[currentIndex + delta]; if (page) goToPage(page.id); }}
            onFit={() => body.current?.zoom(paged ? 'fitWidth' : 'fitAll')} onBookmark={bookmarkView}
            onAdd={() => addPage(currentPageId)} reading={reading}/>
          {zoomWindowOpen && !reading && body.current && <ZoomWindow
            session={session} pdf={pdf} handle={body.current} paged={paged} tool={tool} prefs={prefs}
            dark={!paged && theme === 'dark'} nightPaper={paged && prefs.nightPaper}
            box={zoomBox} liveBoxRef={liveZoomBox} paintRef={zoomPaintRef} boxOverlaySyncRef={zoomBoxSyncRef} factor={zoomFactor} autoAdvance={zoomAutoAdvance}
            onBoxChange={setZoomBox} onFactorChange={setZoomFactor} onAutoAdvanceChange={setZoomAutoAdvance}
            onSwitchToPen={() => setTool('pen')}
            onWritingChange={active => setSurfaceWriting('zoom', active)}
            onClose={() => setZoomWindowOpen(false)} onEraseEnd={onEraseEnd}/>}
          <Toasts toasts={toast.toasts} dismiss={toast.dismiss}/>
        </main>
          <ScratchWindow docked={prefs.scratchPlacement === 'docked'} onDock={() => store.update({ scratchPlacement: prefs.scratchPlacement === 'docked' ? 'floating' : 'docked' })} open={scratchOpen} frame={prefs.scratch} area={areaSize} onClose={() => setScratchOpen(false)}
            onFrame={(frame, done) => { store.update({ scratch: frame }); if (done) scratch.current?.api.refresh(); }}
            history={{ canUndo: session.scratchHistory.canUndo, canRedo: session.scratchHistory.canRedo, undo: () => undo('scratch'), redo: () => redo('scratch'),
              clear: () => run(async () => { const h = scratch.current; if (!h) return; await h.flush(); h.api.updateScene({ elements: [] }); await h.flush(); toast.show({ kind: 'info', message: '草稿纸已清空', action: { label: '撤销', run: () => undo('scratch') } }); }) }}
            selection={scratchSelection && !scratchSelection.busy ? { toBody: () => run(toBody), destination: paged ? '当前页' : '画布', remove: () => run(() => scratch.current?.replaceSelected(() => null)), source: scratchSelection.source ? () => selectionActions.source(scratchSelection) : undefined } : null}>
            <InkCanvas session={session} kind="scratch" pagesKey="scratch" tool={scratchTool} fingerDraws={prefs.fingerDraws} zoomLock={prefs.zoomLock} theme={theme} ref={scratch}
              initialView={initialScratchView}
              onScribble={() => toast.show({ kind: 'info', message: '已涂划擦除', action: { label: '撤销', run: () => undo('scratch') } })}
              onShapeRecognized={({ kind, revert }) => toast.show({ kind: 'info', message: `已规整为${SHAPE_LABELS[kind]}`, action: { label: '还原手绘', run: () => run(() => enqueue('scratch', () => revert(() => performStep('scratch', false)))) } })}
              onWritingChange={active => setSurfaceWriting('scratch', active)}
              onEraseEnd={onEraseEnd}
              onToggleTape={id => run(() => scratch.current?.transformScene(elements => toggleTapeElement(elements, id)))}
              onInsertSpace={(_pageId, sceneY, deltaY) => run(() => enqueue('scratch', async () => {
                const h = scratch.current;
                if (!h) return;
                await h.transformScene(elements => {
                  const result = insertVerticalSpace(elements, sceneY, deltaY);
                  if (!result.changed) return result;
                  return { ...result, elements: (h.api as InkApi).inkRebind(result.elements, result.movedIds) };
                });
              }))}
              onReady={handle => { scratch.current = handle; scratchReady.current = handle; setScratchViews(handle.views); for (const waiter of scratchWaiters.current.splice(0)) waiter.resolve(handle); }}
              onViewChange={() => { if (scratch.current) host.saveView(scratch.current.memory(), 'scratch'); }}
              onError={message => toast.show({ kind: 'error', message })} onSelection={setScratchSelection} onGesture={gesture => gesture === 'undo' ? undo('scratch') : redo('scratch')}/>
            <div className="ink-view-controls ink-scratch-view-controls">
              <ZoomControls views={scratchViews} label="草稿纸缩放" fitLabel="草稿纸显示全部内容" onZoom={anchor => pop.toggle('scratch-zoom', anchor)} onFit={() => scratch.current?.zoom('fitAll')}/>
            </div>
          </ScratchWindow>
        </div>
      </div>
      {resolving && <div className="ink-cover" role="status"><span className="ink-spinner"/>正在保存独立副本…</div>}

      {pop.open === 'insert' && <Popover anchor={pop.anchor} onClose={pop.close} label="插入与排版" align="end" className="ink-toolbox-popover">
        <div className="ink-popover-title">插入与排版</div>
        <Menu onDone={pop.close} items={[
          { heading: '对象' },
          { icon: 'text', label: '文字', hint: 'T · 添加可编辑文字', checked: tool === 'text', onSelect: () => setTool('text') },
          { icon: 'shape', label: '形状', hint: 'S · 矩形、椭圆、箭头与直线', checked: tool === 'shape', onSelect: () => setTool('shape') },
          { icon: 'image', label: '插入图片', hint: 'I · 从本地选择图片', onSelect: chooseImage },
          !reading && !!pdf && { icon: 'capture', label: 'PDF 摘录', hint: 'C · 框选 PDF 内容放入草稿纸', checked: tool === 'capture', onSelect: () => setTool('capture') },
          { heading: '排版与学习' },
          { icon: 'space', label: '插空工具', hint: 'K · 向下拖动插入空白，向上收起空隙', checked: tool === 'space', onSelect: () => setTool('space') },
          { icon: 'tape', label: '遮挡胶带', hint: 'A · 遮盖答案或公式，轻点揭开自测', checked: tool === 'tape', onSelect: () => setTool('tape') },
          { heading: '联动笔记' },
          { icon: 'docText', label: '文字段落…', hint: reading ? '查看嵌入段落与跳转原文' : '嵌入 Markdown 段落并绑定批注', onSelect: openMixed },
          !reading && !paged && { icon: 'canvas', label: '画布卡片…', hint: '插入文本或手写卡片并连线', disabled: !!editingCard, onSelect: () => window.requestAnimationFrame(() => { const anchor = layer?.querySelector<HTMLElement>('[data-anchor="insert"]') ?? topRightAnchor.current; if (anchor) pop.set({ id: 'cards', anchor }); }) },
        ]}/>
      </Popover>}
      {pop.open === 'toolbox' && <Popover anchor={pop.anchor} onClose={pop.close} label="辅助工具" align="end" className="ink-toolbox-popover">
        <div className="ink-popover-title">辅助工具</div>
        <Menu onDone={pop.close} items={[
          { heading: '书写辅助' },
          !reading && { icon: 'zoomWindow', label: '放大书写框', hint: '在底部放大书写并自动推进', checked: zoomWindowOpen, onSelect: toggleZoomWindow },
          !reading && { icon: 'ruler', label: '虚拟直尺', hint: '沿直尺边缘吸附绘制直线', checked: !!ruler, onSelect: toggleRuler },
          !reading && { icon: 'gridSnap', label: '网格吸附', hint: '图形与移动自动对齐网格', checked: prefs.gridSnap, onSelect: () => store.update({ gridSnap: !prefs.gridSnap }) },
          paged && { icon: prefs.nightPaper ? 'sun' : 'moon', label: '夜间护眼纸面', hint: '柔和暗色反显，不影响导出', checked: prefs.nightPaper, onSelect: () => store.update({ nightPaper: !prefs.nightPaper }) },
          { heading: '素材与图层' },
          { icon: 'sticker', label: '常用元素库', hint: savedElements.length ? `已收藏 ${savedElements.length} 项` : '收藏常用图形与公式', onSelect: () => window.requestAnimationFrame(() => { const anchor = layer?.querySelector<HTMLElement>('[data-anchor="toolbox"]') ?? topRightAnchor.current; if (anchor) pop.set({ id: 'elements', anchor }); }) },
          !reading && { icon: 'layers', label: '图层与编组', hint: '调整前后层级、组合与锁定', onSelect: () => window.requestAnimationFrame(() => { const anchor = layer?.querySelector<HTMLElement>('[data-anchor="toolbox"]') ?? topRightAnchor.current; if (anchor) pop.set({ id: 'layers', anchor }); }) },
        ]}/>
      </Popover>}
      {pop.open === 'cards' && <Popover anchor={pop.anchor} onClose={pop.close} label="画布卡片" align="end" className="ink-mixed-popover">
        <CardsPanel elements={boardElements} selected={body.current?.selected() ?? []} busy={textBusy || !!editingCard}
          onInsertText={() => insertCard('text')} onInsertInk={() => insertCard('ink')} onEdit={editCard} onRefresh={refreshCard}
          onRecover={recoverCard} onReveal={showCard} onConnect={connectSelection} onGroup={() => groupSelection()} onUngroup={() => groupSelection(true)}/>
      </Popover>}
      {pop.open === 'mixed' && <Popover anchor={pop.anchor} onClose={pop.close} label="文字段落" align="end" className="ink-mixed-popover">
        <MixedPanel elements={mixedElements} busy={textBusy} selectionCount={selectedInk().length} readOnly={reading} paged={paged}
          onInsert={insertParagraph} onRefresh={refreshParagraphs}
          onEdit={e => { pop.close(); setSidebar(false); runText(() => host.text.edit(textReference(e)!)); }}
          onAttach={e => attachInk(e)} onDetach={() => attachInk()} onMove={reorderParagraph}
          onRemove={e => runText(async () => { await applyMixed(currentPageId, elements => detachParagraph(elements, e.id)); toast.show({ kind: 'info', message: '段落已移除，笔迹保留在原位', action: { label: '撤销', run: () => undo() } }); })}/>
      </Popover>}
      {pop.open === 'pdf-text' && <Popover anchor={pop.anchor} onClose={pop.close} label="PDF 原文文字" align="end" className="ink-pdf-text-popover">
        <div className="ink-popover-title">第 {pdfText.page} 页文字</div>
        <p className="ink-popover-note">{pdfText.loading ? '正在提取此页文字…' : '选中需要的文字即可复制。'}</p>
        <textarea readOnly data-autofocus aria-label="PDF 原文文字" aria-busy={pdfText.loading} value={pdfText.text} placeholder={pdfText.loading ? '正在读取…' : '这一页没有可提取的文字，可能是扫描件。'}/>
      </Popover>}
      {pop.open === 'export' && <Popover anchor={pop.anchor} onClose={pop.close} label="导出" align="end" className="ink-export">
        <div className="ink-popover-title">导出</div>
        <div className="ink-field"><span>PDF 纸张</span><Segmented label="PDF 纸张" value={paper} onChange={setPaper} options={[{ value: 'original', label: '原尺寸' }, { value: 'a4', label: 'A4' }, { value: 'letter', label: 'Letter' }]}/></div>
        {!paged && paper !== 'original' && <div className="ink-export-tile"><Switch label="大图自动分页平铺" hint="适合打印输出" checked={exportTile} onChange={setExportTile}/></div>}
        <Menu onDone={() => {}} items={paged ? [
          { icon: 'pdf', label: manifest.pdf ? '批注版 PDF' : 'PDF', hint: `全部 ${manifest.pages.length} 页`, onSelect: () => run(() => exportDocument('pdf')) },
          { icon: 'page', label: '当前页 PDF', hint: `第 ${currentIndex + 1} 页`, onSelect: () => run(() => exportDocument('pdf', 'page')) },
          { icon: 'image', label: '当前页图片', hint: 'PNG', onSelect: () => run(() => exportDocument('png', 'page')) },
          'separator',
          { icon: 'package', label: '可编辑备份', hint: '.inkpack，可恢复编辑（含草稿纸与原 PDF）', onSelect: () => run(() => exportDocument('package')) },
        ] : [
          { icon: 'pdf', label: 'PDF', hint: '整张画布的全部内容', onSelect: () => run(() => exportDocument('pdf')) },
          { icon: 'image', label: '图片', hint: 'PNG，透明背景', onSelect: () => run(() => exportDocument('png')) },
          'separator',
          { icon: 'package', label: '可编辑备份', hint: '.inkpack，可恢复编辑（含草稿纸）', onSelect: () => run(() => exportDocument('package')) },
        ]}/>
        <p className="ink-popover-note">文件保存在库内「Drawing Exports」文件夹。</p>
      </Popover>}
      {pop.open === 'page-menu' && menuPage && <Popover anchor={pop.anchor} onClose={pop.close} label="页面操作"><Menu items={pageMenu(menuPage, pop.anchor)} onDone={pop.close}/></Popover>}
      {pop.open === 'bookmark-menu' && menuRegion && <Popover anchor={pop.anchor} onClose={pop.close} label="书签操作" align="end"><Menu onDone={pop.close} items={[
        { icon: 'link', label: '复制链接', hint: '粘贴到笔记中，点击即可跳转', onSelect: () => copyLink({ page: menuRegion.pageId, region: menuRegion.id }) },
        { icon: 'embed', label: '复制嵌入代码', hint: '在 Markdown 中显示这块区域的预览', onSelect: () => copyLink({ page: menuRegion.pageId, region: menuRegion.id, embed: true }) },
        { icon: 'pen', label: '重命名', onSelect: () => setRenaming(menuRegion.id) },
        'separator',
        { icon: 'trash', label: '删除书签', danger: true, onSelect: () => session.editLayout(() => { manifest.regions = manifest.regions.filter(r => r.id !== menuRegion.id); }) },
      ]}/></Popover>}
      {pop.open === 'page-settings' && menuPage && <Popover anchor={pop.anchor} onClose={pop.close} label="纸张设置" align="end" className="ink-page-settings">
        <PageSettings page={menuPage} paged={paged} pageNumber={indexOf(menuPage.id) + 1} onTemplate={(template, all) => setTemplate(all ? manifest.pages.map(p => p.id) : [menuPage.id], template)}
          onMargins={(margins, all) => setMargins(all ? manifest.pages.map(p => p.id) : [menuPage.id], margins)} onDefault={template => store.update({ newTemplate: template })} defaultTemplate={prefs.newTemplate}/>
      </Popover>}
      {(pop.open === 'zoom' || pop.open === 'scratch-zoom') && <Popover anchor={pop.anchor} onClose={pop.close} label={pop.open === 'scratch-zoom' ? '草稿纸缩放' : '缩放'}><Menu onDone={pop.close} items={([
        ['zoomIn', '放大', 'in'], ['zoomOut', '缩小', 'out'], ['fit', '100%', 'actual'],
        ...(paged && pop.open === 'zoom' ? [['fitWidth', '适合宽度', 'fitWidth'], ['page', '适合整页', 'fitPage']] : [['fit', '显示全部内容', 'fitAll']]),
      ] as [string, string, ZoomAction][]).map(([icon, label, action]) => ({ icon, label, onSelect: () => (pop.open === 'scratch-zoom' ? scratch.current : body.current)?.zoom(action) }))}/></Popover>}
      {pop.open === 'jump' && <Popover anchor={pop.anchor} onClose={pop.close} label="跳转页面" align="end" className="ink-jump">
        <form onSubmit={event => { event.preventDefault(); const n = Number(new FormData(event.currentTarget).get('page')); const page = manifest.pages[n - 1]; if (page) { goToPage(page.id); pop.close(); } }}>
          <label>跳到第 <input name="page" type="number" min={1} max={manifest.pages.length} defaultValue={currentIndex + 1} data-autofocus onFocus={event => event.currentTarget.select()}/> 页</label>
          <button type="submit" className="mod-cta">前往</button>
        </form>
      </Popover>}
      {pop.open === 'elements' && <Popover anchor={pop.anchor} onClose={pop.close} label="常用元素库" align="end" className="ink-elements-popover">
        <ElementsPanel items={savedElements} dark={!paged && theme === 'dark'} canSave={reading ? !!(scratchOpen && scratchSelection) : !!selection} onSaveCurrent={saveSelectionToLibrary} onInsert={insertLibraryItem} onRemove={id => run(() => host.elements.remove(id))}/>
      </Popover>}
      {pop.open === 'layers' && <Popover anchor={pop.anchor} onClose={pop.close} label="图层与编组" align="end" className="ink-layers-popover">
        <LayersPanel elements={body.current?.elements(paged ? currentPageId : undefined) ?? mixedElements} pageLabel={paged ? `第 ${currentIndex + 1} 页` : undefined}
          selectedIds={selection?.ids ?? []}
          canGroup={selection?.canGroup ?? false} grouped={selection?.grouped ?? false} locked={selection?.locked ?? false} readOnly={reading}
          onSelect={ids => { body.current?.selectIds(ids); }}
          onOrder={(ids, action) => orderSelection(action, ids)}
          onGroup={ids => groupSelection(false, ids)}
          onUngroup={ids => groupSelection(true, ids)}
          onLock={(ids, nextLocked) => lockSelection(nextLocked, ids)}
          onUnlockAll={unlockAllSelection}/>
      </Popover>}
      {pop.open === 'selection-color' && selection && <Popover anchor={pop.anchor} onClose={pop.close} label="选区样式" align="center" className="ink-style-popover">
        {!selection.allImages && <>
          <div className="ink-popover-subtitle">颜色</div>
          <Swatches colors={PEN_COLORS} value={selection.strokeColor ?? PEN_COLORS[0]} custom onChange={color => selectionActions.restyle({ strokeColor: color })} label="改为颜色"/>
        </>}
        {selection.hasStrokeWidth && <>
          <div className="ink-popover-subtitle">粗细</div>
          <div className="ink-chip-row">{PEN_WIDTHS.map(w => <button key={w} type="button" aria-pressed={selection.strokeWidth === w} onClick={() => selectionActions.restyle({ strokeWidth: w })}>{w}px</button>)}</div>
        </>}
        {selection.hasStrokeStyle && <>
          <div className="ink-popover-subtitle">线型</div>
          <div className="ink-chip-row">{([['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线']] as const).map(([style, label]) => <button key={style} type="button" aria-pressed={selection.strokeStyle === style} onClick={() => selectionActions.restyle({ strokeStyle: style })}>{label}</button>)}</div>
        </>}
        {selection.hasFill && <>
          <div className="ink-popover-subtitle">填充</div>
          <Swatches colors={SHAPE_FILLS} value={selection.backgroundColor ?? 'transparent'} allowTransparent custom onChange={backgroundColor => selectionActions.restyle({ backgroundColor })} label="填充颜色"/>
        </>}
        <div className="ink-popover-subtitle">透明度</div>
        <div className="ink-chip-row">{([100, 70, 35] as const).map(op => <button key={op} type="button" aria-pressed={selection.opacity === op} onClick={() => selectionActions.restyle({ opacity: op })}>{op}%</button>)}</div>
      </Popover>}
      {pop.open === 'selection-layers' && selection && <Popover anchor={pop.anchor} onClose={pop.close} label="图层与编组" align="center"><Menu onDone={pop.close} items={[
        { icon: 'bringFront', label: '置于顶层', hint: 'Ctrl+Shift+]', onSelect: () => selectionActions.order('front') },
        { icon: 'moveUp', label: '上移一层', hint: 'Ctrl+]', onSelect: () => selectionActions.order('forward') },
        { icon: 'moveDown', label: '下移一层', hint: 'Ctrl+[', onSelect: () => selectionActions.order('backward') },
        { icon: 'sendBack', label: '置于底层', hint: 'Ctrl+Shift+[', onSelect: () => selectionActions.order('back') },
        'separator',
        selection.canGroup && { icon: 'group', label: '组合所选', hint: 'Ctrl+G · 合并为一个整体', onSelect: selectionActions.group },
        selection.grouped && { icon: 'ungroup', label: '拆分组合', hint: 'Ctrl+Shift+G · 拆回独立笔迹', onSelect: selectionActions.ungroup },
        { icon: selection.locked ? 'unlock' : 'lock', label: selection.locked ? '解锁所选' : '锁定所选', hint: 'Ctrl+Shift+L · 防止误擦或误移', onSelect: selectionActions.toggleLock },
      ]}/></Popover>}
      {pop.open === 'selection-more' && selection && <Popover anchor={pop.anchor} onClose={pop.close} label="更多选区操作" align="center"><Menu onDone={pop.close} items={[
        { icon: 'copy', label: '跨笔记复制', hint: 'Ctrl+C', onSelect: () => copySelectedToClipboard('body') },
        { icon: 'saveSticker', label: '存为常用元素', hint: '跨笔记一键复用', onSelect: saveSelectionToLibrary },
        'separator',
        selection.canGroup && { icon: 'group', label: '组合所选', hint: 'Ctrl+G', onSelect: selectionActions.group },
        selection.grouped && { icon: 'ungroup', label: '拆分组合', hint: 'Ctrl+Shift+G', onSelect: selectionActions.ungroup },
        { icon: selection.locked ? 'unlock' : 'lock', label: selection.locked ? '解锁所选' : '锁定所选', hint: 'Ctrl+Shift+L', onSelect: selectionActions.toggleLock },
        'separator',
        { icon: 'bookmark', label: paged ? '为这块区域加书签' : '加书签', onSelect: selectionActions.bookmark },
        { icon: 'image', label: '导出所选为图片', hint: 'PNG，透明背景', onSelect: () => run(() => exportDocument('png', 'selection')) },
        { icon: 'pdf', label: '导出所选为 PDF', hint: '矢量，只含所选内容', onSelect: () => run(() => exportDocument('pdf', 'selection')) },
      ]}/></Popover>}
    </div>
  </LayerContext.Provider>;
}

function SelectionBar({ views, selection, onDuplicate, onToggleTape, onRemove, onScratch, onLayers, onColor, onMore, onSource }: {
  views: ViewStore; selection: SelectionInfo; onDuplicate: () => void; onToggleTape?: () => void; onRemove: () => void; onScratch: () => void;
  onLayers: (anchor: HTMLElement) => void; onColor: (anchor: HTMLElement) => void; onMore: (anchor: HTMLElement) => void; onSource?: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 260, height: 42 });
  useLayoutEffect(() => {
    const element = bar.current; if (!element) return;
    const measure = () => setSize({ width: element.offsetWidth, height: element.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect();
  }, []);
  const r = selection.rect;
  const place = useView(views, (v: View) => {
    const [x, top] = toScreen(v, r.x + r.width / 2, r.y), [, bottom] = toScreen(v, 0, r.y + r.height);
    return `${Math.round(x)},${Math.round(top)},${Math.round(bottom)},${Math.round(v.width)},${Math.round(v.height)}`;
  });
  const [x, top, bottom, width, height] = place.split(',').map(Number);
  const above = top > size.height + 18, y = above ? top - size.height - 10 : Math.min(bottom + 14, height - size.height - 8);
  const half = size.width / 2;
  const onToolbarKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!buttons.length) return;
    event.preventDefault(); event.stopPropagation();
    const doc = event.currentTarget.ownerDocument;
    const index = Math.max(0, buttons.indexOf(doc.activeElement as HTMLButtonElement));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  return <div ref={bar} className="ink-selection-bar" role="toolbar" aria-label={`已选中 ${selection.ids.length} 个对象`} onKeyDown={onToolbarKeyDown} style={{ left: Math.max(half + 8, Math.min(x, width - half - 8)), top: Math.max(8, y) }}>
    <IconButton icon="duplicate" label="复制一份" onClick={onDuplicate}/>
    <IconButton icon="drop" label="颜色与样式" onClick={event => onColor(event.currentTarget)}/>
    <IconButton icon="layers" label="图层顺序" onClick={event => onLayers(event.currentTarget)}/>
    <IconButton icon="scratch" label="复制到草稿纸" onClick={onScratch}/>
    {onToggleTape && <IconButton icon={selection.tapeRevealed ? 'eyeOff' : 'eye'} label={selection.tapeRevealed ? '重新遮盖胶带' : '揭开胶带'} onClick={onToggleTape}/>}
    {onSource && <IconButton icon="locate" label="查看出处" onClick={onSource}/>}
    <IconButton icon="more" label="更多选区操作" onClick={event => onMore(event.currentTarget)}/>
    <span className="ink-divider" aria-hidden="true"/>
    <IconButton icon="trash" label="删除" className="is-danger" onClick={onRemove}/>
  </div>;
}

function ZoomControls({ views, label = '缩放', fitLabel, zoomLock, onToggleZoomLock, onZoom, onFit }: {
  views: ViewStore; label?: string; fitLabel: string; zoomLock?: boolean; onToggleZoomLock?: () => void; onZoom: (anchor: HTMLElement) => void; onFit: () => void;
}) {
  const zoom = useView(views, v => Math.round(v.zoom * 100));
  return <div className="ink-view-group">
    <IconButton icon={fitLabel === '适合宽度' ? 'fitWidth' : 'fit'} label={fitLabel} onClick={onFit}/>
    <button type="button" className="ink-zoom-value" aria-label={`${label} ${zoom}%`} onClick={event => onZoom(event.currentTarget)}>{zoom}%<InkIcon name="down"/></button>
    {onToggleZoomLock && <IconButton icon={zoomLock ? 'pin' : 'pinOff'} label={zoomLock ? '已锁定缩放（点击解锁）' : '锁定缩放与防横向漂移'} aria-pressed={zoomLock} className="ink-zoom-lock" onClick={onToggleZoomLock}/>}
  </div>;
}

function ViewControls({ views, paged, pageCount, pageIndex, zoomLock, onToggleZoomLock, onZoom, onJump, onStep, onFit, onBookmark, onAdd, reading }: {
  views: ViewStore; paged: boolean; pageCount: number; pageIndex: number; zoomLock: boolean; onToggleZoomLock: () => void;
  onZoom: (anchor: HTMLElement) => void; onJump: (anchor: HTMLElement) => void;
  onStep: (delta: number) => void; onFit: () => void; onBookmark: () => void; onAdd: () => void; reading: boolean;
}) {
  // Bottom-left: Obsidian's status bar floats over the bottom-right corner.
  return <div className="ink-view-controls">
    <ZoomControls views={views} fitLabel={paged ? '适合宽度' : '显示全部内容'} zoomLock={zoomLock} onToggleZoomLock={onToggleZoomLock} onZoom={onZoom} onFit={onFit}/>
    {paged ? <div className="ink-view-group">
      <IconButton icon="left" label="上一页" disabled={pageIndex === 0} onClick={() => onStep(-1)}/>
      <button type="button" className="ink-page-number" aria-label={`第 ${pageIndex + 1} 页，共 ${pageCount} 页，点击跳转`} onClick={event => onJump(event.currentTarget)}>{pageIndex + 1}<span>/ {pageCount}</span></button>
      <IconButton icon="right" label="下一页" disabled={pageIndex === pageCount - 1} onClick={() => onStep(1)}/>
      {!reading && <IconButton icon="pageAdd" label="在当前页后添加" onClick={onAdd}/>}
    </div> : <div className="ink-view-group"><IconButton icon="bookmark" label="保存当前视野" className="ink-labelled" onClick={onBookmark}><span>保存视野</span></IconButton></div>}
  </div>;
}

const MARGIN_PRESETS: { label: string; margins: Margins }[] = [
  { label: '无', margins: { top: 0, right: 0, bottom: 0, left: 0 } },
  { label: '窄', margins: { top: 24, right: 24, bottom: 24, left: 24 } },
  { label: '宽', margins: { top: 64, right: 64, bottom: 64, left: 64 } },
  { label: '右侧笔记栏', margins: { top: 0, right: 280, bottom: 0, left: 0 } },
];
function PageSettings({ page, paged, pageNumber, onTemplate, onMargins, onDefault, defaultTemplate }: {
  page: Page; paged: boolean; pageNumber: number; onTemplate: (template: PageTemplate, all: boolean) => void; onMargins: (margins: Margins, all: boolean) => void;
  onDefault: (template: PageTemplate) => void; defaultTemplate: PageTemplate;
}) {
  const [all, setAll] = useState(false);
  const same = (a: Margins, b: Margins) => (Object.keys(a) as (keyof Margins)[]).every(k => Math.round(a[k]) === Math.round(b[k]));
  return <div className="ink-settings">
    <div className="ink-popover-title">{paged ? `第 ${pageNumber} 页` : '画布样式'}</div>
    {!page.pdfPage && <div className="ink-templates" role="radiogroup" aria-label="纸张样式" onKeyDown={radioKeys}>{TEMPLATES.map(t =>
      <button key={t.id} type="button" role="radio" tabIndex={page.template === t.id ? 0 : -1} aria-checked={page.template === t.id} onClick={() => { onTemplate(t.id, all && paged); if (paged) onDefault(t.id); }}>
        <span className="ink-template-swatch" style={paperStyle(t.id)}/>{t.label}
      </button>)}</div>}
    {page.pdfPage && <p className="ink-popover-note">PDF 页面保持原样；可以加留白，在页边写笔记。</p>}
    {paged && <>
      <div className="ink-popover-subtitle">页边距</div>
      <div className="ink-chip-row">{MARGIN_PRESETS.map(p => <button key={p.label} type="button" aria-pressed={same(page.margins, p.margins)} onClick={() => onMargins(p.margins, all)}>{p.label}</button>)}</div>
      <div className="ink-margins">{(['top', 'right', 'bottom', 'left'] as const).map((edge, i) => <label key={edge}><span>{'上右下左'[i]}</span>
        <input type="number" min={0} step={8} value={Math.round(page.margins[edge])} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 0) onMargins({ ...page.margins, [edge]: value }, all); }}/></label>)}</div>
      <div className="ink-check"><Switch label="同时应用到所有页面" checked={all} onChange={setAll}/></div>
      {!page.pdfPage && <p className="ink-popover-note">新页面默认使用「{TEMPLATES.find(t => t.id === defaultTemplate)?.label}」。</p>}
    </>}
  </div>;
}

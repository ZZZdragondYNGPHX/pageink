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
import { Popover, Menu, MenuEntry, Segmented, Swatches, Toasts, useAnchor, useToasts, LayerContext } from './ui';
import { ToolShelf, SHORTCUTS } from './Toolbar';
import { ToolDock } from './ToolDock';
import type { InkApi } from './kernel-api';
import { imageFile, readDataURL } from './binary';
import { BookmarkList, PageList, SearchPanel, SidebarTabs } from './Sidebar';
import { ScratchWindow } from './Scratch';
import { PEN_COLORS, Preferences, SidebarTab, ToolId } from './preferences';
import { ViewStore, View, useView, toScreen, sceneViewport } from './view';
import { TEMPLATES, paperStyle } from './templates';
import type { WorkspaceHost } from './host';
import type { SearchHit } from './search';
import { toArrayBuffer } from './model';
import { MixedPanel } from './MixedPanel';
import { detachParagraph, moveParagraph, reflowParagraphs, revised, textReference, type TextReference } from './mixed';
import { preserveText, projectParagraph } from './mixed-render';
import type { SourceParagraph } from './mixed-host';
import { cardReference, cardText } from './cards';
import { connectCards, inkCard, refreshTextCards, textCard } from './cards-render';
import { CardEditor, CardsPanel } from './CardsPanel';

export interface WorkspaceProps { session: Session; pdf?: PdfService; host: WorkspaceHost }
type PopoverId = 'export' | 'more' | 'page-settings' | 'zoom' | 'jump' | 'page-menu' | 'bookmark-menu' | 'selection-color' | 'selection-export' | 'pdf-text' | 'mixed' | 'cards';

/** Kernel settings for a tool; a pending bookmark marquee temporarily overrides the tool. */
function canvasTool(tool: ToolId, prefs: Preferences, marquee: CanvasTool['marquee'] | null): CanvasTool {
  const base: CanvasTool = { kernel: 'selection', color: prefs.pen.color, width: prefs.pen.width, opacity: 100, fontSize: prefs.text.size, pressure: false };
  if (marquee) return { ...base, kernel: 'hand', marquee };
  switch (tool) {
    case 'pen': return { ...base, kernel: 'freedraw', pressure: prefs.pen.pressure, scribble: prefs.pen.scribble };
    case 'highlighter': return { ...base, kernel: 'freedraw', color: prefs.highlighter.color, width: prefs.highlighter.width, opacity: 35 };
    case 'eraser': return { ...base, kernel: 'hand', erase: { whole: prefs.eraser.mode === 'stroke', radius: prefs.eraser.size } };
    case 'lasso': return { ...base, marquee: { shape: 'lasso', purpose: 'select' } };
    case 'select': return base;
    case 'hand': return { ...base, kernel: 'hand' };
    case 'text': return { ...base, kernel: 'text', color: prefs.text.color };
    case 'shape': return { ...base, kernel: prefs.shape.kind, color: prefs.shape.color, width: prefs.shape.width };
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
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { session.listeners.add(rerender); return () => { session.listeners.delete(rerender); }; }, []);
  useEffect(() => {
    const doc = area.current!.ownerDocument, win = doc.defaultView!;
    const save = () => { void session.flush().catch(() => {}); };
    const hidden = () => { if (doc.visibilityState === 'hidden') save(); };
    doc.addEventListener('visibilitychange', hidden); win.addEventListener('pagehide', save);
    return () => { doc.removeEventListener('visibilitychange', hidden); win.removeEventListener('pagehide', save); };
  }, [session]);
  const manifest = session.manifest, paged = manifest.mode === 'pages';
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const area = useRef<HTMLDivElement>(null), [areaSize, setAreaSize] = useState({ width: 800, height: 600 });
  const [tool, setToolState] = useState<ToolId>(() => prefs.tool === 'capture' && !pdf ? 'pen' : prefs.tool);
  const [marquee, setMarquee] = useState<CanvasTool['marquee'] | null>(null);
  const [sidebar, setSidebar] = useState(() => paged ? prefs.sidebar.pages && window.innerWidth >= 960 : prefs.sidebar.canvas);
  const [tab, setTab] = useState<SidebarTab>(() => !paged && prefs.sidebar.tab === 'pages' ? 'bookmarks' : prefs.sidebar.tab);
  const [scratchOpen, setScratchOpen] = useState(false);
  const [focus, setFocus] = useState(false);
  const [reading, setReading] = useState(false);
  const [compact, setCompact] = useState(false);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [scratchSelection, setScratchSelection] = useState<SelectionInfo | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [theme, setTheme] = useState(host.theme());
  const [views, setViews] = useState<ViewStore>(EMPTY_VIEWS);
  const [resolving, setResolving] = useState(false);
  const [textBusy, setTextBusy] = useState(false);
  const textTask = useRef(false);
  const [editingCard, setEditingCard] = useState<{ root: Element; source: SourceParagraph; reference: TextReference } | null>(null);
  const [paper, setPaper] = useState<NonNullable<PdfExportOptions['paper']>>('original');
  const [pdfText, setPdfText] = useState({ page: 1, text: '' });
  const pop = useAnchor<PopoverId>();
  const toast = useToasts();
  const body = useRef<CanvasHandle | null>(null), scratch = useRef<CanvasHandle | null>(null);
  const scratchWaiters = useRef<((handle: CanvasHandle) => void)[]>([]);
  const savingShown = useDelayed(session.saveState === 'saving', 700);

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
  const setTool = (next: ToolId) => { setReading(false); setMarquee(null); setToolState(next); if (next !== 'capture') store.update({ tool: next }); };
  const bodyTool = useMemo(() => canvasTool(reading ? 'hand' : tool, prefs, reading ? null : marquee), [tool, prefs, marquee, reading]);
  const scratchTool = useMemo(() => canvasTool(tool === 'capture' ? 'select' : tool, prefs, null), [tool, prefs]);
  const pagesKey = manifest.pages.map(p => [p.id, p.width, p.height, p.template, p.pdfPage ?? 0, p.margins.top, p.margins.right, p.margins.bottom, p.margins.left].join(':')).join('|');
  const currentPageId = useView(views, () => body.current && views !== EMPTY_VIEWS ? body.current.currentPage().page.id : manifest.pages[0].id);
  const currentIndex = Math.max(0, manifest.pages.findIndex(p => p.id === currentPageId));
  const currentPage = manifest.pages[currentIndex];
  const goToPage = (id: string) => { body.current?.reveal(id); if (compact) setSidebar(false); };
  const toggleReading = () => {
    setMarquee(null); pop.close(); body.current?.clearSelection(); setReading(value => !value);
  };

  // ---------- history ----------
  async function step(surface: 'body' | 'scratch', redo: boolean) {
    const handle = surface === 'scratch' ? scratch.current : body.current; if (!handle) return;
    await handle.flush();
    const timeline = surface === 'scratch' ? session.scratchHistory : session.bodyHistory;
    const change = redo ? timeline.redo() : timeline.undo(); if (!change) return;
    if (change.layout) { Object.assign(manifest, structuredClone(change.layout)); session.metadataChanged(); }
    for (const part of change.parts) { await session.load(part.surface); session.change(part.surface, part.elements, false); }
    await handle.rebuild();
    if (surface === 'body' && paged && change.parts.length && !change.parts.some(p => p.surface === handle.currentPage().page.id)) handle.reveal(change.parts[0].surface);
  }
  const undo = (surface: 'body' | 'scratch' = 'body') => run(() => step(surface, false));
  const redo = (surface: 'body' | 'scratch' = 'body') => run(() => step(surface, true));

  // ---------- pages ----------
  async function editPages(edit: () => void, reveal?: string) {
    await body.current?.flush();
    session.editLayout(edit);
    await body.current?.rebuild();
    if (reveal) body.current?.reveal(reveal);
  }
  const indexOf = (id: string) => manifest.pages.findIndex(p => p.id === id);
  function addPage(after = manifest.pages[manifest.pages.length - 1].id) {
    const like = manifest.pages[indexOf(after)] ?? manifest.pages[manifest.pages.length - 1];
    const page = newPage({ width: like.width, height: like.height, margins: like.margins, template: like.pdfPage ? prefs.newTemplate : like.template });
    run(() => editPages(() => manifest.pages.splice(indexOf(after) + 1, 0, page), page.id));
  }
  function duplicatePage(id: string) {
    run(async () => {
      await body.current?.flush();
      const source = manifest.pages[indexOf(id)], copy: Page = { ...structuredClone(source), id: uid() };
      session.change(copy.id, cloneElements(await session.load(id), 0, 0), false);
      await editPages(() => manifest.pages.splice(indexOf(id) + 1, 0, copy), copy.id);
    });
  }
  function deletePage(id: string) {
    if (manifest.pages.length <= 1) return;
    const number = indexOf(id) + 1;
    run(async () => {
      await editPages(() => { manifest.pages.splice(indexOf(id), 1); manifest.regions = manifest.regions.filter(r => r.pageId !== id); });
      toast.show({ kind: 'info', message: `已删除第 ${number} 页`, action: { label: '撤销', run: () => undo() } });
    });
  }
  const movePage = (id: string, delta: number) => run(() => editPages(() => { const i = indexOf(id), [page] = manifest.pages.splice(i, 1); manifest.pages.splice(Math.max(0, Math.min(manifest.pages.length, i + delta)), 0, page); }, id));
  const setTemplate = (ids: string[], template: PageTemplate) => run(() => editPages(() => { for (const p of manifest.pages) if (ids.includes(p.id) && !p.pdfPage) p.template = template; }));
  function setMargins(ids: string[], margins: Margins) {
    run(async () => {
      await body.current?.flush();
      let clamped = false;
      const next = new Map<string, Margins>();
      for (const p of manifest.pages) if (ids.includes(p.id)) {
        const m = constrainMargins(p, margins, (await session.read(p.id)).filter(e => !e.isDeleted));
        clamped ||= (Object.keys(m) as (keyof Margins)[]).some(k => Math.round(m[k]) !== Math.round(margins[k]));
        next.set(p.id, m);
      }
      await editPages(() => { for (const p of manifest.pages) if (next.has(p.id)) p.margins = next.get(p.id)!; });
      if (clamped) toast.show({ kind: 'info', message: '已有笔迹的一侧保留了足够留白，避免裁掉内容' });
    });
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
      body.current?.reveal(pageId, { x: placed.x, y: placed.y, width, height: placed.height });
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
  const showCard = (e: Element) => { pop.close(); body.current?.reveal(manifest.pages[0].id, e); };
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
  function groupSelection(ungroup = false) {
    const selected = body.current?.selected() ?? [], group = uid();
    const outer = new Set(selected.flatMap(e => e.groupIds.length ? [e.groupIds.at(-1)!] : []));
    run(() => body.current?.replaceSelected(e => ({ ...e, groupIds: ungroup ? e.groupIds.filter(id => !outer.has(id)) : [...e.groupIds, group] })));
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
  const openRegion = (region: Region) => body.current?.reveal(region.pageId, region, true);
  const bookmarkView = () => { if (body.current) addBookmark(sceneViewport(body.current.views.get())); };
  const renameRegion = (region: Region, title: string | null) => {
    setRenaming(null);
    const value = title?.trim();
    if (value && value !== region.title) session.editLayout(() => { const r = manifest.regions.find(item => item.id === region.id); if (r) r.title = value; });
  };

  // ---------- scratch ----------
  const scratchHandle = async () => {
    const handle = scratch.current ?? await new Promise<CanvasHandle>(resolve => scratchWaiters.current.push(resolve));
    // The editor stays mounted while hidden. Wait for its opened viewport before placing or fitting content.
    const visible = () => { const v = handle.views.get(); return v.width > 0 && v.height > 0; };
    if (!visible()) await new Promise<void>(resolve => {
      const unsubscribe = handle.views.subscribe(() => { if (visible()) { unsubscribe(); resolve(); } });
    });
    return handle;
  };
  async function toScratch(elements: readonly Element[], at?: ScenePoint) {
    setScratchOpen(true);
    const handle = await scratchHandle();
    await handle.insert(elements, at);
  }
  async function toBody() {
    const items = scratch.current?.selected() ?? []; if (!items.length || !body.current) return;
    await body.current.insert(items); setTool('select');
    toast.show({ kind: 'success', message: `已复制到${paged ? '当前页' : '画布'}，可拖动调整位置` });
  }

  // ---------- marquee results ----------
  async function capture(points: ScenePoint[]) {
    const handle = body.current; if (!handle) return;
    const box = polygonBounds(points), placement = placementAt(handle.layout(), box.y + box.height / 2);
    const local = points.map(([x, y]) => [x - placement.x, y - placement.y] as ScenePoint);
    const task = new AbortController();
    const id = toast.show({ kind: 'progress', message: '正在摘录…', cancel: () => task.abort() });
    try {
      await handle.flush();
      const { element } = await capturePdf(session, pdf, placement.page, local, prefs.capture.annotations, task.signal);
      setScratchOpen(true);
      const target = await scratchHandle(), existing = target.api.getSceneElements();
      const right = existing.reduce((max, e) => Math.max(max, e.x + e.width), -Infinity);
      const top = existing.length ? Math.min(...existing.map(e => e.y)) : 0;
      await target.insert([element], existing.length ? [right + 32 + element.width / 2, top + element.height / 2] : undefined);
      target.zoom('fitAll');
      toast.dismiss(id); toast.show({ kind: 'success', message: '已摘录到草稿纸' });
    } catch (error) { toast.dismiss(id); throw error; }
  }
  const onMarquee = (points: ScenePoint[], purpose: string) => run(async () => {
    if (purpose === 'capture') return capture(points);
    if (purpose === 'bookmark') { setMarquee(null); addBookmark(polygonBounds(points)); }
  });

  // ---------- images ----------
  function chooseImage() {
    const input = createEl('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.onchange = () => run(async () => {
      const file = input.files?.[0], handle = body.current; if (!file || !handle) return;
      const dataURL = await readDataURL(file);
      const image = new Image(); image.src = dataURL; await image.decode();
      const v = handle.views.get(), fit = Math.min(1, (v.width / v.zoom) * 0.6 / image.naturalWidth, (v.height / v.zoom) * 0.6 / image.naturalHeight);
      const id = uid();
      await session.acceptFiles({ [id]: imageFile(id, dataURL, file.type) });
      await handle.insert(convertToExcalidrawElements([{ type: 'image', x: 0, y: 0, width: image.naturalWidth * fit, height: image.naturalHeight * fit, fileId: id as NonNullable<Extract<Element, { type: 'image' }>['fileId']> }]));
      setTool('select');
    });
    input.click();
  }

  // ---------- export ----------
  async function exportDocument(kind: 'pdf' | 'png' | 'package', scope: 'all' | 'page' | 'selection' = 'all') {
    pop.close();
    const task = new AbortController(), name = host.fileName();
    const label = kind === 'package' ? '备份' : kind === 'pdf' ? 'PDF' : '图片';
    const id = toast.show({ kind: 'progress', message: `正在导出${label}…`, cancel: kind === 'png' ? undefined : () => task.abort() });
    try {
      await session.flush();
      let bytes: ArrayBuffer, extension: string, detail = '';
      const progress = (done: number, total: number) => toast.update(id, { message: `正在导出${label} ${done}/${total}` });
      if (kind === 'package') { bytes = toArrayBuffer(await pack(session, progress, task.signal)); extension = 'inkpack'; detail = '包含正文、草稿纸、图片、原 PDF 与引用时的文字原件快照，可恢复编辑'; }
      else if (kind === 'pdf') {
        const options: PdfExportOptions = { paper, pages: scope === 'page' ? [currentPageId] : undefined, selection: scope === 'selection' ? body.current?.selected() : undefined };
        bytes = toArrayBuffer(await readingPdf(session, progress, task.signal, options)); extension = 'pdf';
      } else {
        const result = scope === 'selection' ? await png(session, body.current?.selected() ?? []) : paged ? await pagePng(session, currentPage, pdf, task.signal) : await png(session, await session.read(manifest.pages[0].id));
        bytes = await result.blob.arrayBuffer(); extension = 'png';
        if (result.scale < 2) detail = `内容较大，已按 ${result.scale.toFixed(1)} 倍分辨率导出`;
      }
      const suffix = scope === 'page' ? ` 第${currentIndex + 1}页` : scope === 'selection' ? ' 选区' : '';
      const path = await host.saveExport(name + suffix, extension, bytes);
      toast.dismiss(id);
      toast.show({ kind: 'success', message: `已导出到 ${path}`, detail, action: kind === 'package' ? undefined : { label: '打开', run: () => run(() => host.openFile(path)) } });
    } catch (error) { toast.dismiss(id); throw error; }
  }

  useEffect(() => host.connect({
    exportPdf: () => run(() => exportDocument('pdf')), exportPackage: () => run(() => exportDocument('package')),
    toggleScratch: () => setScratchOpen(open => !open), toggleFocus: () => setFocus(on => !on), search: () => { setSidebar(true); chooseTab('search'); },
  }));

  // ---------- navigation requests (links, embeds, sources) ----------
  const navigationToken = useRef('');
  useEffect(() => {
    const request = session.navigation, handle = body.current;
    if (!request || !handle || request.token === navigationToken.current) return;
    navigationToken.current = request.token;
    if (!manifest.pages.some(p => p.id === request.page)) { toast.show({ kind: 'error', message: '引用的页面已删除或尚未同步。' }); return; }
    const region = request.rect ?? manifest.regions.find(r => r.id === request.region);
    handle.reveal(request.page, region, !!region);
  });

  // ---------- selection actions ----------
  const selectionActions = {
    duplicate: () => run(async () => { const h = body.current!, items = h.selected(); const r = selection!.rect; await h.insert(items, [r.x + r.width / 2 + 24, r.y + r.height / 2 + 24]); }),
    remove: () => run(() => body.current?.replaceSelected(() => null)),
    recolor: (color: string) => run(() => body.current?.replaceSelected(e => e.type === 'image' ? e : { ...e, strokeColor: color })),
    toScratch: () => run(async () => { await toScratch(body.current!.selected()); toast.show({ kind: 'success', message: '已复制到草稿纸' }); }),
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
      if (key === 'f') { event.preventDefault(); event.stopPropagation(); setSidebar(true); setTab('search'); return; }
      if (key === 's') { event.preventDefault(); event.stopPropagation(); run(async () => { await session.flush(); toast.show({ kind: 'success', message: '已保存' }); }); return; }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape') { if (marquee) { setMarquee(null); event.stopPropagation(); } return; }
    if (paged && (event.key === 'PageDown' || event.key === 'PageUp') && body.current) {
      event.preventDefault(); const next = manifest.pages[currentIndex + (event.key === 'PageDown' ? 1 : -1)]; if (next) body.current.reveal(next.id); return;
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
  const copyPageText = (page: Page) => run(async () => {
    const text = (await pdf!.text(page)).map(t => t.str + (t.hasEOL ? '\n' : '')).join('').trim();
    if (!text) { toast.show({ kind: 'info', message: '这一页没有可提取的文字（可能是扫描件）' }); return; }
    await navigator.clipboard.writeText(text); toast.show({ kind: 'success', message: `已复制第 ${indexOf(page.id) + 1} 页文字（${text.length} 字）` });
  });
  const showPageText = (page: Page, anchor: HTMLElement | null) => run(async () => {
    const text = (await pdf!.text(page)).map(t => t.str + (t.hasEOL ? '\n' : ' ')).join('').trim();
    setPdfText({ page: indexOf(page.id) + 1, text });
    pop.set({ id: 'pdf-text', anchor: anchor?.isConnected ? anchor : layer!.querySelector<HTMLElement>('[data-anchor="more"]')! });
  });
  const openSettings = (id: string, anchor: HTMLElement | null) => {
    setTarget(id);
    window.requestAnimationFrame(() => pop.set({ id: 'page-settings', anchor: anchor?.isConnected ? anchor : layer!.querySelector<HTMLElement>('[data-anchor="more"]')! }));
  };
  const moreMenu: (MenuEntry | false)[] = [
    { icon: 'docText', label: '文字段落…', onSelect: () => window.requestAnimationFrame(() => pop.set({ id: 'mixed', anchor: layer!.querySelector<HTMLElement>('[data-anchor="more"]')! })) },
    paged ? { icon: 'sliders', label: '纸张与页边距…', onSelect: () => openSettings(currentPageId, pop.anchor) }
      : { icon: 'canvas', label: '画布样式…', onSelect: () => openSettings(manifest.pages[0].id, pop.anchor) },
    { icon: 'focus', label: '专注模式', hint: '隐藏侧栏和工具栏之外的界面', onSelect: () => { setFocus(true); setSidebar(false); } },
    !paged && { icon: 'bookmark', label: '将当前视野存为书签', onSelect: bookmarkView },
    { icon: 'finger', label: '用手指书写', hint: prefs.fingerDraws ? '手指书写，双指移动' : '目前手指只用于移动和缩放', checked: prefs.fingerDraws, onSelect: () => store.update({ fingerDraws: !prefs.fingerDraws }) },
    'separator',
    { icon: 'link', label: paged ? '复制本页链接' : '复制画布链接', onSelect: () => copyLink({ page: paged ? currentPageId : manifest.pages[0].id }) },
    !!(pdf && currentPage?.pdfPage) && { icon: 'docText', label: '复制本页文字', onSelect: () => copyPageText(currentPage) },
    !!(pdf && currentPage?.pdfPage) && { icon: 'text', label: '选择本页文字…', onSelect: () => showPageText(currentPage, pop.anchor) },
    !!manifest.pdf && { icon: 'relink', label: '重新关联原 PDF…', onSelect: () => host.relinkSource() },
    { icon: 'history', label: '历史版本…', hint: '把较早的保存恢复为副本', onSelect: () => host.showVersions() },
    { icon: 'sliders', label: '笔记属性…', onSelect: () => run(() => host.properties()) },
  ];

  const sidebarVisible = sidebar && !focus;
  const toggleSidebar = () => { const next = !sidebar; setSidebar(next); store.update({ sidebar: paged ? { pages: next } : { canvas: next } }); };
  const chooseTab = (next: SidebarTab) => { setTab(next); store.update({ sidebar: { tab: next } }); };
  const status = session.conflictPath ? null : session.saveState === 'failed'
    ? <button type="button" className="ink-save-failed" onClick={() => run(() => session.flush())}><InkIcon name="warning"/>保存失败 · 重试</button>
    : <span className="ink-save-state" role="status" aria-label={savingShown ? '正在保存' : session.saveState === 'saved' ? '已保存到本地' : '等待保存'} title={savingShown ? '正在保存' : session.saveState === 'saved' ? '已保存到本地' : '等待保存'}>{savingShown ? <span className="ink-spinner"/> : <InkIcon name={session.saveState === 'saved' ? 'check' : 'more'}/>}<span className="ink-save-label">{savingShown ? '正在保存' : session.saveState === 'saved' ? '已保存到本地' : '等待保存'}</span></span>;

  const topbar = <header className="ink-topbar">
    <div className="ink-topbar-start">
      {!focus && <IconButton icon="sidebar" label={sidebar ? '隐藏侧栏' : '显示侧栏'} aria-expanded={sidebarVisible} aria-controls={sidebarId} onClick={toggleSidebar}/>}
      {!reading && <div className="ink-history-tools" role="group" aria-label="编辑历史">
        <IconButton icon="undo" label="撤销" shortcut="Ctrl+Z" disabled={!session.bodyHistory.canUndo} onClick={() => undo()}/>
        <IconButton icon="redo" label="重做" shortcut="Ctrl+Shift+Z" disabled={!session.bodyHistory.canRedo} onClick={() => redo()}/>
      </div>}
      {status}
    </div>
    <div className="ink-topbar-end">
      {paged && <IconButton icon={reading ? 'pen' : 'read'} label={reading ? '继续书写' : '阅读模式'} aria-pressed={reading} className="ink-labelled ink-reading-toggle" onClick={toggleReading}><span>{reading ? '书写' : '阅读'}</span></IconButton>}
      <IconButton icon="scratch" label="草稿纸" aria-pressed={scratchOpen} className="ink-labelled" onClick={() => setScratchOpen(v => !v)}><span>草稿纸</span></IconButton>
      {focus ? <IconButton icon="focus" label="退出专注" className="ink-labelled" aria-pressed onClick={() => setFocus(false)}><span>退出专注</span></IconButton> : <>
        <IconButton icon="search" label="搜索" shortcut="Ctrl+F" onClick={() => { setSidebar(true); chooseTab('search'); }}/>
        <IconButton icon="share" label="导出" className="ink-labelled" aria-expanded={pop.open === 'export'} onClick={event => pop.toggle('export', event.currentTarget)}><span>导出</span></IconButton>
        <IconButton icon="more" label="更多" data-anchor="more" aria-expanded={pop.open === 'more'} onClick={event => pop.toggle('more', event.currentTarget)}/>
      </>}
    </div>
  </header>;
  const tools = <ToolDock layer={layer} visible={!reading || scratchOpen} onDrag={pop.close}>
    <ToolShelf tool={tool} onTool={setTool} onImage={chooseImage} capture={!!pdf} prefs={prefs} store={store}/>
    <IconButton icon="docText" label="文字段落" aria-expanded={pop.open === 'mixed'} onClick={event => pop.toggle('mixed', event.currentTarget)}/>
    {!paged && <IconButton icon="canvas" label="画布卡片" aria-expanded={pop.open === 'cards'} disabled={!!editingCard} onClick={event => pop.toggle('cards', event.currentTarget)}/>}
  </ToolDock>;

  return <LayerContext.Provider value={layer}>
    <div ref={setLayer} className={`ink-workspace ink-mode-${manifest.mode}${focus ? ' is-focus' : ''}${reading ? ' is-reading' : ''}${sidebarVisible ? ' has-sidebar' : ''}`} onKeyDownCapture={onKeyDown}>
      {topbar}
      {tools}
      {session.conflictPath && <div className="ink-banner is-warning" role="alert"><InkIcon name="warning"/><span><strong>这个笔记在别处被修改过。</strong>你的内容已安全保留，自动保存已暂停。两种选择都不会丢失任何一方的内容。</span>
        <span className="ink-banner-actions">{([[true, '继续编辑我的版本（副本）'], [false, '打开外部版本']] as const).map(([copy, label]) =>
          <button key={label} type="button" disabled={resolving} onClick={() => run(async () => { setResolving(true); try { await host.resolveConflict(copy); } finally { setResolving(false); } })}>{label}</button>)}</span></div>}
      {session.sourceIssue && <div className="ink-banner" role="status"><InkIcon name="warning"/><span>原 PDF 暂不可用：{session.sourceIssue} 笔迹不受影响。</span><span className="ink-banner-actions"><button type="button" onClick={() => host.relinkSource()}>重新关联…</button></span></div>}
      <div className={`ink-body${scratchOpen && prefs.scratchPlacement === "docked" ? " has-docked-scratch" : ""}`}>
        {sidebarVisible && <>
        {compact && <button type="button" className="ink-sidebar-backdrop" aria-label="关闭侧栏" onClick={() => setSidebar(false)}/>}
        <aside className="ink-sidebar" id={sidebarId} aria-label="侧栏">
          <div className="ink-sidebar-heading"><strong>{tab === 'search' ? '搜索笔记' : tab === 'bookmarks' || !paged ? '书签' : '页面'}</strong><span>{tab === 'pages' && paged ? `${manifest.pages.length} 页` : tab === 'bookmarks' || !paged && tab !== 'search' ? `${manifest.regions.length} 个` : ''}</span>
            <IconButton icon="close" label="收起侧栏" onClick={toggleSidebar}/></div>
          <SidebarTabs tab={paged ? tab : tab === 'pages' ? 'bookmarks' : tab} onTab={chooseTab} paged={paged}/>
          {paged && tab === 'pages' && <PageList session={session} pdf={pdf} current={currentPageId} onSelect={goToPage} onAdd={() => addPage()} onMenu={(id, anchor) => { setTarget(id); pop.set({ id: 'page-menu', anchor }); }}/>}
          {(tab === 'bookmarks' || !paged && tab === 'pages') && <BookmarkList regions={manifest.regions} pageNumber={id => paged ? indexOf(id) + 1 : 0} onOpen={openRegion}
            onMenu={(region, anchor) => { setTarget(region.id); pop.set({ id: 'bookmark-menu', anchor }); }} onSaveView={paged ? undefined : bookmarkView}
            onAdd={() => { setReading(false); setMarquee({ shape: 'rect', purpose: 'bookmark' }); if (compact) setSidebar(false); }}
            renaming={renaming} onRename={renameRegion}/>}
          {tab === 'search' && <SearchPanel session={session} pdf={pdf} paged={paged} onOpen={(hit: SearchHit) => body.current?.reveal(hit.page, hit.rect, !!hit.rect)}/>}
        </aside></>}
        <div className="ink-surfaces" ref={area}>
        <main className="ink-canvas-area">
          <InkCanvas session={session} pdf={pdf} kind={paged ? 'pages' : 'canvas'} pagesKey={pagesKey} tool={bodyTool} fingerDraws={prefs.fingerDraws} theme={theme} readOnly={reading || !!editingCard}
            initialView={host.loadView()} ref={body}
            onReady={handle => { body.current = handle; setViews(handle.views); }}
            onError={message => toast.show({ kind: 'error', message })}
            onSelection={setSelection} onMarquee={onMarquee} onGesture={gesture => gesture === 'undo' ? undo() : redo()}
            onScribble={() => toast.show({ kind: 'info', message: '已涂划擦除', action: { label: '撤销', run: () => undo() } })}
            onCardEdit={!paged ? editCard : undefined}
            onAddPage={paged && !reading ? () => addPage() : undefined}
            onViewChange={() => { if (body.current) host.saveView(body.current.memory()); }}/>
          {selection && !selection.busy && !marquee && !reading && !editingCard && <SelectionBar views={views} selection={selection} paged={paged}
            onDuplicate={selectionActions.duplicate} onRemove={selectionActions.remove} onScratch={selectionActions.toScratch} onBookmark={selectionActions.bookmark}
            onColor={anchor => pop.set({ id: 'selection-color', anchor })} onExport={anchor => pop.set({ id: 'selection-export', anchor })}
            onSource={selection.source ? () => selectionActions.source(selection) : undefined}/>}
          {editingCard && <CardEditor root={editingCard.root} source={editingCard.source.path} text={editingCard.source.text} views={views} onSave={saveCardDraft} onClose={() => setEditingCard(null)} bindKeys={(element, submit) => host.text.bindDraftKeys(element, submit)}/>}
          {marquee && <div className="ink-mode-hint" role="status">拖动框选要加书签的区域<button type="button" onClick={() => setMarquee(null)}>取消</button></div>}
          <ViewControls views={views} paged={paged} pageCount={manifest.pages.length} pageIndex={currentIndex}
            onZoom={anchor => pop.toggle('zoom', anchor)} onJump={anchor => pop.toggle('jump', anchor)}
            onStep={delta => { const page = manifest.pages[currentIndex + delta]; if (page) goToPage(page.id); }}
            onFit={() => body.current?.zoom(paged ? 'fitWidth' : 'fitAll')} onBookmark={bookmarkView}
            onAdd={() => addPage(currentPageId)} reading={reading}/>
          <Toasts toasts={toast.toasts} dismiss={toast.dismiss}/>
        </main>
          <ScratchWindow docked={prefs.scratchPlacement === 'docked'} onDock={() => store.update({ scratchPlacement: prefs.scratchPlacement === 'docked' ? 'floating' : 'docked' })} open={scratchOpen} frame={prefs.scratch} area={areaSize} onClose={() => setScratchOpen(false)}
            onFrame={(frame, done) => { store.update({ scratch: frame }); if (done) scratch.current?.api.refresh(); }}
            history={{ canUndo: session.scratchHistory.canUndo, canRedo: session.scratchHistory.canRedo, undo: () => undo('scratch'), redo: () => redo('scratch'),
              clear: () => run(async () => { const h = scratch.current; if (!h) return; await h.flush(); h.api.updateScene({ elements: [] }); await h.flush(); toast.show({ kind: 'info', message: '草稿纸已清空', action: { label: '撤销', run: () => undo('scratch') } }); }) }}
            selection={scratchSelection && !scratchSelection.busy ? { toBody: () => run(toBody), destination: paged ? '当前页' : '画布', remove: () => run(() => scratch.current?.replaceSelected(() => null)), source: scratchSelection.source ? () => selectionActions.source(scratchSelection) : undefined } : null}>
            <InkCanvas session={session} kind="scratch" pagesKey="scratch" tool={scratchTool} fingerDraws={prefs.fingerDraws} theme={theme} ref={scratch}
              onScribble={() => toast.show({ kind: 'info', message: '已涂划擦除', action: { label: '撤销', run: () => undo('scratch') } })}
              onReady={handle => { scratch.current = handle; for (const resolve of scratchWaiters.current.splice(0)) resolve(handle); }}
              onError={message => toast.show({ kind: 'error', message })} onSelection={setScratchSelection} onGesture={gesture => gesture === 'undo' ? undo('scratch') : redo('scratch')}/>
          </ScratchWindow>
        </div>
      </div>
      {resolving && <div className="ink-cover" role="status"><span className="ink-spinner"/>正在保存独立副本…</div>}

      {pop.open === 'more' && <Popover anchor={pop.anchor} onClose={pop.close} label="更多" align="end"><Menu items={moreMenu} onDone={pop.close}/></Popover>}
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
        <p className="ink-popover-note">选中需要的文字即可复制。</p>
        <textarea readOnly data-autofocus aria-label="PDF 原文文字" value={pdfText.text} placeholder="这一页没有可提取的文字，可能是扫描件。"/>
      </Popover>}
      {pop.open === 'export' && <Popover anchor={pop.anchor} onClose={pop.close} label="导出" align="end" className="ink-export">
        <div className="ink-popover-title">导出</div>
        <div className="ink-field"><span>PDF 纸张</span><Segmented label="PDF 纸张" value={paper} onChange={setPaper} options={[{ value: 'original', label: '原尺寸' }, { value: 'a4', label: 'A4' }, { value: 'letter', label: 'Letter' }]}/></div>
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
      {pop.open === 'zoom' && <Popover anchor={pop.anchor} onClose={pop.close} label="缩放"><Menu onDone={pop.close} items={([
        ['zoomIn', '放大', 'in'], ['zoomOut', '缩小', 'out'], ['fit', '100%', 'actual'],
        ...(paged ? [['fitWidth', '适合宽度', 'fitWidth'], ['page', '适合整页', 'fitPage']] : [['fit', '显示全部内容', 'fitAll']]),
      ] as [string, string, ZoomAction][]).map(([icon, label, action]) => ({ icon, label, onSelect: () => body.current?.zoom(action) }))}/></Popover>}
      {pop.open === 'jump' && <Popover anchor={pop.anchor} onClose={pop.close} label="跳转页面" align="end" className="ink-jump">
        <form onSubmit={event => { event.preventDefault(); const n = Number(new FormData(event.currentTarget).get('page')); const page = manifest.pages[n - 1]; if (page) { body.current?.reveal(page.id); pop.close(); } }}>
          <label>跳到第 <input name="page" type="number" min={1} max={manifest.pages.length} defaultValue={currentIndex + 1} data-autofocus onFocus={event => event.currentTarget.select()}/> 页</label>
          <button type="submit" className="mod-cta">前往</button>
        </form>
      </Popover>}
      {pop.open === 'selection-color' && <Popover anchor={pop.anchor} onClose={pop.close} label="选区颜色" align="center" className="ink-color-popover">
        <Swatches colors={PEN_COLORS} value="" custom onChange={color => { pop.close(); selectionActions.recolor(color); }} label="改为颜色"/>
      </Popover>}
      {pop.open === 'selection-export' && <Popover anchor={pop.anchor} onClose={pop.close} label="导出选区" align="center"><Menu onDone={pop.close} items={[
        { icon: 'image', label: '导出为图片', hint: 'PNG，透明背景', onSelect: () => run(() => exportDocument('png', 'selection')) },
        { icon: 'pdf', label: '导出为 PDF', hint: '矢量，只含所选内容', onSelect: () => run(() => exportDocument('pdf', 'selection')) },
      ]}/></Popover>}
    </div>
  </LayerContext.Provider>;
}

function SelectionBar({ views, selection, paged, onDuplicate, onRemove, onScratch, onBookmark, onColor, onExport, onSource }: {
  views: ViewStore; selection: SelectionInfo; paged: boolean; onDuplicate: () => void; onRemove: () => void; onScratch: () => void; onBookmark: () => void;
  onColor: (anchor: HTMLElement) => void; onExport: (anchor: HTMLElement) => void; onSource?: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 280, height: 46 });
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
  return <div ref={bar} className="ink-selection-bar" role="toolbar" aria-label={`已选中 ${selection.ids.length} 个对象`} style={{ left: Math.max(half + 8, Math.min(x, width - half - 8)), top: Math.max(8, y) }}>
    <IconButton icon="duplicate" label="复制一份" onClick={onDuplicate}/>
    <IconButton icon="drop" label="颜色" onClick={event => onColor(event.currentTarget)}/>
    <IconButton icon="scratch" label="复制到草稿纸" onClick={onScratch}/>
    <IconButton icon="bookmark" label={paged ? '为这块区域加书签' : '加书签'} onClick={onBookmark}/>
    <IconButton icon="share" label="导出所选" onClick={event => onExport(event.currentTarget)}/>
    {onSource && <IconButton icon="locate" label="查看出处" onClick={onSource}/>}
    <span className="ink-divider" aria-hidden="true"/>
    <IconButton icon="trash" label="删除" className="is-danger" onClick={onRemove}/>
  </div>;
}

function ViewControls({ views, paged, pageCount, pageIndex, onZoom, onJump, onStep, onFit, onBookmark, onAdd, reading }: {
  views: ViewStore; paged: boolean; pageCount: number; pageIndex: number; onZoom: (anchor: HTMLElement) => void; onJump: (anchor: HTMLElement) => void;
  onStep: (delta: number) => void; onFit: () => void; onBookmark: () => void; onAdd: () => void; reading: boolean;
}) {
  const zoom = useView(views, v => Math.round(v.zoom * 100));
  // Bottom-left: Obsidian's status bar floats over the bottom-right corner.
  return <div className="ink-view-controls">
    <div className="ink-view-group">
      <IconButton icon={paged ? 'fitWidth' : 'fit'} label={paged ? '适合宽度' : '显示全部内容'} onClick={onFit}/>
      <button type="button" className="ink-zoom-value" aria-label={`缩放 ${zoom}%`} onClick={event => onZoom(event.currentTarget)}>{zoom}%<InkIcon name="down"/></button>
    </div>
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
    {!page.pdfPage && <div className="ink-templates" role="radiogroup" aria-label="纸张样式">{TEMPLATES.map(t =>
      <button key={t.id} type="button" role="radio" aria-checked={page.template === t.id} onClick={() => { onTemplate(t.id, all && paged); if (paged) onDefault(t.id); }}>
        <span className="ink-template-swatch" style={paperStyle(t.id)}/>{t.label}
      </button>)}</div>}
    {page.pdfPage && <p className="ink-popover-note">PDF 页面保持原样；可以加留白，在页边写笔记。</p>}
    {paged && <>
      <div className="ink-popover-subtitle">页边距</div>
      <div className="ink-chip-row">{MARGIN_PRESETS.map(p => <button key={p.label} type="button" aria-pressed={same(page.margins, p.margins)} onClick={() => onMargins(p.margins, all)}>{p.label}</button>)}</div>
      <div className="ink-margins">{(['top', 'right', 'bottom', 'left'] as const).map((edge, i) => <label key={edge}><span>{'上右下左'[i]}</span>
        <input type="number" min={0} step={8} value={Math.round(page.margins[edge])} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 0) onMargins({ ...page.margins, [edge]: value }, all); }}/></label>)}</div>
      <label className="ink-check"><input type="checkbox" checked={all} onChange={event => setAll(event.target.checked)}/>同时应用到所有页面</label>
      {!page.pdfPage && <p className="ink-popover-note">新页面默认使用「{TEMPLATES.find(t => t.id === defaultTemplate)?.label}」。</p>}
    </>}
  </div>;
}

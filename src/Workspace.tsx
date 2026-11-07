import React, { useEffect, useRef, useState } from 'react';
import { CaptureUpdateAction, convertToExcalidrawElements, exportToBlob } from '@excalidraw/excalidraw';
import { Editor, EditorHandle, InkAPI, Tool, selectedContent } from './Editor';
import { Session } from './session';
import { PdfService } from './pdf';
import { newPage, Page, uid, Element, Rect } from './model';
import { bounds, cloneElements, constrainMargins, lassoHits, removeElements } from './geometry';
import { SelectionOverlay, Point, contains, polygonBounds } from './SelectionOverlay';
import { capturePdf } from './capture';
import { ContinuousPages } from './ContinuousPages';
import { PlacementOverlay } from './PlacementOverlay';
import type { PdfExportOptions } from './export';
import { InkIcon, IconButton } from './InkIcon';

export interface WorkspaceProps {
  session: Session; pdf?: PdfService;
  onExport: (kind: 'pdf' | 'png' | 'package', pageId: string, editor?: EditorHandle, options?: PdfExportOptions) => Promise<unknown>;
  onReference: (pageId: string, regionId?: string, embed?: boolean) => Promise<void>;
  onOpenSource: (document: string, page: string, rect: Rect) => Promise<void>;
  onResolveConflict: (openCopy: boolean) => Promise<void>;
}
export function Workspace({ session, pdf, onExport, onReference, onOpenSource, onResolveConflict }: WorkspaceProps) {
  const [version, refresh] = useState(0), [pageId, setPageId] = useState(session.manifest.pages[0].id);
  const [tool, setTool] = useState<Tool>('freedraw'), [color, setColor] = useState('#202832'), [width, setWidth] = useState(2), [pressure, setPressure] = useState(false);
  const [nav, setNav] = useState(true), [focus, setFocus] = useState(false), [scratch, setScratch] = useState(false), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [results, setResults] = useState<{ page: string; title: string; region?: string }[]>([]);
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const searchTask = useRef<AbortController>(), [searchProgress, setSearchProgress] = useState('');
  const [panel, setPanel] = useState<'pages' | 'margins' | 'search' | 'text' | 'export' | null>(null);
  const [toolMenu, setToolMenu] = useState<'insert' | 'objects' | null>(null);
  const [pdfText, setPdfText] = useState(''), [busy, setBusy] = useState(false);
  const [position, setPosition] = useState({ x: 24, y: 140 });
  const [scratchSize, setScratchSize] = useState({ width: 440, height: 360 });
  const resize = useRef<{ id: number; x: number; y: number; width: number; height: number }>();
  const [selection, setSelection] = useState<'lasso' | 'clip' | 'clipRect' | 'region' | null>(null);
  const [includeAnnotations, setIncludeAnnotations] = useState(false);
  const [continuous, setContinuous] = useState(session.manifest.mode === 'pages');
  const [regionBox, setRegionBox] = useState<ReturnType<typeof polygonBounds> | null>(null), [regionTitle, setRegionTitle] = useState('');
  const [placing, setPlacing] = useState<readonly Element[] | null>(null);
  const [switching, setSwitching] = useState(false);
  const [exportPaper, setExportPaper] = useState<PdfExportOptions['paper']>('original');
  const captureTask = useRef<AbortController>();
  const main = useRef<EditorHandle>(), scratchEditor = useRef<EditorHandle>();
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number }>();
  const root = useRef<HTMLDivElement>(null);
  const containScratch = (next: { x: number; y: number }) => {
    const area = root.current;
    if (!area) return next;
    const actualWidth = Math.min(scratchSize.width, area.clientWidth * .9);
    const actualHeight = Math.min(scratchSize.height, area.clientHeight * .8);
    const toolbarBottom = (area.querySelector<HTMLElement>('.ink-titlebar')?.offsetHeight ?? 0) + (area.querySelector<HTMLElement>('.ink-toolbox')?.offsetHeight ?? 0) + 8;
    const maxY = Math.max(0, area.clientHeight - actualHeight);
    return { x: Math.max(0, Math.min(area.clientWidth - actualWidth, next.x)), y: Math.max(Math.min(toolbarBottom, maxY), Math.min(maxY, next.y)) };
  };
  useEffect(() => {
    const clamp = () => setPosition(previous => { const next = containScratch(previous); return next.x === previous.x && next.y === previous.y ? previous : next; });
    const observer = new ResizeObserver(clamp); if (root.current) observer.observe(root.current); clamp();
    return () => observer.disconnect();
  }, [scratchSize.width, scratchSize.height, focus]);
  useEffect(() => { scratchEditor.current?.api.refresh(); }, [position.x, position.y, scratchSize.width, scratchSize.height, scratch, focus]);
  useEffect(() => {
    if (!toolMenu) return;
    const trigger = document.activeElement as HTMLElement | null;
    const outside = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest('.ink-tool-popover, [aria-controls="ink-insert-tools"], [aria-controls="ink-object-tools"]')) setToolMenu(null); };
    document.addEventListener('pointerdown', outside);
    root.current?.querySelector<HTMLElement>('.ink-tool-popover button')?.focus({ preventScroll: true });
    return () => { document.removeEventListener('pointerdown', outside); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, [toolMenu]);
  useEffect(() => {
    if (!panel) return;
    const trigger = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>('.ink-panel-heading button')?.focus({ preventScroll: true });
    return () => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, [panel]);
  const navigationToken = useRef('');
  const pendingRegion = useRef<string>();
  const pendingRect = useRef<Rect>();
  const page = session.manifest.pages.find(p => p.id === pageId) ?? session.manifest.pages[0];
  useEffect(() => { const listener = () => refresh(v => v + 1); session.listeners.add(listener); return () => { session.listeners.delete(listener); }; }, []);
  useEffect(() => { if ((root.current?.clientWidth ?? 800) < 740) setNav(false); }, []);
  const run = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); } catch (e) { if ((e as Error).name !== 'AbortError') setError((e as Error).message); } };
  useEffect(() => () => { searchTask.current?.abort(); captureTask.current?.abort(); }, []);
  const goto = async (id: string) => { if (id === pageId || switching) return; setSwitching(true); try { await main.current?.flush(); main.current = undefined; setPageId(id); } catch (error) { setSwitching(false); throw error; } };
  useEffect(() => {
    const target = session.navigation;
    if (!target || switching || target.token === navigationToken.current) return;
    navigationToken.current = target.token;
    if (!session.manifest.pages.some(p => p.id === target.page)) { setError('引用的页面已删除或尚未同步。'); return; }
    pendingRegion.current = target.region;
    pendingRect.current = target.rect;
    if (target.page === pageId && main.current) locate(main.current);
    else void run(() => goto(target.page));
  }, [version, switching, pageId]);
  function locate(handle: EditorHandle) {
    const region = pendingRect.current ?? session.manifest.regions.find(r => r.id === pendingRegion.current);
    if (region) { const box = root.current?.querySelector('.ink-main')?.getBoundingClientRect(); const zoom = Math.min(2, (box?.width ?? 600) / (region.width + 80), (box?.height ?? 600) / (region.height + 80)); handle.api.updateScene({ appState: { zoom: { value: zoom as any }, scrollX: -region.x + 40 / zoom, scrollY: -region.y + 40 / zoom }, captureUpdate: CaptureUpdateAction.NEVER }); }
    pendingRegion.current = undefined;
    pendingRect.current = undefined;
    requestAnimationFrame(() => root.current?.querySelector(`[data-page-id="${pageId}"]`)?.scrollIntoView({ block: 'start' }));
  }
  async function history(scratchSurface: boolean, redo: boolean) {
    const handle = scratchSurface ? scratchEditor.current : main.current;
    await handle?.flush();
    const timeline = scratchSurface ? session.scratchHistory : session.bodyHistory;
    const change = redo ? timeline.redo() : timeline.undo();
    if (!change) return;
    if (change.layout) { Object.assign(session.manifest, structuredClone(change.layout)); session.metadataChanged(); if (!session.manifest.pages.some(p => p.id === pageId)) await goto(session.manifest.pages[0].id); return; }
    await session.load(change.surface);
    session.change(change.surface, change.elements, false);
    if (!scratchSurface && change.surface !== pageId) await goto(change.surface);
    else handle?.api.updateScene({ elements: change.elements, captureUpdate: CaptureUpdateAction.NEVER });
  }
  const toolbar = <div className="ink-toolbox">
    <div className="ink-tool-row">
      <div className="ink-tools" role="toolbar" aria-label="绘图工具">
        {([['freedraw', '笔', 'pen'], ['highlighter', '荧光笔', 'highlighter'], ['erase', '局部擦', 'erase'], ['wholeErase', '整笔擦', 'wholeErase']] as [Tool, string, string][]).map(([id, label, icon]) => <IconButton key={id} icon={icon} label={label} aria-pressed={!selection && tool === id} onClick={() => { setSelection(null); setTool(id); setToolMenu(null); }}/>) }
        <span className="ink-divider" />
        <IconButton icon="lasso" label="套索" aria-pressed={selection === 'lasso'} onClick={() => { setSelection('lasso'); setToolMenu(null); }}/>
        <IconButton icon="selection" label="选择" aria-pressed={!selection && tool === 'selection'} onClick={() => { setSelection(null); setTool('selection'); setToolMenu(null); }}/>
        <IconButton icon="hand" label="导航" aria-pressed={tool === 'hand'} onClick={() => { setSelection(null); setTool('hand'); setToolMenu(null); }}/>
        <span className="ink-divider" />
        <IconButton icon="plus" label="插入文字、图片或形状" aria-expanded={toolMenu === 'insert'} aria-controls="ink-insert-tools" onClick={() => setToolMenu(toolMenu === 'insert' ? null : 'insert')}><span>插入</span><InkIcon name="down"/></IconButton>
        <IconButton icon="more" label="选区操作" aria-expanded={toolMenu === 'objects'} aria-controls="ink-object-tools" onClick={() => setToolMenu(toolMenu === 'objects' ? null : 'objects')}/>
      </div>
      <div className="ink-history-tools">
        <IconButton icon="undo" label="撤销" disabled={switching || !session.bodyHistory.canUndo} onClick={() => run(() => history(false, false))}/>
        <IconButton icon="redo" label="重做" disabled={switching || !session.bodyHistory.canRedo} onClick={() => run(() => history(false, true))}/>
      </div>
      <div className="ink-fixed-tools"><IconButton icon="scratch" label="草稿" aria-pressed={scratch} onClick={() => setScratch(v => !v)}><span>草稿</span></IconButton><IconButton icon="focus" label={focus ? '退出专注' : '专注'} aria-pressed={focus} onClick={() => setFocus(v => !v)}/></div>
    </div>
    <div className="ink-style-row" role="group" aria-label="笔迹样式">
      <div className="ink-color-presets">{['#202832', '#2867b2', '#bd3c3c', '#28794d', '#e5b52b'].map(value => <button key={value} className="ink-color" title={`预设颜色 ${value}`} aria-label={`预设颜色 ${value}`} aria-pressed={color === value} onClick={() => setColor(value)}><span style={{ background: value }}/></button>)}<label className="ink-custom-color" title="自定义笔迹颜色"><input type="color" aria-label="笔迹颜色" value={color} onChange={e => setColor(e.target.value)}/></label></div>
      <span className="ink-divider"/>
      <label className="ink-width-control"><span className="ink-stroke-sample" style={{ height: width, background: color }}/><select aria-label="线条粗细" value={width} onChange={e => setWidth(Number(e.target.value))}>{[1, 2, 4, 8].map(n => <option key={n} value={n}>{{ 1: '细', 2: '标准', 4: '粗', 8: '特粗' }[n]}</option>)}</select></label>
      <button className="ink-pressure" aria-pressed={pressure} onClick={() => setPressure(v => !v)}>{pressure ? '压感' : '等宽'}</button>
      <span className="ink-tool-caption">{selection === 'lasso' ? '圈选对象' : ({freedraw:'自由书写',highlighter:'高亮重点',erase:'局部擦除',wholeErase:'整笔擦除',selection:'选择与移动',hand:'移动画布',text:'添加文字',rectangle:'矩形',ellipse:'椭圆',diamond:'菱形',line:'直线',arrow:'箭头',image:'添加图片'} as Record<string,string>)[tool]}</span>
    </div>
    {toolMenu && <section className="ink-tool-popover" id={toolMenu === 'insert' ? 'ink-insert-tools' : 'ink-object-tools'} aria-label={toolMenu === 'insert' ? '插入工具' : '选区操作'}>
      <div className="ink-panel-heading"><strong>{toolMenu === 'insert' ? '添加到页面' : '选中对象'}</strong><IconButton icon="close" label="关闭工具菜单" onClick={() => setToolMenu(null)}/></div>
      {toolMenu === 'insert' ? <div className="ink-insert-grid">{([['text', '文字'], ['image', '图片'], ['rectangle', '矩形'], ['ellipse', '椭圆'], ['diamond', '菱形'], ['line', '直线'], ['arrow', '箭头']] as [Tool, string][]).map(([id,label]) => <IconButton key={id} icon={id} label={label} aria-pressed={tool === id} onClick={() => {setToolMenu(null); setSelection(null); if(id === 'image') chooseImage(); else setTool(id);}}><span>{label}</span></IconButton>)}</div> : <div className="ink-menu-actions">
        <IconButton icon="copy" label="复制选中" onClick={() => run(async () => { const api = main.current?.api; if (!api) return; const selected = selectedContent(api); if (!selected.length) throw Error('请先选择对象。'); api.updateScene({ elements: [...api.getSceneElements(), ...cloneElements(selected)], captureUpdate: CaptureUpdateAction.NEVER }); await main.current?.flush(); setToolMenu(null); })}><span>复制选中</span></IconButton>
        <IconButton icon="trash" label="删除选中" onClick={() => run(async () => { const api = main.current?.api; if (!api) return; api.updateScene({ elements: removeElements(api.getSceneElements(), new Set(selectedContent(api).map(e => e.id))), captureUpdate: CaptureUpdateAction.NEVER }); await main.current?.flush(); setToolMenu(null); })}><span>删除选中</span></IconButton>
        <IconButton icon="link" label="摘题来源" onClick={() => run(() => openSource(false))}><span>摘题来源</span></IconButton>
      </div>}
    </section>}
  </div>;
  function chooseImage() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = () => { const file = input.files?.[0]; if (!file) return; void run(async () => {
      const dataURL = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
      const image = new Image(); image.src = dataURL; await image.decode();
      const id = uid(), scale = Math.min(1, 640 / image.naturalWidth);
      await session.acceptFiles({ [id]: { id: id as any, dataURL: dataURL as any, mimeType: file.type as any, created: Date.now() } });
      setPlacing(convertToExcalidrawElements([{ type: 'image', x: 0, y: 0, width: image.naturalWidth * scale, height: image.naturalHeight * scale, fileId: id as any }]));
    }); }; input.click();
  }
  async function place(x: number, y: number) {
    const elements = placing, api = main.current?.api; if (!elements || !api) return;
    setPlacing(null); const b = bounds(elements)!;
    const copies = cloneElements(elements, x - b.x, y - b.y);
    api.addFiles(Object.values(session.files)); api.updateScene({ elements: [...api.getSceneElements(), ...copies], captureUpdate: CaptureUpdateAction.NEVER }); await main.current?.flush();
  }
  async function openSource(scratchSurface: boolean) {
    const api = (scratchSurface ? scratchEditor.current : main.current)?.api;
    const selected = api?.getSceneElements().find(e => api.getAppState().selectedElementIds[e.id] && e.customData?.source);
    const source = selected?.customData?.source;
    if (!source?.document || !source.page || !Array.isArray(source.polygon)) throw Error('请先选择一张摘题图片。');
    setScratch(false); await onOpenSource(source.document, source.page, polygonBounds(source.polygon));
  }
  async function addPage(copy: boolean) {
    await main.current?.flush();
    const p = copy ? { ...structuredClone(page), id: uid() } : newPage();
    const index = session.manifest.pages.findIndex(p => p.id === pageId);
    if (copy) session.change(p.id, cloneElements(await session.load(pageId), 0, 0), false);
    session.editLayout(() => session.manifest.pages.splice(index + 1, 0, p)); await goto(p.id);
  }
  async function search() {
    searchTask.current?.abort(); const task = new AbortController(); searchTask.current = task;
    const term = query.trim().toLocaleLowerCase(); if (!term) return;
    setBusy(true); const found: typeof results = []; setResults([]);
    try {
      await main.current?.flush();
      for (const [index, p] of session.manifest.pages.entries()) {
        task.signal.throwIfAborted(); setSearchProgress(`${index + 1}/${session.manifest.pages.length}`);
        const elements = await session.read(p.id);
        for (const e of elements) if (e.type === 'text' && !e.isDeleted && e.text.toLocaleLowerCase().includes(term)) found.push({ page: p.id, title: e.text });
        if (pdf && p.pdfPage) { const text = (await pdf.text(p)).map(t => t.str).join(' '); const at = text.toLocaleLowerCase().indexOf(term); if (at >= 0) found.push({ page: p.id, title: text.slice(Math.max(0, at - 20), at + 100) }); }
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      task.signal.throwIfAborted();
      for (const r of session.manifest.regions) if (r.title.toLocaleLowerCase().includes(term)) found.push({ page: r.pageId, title: r.title, region: r.id });
      setResults(found);
      setSearchProgress(`找到 ${found.length} 项`);
    } finally { if (searchTask.current === task) { if (task.signal.aborted) setSearchProgress('已取消查找'); searchTask.current = undefined; setBusy(false); } }
  }
  async function nameRegion() {
    const api = main.current?.api; if (!api) return;
    const selected = selectedContent(api);
    const box = bounds(selected); if (!box) throw new Error('请先选择需要引用的对象。');
    setRegionBox(box); setRegionTitle('');
  }
  async function selectPolygon(points: Point[]) {
    const mode = selection; setSelection(null);
    if (mode === 'region') { const box = polygonBounds(points); if (box.width < 1 || box.height < 1) throw Error('区域太小，请重新框选。'); setRegionBox(box); setRegionTitle(''); return; }
    if (mode === 'lasso') {
      const api = main.current?.api; if (!api) return;
      const selected: Record<string, true> = {};
      const candidates = (api as InkAPI).inkQuery(polygonBounds(points));
      for (const e of candidates) {
        if (lassoHits(e, points)) selected[e.id] = true;
      }
      // Bring grouped and bound objects into the same operation, preserving editing relationships.
      const groups = new Set(candidates.filter(e => selected[e.id]).flatMap(e => e.groupIds));
      if (groups.size) for (const e of api.getSceneElements()) if (e.groupIds.some(g => groups.has(g))) selected[e.id] = true;
      for (const e of api.getSceneElements()) { if (selected[e.id]) for (const bound of e.boundElements ?? []) if (bound.type === "text") selected[bound.id] = true; if (e.type === "text" && e.containerId && selected[e.id]) selected[e.containerId] = true; }
      api.updateScene({ appState: { selectedElementIds: selected }, captureUpdate: CaptureUpdateAction.NEVER }); setTool('selection'); return;
    }
    if (!pdf) throw Error('源 PDF 当前不可用。');
    await main.current?.flush(); setBusy(true); captureTask.current = new AbortController();
    try {
      const { element, files } = await capturePdf(session, pdf, page, points, includeAnnotations, captureTask.current.signal);
      const previous = await session.load('scratch'), b = bounds(previous);
      const placed = { ...element, x: b ? b.x + b.width + 32 : 0, y: 0 };
      session.change('scratch', [...previous, placed]); setScratch(true);
      scratchEditor.current?.api.addFiles(Object.values(files));
      scratchEditor.current?.api.updateScene({ elements: [...previous, placed], captureUpdate: CaptureUpdateAction.NEVER });
      scratchEditor.current?.api.scrollToContent(placed);
    } finally { setBusy(false); captureTask.current = undefined; }
  }
  return <div className={`ink-workspace ${focus ? 'ink-focus' : ''}`} ref={root} onKeyDownCapture={event => {
    if (resolvingConflict) { event.preventDefault(); event.stopPropagation(); return; }
    if (event.nativeEvent.isComposing || (event.target as HTMLElement).closest('input,textarea,[contenteditable=true]')) return;
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      const shortcuts: Record<string, Tool> = { p: 'freedraw', v: 'selection', r: 'rectangle', o: 'ellipse', d: 'diamond', a: 'arrow', l: 'line', t: 'text', h: 'hand', e: 'erase', '1': 'selection', '2': 'rectangle', '3': 'diamond', '4': 'ellipse', '5': 'arrow', '6': 'line', '7': 'freedraw', '8': 'text', '9': 'image', '0': 'erase' };
      const next = shortcuts[event.key.toLowerCase()];
      if (next) { event.preventDefault(); event.stopPropagation(); setSelection(null); setToolMenu(null); if (next === 'image') { if (!event.repeat) chooseImage(); } else setTool(next); }
    }
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); void run(() => history(!!(event.target as HTMLElement).closest('.ink-scratch'), event.shiftKey || event.key.toLowerCase() === 'y')); }
    if (event.key === 'Escape') { setToolMenu(null); setPanel(null); setSelection(null); setPlacing(null); }
  }}>
    {!focus && <header className="ink-titlebar"><IconButton icon="nav" label="导航" aria-expanded={nav} onClick={() => setNav(v => !v)}/><div className="ink-document-heading"><strong title={session.manifest.title}>{session.manifest.title}</strong><span role="status"><span className="ink-status-dot"/>{session.status}</span></div><div className="ink-document-actions"><IconButton icon="search" label="查找" aria-expanded={panel === 'search'} onClick={() => setPanel(panel === 'search' ? null : 'search')}/><IconButton icon="export" label="导出" aria-expanded={panel === 'export'} onClick={() => setPanel(panel === 'export' ? null : 'export')}><span>导出</span></IconButton><IconButton icon="save" label="保存 / 重试" onClick={() => run(() => session.flush())}/></div></header>}
    {toolbar}
    {error && <div className="ink-error" role="alert">{error}<button onClick={() => setError('')}>关闭提示</button></div>}
    {session.conflictPath && <div className="ink-error" role="alert">检测到外部修改。本地内容保留，自动保存已暂停。{[true, false].map(copy => <button key={String(copy)} disabled={resolvingConflict} onClick={() => void run(async () => { setResolvingConflict(true); try { await onResolveConflict(copy); } finally { setResolvingConflict(false); } })}>{copy ? '保留当前内容并打开副本' : '保留当前内容后重载外部版本'}</button>)}</div>}
    {resolvingConflict && <div className="ink-conflict-cover" role="status">正在保存独立冲突副本…</div>}
    {session.sourceIssue && <div className="ink-error" role="alert">源 PDF 不可用：{session.sourceIssue}。笔迹和草稿保留；请使用命令“重新关联原 PDF”。</div>}
    <div className="ink-body">
      {nav && !focus && <aside className="ink-nav" aria-label="文档导航">
        <div className="ink-nav-heading"><h3>{session.manifest.mode === 'canvas' ? '文档导航' : '页面'}</h3><span>{session.manifest.mode === 'pages' ? session.manifest.pages.length : session.manifest.regions.length}</span></div>
        {session.manifest.mode === 'pages' && <><label className="ink-jump-page">跳至页 <input type="number" min="1" max={session.manifest.pages.length} value={session.manifest.pages.indexOf(page) + 1} onChange={e => { const target = session.manifest.pages[Number(e.target.value) - 1]; if (target) void run(() => goto(target.id)); }} /></label>
          <div className="ink-page-list">{session.manifest.pages.map((p, i) => <button key={p.id} aria-label={`第 ${i + 1} 页`} aria-current={p.id === pageId ? 'page' : undefined} onClick={() => run(() => goto(p.id))}><span className={`ink-page-symbol ink-template-${p.pdfPage ? 'pdf' : p.template}`} aria-hidden="true"><InkIcon name="page"/></span><span className="ink-page-label">第 {i + 1} 页<small>{p.pdfPage ? 'PDF' : p.template === 'grid' ? '方格' : p.template === 'ruled' ? '横线' : '空白'}</small></span></button>)}</div>
          <button onClick={() => setPanel(panel === 'pages' ? null : 'pages')}><InkIcon name="page"/>页面管理</button><button onClick={() => setPanel(panel === 'margins' ? null : 'margins')}><InkIcon name="focus"/>四边留白</button></>}
        <h3 className="ink-section-title">命名区域</h3>{session.manifest.regions.length === 0 && <p className="ink-empty-hint">标记题目或重点，随时回到这里。</p>}{session.manifest.regions.map(r => <div key={r.id} className="ink-region-row"><button onClick={() => session.navigate(r.pageId, r.id)}>{r.title}</button><button aria-label={`复制 ${r.title} 预览嵌入`} onClick={() => run(() => onReference(r.pageId, r.id, true))}>嵌入</button><button aria-label={`删除区域 ${r.title}`} onClick={() => session.editLayout(() => { session.manifest.regions = session.manifest.regions.filter(item => item.id !== r.id); })}>×</button></div>)}
        <button onClick={() => run(nameRegion)}><InkIcon name="link"/>命名选区并复制引用</button><button onClick={() => run(() => onReference(pageId))}><InkIcon name="copy"/>复制本页引用</button>
        <button onClick={() => setSelection('region')}><InkIcon name="plus"/>框选命名区域</button>
        {pdf && <button onClick={() => run(async () => { setPdfText((await pdf.text(page)).map(t => t.str).join(' ')); setPanel('text'); })}><InkIcon name="text"/>选择 PDF 文字</button>}
        {pdf && <><button disabled={busy} onClick={() => setSelection('clip')}><InkIcon name="lasso"/>套索摘题到草稿</button><button disabled={busy} onClick={() => setSelection('clipRect')}><InkIcon name="rectangle"/>矩形摘题到草稿</button><label><input type="checkbox" checked={includeAnnotations} onChange={e => setIncludeAnnotations(e.target.checked)} />包含批注（合成图片）</label></>}
      </aside>}
      <main className="ink-main">{(() => {
        const editor = <div className="ink-active-page"><Editor key={pageId} session={session} surface={pageId} page={session.manifest.mode === 'pages' ? structuredClone(page) : undefined} pdf={pdf} tool={tool} color={color} width={width} pressure={pressure} onReady={h => { main.current = h; setSwitching(false); locate(h); }} onError={message => { setSwitching(false); setError(message); }} />
        {selection && <SelectionOverlay editor={() => main.current} rectangle={selection === 'clipRect' || selection === 'region'} onCancel={() => setSelection(null)} onSelect={points => void run(() => selectPolygon(points))} />}
        {placing && <PlacementOverlay editor={() => main.current} onCancel={() => setPlacing(null)} onPlace={(x, y) => void run(() => place(x, y))} />}
        </div>;
        return continuous ? <ContinuousPages session={session} current={pageId} pdf={pdf} onSelect={id => void run(() => goto(id))}>{editor}</ContinuousPages> : editor;
      })()}
      </main>
    </div>
    {panel && <section className="ink-panel" aria-label="文档操作"><div className="ink-panel-heading"><strong>{{ pages: '页面管理', margins: '四边留白', search: '文档内查找', text: 'PDF 原文文字', export: '导出与备份' }[panel]}</strong><IconButton icon="close" label="关闭" onClick={() => { searchTask.current?.abort(); setPanel(null); }}/></div>
      {panel === 'pages' && <>{page.pdfPage ? <p>源 PDF 页序保持不变。</p> : <><button onClick={() => run(() => addPage(false))}>新增页面</button><button onClick={() => run(() => addPage(true))}>复制本页</button><button disabled={session.manifest.pages.length <= 1} onClick={() => run(async () => { const index = session.manifest.pages.indexOf(page); session.editLayout(() => session.manifest.pages.splice(index, 1)); await goto(session.manifest.pages[Math.max(0, index - 1)].id); })}>删除本页</button><button disabled={session.manifest.pages.indexOf(page) === 0} onClick={() => { const i = session.manifest.pages.indexOf(page); session.editLayout(() => { session.manifest.pages.splice(i, 1); session.manifest.pages.splice(i - 1, 0, page); }); }}>向前移动</button><label>纸面模板<select value={page.template} onChange={e => { session.editLayout(() => { page.template = e.target.value as Page['template']; }); }}><option value="blank">空白</option><option value="ruled">横线</option><option value="grid">方格</option></select></label></>}</>}
      {panel === 'margins' && <>{(['top', 'right', 'bottom', 'left'] as const).map((edge, i) => <label key={edge}>{['上', '右', '下', '左'][i]}<input type="number" min="0" value={Math.round(page.margins[edge])} onChange={e => { session.editLayout(() => { page.margins = constrainMargins(page, { ...page.margins, [edge]: Number(e.target.value) }, main.current?.api.getSceneElements() ?? []); }); }} /></label>)}<button onClick={() => run(async () => { await main.current?.flush(); const margins = new Map(); for (const p of session.manifest.pages) margins.set(p.id, constrainMargins(p, page.margins, await session.read(p.id))); session.editLayout(() => { for (const p of session.manifest.pages) p.margins = margins.get(p.id); }); })}>应用到全部页面（保护笔迹）</button></>}
      {panel === 'search' && <><form onSubmit={e => { e.preventDefault(); void run(search); }}><input placeholder="搜索 PDF 文字、文字框或区域…" autoComplete="off" name="document-search" aria-label="查找文字" value={query} onChange={e => setQuery(e.target.value)} /><button disabled={!query || busy}>{busy ? '查找中…' : '查找'}</button></form><span role="status">{searchProgress}</span>{searchTask.current && <button onClick={() => searchTask.current?.abort()}>取消查找</button>}{results.map((r, i) => <button key={i} onClick={() => session.navigate(r.page, r.region)}>{r.title}</button>)}</>}
      {panel === 'text' && <><p>可选择并复制文字；扫描件没有文字层时为空。</p><textarea readOnly aria-label="可提取的 PDF 文字" value={pdfText} /><button onClick={() => run(() => navigator.clipboard.writeText(pdfText))}>复制全文</button></>}
      {panel === 'export' && <><label>PDF 纸张<select value={exportPaper} onChange={e => setExportPaper(e.target.value as PdfExportOptions['paper'])}><option value="original">完整内容原比例（含留白）</option><option value="a4">等比适配 A4</option><option value="letter">等比适配 Letter</option></select></label>{(['pdf', 'png', 'package'] as const).map((kind, i) => <button key={kind} disabled={busy} onClick={() => run(async () => { setBusy(true); try { await session.flush(); await onExport(kind, pageId, main.current, { paper: exportPaper }); } finally { setBusy(false); } })}>{[session.manifest.mode === 'canvas' ? '选区 PDF' : '阅读版 PDF', '选区 PNG', '完整可编辑打包'][i]}</button>)}</>}
    </section>}
    {regionBox && <section className="ink-panel" aria-label="命名区域"><form onSubmit={e => { e.preventDefault(); void run(async () => { const region = { ...regionBox, id: uid(), pageId, title: regionTitle.trim() }; session.editLayout(() => session.manifest.regions.push(region)); setRegionBox(null); await onReference(pageId, region.id); }); }}><label>区域标题<input autoFocus value={regionTitle} onChange={e => setRegionTitle(e.target.value)} /></label><button disabled={!regionTitle.trim()}>创建并复制引用</button><button type="button" onClick={() => setRegionBox(null)}>取消</button></form></section>}
    {captureTask.current && <div className="ink-task" role="status">正在生成题目图片…<button onClick={() => captureTask.current?.abort()}>取消</button></div>}
    <section className="ink-scratch" aria-label="文档草稿" style={{ display: scratch ? 'flex' : 'none', left: position.x, top: position.y, width: scratchSize.width, height: scratchSize.height }}>
      <div className="ink-scratch-handle" tabIndex={0} role="group" aria-label="移动草稿，方向键调整位置" onKeyDown={e => { if (e.target !== e.currentTarget) return; if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); setPosition(p => containScratch({ x: p.x + (e.key === 'ArrowRight' ? 20 : e.key === 'ArrowLeft' ? -20 : 0), y: p.y + (e.key === 'ArrowDown' ? 20 : e.key === 'ArrowUp' ? -20 : 0) })); } }} onPointerDown={e => { if ((e.target as HTMLElement).closest('button')) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: position.x, top: position.y }; }} onPointerMove={e => { const d = drag.current; if (d?.id === e.pointerId) setPosition(containScratch({ x: d.left + e.clientX - d.x, y: d.top + e.clientY - d.y })); }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}><span className="ink-scratch-title"><InkIcon name="grip"/><strong>文档草稿</strong><small>独立演算</small></span><IconButton icon="down" label="收起" onClick={() => setScratch(false)}/></div>
      <div className="ink-scratch-tools"><button onClick={() => run(() => openSource(true))}>摘题来源</button><button disabled={!session.scratchHistory.canUndo} onClick={() => run(() => history(true, false))}>撤销</button><button disabled={!session.scratchHistory.canRedo} onClick={() => run(() => history(true, true))}>重做</button><button onClick={() => run(async () => { await scratchEditor.current?.flush(); session.change('scratch', []); scratchEditor.current?.api.updateScene({ elements: [], captureUpdate: CaptureUpdateAction.NEVER }); })}>清空</button><button onClick={() => run(async () => { const from = scratchEditor.current?.api, to = main.current?.api; if (!from || !to) return; const selected = selectedContent(from); if (!selected.length) throw Error('请先选择草稿中的对象。'); setPlacing(selected.map(e => structuredClone(e))); setScratch(false); })}>复制到正文</button></div>
      <Editor session={session} surface="scratch" tool={tool} color={color} width={width} pressure={pressure} onReady={h => { scratchEditor.current = h; }} onError={setError} /><button className="ink-scratch-resize" aria-label="调整草稿大小" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); const box = e.currentTarget.parentElement!.getBoundingClientRect(); resize.current = { id: e.pointerId, x: e.clientX, y: e.clientY, width: box.width, height: box.height }; }} onPointerMove={e => { const r = resize.current; if (r?.id === e.pointerId) setScratchSize({ width: Math.max(280, Math.min((root.current?.clientWidth ?? 800) - position.x, r.width + e.clientX - r.x)), height: Math.max(240, Math.min((root.current?.clientHeight ?? 600) - position.y, r.height + e.clientY - r.y)) }); }} onPointerUp={() => { resize.current = undefined; }} onPointerCancel={() => { resize.current = undefined; }} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); setScratchSize(s => ({ width: Math.max(280, Math.min((root.current?.clientWidth ?? 800) - position.x, s.width + (e.key === 'ArrowRight' ? 20 : e.key === 'ArrowLeft' ? -20 : 0))), height: Math.max(240, Math.min((root.current?.clientHeight ?? 600) - position.y, s.height + (e.key === 'ArrowDown' ? 20 : e.key === 'ArrowUp' ? -20 : 0))) })); } }}>↘</button>
    </section>
    <footer className="ink-footer"><span>{session.manifest.mode === 'pages' ? `第 ${session.manifest.pages.indexOf(page) + 1} / ${session.manifest.pages.length} 页` : '无边记'}</span>{session.manifest.mode === 'pages' && <button onClick={() => run(async () => { await main.current?.flush(); setContinuous(v => !v); })}>{continuous ? '切换单页阅读' : '切换连续阅读'}</button>}<span>{tool === 'erase' ? '局部擦 · 仅移除笔迹' : pressure ? '压感笔' : '等宽笔'} · 手指导航</span></footer>
  </div>;
}

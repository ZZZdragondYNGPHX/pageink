import React, { useEffect, useRef, useState } from 'react';
import type { Page, Region } from './model';
import { pageRect } from './model';
import type { Session } from './session';
import type { PdfService } from './pdf';
import { renderArea } from './preview';
import { IconButton, InkIcon } from './InkIcon';
import { searchDocument, SearchHit } from './search';
import type { SidebarTab } from './preferences';

/** Renders at most two previews at once so scrolling the list never floods the main thread. */
class PreviewQueue {
  private running = 0; private waiting: (() => void)[] = [];
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= 2) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.running++;
    try { return await task(); } finally { this.running--; this.waiting.shift()?.(); }
  }
}
const queue = new PreviewQueue();

function Thumbnail({ session, page, pdf, version, root }: { session: Session; page: Page; pdf?: PdfService; version: string; root: HTMLElement | null }) {
  const canvas = useRef<HTMLCanvasElement>(null), [visible, setVisible] = useState(false), drawn = useRef('');
  useEffect(() => {
    const target = canvas.current!; const observer = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)), { root, rootMargin: '300px 0px' });
    observer.observe(target); return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    if (!visible || drawn.current === version) return;
    const abort = new AbortController();
    const timer = setTimeout(() => void queue.run(async () => {
      abort.signal.throwIfAborted();
      const rect = pageRect(page), scale = Math.min(1, 132 * devicePixelRatio / rect.width);
      const rendered = await renderArea(session, page, rect, scale, pdf, abort.signal);
      const target = canvas.current; if (!target || abort.signal.aborted) return;
      target.width = rendered.width; target.height = rendered.height; target.getContext('2d')!.drawImage(rendered, 0, 0);
      rendered.width = rendered.height = 0; drawn.current = version;
    }).catch(() => {}), drawn.current ? 5000 : 30);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [visible, version, pdf]);
  useEffect(() => () => { if (canvas.current) canvas.current.width = canvas.current.height = 0; }, []);
  const rect = pageRect(page);
  return <canvas ref={canvas} className="ink-thumb-canvas" style={{ aspectRatio: `${rect.width} / ${rect.height}` }}/>;
}

export function PageList({ session, pdf, current, onSelect, onMenu, onAdd }: {
  session: Session; pdf?: PdfService; current?: string; onSelect: (id: string) => void; onMenu: (id: string, anchor: HTMLElement) => void; onAdd: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const item = list.current?.querySelector<HTMLElement>(`[data-page="${current}"]`);
    if (item && list.current) { const a = item.getBoundingClientRect(), b = list.current.getBoundingClientRect(); if (a.top < b.top || a.bottom > b.bottom) item.scrollIntoView({ block: 'nearest' }); }
  }, [current]);
  return <><div className="ink-page-list" ref={list}>
    {session.manifest.pages.map((page, index) => {
      const version = `${session.revision(page.id)}|${page.template}|${page.width}x${page.height}|${Object.values(page.margins).join(',')}|${pdf ? 1 : 0}`;
      return <div key={page.id} className="ink-thumb" data-page={page.id} aria-current={page.id === current ? 'page' : undefined}>
        <button type="button" className="ink-thumb-button" aria-label={`第 ${index + 1} 页`} onClick={() => onSelect(page.id)} onContextMenu={event => { event.preventDefault(); onMenu(page.id, event.currentTarget); }}>
          <Thumbnail session={session} page={page} pdf={pdf} version={version} root={list.current}/>
        </button>
        <div className="ink-thumb-footer"><span>{index + 1}</span><IconButton icon="more" label={`第 ${index + 1} 页操作`} className="ink-thumb-more" onClick={event => onMenu(page.id, event.currentTarget)}/></div>
      </div>;
    })}
  </div><div className="ink-sidebar-footer"><button type="button" className="ink-thumb-add" onClick={onAdd}><InkIcon name="plus"/><span>添加页面</span></button></div></>;
}

export function BookmarkList({ regions, pageNumber, onOpen, onMenu, onAdd, onSaveView, renaming, onRename }: {
  regions: readonly Region[]; pageNumber: (pageId: string) => number; onOpen: (region: Region) => void; onMenu: (region: Region, anchor: HTMLElement) => void; onAdd: () => void;
  onSaveView?: () => void;
  renaming: string | null; onRename: (region: Region, title: string | null) => void;
}) {
  return <div className="ink-bookmarks">
    {onSaveView && <button type="button" className="ink-sidebar-action" onClick={onSaveView}><InkIcon name="plus"/>保存当前视野</button>}
    <button type="button" className="ink-sidebar-action" onClick={onAdd}><InkIcon name="capture"/>框选区域加书签</button>
    {regions.length === 0 && <div className="ink-empty"><InkIcon name="bookmark"/><strong>{onSaveView ? '让想法有迹可循' : '把重点留在手边'}</strong><p>{onSaveView ? '保存画布上的一处视野，下次一点就能回到这里。' : '框住题目、笔记或图表，添加书签后随时跳回。'}</p></div>}
    {regions.map(region => <div key={region.id} className="ink-bookmark">
      {renaming === region.id ? <form className="ink-rename" onSubmit={event => { event.preventDefault(); onRename(region, new FormData(event.currentTarget).get('title') as string); }}>
        <input name="title" defaultValue={region.title} aria-label="书签名称" data-autofocus autoFocus onFocus={event => event.currentTarget.select()} onBlur={event => onRename(region, event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onRename(region, null); } }}/>
      </form> : <button type="button" className="ink-bookmark-open" onClick={() => onOpen(region)}>
        <InkIcon name="bookmark"/><span className="ink-bookmark-title">{region.title || '未命名书签'}</span>{pageNumber(region.pageId) > 0 && <small>第 {pageNumber(region.pageId)} 页</small>}
      </button>}
      <IconButton icon="more" label={`${region.title} 的操作`} className="ink-row-more" onClick={event => onMenu(region, event.currentTarget)}/>
    </div>)}
  </div>;
}

export function SearchPanel({ session, pdf, paged, onOpen, initial }: { session: Session; pdf?: PdfService; paged: boolean; onOpen: (hit: SearchHit) => void; initial?: string }) {
  const [query, setQuery] = useState(initial ?? ''), [hits, setHits] = useState<SearchHit[] | null>(null), [progress, setProgress] = useState(''), [active, setActive] = useState(-1);
  const task = useRef<AbortController>();
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    task.current?.abort();
    if (composing) return;
    if (!query.trim()) { setHits(null); setProgress(''); return; }
    setProgress('正在搜索…');
    const controller = new AbortController(); task.current = controller;
    const timer = setTimeout(() => void (async () => {
      await session.flush().catch(() => {});
      const found = await searchDocument(session, pdf, query, controller.signal, (done, total) => { if (!controller.signal.aborted) setProgress(total > 1 && done < total ? `正在查找 ${done + 1}/${total}` : '正在搜索…'); });
      if (!controller.signal.aborted) { setHits(found); setActive(-1); setProgress(''); }
    })().catch(error => { if (!controller.signal.aborted) setProgress((error as Error).message); }), 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, composing]);
  const term = query.trim();
  return <div className="ink-search">
    <div className="ink-search-field"><InkIcon name="search"/><input type="search" value={query} placeholder={pdf ? '搜索 PDF 文字、文本框、书签' : '搜索文本框和书签'} aria-label="搜索" data-autofocus autoFocus
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
      onChange={event => { setQuery(event.target.value); setHits(null); }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || composing) return;
        if (!hits?.length) return;
        if (event.key === 'Enter' || event.key === 'ArrowDown') { event.preventDefault(); const next = (active + 1) % hits.length; setActive(next); onOpen(hits[next]); }
        if (event.key === 'ArrowUp') { event.preventDefault(); const next = (active - 1 + hits.length) % hits.length; setActive(next); onOpen(hits[next]); }
      }}/></div>
    <div className="ink-search-status" role="status">{progress || (hits ? hits.length ? `${hits.length} 个结果` : '没有找到' : '')}</div>
    <div className="ink-search-results">{hits?.map((hit, i) => <button key={i} type="button" className="ink-search-hit" aria-current={i === active ? 'true' : undefined} onClick={() => { setActive(i); onOpen(hit); }}>
      <small>{paged ? `第 ${hit.pageIndex + 1} 页` : ''}{hit.kind === 'bookmark' ? ' · 书签' : hit.kind === 'text' ? ' · 文本框' : ''}</small>
      <span>{hit.snippet.slice(0, hit.at)}<mark>{hit.snippet.slice(hit.at, hit.at + term.length)}</mark>{hit.snippet.slice(hit.at + term.length)}</span>
    </button>)}</div>
    {!pdf && !hits && <p className="ink-empty-tip">手写内容暂不支持搜索。</p>}
  </div>;
}

export function SidebarTabs({ tab, onTab, paged }: { tab: SidebarTab; onTab: (tab: SidebarTab) => void; paged: boolean }) {
  const tabs: [SidebarTab, string, string][] = [...(paged ? [['pages', '页面', 'pages'] as [SidebarTab, string, string]] : []), ['bookmarks', '书签', 'bookmark'], ['search', '搜索', 'search']];
  return <div className="ink-tabs" role="tablist" aria-label="侧栏" onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.findIndex(([id]) => id === tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    onTab(tabs[next][0]); event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  }}>{tabs.map(([id, label, icon]) =>
    <button key={id} type="button" role="tab" tabIndex={tab === id ? 0 : -1} aria-selected={tab === id} onClick={() => onTab(id)}><InkIcon name={icon}/><span>{label}</span></button>)}</div>;
}

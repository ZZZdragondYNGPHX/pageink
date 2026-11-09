import React, { useEffect, useMemo, useRef, useState } from 'react';
import { IconButton, InkIcon } from './InkIcon';
import { filterNotes, NOTE_LABELS, NOTE_TYPES, NoteCreateKind, NoteEntry, NoteFilter } from './notes';
import { LayerContext, Popover, Segmented, useAnchor } from './ui';
import type { LibrarySearchState, NoteTarget } from './library-search';

export interface LibraryHost {
  list(signal: AbortSignal): Promise<NoteEntry[]>;
  subscribe(listener: () => void): () => void;
  open(path: string, target?: NoteTarget): Promise<void>;
  search(entries: NoteEntry[], query: string, signal: AbortSignal, progress: (state: LibrarySearchState) => void): Promise<LibrarySearchState>;
  properties(path: string): Promise<void>;
  daily(): Promise<void>;
  quickOpen(): void;
  create(kind?: NoteCreateKind): Promise<void>;
}

const filters: { id: NoteFilter; label: string }[] = [
  { id: 'all', label: '全部' }, ...(['text', 'pages', 'canvas'] as const).map(id => ({ id, label: NOTE_TYPES[id].label })), { id: 'pdf', label: 'PDF' },
];
const icons = { text: 'docText', pages: 'notebook', canvas: 'canvas', pdf: 'pdf', unavailable: 'warning' };
const starters = (['text', 'pages', 'canvas'] as const).map(kind => ({ kind, ...NOTE_TYPES[kind] }));

function modifiedLabel(timestamp: number) {
  const date = new Date(timestamp), today = new Date(), yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return '今天';
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN', { ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } as const : {}), month: 'short', day: 'numeric' });
}

export function Library({ host }: { host: LibraryHost }) {
  const [layer, setLayer] = useState<HTMLDivElement | null>(null), pop = useAnchor<'search'>();
  const [entries, setEntries] = useState<NoteEntry[]>([]), [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(''), [searchError, setSearchError] = useState('');
  const [actionError, setActionError] = useState<{ message: string; retry: () => Promise<void> } | null>(null);
  const [query, setQuery] = useState(''), [searchQuery, setSearchQuery] = useState(''), [filter, setFilter] = useState<NoteFilter>('all');
  const [limit, setLimit] = useState(60), [pending, setPending] = useState<string | null>(null), busy = useRef(false);
  const [retry, setRetry] = useState(0), [fullText, setFullText] = useState(true), [searchRetry, setSearchRetry] = useState(0);
  const [searchState, setSearchState] = useState<LibrarySearchState & { key: string }>({ key: '', matches: [], issues: [], done: 0, total: 0 });
  const [searchStatus, setSearchStatus] = useState<'running' | 'done' | 'canceled'>('done');
  const searchInput = useRef<HTMLInputElement>(null), list = useRef<HTMLUListElement>(null), composing = useRef(false);
  const searching = !!searchQuery.trim() && fullText, searchTask = useRef<AbortController>();
  const searchKey = `${filter}:${searchQuery}:${searchRetry}`;
  useEffect(() => {
    let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      controller?.abort(); const task = new AbortController(); controller = task;
      try { const next = await host.list(task.signal); if (!task.signal.aborted) { setEntries(next); setListError(''); } }
      catch (e) { if (!task.signal.aborted) setListError((e as Error).message); }
      finally { if (!task.signal.aborted) setLoading(false); }
    };
    void refresh();
    const unsubscribe = host.subscribe(() => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 250); });
    return () => { unsubscribe(); controller?.abort(); clearTimeout(timer); };
  }, [host, retry]);
  useEffect(() => { setLimit(60); list.current?.parentElement?.scrollTo({ top: 0 }); }, [searchQuery, filter, fullText]);
  const candidates = useMemo(() => filterNotes(entries, filter, ''), [entries, filter]);
  useEffect(() => {
    setSearchError('');
    if (!searching) return;
    const task = new AbortController(); searchTask.current = task;
    setSearchState({ key: searchKey, matches: [], issues: [], done: 0, total: candidates.length }); setSearchStatus('running');
    const timer = setTimeout(() => {
      void host.search(candidates, searchQuery, task.signal, state => { if (!task.signal.aborted) setSearchState({ ...state, key: searchKey }); }).then(state => {
        if (!task.signal.aborted) { setSearchState({ ...state, key: searchKey }); setSearchStatus('done'); }
      }).catch(e => { if (!task.signal.aborted) { setSearchError((e as Error).message); setSearchStatus('canceled'); } });
    }, 250);
    return () => { clearTimeout(timer); task.abort(); };
  }, [host, candidates, searchQuery, searching, searchKey]);
  const currentSearch = searchState.key === searchKey;
  const running = searching && (!currentSearch || searchStatus === 'running');
  const matches = searching ? currentSearch ? searchState.matches : [] : filterNotes(entries, filter, searchQuery).map(entry => ({ entry, snippet: '', label: '', target: undefined }));
  const counts = useMemo(() => Object.fromEntries(filters.map(item => [item.id, item.id === 'all' ? entries.length : entries.filter(e => e.kind === item.id).length])), [entries]);
  const action = async (key: string, task: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true; setPending(key); setActionError(null);
    try { await task(); } catch (e) { setActionError({ message: (e as Error).message, retry: () => action(key, task) }); }
    finally { busy.current = false; setPending(null); }
  };
  const changeQuery = (value: string) => { setQuery(value); setSearchQuery(value); };
  const clearSearch = () => { changeQuery(''); searchInput.current?.focus(); };
  const reset = () => { setFilter('all'); clearSearch(); };
  const filtered = !!searchQuery.trim() || filter !== 'all';

  return <LayerContext.Provider value={layer}><div ref={setLayer} className="ink-workspace ink-library" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); searchInput.current?.focus(); searchInput.current?.select(); }
  }}>
    <header className="ink-library-heading">
      <div className="ink-library-title"><span className="ink-library-mark"><InkIcon name="notebook"/></span><div><span className="ink-library-brand">页墨手记 PageInk</span><h1>笔记库</h1></div></div>
      <div className="ink-library-actions">
        <button type="button" className="ink-library-daily" disabled={pending === 'daily'} onClick={() => void action('daily', () => host.daily())}>{pending === 'daily' ? <span className="ink-spinner"/> : <InkIcon name="calendar"/>}今日记录</button>
        <button type="button" onClick={() => void action('create', () => host.create())}><InkIcon name="plus"/><span>新建与导入</span></button>
      </div>
    </header>
    <div className="ink-library-start" role="group" aria-label="新建笔记">
      {starters.map(item => <button key={item.kind} type="button" className={`ink-library-starter ink-note-${item.kind}`} disabled={!!pending} onClick={() => void action(item.kind, () => host.create(item.kind))} aria-label={`新建${item.label}`} aria-description={item.description}>
        <span className="ink-library-starter-icon">{pending === item.kind ? <span className="ink-spinner"/> : <InkIcon name={icons[item.kind]}/>}</span>
        <span><strong>{item.label}</strong><small className="ink-library-starter-description">{item.description}</small><small className="ink-library-starter-short">{item.shortDescription}</small></span><InkIcon name="plus"/>
      </button>)}
    </div>
    <div className="ink-library-controls">
      <div className="ink-library-search-row">
        <div className="ink-library-search"><InkIcon name="search"/><input ref={searchInput} type="search" name="note-search" autoComplete="off" aria-label="搜索笔记" placeholder={fullText ? '搜索笔记名称、正文…' : '搜索笔记名称…'} value={query}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={e => { composing.current = false; setSearchQuery(e.currentTarget.value); }}
          onChange={e => { setQuery(e.target.value); if (!composing.current) setSearchQuery(e.target.value); }}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing || composing.current) return;
            if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); clearSearch(); }
            if (e.key === 'ArrowDown' && matches.length) { e.preventDefault(); list.current?.querySelector<HTMLButtonElement>('.ink-library-note')?.focus(); }
            if (e.key === 'Enter' && matches.length && !running) { e.preventDefault(); void action(matches[0].entry.path, () => host.open(matches[0].entry.path, matches[0].target)); }
          }}/>
          {query && <IconButton icon="close" label="清除搜索" onClick={clearSearch}/>}
          <IconButton icon="sliders" label="搜索选项" aria-expanded={pop.open === 'search'} onClick={event => pop.toggle('search', event.currentTarget)}/>
        </div>
        <button type="button" className="ink-library-quick-open" aria-label="快速打开" title="快速打开" onClick={() => host.quickOpen()}><InkIcon name="folderOpen"/><span>快速打开</span></button>
      </div>
      <div className="ink-library-filters" role="group" aria-label="笔记类型">{filters.map(item => <button key={item.id} type="button" aria-label={item.label} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}<span>{loading ? '–' : counts[item.id]}</span></button>)}</div>
    </div>
    <div className="ink-library-caption"><span>{searchQuery.trim() ? '搜索结果' : filter === 'all' ? '所有笔记' : filters.find(f => f.id === filter)!.label}<small>最近修改</small></span>
      <span role="status" aria-live="polite">{loading ? '正在读取…' : running ? `已搜索 ${currentSearch ? searchState.done : 0}/${candidates.length} · 找到 ${matches.length} 个文件` : `${matches.length} 个文件${searching && searchStatus === 'canceled' ? ' · 已停止，结果不完整' : ''}`}</span>
      {searching && <button type="button" onClick={() => { if (running) { searchTask.current?.abort(); setSearchStatus('canceled'); } else setSearchRetry(n => n + 1); }}>{running ? '停止搜索' : '重新搜索'}</button>}
    </div>
    {listError && <div className="ink-library-error" role="alert"><InkIcon name="warning"/><span>{listError}</span><button type="button" onClick={() => { setLoading(true); setRetry(n => n + 1); }}>重新读取</button></div>}
    {actionError && <div className="ink-library-error" role="alert"><InkIcon name="warning"/><span>{actionError.message}</span><button type="button" onClick={() => void actionError.retry()}>再试一次</button><IconButton icon="close" label="关闭错误提示" onClick={() => setActionError(null)}/></div>}
    {searchError && <div className="ink-library-error" role="alert"><span>{searchError}</span><button type="button" onClick={() => setSearchRetry(n => n + 1)}>重试搜索</button></div>}
    <div className="ink-library-scroll" aria-busy={loading || running}>
      {searching && currentSearch && !!searchState.issues.length && <details className="ink-library-issues"><summary>{searchState.issues.length} 个文件未能完整搜索</summary><ul>{searchState.issues.map(issue => <li key={issue.path}><strong>{issue.path}</strong>：{issue.message}</li>)}</ul></details>}
      {loading && <div className="ink-library-loading"><span className="ink-spinner"/>正在读取笔记…</div>}
      {!loading && !matches.length && !running && !listError && <div className="ink-library-empty"><span><InkIcon name={filtered ? 'search' : 'notebook'}/></span><h2>{searching && searchStatus === 'canceled' ? '搜索已停止' : searchQuery.trim() ? '没有找到匹配的笔记' : filter !== 'all' ? `还没有${NOTE_LABELS[filter]}` : '一页空白，等你落笔'}</h2><p>{filtered ? '换个关键词，或查看全部笔记。' : '选一份文笺、一册手札，或展开一幅长卷。'}</p>{filtered && <button type="button" onClick={reset}>查看全部笔记</button>}</div>}
      <ul ref={list} className="ink-library-list" aria-label="笔记列表" onKeyDown={event => {
        if (event.nativeEvent.isComposing || !(event.target as HTMLElement).matches('.ink-library-note')) return;
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.ink-library-note')], index = buttons.indexOf(event.target as HTMLButtonElement);
        if (event.key === 'ArrowUp' && index === 0) searchInput.current?.focus();
        else buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))]?.focus();
      }}>
        {matches.slice(0, limit).map(({ entry, snippet, label, target }) => <li key={entry.path} className="ink-library-row">
          <button type="button" className={`ink-library-note ink-note-${entry.kind}`} disabled={!!pending} onClick={() => void action(entry.path, () => host.open(entry.path, target))} title={entry.path}>
            <span className="ink-library-note-icon">{pending === entry.path ? <span className="ink-spinner"/> : <InkIcon name={icons[entry.kind]}/>}</span>
            <span className="ink-library-note-name"><strong>{entry.name}</strong><span className="ink-library-note-meta"><small className="ink-library-note-kind">{NOTE_LABELS[entry.kind]}{entry.kind in NOTE_TYPES ? ` · ${entry.detail || NOTE_TYPES[entry.kind as NoteCreateKind].detail}` : ''}</small>{entry.path.includes('/') && <small className="ink-library-note-folder">{entry.path.slice(0, entry.path.lastIndexOf('/'))}</small>}<time dateTime={new Date(entry.modified).toISOString()} title={new Date(entry.modified).toLocaleString('zh-CN')}>{modifiedLabel(entry.modified)}</time></span>
              {snippet && <><small className="ink-library-snippet">{snippet}</small><small>{label}</small></>}{entry.kind === 'unavailable' && <small className="ink-library-note-issue">{entry.detail}</small>}
            </span>
            <InkIcon name="right"/>
          </button>
          {['text', 'pages', 'canvas'].includes(entry.kind) && <IconButton icon="sliders" className="ink-library-properties" label={`编辑属性：${entry.name}`} onClick={() => void action(`properties:${entry.path}`, () => host.properties(entry.path))}/>}
        </li>)}
      </ul>
      {matches.length > limit && <button type="button" className="ink-library-load" onClick={() => setLimit(n => n + 60)}>显示更多（还有 {matches.length - limit} 个）</button>}
    </div>
    {pop.open === 'search' && <Popover anchor={pop.anchor} onClose={pop.close} label="搜索选项" align="end" className="ink-library-search-popover"><div className="ink-popover-title">搜索范围</div>
      <Segmented value={fullText ? 'full' : 'names'} label="搜索范围" options={[{ value: 'full', label: '名称与内容' }, { value: 'names', label: '仅名称' }]} onChange={value => setFullText(value === 'full')}/>
      <p className="ink-popover-note">内容包括文字、属性和 PDF 文本。手写与扫描图片暂不支持内容搜索。</p>
    </Popover>}
  </div></LayerContext.Provider>;
}

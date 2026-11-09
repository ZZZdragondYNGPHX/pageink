import React, { useEffect, useMemo, useRef, useState } from 'react';
import { InkIcon } from './InkIcon';
import { filterNotes, NOTE_LABELS, NoteEntry, NoteFilter } from './notes';
import type { LibrarySearchState, NoteTarget } from './library-search';

export interface LibraryHost {
  list(signal: AbortSignal): Promise<NoteEntry[]>;
  subscribe(listener: () => void): () => void;
  open(path: string, target?: NoteTarget): Promise<void>;
  search(entries: NoteEntry[], query: string, signal: AbortSignal, progress: (state: LibrarySearchState) => void): Promise<LibrarySearchState>;
  properties(path: string): Promise<void>;
  daily(): Promise<void>;
  quickOpen(): void;
  create(): void;
}

const filters: { id: NoteFilter; label: string }[] = [
  { id: 'all', label: '全部' }, { id: 'text', label: '文字笔记' },
  { id: 'pages', label: '笔记本' }, { id: 'canvas', label: '自由画布' }, { id: 'pdf', label: 'PDF' },
];
const icons = { text: 'docText', pages: 'notebook', canvas: 'canvas', pdf: 'pdf', unavailable: 'warning' };

export function Library({ host }: { host: LibraryHost }) {
  const [entries, setEntries] = useState<NoteEntry[]>([]), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [query, setQuery] = useState(''), [filter, setFilter] = useState<NoteFilter>('all');
  const [limit, setLimit] = useState(60), [opening, setOpening] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [fullText, setFullText] = useState(true), [searchRetry, setSearchRetry] = useState(0);
  const [searchState, setSearchState] = useState<LibrarySearchState>({ matches: [], issues: [], done: 0, total: 0 });
  const [searchStatus, setSearchStatus] = useState<'running' | 'done' | 'canceled'>('done');
  const searching = !!query.trim() && fullText, searchTask = useRef<AbortController>();
  useEffect(() => {
    let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      controller?.abort(); const task = new AbortController(); controller = task;
      try { const next = await host.list(task.signal); if (!task.signal.aborted) { setEntries(next); setError(''); } }
      catch (e) { if (!task.signal.aborted) setError((e as Error).message); }
      finally { if (!task.signal.aborted) setLoading(false); }
    };
    void refresh();
    const unsubscribe = host.subscribe(() => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 250); });
    return () => { unsubscribe(); controller?.abort(); clearTimeout(timer); };
  }, [host, retry]);
  useEffect(() => setLimit(60), [query, filter, fullText]);
  const candidates = useMemo(() => filterNotes(entries, filter, ''), [entries, filter]);
  useEffect(() => {
    if (!searching) return;
    const task = new AbortController(); searchTask.current = task;
    setSearchState({ matches: [], issues: [], done: 0, total: candidates.length }); setSearchStatus('running');
    const timer = setTimeout(() => {
      void host.search(candidates, query, task.signal, state => { if (!task.signal.aborted) setSearchState(state); }).then(state => {
        if (!task.signal.aborted) { setSearchState(state); setSearchStatus('done'); }
      }).catch(e => { if (!task.signal.aborted) { setError((e as Error).message); setSearchStatus('canceled'); } });
    }, 250);
    return () => { clearTimeout(timer); task.abort(); };
  }, [host, candidates, query, searching, searchRetry]);
  const matches = searching ? searchState.matches : filterNotes(entries, filter, query).map(entry => ({ entry, snippet: '', label: '', target: undefined }));
  const open = async (path: string, target?: NoteTarget) => {
    if (opening) return;
    setOpening(path); setError('');
    try { await host.open(path, target); } catch (e) { setError((e as Error).message); }
    finally { setOpening(null); }
  };
  const action = async (task: () => Promise<void>) => {
    setError(''); try { await task(); } catch (e) { setError((e as Error).message); }
  };

  return <div className="ink-workspace ink-library">
    <header className="ink-library-heading">
      <div><span className="ink-library-brand">页墨手记 PageInk</span><h1>笔记库</h1><p>文字、手写与想法，都从这里继续。</p></div>
      <div className="ink-library-actions"><button type="button" onClick={() => void action(() => host.daily())} title="打开 PageInk Daily 中今天的文字笔记"><InkIcon name="docText"/>今日记录</button><button type="button" className="ink-library-create" onClick={() => host.create()}><InkIcon name="plus"/>新建笔记</button></div>
    </header>
    <div className="ink-library-controls">
      <label className="ink-library-search"><InkIcon name="search"/><input type="search" aria-label="搜索笔记" placeholder={fullText ? '搜索名称、正文或属性' : '搜索名称或路径'} value={query} onChange={e => setQuery(e.target.value)}/></label>
      <div className="ink-library-search-options"><label><input type="checkbox" checked={fullText} onChange={e => setFullText(e.target.checked)}/>搜索正文与属性</label><span>含 PDF 文本层，暂不识别手写</span><button type="button" onClick={() => host.quickOpen()}>快速打开…</button></div>
      <div className="ink-library-filters" role="group" aria-label="笔记类型">
        {filters.map(item => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}
      </div>
    </div>
    <div className="ink-library-caption"><span>{searching ? '搜索结果 · 最近修改' : '最近修改'}</span><span role="status" aria-live="polite">{loading ? '正在读取笔记…' : searching && searchStatus === 'running' ? `已搜索 ${searchState.done}/${searchState.total} · 找到 ${matches.length} 个文件` : `${matches.length} 个文件${searching && searchStatus === 'canceled' ? ' · 已停止，结果不完整' : ''}`}</span>
      {searching && <button type="button" onClick={() => { if (searchStatus === 'running') { searchTask.current?.abort(); setSearchStatus('canceled'); } else setSearchRetry(n => n + 1); }}>{searchStatus === 'running' ? '停止搜索' : '重新搜索'}</button>}
    </div>
    {error && <div className="ink-library-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRetry(n => n + 1)}>重新读取</button></div>}
    <div className="ink-library-scroll" aria-busy={loading || searching && searchStatus === 'running'}>
      {searching && !!searchState.issues.length && <details className="ink-library-issues"><summary>{searchState.issues.length} 个文件未能完整搜索</summary><ul>{searchState.issues.map(issue => <li key={issue.path}><strong>{issue.path}</strong>：{issue.message}</li>)}</ul></details>}
      {!loading && !matches.length && (!searching || searchStatus !== 'running') && <div className="ink-library-empty"><InkIcon name="notebook"/><h2>{searching && searchStatus === 'canceled' ? '搜索已停止' : query ? '没有找到匹配的笔记' : '还没有这类笔记'}</h2><p>{query ? '试试较短的关键词或切换笔记类型；手写和扫描图片还不能按内容搜索。' : '新建一份文字笔记、手写笔记本，或自由画布。'}</p><button type="button" onClick={() => query ? setQuery('') : host.create()}>{query ? '清除搜索' : '新建笔记'}</button></div>}
      <ul className="ink-library-list" aria-label="笔记列表">
        {matches.slice(0, limit).map(({ entry, snippet, label, target }) => <li key={entry.path} className="ink-library-row">
          <button type="button" className={`ink-library-note ink-note-${entry.kind}`} disabled={!!opening} onClick={() => void open(entry.path, target)} title={entry.path}>
            <span className="ink-library-note-icon">{opening === entry.path ? <span className="ink-spinner"/> : <InkIcon name={icons[entry.kind]}/>}</span>
            <span className="ink-library-note-name"><strong>{entry.name}</strong><small>{entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '笔记库根目录'}</small>{snippet && <><small className="ink-library-snippet">{snippet}</small><small>{label}</small></>}{entry.kind === 'unavailable' && <small className="ink-library-note-issue">{entry.detail}</small>}</span>
            <span className="ink-library-note-kind">{NOTE_LABELS[entry.kind]}{entry.kind !== 'unavailable' && entry.detail ? ` · ${entry.detail}` : ''}</span>
            <time dateTime={new Date(entry.modified).toISOString()}>{new Date(entry.modified).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
            <InkIcon name="right"/>
          </button>
          {['text', 'pages', 'canvas'].includes(entry.kind) && <button type="button" className="ink-library-properties" aria-label={`编辑属性：${entry.name}`} title="笔记属性" onClick={() => void action(() => host.properties(entry.path))}><InkIcon name="sliders"/></button>}
        </li>)}
      </ul>
      {matches.length > limit && <button type="button" className="ink-library-load" onClick={() => setLimit(n => n + 60)}>继续显示（剩余 {matches.length - limit} 个）</button>}
    </div>
  </div>;
}

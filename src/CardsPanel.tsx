import React, { useEffect, useRef, useState } from 'react';
import { Element } from './model';
import { cardReference, cardTitle } from './cards';
import { ViewStore, useView, toScreen } from './view';

export function CardsPanel({ elements, selected, busy, onInsertText, onInsertInk, onEdit, onRefresh, onRecover, onReveal, onConnect, onGroup, onUngroup }: {
  elements: readonly Element[]; selected: readonly Element[]; busy: boolean;
  onInsertText(): void; onInsertInk(): void; onEdit(e: Element): void; onRefresh(e: Element): void; onRecover(e: Element): void; onReveal(e: Element): void;
  onConnect(): void; onGroup(): void; onUngroup(): void;
}) {
  const cards = elements.filter(e => !e.isDeleted && cardReference(e)), selectedCards = selected.filter(e => cardReference(e));
  return <div className="ink-cards-panel" aria-busy={busy}>
    <div className="ink-popover-title">画板卡片</div>
    <p className="ink-popover-note">把文字与手写放在一起，拖动整理，连接想法。</p>
    <div className="ink-mixed-actions">
      <button type="button" className="mod-cta" disabled={busy} onClick={onInsertText}>插入文字卡片</button>
      <button type="button" disabled={busy} onClick={onInsertInk}>插入手写卡片</button>
    </div>
    {selected.length > 0 && <div className="ink-card-selection">
      <span>已选 {selectedCards.length} 张卡片</span>
      <button type="button" disabled={busy || selectedCards.length !== 2} onClick={onConnect}>连接所选卡片</button>
      <button type="button" disabled={busy || selected.length < 2} onClick={onGroup}>组合所选</button>
      <button type="button" disabled={busy || !selected.some(e => e.groupIds.length)} onClick={onUngroup}>取消组合</button>
    </div>}
    {!cards.length && <p className="ink-mixed-empty">先放入一张卡片。双击文字卡片，就能在这里修改段落。</p>}
    <ol className="ink-mixed-list">{cards.map(e => <li key={e.id}>
      <button type="button" className="ink-card-list-title" onClick={() => onReveal(e)}>{cardTitle(e, elements)}</button>
      <small>{cardReference(e)?.kind === 'ink' ? '手写区域 · 含完整原件备份' : '共享文字段落'}</small>
      <div className="ink-mixed-row-actions">
        <button type="button" disabled={busy} onClick={() => onEdit(e)}>{cardReference(e)?.kind === 'ink' ? '打开手写原件' : '在卡片内编辑'}</button>
        <button type="button" disabled={busy} onClick={() => onRefresh(e)}>更新卡片</button>
        {cardReference(e)?.kind === 'ink' && <button type="button" disabled={busy} onClick={() => onRecover(e)}>恢复引用时的原件</button>}
      </div>
    </li>)}</ol>
    <p className="ink-popover-note">原件修改后，点「更新卡片」载入。选择两张卡片可连线；框选后可组合移动。</p>
  </div>;
}

/** A temporary paragraph draft; the native Markdown editor applies the final transaction. */
export function CardEditor({ root, source, text, views, onSave, onClose, bindKeys }: {
  root: Element; source: string; text: string; views: ViewStore; onSave(text: string): Promise<void>; onClose(): void;
  bindKeys(element: HTMLElement, submit: () => void): () => void;
}) {
  const [draft, setDraft] = useState(text), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null), submitting = useRef(false);
  const submitLatest = useRef<() => Promise<void>>();
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => bindKeys(input.current!.closest<HTMLElement>('.ink-card-editor')!, () => void submitLatest.current?.()), []);
  const position = useView(views, view => { const [x, y] = toScreen(view, root.x, root.y); return `${x},${y},${view.width},${view.height}`; });
  const [x, y, width, height] = position.split(',').map(Number), panelWidth = Math.min(480, Math.max(1, width - 24));
  const save = async () => {
    if (submitting.current) return; submitting.current = true; setBusy(true); setError('');
    try { await onSave(draft); onClose(); } catch (error) { setError((error as Error).message); }
    finally { submitting.current = false; setBusy(false); }
  };
  submitLatest.current = save;
  return <section className="ink-card-editor" role="dialog" aria-label="编辑卡片段落" aria-busy={busy}
    style={{ left: Math.max(12, Math.min(x, width - panelWidth - 12)), top: Math.max(64, Math.min(y, height - 360)), width: panelWidth, maxHeight: Math.max(120, height - 80) }}
    onKeyDownCapture={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && (event.key === 'Enter' || event.key.toLowerCase() === 's')) { event.preventDefault(); void save(); }
      if (event.key === 'Escape') { event.preventDefault(); if (draft === text && !busy) onClose(); }
    }}>
    <header><strong>编辑卡片段落</strong></header>
    <small title={source}>{source}</small>
    <label>段落正文<textarea ref={input} value={draft} onChange={event => setDraft(event.target.value)} disabled={busy} spellCheck={false}/></label>
    {error && <p role="alert" className="ink-card-error">{error}</p>}
    <footer><span>Ctrl / ⌘ + Enter 提交</span><button type="button" disabled={busy} onClick={onClose}>{draft === text ? '关闭' : '放弃草稿'}</button><button type="button" className="mod-cta" disabled={busy} onClick={() => void save()}>{busy ? '正在保存…' : '保存到原文'}</button></footer>
  </section>;
}

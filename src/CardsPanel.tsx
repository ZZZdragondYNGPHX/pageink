import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Element } from './model';
import { cardReference, cardTitle } from './cards';
import { ViewStore, useView, toScreen } from './view';
import { IconButton, InkIcon } from './InkIcon';
import { isImeComposing } from './ui';

export function CardsPanel({ elements, selected, busy, onInsertText, onInsertInk, onEdit, onRefresh, onRecover, onReveal, onConnect, onGroup, onUngroup, onHoverCard }: {
  elements: readonly Element[]; selected: readonly Element[]; busy: boolean;
  onInsertText: () => void; onInsertInk: () => void; onEdit: (e: Element) => void; onRefresh: (e: Element) => void; onRecover: (e: Element) => void; onReveal: (e: Element) => void;
  onConnect: () => void; onGroup: () => void; onUngroup: () => void;
  onHoverCard?: (event: React.MouseEvent<HTMLElement>, element: Element) => void;
}) {
  const cards = elements.filter(e => !e.isDeleted && cardReference(e)), selectedCards = selected.filter(e => cardReference(e));
  return <div className="ink-cards-panel" aria-busy={busy}>
    <div className="ink-popover-title">画布卡片</div>
    <p className="ink-popover-note">把文字与手写放在一起，拖动整理，连接想法。</p>
    <div className="ink-mixed-actions">
      <button type="button" className="mod-cta" disabled={busy} onClick={onInsertText}><InkIcon name="docText"/>插入文字卡片</button>
      <button type="button" disabled={busy} onClick={onInsertInk}><InkIcon name="pen"/>插入手写卡片</button>
    </div>
    {selected.length > 0 && <div className="ink-card-selection">
      <span>已选 {selectedCards.length} 张卡片</span>
      <button type="button" disabled={busy || selectedCards.length !== 2} onClick={onConnect}><InkIcon name="arrow"/>连接所选卡片</button>
      <button type="button" disabled={busy || selected.length < 2} onClick={onGroup}><InkIcon name="group"/>组合所选</button>
      <button type="button" disabled={busy || !selected.some(e => e.groupIds.length)} onClick={onUngroup}><InkIcon name="ungroup"/>取消组合</button>
    </div>}
    {!cards.length && <p className="ink-mixed-empty">先放入一张卡片。双击文字卡片，就能在这里修改段落。</p>}
    <ol className="ink-mixed-list">{cards.map(e => <li key={e.id}>
      <button type="button" className="ink-card-list-title" onClick={() => onReveal(e)} onMouseEnter={onHoverCard ? event => onHoverCard(event, e) : undefined}>{cardTitle(e, elements)}</button>
      <small>{cardReference(e)?.kind === 'ink' ? '手写区域 · 含完整原件备份' : '共享文字段落'}</small>
      <div className="ink-mixed-row-actions">
        <button type="button" disabled={busy} onClick={() => onEdit(e)}><InkIcon name={cardReference(e)?.kind === 'ink' ? 'external' : 'pen'}/>{cardReference(e)?.kind === 'ink' ? '打开手写原件' : '在卡片内编辑'}</button>
        <button type="button" disabled={busy} onClick={() => onRefresh(e)}><InkIcon name="relink"/>更新卡片</button>
        {cardReference(e)?.kind === 'ink' && <button type="button" disabled={busy} onClick={() => onRecover(e)}><InkIcon name="history"/>另存当时的原件副本</button>}
      </div>
    </li>)}</ol>
    <p className="ink-popover-note">原件修改后，点「更新卡片」载入。选择两张卡片可连线；框选后可组合移动。</p>
  </div>;
}

/** A temporary paragraph draft; the native Markdown editor applies the final transaction. */
export function CardEditor({ root, source, text, views, onSave, onClose, bindKeys, onHoverSource }: {
  root: Element; source: string; text: string; views: ViewStore; onSave: (text: string) => Promise<void>; onClose: () => void;
  bindKeys: (element: HTMLElement, submit: () => void) => () => void;
  onHoverSource?: (event: React.MouseEvent<HTMLElement>) => void;
}) {
  const [draft, setDraft] = useState(text), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [visibleHeight, setVisibleHeight] = useState<number | null>(null);
  const sectionRef = useRef<HTMLElement>(null), input = useRef<HTMLTextAreaElement>(null), keepEditing = useRef<HTMLButtonElement>(null), submitting = useRef(false);
  const submitLatest = useRef<() => Promise<void>>();
  const dirty = draft !== text;
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { if (confirmDiscard && dirty) keepEditing.current?.focus(); }, [confirmDiscard, dirty]);
  useEffect(() => bindKeys(sectionRef.current!, () => void submitLatest.current?.()), []);
  useLayoutEffect(() => {
    const el = sectionRef.current;
    const win = el?.ownerDocument.defaultView ?? window;
    const vv = win.visualViewport;
    if (!vv) return;
    const sync = () => {
      const parent = el?.parentElement?.getBoundingClientRect();
      if (!parent || parent.height <= 0) return;
      const next = Math.max(0, Math.round(vv.offsetTop + vv.height - parent.top));
      setVisibleHeight(prev => prev === next ? prev : next);
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    win.addEventListener('resize', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      win.removeEventListener('resize', sync);
    };
  }, []);
  const position = useView(views, view => { const [x, y] = toScreen(view, root.x, root.y); return `${x},${y},${view.width},${view.height}`; });
  const [x, y, width, height] = position.split(',').map(Number), panelWidth = Math.min(480, Math.max(1, width - 24));
  const effectiveHeight = visibleHeight === null ? height : Math.min(height, visibleHeight);
  const topMin = effectiveHeight < 460 ? 12 : 64;
  const preferredHeight = Math.min(360, Math.max(120, effectiveHeight - topMin - 16));
  const top = Math.max(topMin, Math.min(y, effectiveHeight - preferredHeight - 12));
  const maxHeight = Math.max(120, effectiveHeight - top - 12);
  const requestClose = () => {
    if (busy) return;
    if (!dirty) { onClose(); return; }
    setConfirmDiscard(true);
  };
  const save = async () => {
    if (submitting.current) return; submitting.current = true; setBusy(true); setError(''); setConfirmDiscard(false);
    try { await onSave(draft); onClose(); } catch (error) { setError((error as Error).message); }
    finally { submitting.current = false; setBusy(false); }
  };
  submitLatest.current = save;
  return <section ref={sectionRef} className="ink-card-editor" role="dialog" aria-label="编辑卡片段落" aria-busy={busy}
    style={{ left: Math.max(12, Math.min(x, width - panelWidth - 12)), top, width: panelWidth, maxHeight }}
    onKeyDownCapture={event => {
      event.stopPropagation();
      if (isImeComposing(event)) return;
      if ((event.ctrlKey || event.metaKey) && (event.key === 'Enter' || event.key.toLowerCase() === 's')) { event.preventDefault(); void save(); }
      if (event.key === 'Escape') { event.preventDefault(); requestClose(); }
    }}>
    <header><strong>编辑卡片段落</strong><IconButton icon="close" label="关闭编辑" disabled={busy} onClick={requestClose}/></header>
    <small title={source} onMouseEnter={onHoverSource}>{source}</small>
    <label>段落正文<textarea ref={input} value={draft} onChange={event => { setDraft(event.target.value); if (confirmDiscard) setConfirmDiscard(false); }} disabled={busy} spellCheck={false}/></label>
    {error && <p role="alert" className="ink-card-error">{error}</p>}
    {confirmDiscard && dirty && <div className="pageink-properties-confirm" role="group" aria-label="放弃修改确认">
      <p>有未保存的段落修改。</p>
      <button ref={keepEditing} type="button" disabled={busy} onClick={() => { setConfirmDiscard(false); input.current?.focus(); }}>继续编辑</button>
      <button type="button" className="mod-warning" disabled={busy} onClick={onClose}>放弃修改</button>
    </div>}
    <footer><span>Ctrl / ⌘ + Enter 保存</span><button type="button" disabled={busy} onClick={requestClose}>{dirty ? '放弃修改' : '关闭'}</button><button type="button" className="mod-cta" disabled={busy} onClick={() => void save()}>{busy ? '正在保存…' : '保存到原文'}</button></footer>
  </section>;
}

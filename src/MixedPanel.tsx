import React from 'react';
import type { Element } from './model';
import { inkAnchor, textReference } from './mixed';
import { InkIcon } from './InkIcon';

export function MixedPanel({ elements, busy, selectionCount, readOnly, onInsert, onRefresh, onEdit, onAttach, onMove, onRemove, onDetach }: {
  elements: readonly Element[]; busy: boolean; selectionCount: number; readOnly: boolean;
  onInsert: () => void; onRefresh: () => void; onEdit: (element: Element) => void; onAttach: (element: Element) => void;
  onMove: (element: Element, direction: 'up' | 'down') => void; onRemove: (element: Element) => void; onDetach: () => void;
}) {
  const paragraphs = elements.filter(e => !e.isDeleted && textReference(e) && !(e.type === 'text' && e.containerId)).sort((a, b) => a.y - b.y);
  return <div className="ink-mixed-panel" aria-busy={busy}>
    <div className="ink-popover-title">本页文字段落</div>
    <p className="ink-popover-note">在原笔记中编辑，更新后段落批注一起移动。段内换行后请检查批注位置。</p>
    <div className="ink-mixed-actions">
      <button type="button" className="mod-cta" disabled={busy || readOnly} onClick={onInsert}><InkIcon name="plus"/>插入文字段落</button>
      <button type="button" disabled={busy || readOnly || !paragraphs.length} onClick={onRefresh}>更新本页文字</button>
    </div>
    {selectionCount > 0 && <div className="ink-mixed-selection" role="status">已选中 {selectionCount} 条笔迹，可绑定到下面的段落。<button type="button" disabled={busy || readOnly} onClick={onDetach}>解除所选绑定</button></div>}
    {!paragraphs.length && <p className="ink-mixed-empty">把一段文字放到纸上，再在旁边批注。</p>}
    <ol className="ink-mixed-list">{paragraphs.map((e, index) => {
      const reference = textReference(e)!, count = elements.filter(ink => !ink.isDeleted && inkAnchor(ink)?.elementId === e.id).length;
      return <li key={e.id}>
        <p>{e.type === 'text' ? e.originalText : ''}</p>
        <small title={reference.path}>{reference.path.split('/').pop()} · {count} 条绑定笔迹</small>
        <div className="ink-mixed-row-actions">
          <button type="button" disabled={busy} onClick={() => onEdit(e)}>编辑原文</button>
          <button type="button" disabled={busy || readOnly || !selectionCount} onClick={() => onAttach(e)}>绑定所选笔迹</button>
          <button type="button" aria-label={`上移段落 ${index + 1}`} disabled={busy || readOnly || index === 0} onClick={() => onMove(e, 'up')}>上移</button>
          <button type="button" aria-label={`下移段落 ${index + 1}`} disabled={busy || readOnly || index === paragraphs.length - 1} onClick={() => onMove(e, 'down')}>下移</button>
          <button type="button" disabled={busy || readOnly} onClick={() => onRemove(e)}>移除</button>
        </div>
      </li>;
    })}</ol>
    <p className="ink-popover-note">支持普通段落与标题，以纯文本排版；更新和移除均可撤销，原文由原生编辑器保存。</p>
  </div>;
}

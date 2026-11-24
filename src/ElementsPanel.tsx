import React, { useEffect, useState } from 'react';
import { exportToSvg } from '@excalidraw/excalidraw';
import type { SavedElementItem } from './elements-library';
import { IconButton, InkIcon } from './InkIcon';

const previewCache = new Map<string, string>();

function ElementPreview({ item }: { item: SavedElementItem }) {
  const [svgMarkup, setSvgMarkup] = useState<string>(() => previewCache.get(item.id) ?? '');
  useEffect(() => {
    const cached = previewCache.get(item.id);
    if (cached) { setSvgMarkup(cached); return; }
    let active = true;
    void exportToSvg({
      elements: item.elements,
      files: item.files,
      appState: { exportBackground: false, exportWithDarkMode: false },
      exportPadding: 8,
      skipInliningFonts: true,
    }).then(svg => {
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      const markup = svg.outerHTML;
      previewCache.set(item.id, markup);
      if (active) setSvgMarkup(markup);
    }).catch(() => {});
    return () => { active = false; };
  }, [item.id]);

  if (!svgMarkup) return <div className="ink-element-thumb is-loading"><InkIcon name="sticker"/></div>;
  return <div className="ink-element-thumb" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svgMarkup }}/>;
}

export function ElementsPanel({ items, canSave, onSaveCurrent, onInsert, onRemove }: {
  items: readonly SavedElementItem[];
  canSave: boolean;
  onSaveCurrent: () => void;
  onInsert: (item: SavedElementItem) => void;
  onRemove: (id: string) => void;
}) {
  return <div className="ink-elements-panel">
    <div className="ink-layers-head">
      <div className="ink-popover-title">常用元素库 ({items.length})</div>
      {canSave && <button type="button" className="ink-layers-unlock-all" onClick={onSaveCurrent}>存入当前选区</button>}
    </div>
    {!items.length ? <div className="ink-empty">
      <InkIcon name="sticker"/>
      <strong>收藏常用图形与公式</strong>
      <p>选中任意手写图形、坐标系或文本框后，点击操作栏「存为常用元素」，即可跨笔记一键复用。</p>
    </div> : <div className="ink-elements-grid">
      {items.map(item => <div key={item.id} className="ink-element-card">
        <button type="button" className="ink-element-insert" title={`插入「${item.name}」`} onClick={() => onInsert(item)}>
          <ElementPreview item={item}/>
          <span className="ink-element-name">{item.name}</span>
        </button>
        <IconButton icon="trash" label={`删除「${item.name}」`} className="ink-element-delete" onClick={() => { previewCache.delete(item.id); onRemove(item.id); }}/>
      </div>)}
    </div>}
  </div>;
}

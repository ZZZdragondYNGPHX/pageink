import React, { useEffect, useState } from 'react';
import { exportToSvg } from '@excalidraw/excalidraw';
import type { SavedElementItem } from './elements-library';
import { IconButton, InkIcon } from './InkIcon';

const MAX_PREVIEW_CACHE = 64;
const previewCache = new Map<string, string>();
function cachePreview(key: string, markup: string) {
  if (previewCache.has(key)) previewCache.delete(key);
  previewCache.set(key, markup);
  while (previewCache.size > MAX_PREVIEW_CACHE) {
    const oldest = previewCache.keys().next().value;
    if (oldest !== undefined) previewCache.delete(oldest);
  }
}

function ElementPreview({ item, dark }: { item: SavedElementItem; dark: boolean }) {
  const key = `${item.id}:${dark ? 1 : 0}`;
  const [svgMarkup, setSvgMarkup] = useState<string>(() => previewCache.get(key) ?? '');
  useEffect(() => {
    const cached = previewCache.get(key);
    if (cached) { setSvgMarkup(cached); return; }
    setSvgMarkup('');
    let active = true;
    void exportToSvg({
      elements: item.elements,
      files: item.files,
      appState: { exportBackground: false, exportWithDarkMode: dark },
      exportPadding: 8,
      skipInliningFonts: true,
    }).then(svg => {
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      const markup = svg.outerHTML;
      cachePreview(key, markup);
      if (active) setSvgMarkup(markup);
    }).catch(() => {});
    return () => { active = false; };
  }, [key]);

  if (!svgMarkup) return <div className="ink-element-thumb is-loading"><InkIcon name="sticker"/></div>;
  return <div className="ink-element-thumb" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svgMarkup }}/>;
}

export function ElementsPanel({ items, dark = false, canSave, onSaveCurrent, onInsert, onRemove }: {
  items: readonly SavedElementItem[];
  dark?: boolean;
  canSave: boolean;
  onSaveCurrent: () => void;
  onInsert: (item: SavedElementItem) => void;
  onRemove: (id: string) => void;
}) {
  return <div className="ink-elements-panel">
    <div className="ink-layers-head">
      <div className="ink-popover-title">常用元素库 ({items.length})</div>
      {canSave && <button type="button" className="ink-layers-unlock-all" onClick={onSaveCurrent}><InkIcon name="plus"/>存入当前选区</button>}
    </div>
    {!items.length ? <div className="ink-empty">
      <InkIcon name="sticker"/>
      <strong>收藏常用图形与公式</strong>
      <p>选中任意手写图形、坐标系或文本框后，点击操作栏「存为常用元素」，即可跨笔记一键复用。</p>
    </div> : <div className="ink-elements-grid">
      {items.map(item => <div key={item.id} className="ink-element-card">
        <button type="button" className="ink-element-insert" title={`插入「${item.name}」`} onClick={() => onInsert(item)}>
          <ElementPreview item={item} dark={dark}/>
          <span className="ink-element-name">{item.name}</span>
        </button>
        <IconButton icon="trash" label={`删除「${item.name}」`} className="ink-element-delete" onClick={() => { previewCache.delete(`${item.id}:0`); previewCache.delete(`${item.id}:1`); onRemove(item.id); }}/>
      </div>)}
    </div>}
  </div>;
}

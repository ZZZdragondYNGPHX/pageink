import React, { useEffect, useRef } from 'react';
import { EditorHandle } from './Editor';
export function PlacementOverlay({ editor, onPlace, onCancel }: { editor: () => EditorHandle | undefined; onPlace: (x: number, y: number) => void; onCancel: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.focus(); }, []);
  return <div ref={root} className="ink-selection-overlay" tabIndex={0} aria-label="点击放置可编辑内容" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }} onPointerDown={e => {
    if ((e.target as HTMLElement).closest('button') || e.pointerType === 'touch') return;
    const api = editor()?.api; if (!api) return;
    const rect = e.currentTarget.getBoundingClientRect(), state = api.getAppState();
    onPlace((e.clientX - rect.left) / state.zoom.value - state.scrollX, (e.clientY - rect.top) / state.zoom.value - state.scrollY);
  }}><div className="ink-selection-hint">点击正文放置<small>（原内容保留）</small><button onClick={onCancel}>取消</button></div></div>;
}

import React, { useEffect, useRef } from 'react';
import { IconButton, InkIcon } from './InkIcon';
import type { ScratchFrame } from './preferences';

const MIN = { width: 260, height: 200 };
/** Keeps at least the title bar reachable inside the area. */
export function containFrame(frame: ScratchFrame, area: { width: number; height: number }): ScratchFrame {
  const width = Math.max(MIN.width, Math.min(frame.width, area.width - 16)), height = Math.max(MIN.height, Math.min(frame.height, area.height - 16));
  return { width, height, right: Math.max(8, Math.min(frame.right, area.width - width - 8)), top: Math.max(8, Math.min(frame.top, area.height - height - 8)) };
}

export function ScratchWindow({ open, frame, area, onFrame, onClose, history, selection, children }: {
  open: boolean; frame: ScratchFrame; area: { width: number; height: number }; onFrame: (frame: ScratchFrame, done: boolean) => void; onClose: () => void;
  history: { canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void; clear: () => void };
  selection: { toBody: () => void; destination: string; remove: () => void; source?: () => void } | null;
  children: React.ReactNode;
}) {
  const drag = useRef<{ id: number; x: number; y: number; frame: ScratchFrame; resize: boolean } | null>(null);
  const shown = containFrame(frame, area);
  const latest = useRef(shown); latest.current = shown;
  useEffect(() => { if (open && (shown.right !== frame.right || shown.top !== frame.top || shown.width !== frame.width || shown.height !== frame.height)) onFrame(shown, false); }, [open, area.width, area.height]);
  const start = (resize: boolean) => (event: React.PointerEvent<HTMLElement>) => {
    if (drag.current || event.button !== 0) return;
    if (!resize && (event.target as HTMLElement).closest('button')) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, frame: latest.current, resize };
  };
  const move = (event: React.PointerEvent) => {
    const d = drag.current; if (d?.id !== event.pointerId) return;
    const dx = event.clientX - d.x, dy = event.clientY - d.y;
    onFrame(containFrame(d.resize ? { ...d.frame, width: d.frame.width - dx, height: d.frame.height + dy } : { ...d.frame, right: d.frame.right - dx, top: d.frame.top + dy }, area), false);
  };
  const end = (event: React.PointerEvent) => { if (drag.current?.id === event.pointerId) { drag.current = null; onFrame(latest.current, true); } };
  const nudge = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 40 : 16, f = latest.current;
    const moves: Record<string, Partial<ScratchFrame>> = { ArrowLeft: { right: f.right + step }, ArrowRight: { right: f.right - step }, ArrowUp: { top: f.top - step }, ArrowDown: { top: f.top + step } };
    if (event.target === event.currentTarget && moves[event.key]) { event.preventDefault(); onFrame(containFrame({ ...f, ...moves[event.key] }, area), true); }
  };
  const resizeWithKeys = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 40 : 16, f = latest.current;
    const sizes: Record<string, Partial<ScratchFrame>> = { ArrowLeft: { width: f.width + step }, ArrowRight: { width: f.width - step }, ArrowUp: { height: f.height - step }, ArrowDown: { height: f.height + step } };
    if (sizes[event.key]) { event.preventDefault(); onFrame(containFrame({ ...f, ...sizes[event.key] }, area), true); }
  };
  return <section className="ink-scratch" aria-label="草稿纸" hidden={!open} style={{ right: shown.right, top: shown.top, width: shown.width, height: shown.height }}>
    <header className="ink-scratch-bar" tabIndex={0} aria-label="草稿纸窗口，可拖动；聚焦后用方向键移动" onPointerDown={start(false)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={nudge}>
      <span className="ink-scratch-title"><InkIcon name="scratch"/>草稿纸</span>
      <span className="ink-scratch-actions">
        <IconButton icon="undo" label="撤销草稿纸" disabled={!history.canUndo} onClick={history.undo}/>
        <IconButton icon="redo" label="重做草稿纸" disabled={!history.canRedo} onClick={history.redo}/>
        <IconButton icon="trash" label="清空草稿纸（可撤销）" onClick={history.clear}/>
        <IconButton icon="close" label="收起草稿纸" onClick={onClose}/>
      </span>
    </header>
    <div className="ink-scratch-body">{children}
      {selection && <div className="ink-scratch-selection" role="toolbar" aria-label="草稿纸选区">
        <button type="button" className="is-primary" onClick={selection.toBody}><InkIcon name="toBody"/>复制到{selection.destination}</button>
        {selection.source && <button type="button" onClick={selection.source}><InkIcon name="locate"/>出处</button>}
        <IconButton icon="trash" label="删除" onClick={selection.remove}/>
      </div>}
    </div>
    <div className="ink-scratch-resize" role="button" tabIndex={0} aria-label="调整草稿纸大小，用方向键调整" onKeyDown={resizeWithKeys} onPointerDown={start(true)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}/>
  </section>;
}

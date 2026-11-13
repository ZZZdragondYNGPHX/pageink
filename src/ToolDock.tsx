import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { InkIcon } from './InkIcon';

type Dock = { x: number; y: number; edge: 'none' | 'left' | 'right' | 'top' | 'bottom'; collapsed: boolean };
type Drag = { id: number; x: number; y: number; baseX: number; baseY: number; nextX: number; nextY: number; active: boolean; previous: Dock | null };

/** Tool controls keep their own input; only the grip moves the toolbox. */
export function ToolDock({ layer, visible, onDrag, children }: { layer: HTMLDivElement | null; visible: boolean; onDrag: () => void; children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null), grip = useRef<HTMLButtonElement>(null);
  const [dock, setDock] = useState<Dock | null>(null), [dragging, setDragging] = useState(false);
  const latest = useRef(dock); latest.current = dock;
  const drag = useRef<Drag | null>(null), suppressClick = useRef(false);
  const contain = (value: Dock, anchor = true): Dock => {
    if (!layer || !root.current || root.current.hidden) return value;
    const maxX = Math.max(8, layer.clientWidth - root.current.offsetWidth - 8);
    const maxY = Math.max(8, layer.clientHeight - root.current.offsetHeight - 8);
    return { ...value,
      x: anchor && value.edge === 'right' ? maxX : anchor && value.edge === 'left' ? 8 : Math.max(8, Math.min(maxX, value.x)),
      y: anchor && value.edge === 'bottom' ? maxY : anchor && value.edge === 'top' ? 8 : Math.max(8, Math.min(maxY, value.y)),
    };
  };
  const place = () => {
    if (drag.current?.active || !root.current) return;
    root.current.style.transform = '';
    const value = latest.current;
    if (!value) return;
    const next = contain(value);
    if (next.x !== value.x || next.y !== value.y) setDock(next);
  };
  useLayoutEffect(place);
  useLayoutEffect(() => {
    if (!layer || !root.current) return;
    const observer = new ResizeObserver(place);
    observer.observe(layer); observer.observe(root.current);
    return () => observer.disconnect();
  }, [layer]);
  useEffect(() => {
    const element = grip.current!;
    // Match the scratch window's native isolation from Obsidian's mobile drawers.
    const isolate = (event: TouchEvent) => { event.stopPropagation(); if (event.type === 'touchmove' && event.cancelable) event.preventDefault(); };
    const events = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const;
    for (const type of events) element.addEventListener(type, isolate, { passive: false });
    return () => { drag.current = null; for (const type of events) element.removeEventListener(type, isolate); };
  }, []);
  const start = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || drag.current || !layer || !root.current) return;
    event.stopPropagation(); suppressClick.current = false;
    const bar = root.current.getBoundingClientRect(), area = layer.getBoundingClientRect();
    // Use local CSS coordinates even when Obsidian's interface is zoomed.
    const baseX = (bar.left - area.left) * layer.clientWidth / area.width;
    const baseY = (bar.top - area.top) * layer.clientHeight / area.height;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, baseX, baseY, nextX: baseX, nextY: baseY, active: false, previous: latest.current };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId || !layer || !root.current) return;
    const rect = layer.getBoundingClientRect();
    const dx = (event.clientX - d.x) * layer.clientWidth / rect.width, dy = (event.clientY - d.y) * layer.clientHeight / rect.height;
    if (!d.active) {
      if (Math.hypot(dx, dy) < 7) return;
      d.active = true; suppressClick.current = true; onDrag(); setDragging(true);
      setDock({ x: d.baseX, y: d.baseY, edge: d.previous?.edge ?? 'none', collapsed: d.previous?.collapsed ?? false });
    }
    event.preventDefault(); event.stopPropagation();
    const next = contain({ x: d.baseX + dx, y: d.baseY + dy, edge: 'none', collapsed: d.previous?.collapsed ?? false }, false);
    d.nextX = next.x; d.nextY = next.y;
    // Follow the pointer without rendering Workspace or relaying out the canvas on every move.
    root.current.style.transform = `translate(${next.x - d.baseX}px, ${next.y - d.baseY}px)`;
  };
  const finish = (cancelled: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (grip.current?.hasPointerCapture(d.id)) grip.current.releasePointerCapture(d.id);
    if (!d.active || !root.current || !layer) return;
    setDragging(false); root.current.style.transform = '';
    if (cancelled) { setDock(d.previous); return; }
    const distances = [
      { edge: 'left' as const, distance: d.nextX },
      { edge: 'right' as const, distance: layer.clientWidth - d.nextX - root.current.offsetWidth },
      { edge: 'top' as const, distance: d.nextY },
      { edge: 'bottom' as const, distance: layer.clientHeight - d.nextY - root.current.offsetHeight },
    ].sort((a, b) => a.distance - b.distance);
    const edge = distances[0].distance <= 54 ? distances[0].edge : 'none';
    if (edge === 'top' && Math.abs(d.nextX + root.current.offsetWidth / 2 - layer.clientWidth / 2) < 120) setDock(null);
    else setDock({ x: d.nextX, y: d.nextY, edge, collapsed: edge !== 'none' });
  };
  const end = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    event.stopPropagation(); finish(event.type !== 'pointerup');
  };
  useEffect(() => { if (!visible) finish(true); }, [visible]);
  const toggle = () => setDock(value => value ? { ...value, collapsed: !value.collapsed } : { x: 8, y: 64, edge: 'left', collapsed: true });
  const nudge = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
    if (event.key === 'Home') { event.preventDefault(); event.stopPropagation(); onDrag(); setDock(null); return; }
    const offsets: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const offset = offsets[event.key];
    if (!offset || !layer || !root.current) return;
    event.preventDefault(); event.stopPropagation(); onDrag();
    const bar = root.current.getBoundingClientRect(), area = layer.getBoundingClientRect(), step = event.shiftKey ? 40 : 16;
    const value = latest.current ?? { x: (bar.left - area.left) * layer.clientWidth / area.width, y: (bar.top - area.top) * layer.clientHeight / area.height, edge: 'none', collapsed: false };
    setDock(contain({ ...value, edge: 'none', x: value.x + offset[0] * step, y: value.y + offset[1] * step }, false));
  };
  return <div ref={root} hidden={!visible} className={`ink-writing-bar${dock ? ' is-floating-dock' : ''}${dock?.collapsed ? ' is-collapsed' : ''}${dragging ? ' is-dragging' : ''}`}
    data-edge={dock?.edge ?? 'none'} style={dock ? { left: dock.x, top: dock.y } : undefined}
    onPointerDownCapture={() => { if (!drag.current) suppressClick.current = false; }}
    onClickCapture={event => {
      if (suppressClick.current && event.detail > 0) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); return; }
      if (dock?.collapsed && !(event.target as HTMLElement).closest('.ink-dock-grip')) setDock({ ...dock, collapsed: false });
    }}>
    <button ref={grip} type="button" className="ink-dock-grip" aria-label={dock?.collapsed ? '展开笔盒' : '收起笔盒'} aria-expanded={!dock?.collapsed}
      title="拖动移动笔盒；方向键移动，Home 复位" onClick={toggle} onKeyDown={nudge}
      onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
      <InkIcon name="grip"/>
    </button>
    {children}
  </div>;
}

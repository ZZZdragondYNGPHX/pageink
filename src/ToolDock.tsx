import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { InkIcon } from './InkIcon';

type Dock = { x: number; y: number; edge: 'none' | 'left' | 'right' | 'top' | 'bottom'; collapsed: boolean };
type Drag = { id: number; x: number; y: number; pointerX: number; pointerY: number; baseX: number; baseY: number; nextX: number; nextY: number; active: boolean; previous: Dock | null };
const IDLE_DELAY = 8000;

/** Tool controls keep their own input; only the grip moves the toolbox. */
export function ToolDock({ layer, visible, onDrag, children }: { layer: HTMLDivElement | null; visible: boolean; onDrag: () => void; children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null), grip = useRef<HTMLButtonElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const [slotHeight, setSlotHeight] = useState(54);
  const [dock, setDock] = useState<Dock | null>(null), [dragging, setDragging] = useState(false);
  const latest = useRef(dock); latest.current = dock;
  const drag = useRef<Drag | null>(null), suppressClick = useRef(false);
  const idleTimer = useRef<number>(), pressed = useRef(false);
  const keyboardActive = useRef(false);
  const position = (): Dock | null => {
    if (latest.current) return latest.current;
    if (!layer || !root.current) return null;
    const bar = root.current.getBoundingClientRect(), area = layer.getBoundingClientRect();
    return { x: (bar.left - area.left) * layer.clientWidth / area.width, y: (bar.top - area.top) * layer.clientHeight / area.height, edge: 'none', collapsed: false };
  };
  const collapse = () => {
    const value = position();
    if (value) setDock({ ...value, collapsed: true });
  };
  const stopIdle = () => window.clearTimeout(idleTimer.current);
  const armIdle = () => {
    stopIdle();
    if (!visible || latest.current?.collapsed) return;
    idleTimer.current = window.setTimeout(() => {
      const doc = root.current?.ownerDocument;
      const keyboardFocus = root.current?.contains(doc?.activeElement ?? null) && (keyboardActive.current || doc?.activeElement?.matches(':focus-visible'));
      if (drag.current || pressed.current || keyboardFocus || doc?.visibilityState !== 'visible' || layer?.querySelector('.ink-popover, .ink-card-editor')) { armIdle(); return; }
      collapse();
    }, IDLE_DELAY);
  };
  useEffect(() => { armIdle(); return stopIdle; }, [layer, visible, dock?.collapsed]);
  useEffect(() => {
    const doc = root.current?.ownerDocument;
    const release = () => { if (pressed.current) { pressed.current = false; armIdle(); } };
    doc?.addEventListener('pointerup', release, true); doc?.addEventListener('pointercancel', release, true);
    return () => { doc?.removeEventListener('pointerup', release, true); doc?.removeEventListener('pointercancel', release, true); };
  }, [layer, visible, dock?.collapsed]);
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
    root.current.setCssStyles({ transform: '' });
    const value = latest.current;
    if (!value) {
      if (!root.current.hidden) setSlotHeight(root.current.offsetHeight + 8);
      return;
    }
    const next = contain(value);
    if (next.x !== value.x || next.y !== value.y) setDock(next);
  };
  useLayoutEffect(place);
  useLayoutEffect(() => {
    if (!layer || !root.current) return;
    const observer = new ResizeObserver(place);
    observer.observe(layer); observer.observe(root.current); if (slot.current) observer.observe(slot.current);
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
    stopIdle();
    event.stopPropagation(); suppressClick.current = false;
    const bar = root.current.getBoundingClientRect(), area = layer.getBoundingClientRect();
    // Use local CSS coordinates even when Obsidian's interface is zoomed.
    const baseX = (bar.left - area.left) * layer.clientWidth / area.width;
    const baseY = (bar.top - area.top) * layer.clientHeight / area.height;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, pointerX: (event.clientX - area.left) * layer.clientWidth / area.width, pointerY: (event.clientY - area.top) * layer.clientHeight / area.height, baseX, baseY, nextX: baseX, nextY: baseY, active: false, previous: latest.current };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId || !layer || !root.current) return;
    const rect = layer.getBoundingClientRect();
    const dx = (event.clientX - d.x) * layer.clientWidth / rect.width, dy = (event.clientY - d.y) * layer.clientHeight / rect.height;
    d.pointerX = (event.clientX - rect.left) * layer.clientWidth / rect.width;
    d.pointerY = (event.clientY - rect.top) * layer.clientHeight / rect.height;
    if (!d.active) {
      if (Math.hypot(dx, dy) < 7) return;
      d.active = true; suppressClick.current = true; onDrag(); setDragging(true);
      setDock({ x: d.baseX, y: d.baseY, edge: d.previous?.edge ?? 'none', collapsed: d.previous?.collapsed ?? false });
    }
    event.preventDefault(); event.stopPropagation();
    const next = contain({ x: d.baseX + dx, y: d.baseY + dy, edge: 'none', collapsed: d.previous?.collapsed ?? false }, false);
    d.nextX = next.x; d.nextY = next.y;
    // Follow the pointer without rendering Workspace or relaying out the canvas on every move.
    root.current.setCssStyles({ transform: `translate(${next.x - d.baseX}px, ${next.y - d.baseY}px)` });
  };
  const finish = (cancelled: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    armIdle();
    if (grip.current?.hasPointerCapture(d.id)) grip.current.releasePointerCapture(d.id);
    if (!d.active || !root.current || !layer) return;
    setDragging(false); root.current.setCssStyles({ transform: '' });
    if (cancelled) { setDock(d.previous); return; }
    const distances = [
      { edge: 'left' as const, distance: d.nextX },
      { edge: 'right' as const, distance: layer.clientWidth - d.nextX - root.current.offsetWidth },
      { edge: 'top' as const, distance: d.nextY },
      { edge: 'bottom' as const, distance: layer.clientHeight - d.nextY - root.current.offsetHeight },
    ].sort((a, b) => a.distance - b.distance);
    // The handle can reach a new edge even when the old vertical/horizontal palette is clamped.
    const pointerEdges = [
      { edge: 'left' as const, distance: d.pointerX }, { edge: 'right' as const, distance: layer.clientWidth - d.pointerX },
      { edge: 'top' as const, distance: d.pointerY }, { edge: 'bottom' as const, distance: layer.clientHeight - d.pointerY },
    ].sort((a, b) => a.distance - b.distance);
    const edge = pointerEdges[0].distance <= 54 ? pointerEdges[0].edge : distances[0].distance <= 54 ? distances[0].edge : 'none';
    setDock({ x: d.nextX, y: d.nextY, edge, collapsed: d.previous?.collapsed ?? false });
  };
  const end = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    event.stopPropagation(); finish(event.type !== 'pointerup');
  };
  useEffect(() => { if (!visible) finish(true); }, [visible]);
  const toggle = () => { if (latest.current?.collapsed) setDock({ ...latest.current, collapsed: false }); else collapse(); };
  const nudge = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
    if (event.key === 'Home') { event.preventDefault(); event.stopPropagation(); onDrag(); setDock(null); armIdle(); return; }
    const offsets: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const offset = offsets[event.key];
    if (!offset || !layer || !root.current) return;
    event.preventDefault(); event.stopPropagation(); onDrag();
    const bar = root.current.getBoundingClientRect(), area = layer.getBoundingClientRect(), step = event.shiftKey ? 40 : 16;
    const value = latest.current ?? { x: (bar.left - area.left) * layer.clientWidth / area.width, y: (bar.top - area.top) * layer.clientHeight / area.height, edge: 'none', collapsed: false };
    setDock(contain({ ...value, edge: 'none', x: value.x + offset[0] * step, y: value.y + offset[1] * step }, false));
  };
  return <div ref={slot} className="ink-dock-slot" hidden={!visible} style={{ height: slotHeight }}><div ref={root} hidden={!visible} className={`ink-writing-bar${dock ? ' is-floating-dock' : ''}${dock?.collapsed ? ' is-collapsed' : ''}${dragging ? ' is-dragging' : ''}`}
    data-edge={dock?.edge ?? 'none'} style={dock ? { left: dock.x, top: dock.y } : undefined}
    onPointerEnter={armIdle} onPointerLeave={armIdle}
    onPointerMoveCapture={armIdle} onWheelCapture={armIdle} onScrollCapture={armIdle}
    onFocusCapture={stopIdle} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) keyboardActive.current = false; armIdle(); }}
    onKeyDownCapture={() => { keyboardActive.current = true; stopIdle(); }}
    onPointerDownCapture={() => { keyboardActive.current = false; pressed.current = true; stopIdle(); if (!drag.current) suppressClick.current = false; }}
    onPointerUpCapture={() => { pressed.current = false; armIdle(); }} onPointerCancelCapture={() => { pressed.current = false; armIdle(); }}
    onLostPointerCapture={() => { pressed.current = false; armIdle(); }}
    onClickCapture={event => {
      if (suppressClick.current && event.detail > 0) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); return; }
      if (dock?.collapsed && !(event.target as HTMLElement).closest('.ink-dock-grip')) setDock({ ...dock, collapsed: false });
    }}>
    <button ref={grip} type="button" className="ink-dock-grip" aria-label={dock?.collapsed ? '展开笔盒' : '收起笔盒'} aria-expanded={!dock?.collapsed}
      title="拖动移动笔盒；方向键移动，Home 复位" onClick={toggle} onKeyDown={nudge}
      onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
      <InkIcon name={dock?.collapsed ? 'pen' : 'grip'}/>
    </button>
    <div className="ink-dock-content" hidden={dock?.collapsed}>{children}</div>
  </div></div>;
}

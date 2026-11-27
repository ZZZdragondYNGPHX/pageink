import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { InkIcon } from './InkIcon';
import { isolateFloatingInput } from './pointer-input';
import type { DockPlacement } from './preferences';
import { isImeComposing } from './ui';

type Dock = { x: number; y: number; edge: 'none' | 'left' | 'right' | 'top' | 'bottom'; collapsed: boolean };
type Drag = { id: number; x: number; y: number; pointerX: number; pointerY: number; baseX: number; baseY: number; nextX: number; nextY: number; active: boolean; previous: Dock | null };
const IDLE_DELAY = 8000;
const DEFAULT_DOCK_PREF: DockPlacement = { edge: 'none', rx: 0.5, ry: 0, collapsed: false };
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const isCustomDockPref = (pref: DockPlacement) => pref.edge !== 'none' || pref.collapsed || pref.rx !== 0.5 || pref.ry !== 0;

export interface WritingSignal {
  get(): boolean;
  subscribe(listener: () => void): () => void;
}

/** Tool controls keep their own input; only the grip moves the toolbox. */
export function ToolDock({ layer, visible, autoCollapse = false, writing = false, writingSignal, dockPref, onDockChange, onDrag, children }: {
  layer: HTMLDivElement | null; visible: boolean; autoCollapse?: boolean; writing?: boolean; writingSignal?: WritingSignal;
  dockPref?: DockPlacement; onDockChange?: (next: DockPlacement) => void; onDrag: () => void; children: React.ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null), grip = useRef<HTMLButtonElement>(null);
  const [dock, setDock] = useState<Dock | null>(null), [dragging, setDragging] = useState(false);
  const latest = useRef(dock); latest.current = dock;
  const dockPrefRef = useRef(dockPref); dockPrefRef.current = dockPref;
  const onDockChangeRef = useRef(onDockChange); onDockChangeRef.current = onDockChange;
  const restored = useRef(false);
  const autoCollapseRef = useRef(autoCollapse); autoCollapseRef.current = autoCollapse;
  const writingRef = useRef(writingSignal ? writingSignal.get() : writing);
  if (!writingSignal) writingRef.current = writing;
  const drag = useRef<Drag | null>(null), suppressClick = useRef(false);
  const idleTimer = useRef<number>(), pressed = useRef(false);
  const keyboardActive = useRef(false);
  const persistDock = (next: Dock | null) => {
    const emit = onDockChangeRef.current;
    if (!emit) return;
    if (!next) { emit({ ...DEFAULT_DOCK_PREF }); return; }
    if (!layer || !root.current) return;
    const maxX = Math.max(8, layer.clientWidth - root.current.offsetWidth - 8);
    const maxY = Math.max(8, layer.clientHeight - root.current.offsetHeight - 8);
    const rx = next.edge === 'left' ? 0 : next.edge === 'right' ? 1 : clamp01((next.x - 8) / Math.max(1, maxX - 8));
    const ry = next.edge === 'top' ? 0 : next.edge === 'bottom' ? 1 : clamp01((next.y - 8) / Math.max(1, maxY - 8));
    emit({ edge: next.edge, rx, ry, collapsed: next.collapsed });
  };
  const position = (): Dock | null => {
    if (latest.current) return latest.current;
    if (!layer || !root.current) return null;
    const bar = root.current.getBoundingClientRect(), area = layer.getBoundingClientRect();
    return { x: (bar.left - area.left) * layer.clientWidth / area.width, y: (bar.top - area.top) * layer.clientHeight / area.height, edge: 'none', collapsed: false };
  };
  const collapse = () => {
    const value = position();
    if (!value) return;
    const next = { ...value, collapsed: true };
    setDock(next);
    persistDock(next);
  };
  const stopIdle = () => window.clearTimeout(idleTimer.current);
  const armIdle = () => {
    stopIdle();
    if (!autoCollapseRef.current || !visible || latest.current?.collapsed || writingRef.current) return;
    idleTimer.current = window.setTimeout(() => {
      const doc = root.current?.ownerDocument;
      const keyboardFocus = root.current?.contains(doc?.activeElement ?? null) && (keyboardActive.current || doc?.activeElement?.matches(':focus-visible'));
      if (!autoCollapseRef.current || writingRef.current || drag.current || pressed.current || keyboardFocus || doc?.visibilityState !== 'visible' || (root.current?.closest('.ink-workspace') ?? layer)?.querySelector('.ink-popover, .ink-card-editor')) { armIdle(); return; }
      collapse();
    }, IDLE_DELAY);
  };
  useEffect(() => { armIdle(); return stopIdle; }, [layer, visible, dock?.collapsed, autoCollapse, writing]);
  useEffect(() => {
    if (!writingSignal) return;
    writingRef.current = writingSignal.get();
    armIdle();
    return writingSignal.subscribe(() => {
      writingRef.current = writingSignal.get();
      armIdle();
    });
  }, [writingSignal, layer, visible, dock?.collapsed, autoCollapse]);
  useEffect(() => {
    const doc = root.current?.ownerDocument;
    const release = () => { if (pressed.current) { pressed.current = false; armIdle(); } };
    doc?.addEventListener('pointerup', release, true); doc?.addEventListener('pointercancel', release, true);
    return () => { doc?.removeEventListener('pointerup', release, true); doc?.removeEventListener('pointercancel', release, true); };
  }, [layer, visible, dock?.collapsed, autoCollapse, writing]);
  const contain = (value: Dock, anchor = true): Dock => {
    if (!layer || !root.current || root.current.hidden) return value;
    const maxX = Math.max(8, layer.clientWidth - root.current.offsetWidth - 8);
    const maxY = Math.max(8, layer.clientHeight - root.current.offsetHeight - 8);
    const verticalDock = anchor && !value.collapsed && (value.edge === 'left' || value.edge === 'right');
    const minY = verticalDock ? Math.min(12, maxY) : 8;
    const clampedMaxY = verticalDock ? Math.max(minY, Math.min(maxY, layer.clientHeight - root.current.offsetHeight - 60)) : maxY;
    return { ...value,
      x: anchor && value.edge === 'right' ? maxX : anchor && value.edge === 'left' ? 8 : Math.max(8, Math.min(maxX, value.x)),
      y: anchor && value.edge === 'bottom' ? maxY : anchor && value.edge === 'top' ? 8 : Math.max(minY, Math.min(clampedMaxY, value.y)),
    };
  };
  const tryRestore = () => {
    if (restored.current || !visible || !layer || !root.current || root.current.hidden) return false;
    if (layer.clientWidth <= 0 || layer.clientHeight <= 0) return false;
    const barWidth = root.current.offsetWidth, barHeight = root.current.offsetHeight;
    if (barWidth <= 0 || barHeight <= 0) return false;
    restored.current = true;
    const pref = dockPrefRef.current;
    if (!pref || !isCustomDockPref(pref)) return false;
    const maxX = Math.max(8, layer.clientWidth - barWidth - 8);
    const maxY = Math.max(8, layer.clientHeight - barHeight - 8);
    const x = 8 + clamp01(pref.rx) * Math.max(0, maxX - 8);
    const y = 8 + clamp01(pref.ry) * Math.max(0, maxY - 8);
    setDock(contain({ x, y, edge: pref.edge, collapsed: pref.collapsed }));
    return true;
  };
  const place = () => {
    if (drag.current?.active || !root.current) return;
    root.current.setCssStyles({ transform: '' });
    if (tryRestore()) return;
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
    const dispose = isolateFloatingInput(grip.current!);
    return () => { drag.current = null; dispose(); };
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
    const next: Dock = { x: d.nextX, y: d.nextY, edge, collapsed: d.previous?.collapsed ?? false };
    setDock(next);
    persistDock(next);
  };
  const end = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    event.stopPropagation(); finish(event.type !== 'pointerup');
  };
  useEffect(() => { if (!visible) finish(true); }, [visible]);
  const toggle = () => {
    if (latest.current?.collapsed) {
      const next = { ...latest.current, collapsed: false };
      setDock(next);
      persistDock(next);
    } else collapse();
  };
  const nudge = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
    if (event.key === 'Home') { event.preventDefault(); event.stopPropagation(); onDrag(); setDock(null); persistDock(null); armIdle(); return; }
    const offsets: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const offset = offsets[event.key];
    if (!offset || !layer || !root.current) return;
    event.preventDefault(); event.stopPropagation(); onDrag();
    const bar = root.current.getBoundingClientRect(), area = layer.getBoundingClientRect(), step = event.shiftKey ? 40 : 16;
    const value = latest.current ?? { x: (bar.left - area.left) * layer.clientWidth / area.width, y: (bar.top - area.top) * layer.clientHeight / area.height, edge: 'none', collapsed: false };
    const next = contain({ ...value, edge: 'none', x: value.x + offset[0] * step, y: value.y + offset[1] * step }, false);
    setDock(next);
    persistDock(next);
  };
  return <div className="ink-dock-slot" hidden={!visible}><div ref={root} hidden={!visible} className={`ink-writing-bar${dock ? ' is-floating-dock' : ''}${dock?.collapsed ? ' is-collapsed' : ''}${dragging ? ' is-dragging' : ''}`}
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
      if (dock?.collapsed && !(event.target as HTMLElement).closest('.ink-dock-grip')) {
        const next = { ...dock, collapsed: false };
        setDock(next);
        persistDock(next);
      }
    }}>
    <button ref={grip} type="button" className="ink-dock-grip" aria-label={dock?.collapsed ? '展开笔盒' : '收起笔盒'} aria-expanded={!dock?.collapsed}
      title="拖动移动笔盒；方向键移动，Home 复位" onClick={toggle} onKeyDown={nudge}
      onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
      <InkIcon name={dock?.collapsed ? 'pen' : 'grip'}/>
    </button>
    <div className="ink-dock-content" hidden={dock?.collapsed}>{children}</div>
  </div></div>;
}

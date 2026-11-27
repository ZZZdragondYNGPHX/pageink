import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { exportToSvg, getCommonBounds, getFreeDrawSvgPath } from '@excalidraw/excalidraw';
import type { Element, Rect } from './model';
import { pageRect } from './model';
import { bounds, isHighlighterElement, type ScenePoint } from './geometry';
import type { InkApi } from './kernel-api';
import type { Session } from './session';
import type { PdfService } from './pdf';
import type { CanvasHandle } from './InkCanvas';
import type { Preferences, ToolId } from './preferences';
import { placementAt } from './layout';
import { templateDots, templateLines, templateSpec } from './templates';
import { toScreen, useView, View, ViewStore } from './view';
import { InkStabilizer } from './ink-input';
import { IconButton, InkIcon } from './InkIcon';
import { Segmented, Switch } from './ui';
import { isolateFloatingInput } from './pointer-input';
import {
  advanceZoomBox,
  buildZoomFreedrawElement,
  clampZoomBox,
  newlineZoomBox,
  shouldAutoAdvance,
  zoomBoxSize,
  zoomCanvasToScene,
  ZoomFactor,
} from './zoom-window';

interface LiveStroke {
  id?: string;
  seq: number;
  committing?: boolean;
  path2d?: Path2D;
  pathCount?: number;
  elX?: number;
  elY?: number;
  points: ScenePoint[];
  rawPoints?: ScenePoint[];
  rawPressures?: number[];
  pressures: number[];
  color: string;
  width: number;
  opacity: number;
  inkKind: 'pen' | 'highlighter';
  usePressure: boolean;
}

const committedPathCache = new WeakMap<Element, { version: number; path: Path2D }>();

function getCommittedFreedrawPath(el: Extract<Element, { type: 'freedraw' }>): Path2D | null {
  const cached = committedPathCache.get(el);
  if (cached && cached.version === el.version) return cached.path;
  const d = getFreeDrawSvgPath(el);
  if (!d) return null;
  const path = new Path2D(d);
  committedPathCache.set(el, { version: el.version, path });
  return path;
}

function buildLiveStrokePath(stroke: LiveStroke): { path: Path2D; x: number; y: number } | null {
  if (!stroke.points.length) return null;
  if (stroke.path2d && stroke.pathCount === stroke.points.length && stroke.elX !== undefined && stroke.elY !== undefined) {
    return { path: stroke.path2d, x: stroke.elX, y: stroke.elY };
  }
  let minX = Infinity, minY = Infinity;
  for (const [x, y] of stroke.points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  }
  const localPoints: [number, number][] = stroke.points.map(([x, y]) => [x - minX, y - minY]);
  if (localPoints.length === 1) localPoints.push([0.01, 0.01]);
  const pressures = !stroke.usePressure
    ? localPoints.map(() => 0.5)
    : localPoints.map((_, i) => stroke.pressures[Math.min(i, stroke.pressures.length - 1)] ?? 0.5);
  const d = getFreeDrawSvgPath({
    type: 'freedraw',
    points: localPoints,
    pressures,
    strokeWidth: stroke.width,
    simulatePressure: false,
    lastCommittedPoint: null,
  } as unknown as Parameters<typeof getFreeDrawSvgPath>[0]);
  if (!d) return null;
  const path = new Path2D(d);
  stroke.path2d = path;
  stroke.pathCount = stroke.points.length;
  stroke.elX = minX;
  stroke.elY = minY;
  return { path, x: minX, y: minY };
}

function readPressure(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0.5;
}

function darkPreviewColor(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.25 ? '#e4e7ec' : hex;
}

/** Draggable translucent target frame shown on the main canvas when Zoom Window is open. */
export function ZoomBoxOverlay({ views, box, liveRef, syncRef, onLiveMove, autoAdvance, onChange }: {
  views: ViewStore;
  box: Rect;
  liveRef?: React.MutableRefObject<Rect>;
  syncRef?: React.MutableRefObject<((next: Rect) => void) | null>;
  onLiveMove?: () => void;
  autoAdvance: boolean;
  onChange: (next: Rect) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const screen = useView(views, (v: View) => {
    const [x, y] = toScreen(v, box.x, box.y);
    return `${x},${y},${box.width * v.zoom},${box.height * v.zoom},${v.zoom}`;
  });
  const [sx, sy, sw, sh, zoom] = screen.split(',').map(Number);
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const latestBox = useRef(box); latestBox.current = box;
  const drag = useRef<{ id: number; startX: number; startY: number; lastX: number; lastY: number; origin: Rect; next: Rect } | null>(null);

  useEffect(() => isolateFloatingInput(boxRef.current!), []);
  useEffect(() => {
    if (!syncRef) return;
    const sync = (next: Rect) => {
      const el = boxRef.current;
      if (!el) return;
      const dx = (next.x - latestBox.current.x) * zoomRef.current;
      const dy = (next.y - latestBox.current.y) * zoomRef.current;
      el.setCssStyles({ transform: `translate3d(${dx}px, ${dy}px, 0)` });
    };
    syncRef.current = sync;
    return () => { if (syncRef.current === sync) syncRef.current = null; };
  }, [syncRef]);
  useLayoutEffect(() => {
    if (drag.current) {
      drag.current = {
        ...drag.current,
        startX: drag.current.lastX,
        startY: drag.current.lastY,
        origin: box,
        next: box,
      };
    }
    if (liveRef) liveRef.current = box;
    boxRef.current?.setCssStyles({ transform: '' });
  }, [box, liveRef]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button > 0) return;
    event.stopPropagation();
    event.preventDefault();
    if (drag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, origin: latestBox.current, next: latestBox.current };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    event.stopPropagation();
    d.lastX = event.clientX;
    d.lastY = event.clientY;
    const dx = event.clientX - d.startX, dy = event.clientY - d.startY;
    const z = Math.max(0.05, zoomRef.current);
    d.next = { ...d.origin, x: d.origin.x + dx / z, y: d.origin.y + dy / z };
    if (liveRef) liveRef.current = d.next;
    onLiveMove?.();
    boxRef.current?.setCssStyles({ transform: `translate3d(${dx}px, ${dy}px, 0)` });
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    event.stopPropagation();
    drag.current = null;
    boxRef.current?.setCssStyles({ transform: '' });
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled) {
      if (liveRef) liveRef.current = d.origin;
      onLiveMove?.();
      return;
    }
    if (d.next.x !== d.origin.x || d.next.y !== d.origin.y) onChange(d.next);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const step = (event.shiftKey ? 36 : 12) / Math.max(0.25, zoom);
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (!moves[event.key]) return;
    event.preventDefault(); event.stopPropagation();
    const [dx, dy] = moves[event.key];
    onChange({ ...box, x: box.x + dx, y: box.y + dy });
  };

  return <div
    ref={boxRef}
    className="ink-zoom-target-box"
    tabIndex={0}
    style={{ left: sx, top: sy, width: Math.max(24, sw), height: Math.max(16, sh) }}
    onKeyDown={onKeyDown}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={e => endDrag(e, false)}
    onPointerCancel={e => endDrag(e, true)}
    onLostPointerCapture={e => endDrag(e, false)}
    role="region"
    aria-label="放大书写取景框（拖动或方向键调整位置）"
  >
    {autoAdvance && <div className="ink-zoom-target-zone" aria-hidden="true"/>}
  </div>;
}

/**
 * Single-source-of-truth zoomed handwriting strip docked at the bottom of the canvas.
 * Maps high-DPR 2D input 1-to-1 into main scene coordinates and commits strokes directly into `handle`.
 */
export function ZoomWindow({
  session,
  pdf,
  handle,
  paged,
  tool,
  prefs,
  dark,
  nightPaper,
  box,
  liveBoxRef,
  paintRef,
  boxOverlaySyncRef,
  factor,
  autoAdvance,
  onBoxChange,
  onFactorChange,
  onAutoAdvanceChange,
  onSwitchToPen,
  onWritingChange,
  onClose,
  onEraseEnd,
}: {
  session: Session;
  pdf?: PdfService;
  handle: CanvasHandle;
  paged: boolean;
  tool: ToolId;
  prefs: Preferences;
  dark: boolean;
  nightPaper: boolean;
  box: Rect;
  liveBoxRef?: React.MutableRefObject<Rect>;
  paintRef?: React.MutableRefObject<(() => void) | null>;
  boxOverlaySyncRef?: React.MutableRefObject<((next: Rect) => void) | null>;
  factor: ZoomFactor;
  autoAdvance: boolean;
  onBoxChange: (next: Rect) => void;
  onFactorChange: (next: ZoomFactor) => void;
  onAutoAdvanceChange: (next: boolean) => void;
  onSwitchToPen?: () => void;
  onWritingChange?: (writing: boolean) => void;
  onClose: () => void;
  onEraseEnd?: () => void;
}) {
  const windowRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const backdropRef = useRef<HTMLCanvasElement | null>(null);
  const backdropBoxRef = useRef<Rect | null>(null);
  const [stripSize, setStripSize] = useState({ width: 640, height: 180 });
  const [sceneTick, setSceneTick] = useState(0);
  const [advancing, setAdvancing] = useState(false);
  const activeStroke = useRef<LiveStroke | null>(null);
  const pendingStrokes = useRef<LiveStroke[]>([]);
  const strokeSeq = useRef(0);
  const compositeFrame = useRef(0);
  const backdropTimer = useRef<number>();
  const pointerState = useRef<{
    id: number;
    mode: 'draw' | 'erase' | 'pan';
    stabilizer?: InkStabilizer;
    lastScreen?: [number, number];
    panOrigin?: Rect;
    panCurrent?: Rect;
    erasePath?: ScenePoint[];
  } | null>(null);
  const advanceTimer = useRef<number>();
  const backdropBusy = useRef(false);
  const backdropDirty = useRef(false);
  const backdropAbort = useRef<AbortController | null>(null);
  const unmounted = useRef(false);
  const latestRenderDeps = useRef({ paged, pdf, dark, session, handle });
  latestRenderDeps.current = { paged, pdf, dark, session, handle };
  const latestBox = useRef(box); latestBox.current = box;
  const latestSize = useRef(stripSize); latestSize.current = stripSize;
  const currentBox = () => liveBoxRef?.current ?? latestBox.current;
  const supported = tool === 'pen' || tool === 'highlighter' || tool === 'eraser' || tool === 'hand';
  const setZoomWriting = (active: boolean) => {
    session.setWriting('zoom', active);
    onWritingChange?.(active);
  };

  useEffect(() => isolateFloatingInput(windowRef.current!), []);

  const cancelAutoAdvance = () => {
    window.clearTimeout(advanceTimer.current);
    setAdvancing(false);
  };

  useEffect(() => {
    if (!autoAdvance) cancelAutoAdvance();
  }, [autoAdvance]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 40) {
        setStripSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const nextDim = zoomBoxSize(stripSize.width, stripSize.height, factor);
    if (Math.abs(nextDim.width - box.width) > 1 || Math.abs(nextDim.height - box.height) > 1) {
      onBoxChange({ ...box, width: nextDim.width, height: nextDim.height });
    }
  }, [stripSize.width, stripSize.height, factor]);

  useEffect(() => {
    const bump = () => {
      if (pendingStrokes.current.length) {
        // Read live IDs from session.surfaces first so undo/redo (which notifies listeners before handle.rebuild()) drops ghost strokes immediately.
        const liveIds = new Set<string>();
        for (const p of session.manifest.pages) {
          for (const e of session.surfaces.get(p.id) ?? []) if (!e.isDeleted) liveIds.add(e.id);
        }
        const next = pendingStrokes.current.filter(s => s.committing || !s.id || liveIds.has(s.id));
        if (next.length !== pendingStrokes.current.length) {
          pendingStrokes.current = next;
          paintComposite();
        }
      }
      setSceneTick(n => n + 1);
    };
    session.listeners.add(bump);
    return () => { session.listeners.delete(bump); };
  }, [session, handle]);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      backdropAbort.current?.abort();
      window.clearTimeout(advanceTimer.current);
      window.clearTimeout(backdropTimer.current);
      window.cancelAnimationFrame(compositeFrame.current);
      setZoomWriting(false);
    };
  }, []);

  function pageContextFor(target: Rect) {
    if (!paged) return { limit: undefined as Rect | undefined, lineStep: undefined as number | undefined };
    const placement = placementAt(handle.layout(), target.y + target.height / 2);
    const step = placement.page.pdfPage ? undefined : (placement.page.template === 'blank' ? undefined : templateSpec(placement.page.template).step * 2);
    return { limit: placement.paper, lineStep: step, placement };
  }

  function ensureBoxVisible(next: Rect) {
    const v = handle.views.get();
    const [left, top] = toScreen(v, next.x, next.y);
    const [right, bottom] = toScreen(v, next.x + next.width, next.y + next.height);
    const margin = 36;
    const stripReserve = 240;
    if (left < margin || right > v.width - margin || top < margin || bottom > v.height - stripReserve) {
      const targetCenterX = next.x + next.width / 2;
      const targetCenterY = next.y + next.height / 2;
      const visibleH = Math.max(120, v.height - stripReserve);
      handle.api.updateScene({
        appState: {
          scrollX: -(targetCenterX - v.width / v.zoom / 2),
          scrollY: -(targetCenterY - visibleH / v.zoom / 2),
        },
      });
    }
  }

  function stepBox(action: 'prev' | 'next' | 'newline') {
    cancelAutoAdvance();
    const cur = currentBox();
    const { limit, lineStep } = pageContextFor(cur);
    const next = action === 'newline'
      ? newlineZoomBox(cur, limit, lineStep)
      : advanceZoomBox(cur, limit, action === 'next' ? 1 : -1, lineStep);
    onBoxChange(next);
    ensureBoxVisible(next);
  }

  function drawBaseSurface(ctx: CanvasRenderingContext2D, w: number, h: number, targetBox: Rect) {
    ctx.fillStyle = dark ? '#1f2329' : paged ? '#e7e4de' : '#faf9f5';
    ctx.fillRect(0, 0, w, h);
    if (!paged) return;
    const scaleX = w / Math.max(1, targetBox.width), scaleY = h / Math.max(1, targetBox.height);
    const placements = handle.layout().placements.filter(p =>
      p.paper.x < targetBox.x + targetBox.width && p.paper.x + p.paper.width > targetBox.x &&
      p.paper.y < targetBox.y + targetBox.height && p.paper.y + p.paper.height > targetBox.y,
    );
    for (const p of placements) {
      const px = (p.paper.x - targetBox.x) * scaleX, py = (p.paper.y - targetBox.y) * scaleY;
      const pw = p.paper.width * scaleX, ph = p.paper.height * scaleY;
      ctx.fillStyle = p.page.pdfPage ? '#ffffff' : '#fcfbf7';
      ctx.fillRect(px, py, pw, ph);
      if (!p.page.pdfPage) {
        const localArea: Rect = { x: targetBox.x - p.x, y: targetBox.y - p.y, width: targetBox.width, height: targetBox.height };
        const paperLocal = pageRect(p.page);
        ctx.strokeStyle = templateSpec(p.page.template).color;
        ctx.lineWidth = Math.max(0.75, scaleX * 0.5);
        for (const [x1, y1, x2, y2] of templateLines(p.page.template, paperLocal, localArea)) {
          ctx.beginPath();
          ctx.moveTo((p.x + x1 - targetBox.x) * scaleX, (p.y + y1 - targetBox.y) * scaleY);
          ctx.lineTo((p.x + x2 - targetBox.x) * scaleX, (p.y + y2 - targetBox.y) * scaleY);
          ctx.stroke();
        }
        ctx.fillStyle = templateSpec(p.page.template).color;
        for (const [dx, dy] of templateDots(p.page.template, paperLocal, localArea)) {
          ctx.beginPath();
          ctx.arc((p.x + dx - targetBox.x) * scaleX, (p.y + dy - targetBox.y) * scaleY, Math.max(0.8, 1.15 * scaleX * 0.6), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  function drawStrokeOnCtx(ctx: CanvasRenderingContext2D, stroke: LiveStroke, w: number, h: number, targetBox: Rect) {
    const built = buildLiveStrokePath(stroke);
    if (!built) return;
    ctx.save();
    ctx.globalAlpha = stroke.opacity / 100;
    if (!dark && stroke.inkKind === 'highlighter') ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = dark && stroke.inkKind === 'pen' ? darkPreviewColor(stroke.color) : stroke.color;
    const scaleX = w / Math.max(1, targetBox.width), scaleY = h / Math.max(1, targetBox.height);
    ctx.translate((built.x - targetBox.x) * scaleX, (built.y - targetBox.y) * scaleY);
    ctx.scale(scaleX, scaleY);
    ctx.fill(built.path);
    ctx.restore();
  }

  function scheduleComposite() {
    if (compositeFrame.current) return;
    compositeFrame.current = window.requestAnimationFrame(() => {
      compositeFrame.current = 0;
      paintComposite();
    });
  }

  function paintComposite() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { width: w, height: h } = latestSize.current;
    const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const targetBox = currentBox();
    const backdrop = backdropRef.current, prev = backdropBoxRef.current;
    let dx = 0, dy = 0, dw = 0, dh = 0, covered = false;
    if (backdrop && prev) {
      dx = ((prev.x - targetBox.x) / Math.max(1, targetBox.width)) * w;
      dy = ((prev.y - targetBox.y) / Math.max(1, targetBox.height)) * h;
      dw = (prev.width / Math.max(1, targetBox.width)) * w;
      dh = (prev.height / Math.max(1, targetBox.height)) * h;
      covered = dx <= 0.5 && dy <= 0.5 && dx + dw >= w - 0.5 && dy + dh >= h - 0.5;
    }
    if (!covered) drawBaseSurface(ctx, w, h, targetBox);
    if (backdrop && prev) ctx.drawImage(backdrop, dx, dy, dw, dh);
    for (const s of pendingStrokes.current) drawStrokeOnCtx(ctx, s, w, h, targetBox);
    if (activeStroke.current) drawStrokeOnCtx(ctx, activeStroke.current, w, h, targetBox);
  }

  async function renderBackdropOnce(signal: AbortSignal) {
    const { width: w, height: h } = latestSize.current;
    const target = currentBox();
    const { paged: isPaged, pdf: pdfSvc, dark: isDark, session: sess, handle: hdl } = latestRenderDeps.current;
    if (w < 40 || h < 40 || target.width <= 0 || target.height <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Render with 25% overscan on each side so dragging/panning the Zoom Box slides over
    // already-rendered ink and paper at 120fps without flashing blank edges.
    const overscan = 0.25;
    const padX = target.width * overscan, padY = target.height * overscan;
    const snapBox: Rect = {
      x: target.x - padX,
      y: target.y - padY,
      width: target.width + padX * 2,
      height: target.height + padY * 2,
    };
    const pixelScale = Math.min(dpr, Math.sqrt(2_500_000 / Math.max(1, w * h * (1 + overscan * 2) ** 2)));
    const bw = Math.max(1, Math.round(w * (1 + overscan * 2) * pixelScale));
    const bh = Math.max(1, Math.round(h * (1 + overscan * 2) * pixelScale));
    const scaleX = bw / snapBox.width, scaleY = bh / snapBox.height;

    const off = createEl('canvas');
    off.width = bw;
    off.height = bh;
    let committed = false;
    try {
      const ctx = off.getContext('2d')!;
      ctx.fillStyle = isDark ? '#1f2329' : isPaged ? '#e7e4de' : '#faf9f5';
      ctx.fillRect(0, 0, bw, bh);

      if (isPaged) {
        const placements = hdl.layout().placements.filter(p =>
          p.paper.x < snapBox.x + snapBox.width && p.paper.x + p.paper.width > snapBox.x &&
          p.paper.y < snapBox.y + snapBox.height && p.paper.y + p.paper.height > snapBox.y,
        );
        for (const p of placements) {
          const px = (p.paper.x - snapBox.x) * scaleX, py = (p.paper.y - snapBox.y) * scaleY;
          const pw = p.paper.width * scaleX, ph = p.paper.height * scaleY;
          ctx.fillStyle = p.page.pdfPage ? '#ffffff' : '#fcfbf7';
          ctx.fillRect(px, py, pw, ph);
          if (p.page.pdfPage && pdfSvc) {
            const left = Math.max(0, snapBox.x - p.x);
            const top = Math.max(0, snapBox.y - p.y);
            const right = Math.min(p.page.width, snapBox.x + snapBox.width - p.x);
            const bottom = Math.min(p.page.height, snapBox.y + snapBox.height - p.y);
            if (right > left && bottom > top) {
              const pdfCanvas = createEl('canvas');
              const renderScale = Math.min(3, Math.max(scaleX, scaleY));
              try {
                await pdfSvc.render(p.page, pdfCanvas, renderScale, { x: left, y: top, width: right - left, height: bottom - top }, signal);
                if (signal.aborted || unmounted.current) return;
                ctx.drawImage(
                  pdfCanvas,
                  (p.x + left - snapBox.x) * scaleX,
                  (p.y + top - snapBox.y) * scaleY,
                  (right - left) * scaleX,
                  (bottom - top) * scaleY,
                );
              } catch { /* ignore cancelled/missing PDF slice */ } finally {
                pdfCanvas.width = pdfCanvas.height = 0;
              }
            }
          } else if (!p.page.pdfPage) {
            const localArea: Rect = { x: snapBox.x - p.x, y: snapBox.y - p.y, width: snapBox.width, height: snapBox.height };
            const paperLocal = pageRect(p.page);
            ctx.strokeStyle = templateSpec(p.page.template).color;
            ctx.lineWidth = Math.max(1, scaleX * 0.8);
            for (const [x1, y1, x2, y2] of templateLines(p.page.template, paperLocal, localArea)) {
              ctx.beginPath();
              ctx.moveTo((p.x + x1 - snapBox.x) * scaleX, (p.y + y1 - snapBox.y) * scaleY);
              ctx.lineTo((p.x + x2 - snapBox.x) * scaleX, (p.y + y2 - snapBox.y) * scaleY);
              ctx.stroke();
            }
            ctx.fillStyle = templateSpec(p.page.template).color;
            for (const [dx, dy] of templateDots(p.page.template, paperLocal, localArea)) {
              ctx.beginPath();
              ctx.arc((p.x + dx - snapBox.x) * scaleX, (p.y + dy - snapBox.y) * scaleY, Math.max(1, 1.15 * scaleX), 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }

      const startedAtSeq = strokeSeq.current;
      const queryRect: Rect = { x: snapBox.x - 16, y: snapBox.y - 16, width: snapBox.width + 32, height: snapBox.height + 32 };
      const candidates = (hdl.api as InkApi).inkQuery(queryRect);
      const sceneEls = candidates.filter(e => {
        if (e.isDeleted) return false;
        const b = bounds([e]);
        return !!b && b.x + b.width > queryRect.x && b.y + b.height > queryRect.y && b.x < queryRect.x + queryRect.width && b.y < queryRect.y + queryRect.height;
      });
      const exportedIds = new Set(sceneEls.map(e => e.id));
      const directFreedrawOnly = !isDark && sceneEls.length > 0 && sceneEls.every(e =>
        e.type === 'freedraw' && !e.frameId && Math.abs(e.angle) < 1e-6 && (!e.backgroundColor || e.backgroundColor === 'transparent'),
      );
      if (directFreedrawOnly) {
        for (const e of sceneEls) {
          if (e.type !== 'freedraw') continue;
          const path = getCommittedFreedrawPath(e);
          if (!path) continue;
          const hi = isHighlighterElement(e);
          ctx.save();
          ctx.globalAlpha = e.opacity / 100;
          if (hi) ctx.globalCompositeOperation = 'multiply';
          ctx.fillStyle = e.strokeColor;
          ctx.translate((e.x - snapBox.x) * scaleX, (e.y - snapBox.y) * scaleY);
          ctx.scale(scaleX, scaleY);
          ctx.fill(path);
          ctx.restore();
        }
      } else if (sceneEls.length) {
        const [ox, oy] = getCommonBounds(sceneEls);
        const svg = await exportToSvg({
          elements: sceneEls,
          files: { ...sess.files, ...hdl.api.getFiles() },
          appState: { exportBackground: false, exportWithDarkMode: isDark },
          exportPadding: 0,
        });
        if (signal.aborted || unmounted.current) return;
        svg.setAttribute('viewBox', `${snapBox.x - ox} ${snapBox.y - oy} ${snapBox.width} ${snapBox.height}`);
        svg.setAttribute('width', String(bw));
        svg.setAttribute('height', String(bh));
        const url = URL.createObjectURL(new Blob([svg.outerHTML], { type: 'image/svg+xml' }));
        try {
          const img = new Image();
          img.src = url;
          await img.decode();
          if (signal.aborted || unmounted.current) return;
          ctx.drawImage(img, 0, 0, bw, bh);
        } finally {
          URL.revokeObjectURL(url);
        }
      }

      if (signal.aborted || unmounted.current) return;
      if (backdropRef.current) backdropRef.current.width = backdropRef.current.height = 0;
      backdropRef.current = off;
      backdropBoxRef.current = snapBox;
      committed = true;
      if (pendingStrokes.current.length) {
        const liveBox = currentBox();
        const coversLiveBox = snapBox.x <= liveBox.x && snapBox.y <= liveBox.y && snapBox.x + snapBox.width >= liveBox.x + liveBox.width && snapBox.y + snapBox.height >= liveBox.y + liveBox.height;
        const currentLiveIds = new Set(hdl.elements().filter(e => !e.isDeleted).map(e => e.id));
        pendingStrokes.current = pendingStrokes.current.filter(s => {
          if (s.committing) return true;
          if (s.id && !currentLiveIds.has(s.id)) return false;
          if (s.seq > startedAtSeq) return true;
          if (!coversLiveBox && s.id && !exportedIds.has(s.id)) return true;
          return false;
        });
      }
      paintComposite();
    } finally {
      if (!committed) off.width = off.height = 0;
    }
  }

  function scheduleBackdrop(delayMs: number) {
    window.clearTimeout(backdropTimer.current);
    backdropTimer.current = window.setTimeout(() => {
      backdropTimer.current = undefined;
      requestBackdrop(false);
    }, delayMs);
  }

  function requestBackdrop(restart = false) {
    if (unmounted.current) return;
    window.clearTimeout(backdropTimer.current);
    backdropTimer.current = undefined;
    backdropDirty.current = true;
    if (restart && backdropBusy.current) backdropAbort.current?.abort();
    if (backdropBusy.current) return;
    backdropBusy.current = true;
    void (async () => {
      try {
        while (backdropDirty.current && !unmounted.current) {
          backdropDirty.current = false;
          const ac = new AbortController();
          backdropAbort.current = ac;
          await renderBackdropOnce(ac.signal).catch(() => {});
        }
      } finally {
        backdropBusy.current = false;
        backdropAbort.current = null;
      }
    })();
  }

  // Re-project via rAF whenever `box` moves so dragging the target frame stays 120fps,
  // and debounce full backdrop refresh until motion slows/stops so PDF/SVG work never stalls drags.
  useEffect(() => {
    if (!paintRef) return;
    const onLiveMove = () => {
      scheduleComposite();
      scheduleBackdrop(90);
    };
    paintRef.current = onLiveMove;
    return () => { if (paintRef.current === onLiveMove) paintRef.current = null; };
  });
  useEffect(() => {
    paintComposite();
  }, [box.x, box.y, box.width, box.height, stripSize.width, stripSize.height, dark]);

  const prevBackdropStruct = useRef({ w: stripSize.width, h: stripSize.height, paged, pdf, dark });
  useEffect(() => {
    const prev = prevBackdropStruct.current;
    const restart = prev.w !== stripSize.width || prev.h !== stripSize.height || prev.paged !== paged || prev.pdf !== pdf || prev.dark !== dark;
    prevBackdropStruct.current = { w: stripSize.width, h: stripSize.height, paged, pdf, dark };
    requestBackdrop(restart);
  }, [box.x, box.y, box.width, box.height, sceneTick, stripSize.width, stripSize.height, paged, pdf, dark]);

  useEffect(() => () => {
    if (backdropRef.current) {
      backdropRef.current.width = backdropRef.current.height = 0;
      backdropRef.current = null;
      backdropBoxRef.current = null;
    }
  }, []);

  const toLocalCss = (clientX: number, clientY: number): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return [clientX - rect.left, clientY - rect.top];
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button > 0) return;
    event.stopPropagation();
    event.preventDefault();
    // Never allow a second pointer to hijack an active draw/erase stroke,
    // but let a stylus preempt an ongoing palm/touch pan so palm-first writing is never lost.
    if (pointerState.current !== null) {
      if (pointerState.current.mode === 'pan' && event.pointerType === 'pen') {
        const { panCurrent, panOrigin } = pointerState.current;
        pointerState.current = null;
        if (panCurrent && panOrigin && (panCurrent.x !== panOrigin.x || panCurrent.y !== panOrigin.y)) {
          if (liveBoxRef) liveBoxRef.current = panCurrent;
          boxOverlaySyncRef?.current?.(panCurrent);
          onBoxChange(panCurrent);
        }
      } else {
        return;
      }
    }
    cancelAutoAdvance();
    event.currentTarget.setPointerCapture(event.pointerId);
    const [cx, cy] = toLocalCss(event.clientX, event.clientY);
    const activeBox = currentBox();

    if ((event.pointerType === 'touch' && !prefs.fingerDraws) || tool === 'hand') {
      pointerState.current = { id: event.pointerId, mode: 'pan', lastScreen: [cx, cy], panOrigin: activeBox, panCurrent: activeBox };
      return;
    }
    if (!supported) return;

    const pt = zoomCanvasToScene(cx, cy, stripSize.width, stripSize.height, activeBox);
    setZoomWriting(true);
    if (tool === 'eraser') {
      pointerState.current = { id: event.pointerId, mode: 'erase', erasePath: [pt] };
      return;
    }

    const isHi = tool === 'highlighter';
    const stabilize = isHi ? 0 : prefs.pen.stabilize;
    const stabilizer = new InkStabilizer(stabilize);
    const startPt = stabilizer.start(pt[0], pt[1]);
    const usePressure = !isHi && prefs.pen.pressure;
    const pressure = usePressure ? readPressure(event.pressure) : 0.5;
    activeStroke.current = {
      seq: 0,
      points: [startPt],
      rawPoints: stabilize > 0 ? [pt] : undefined,
      rawPressures: stabilize > 0 ? [pressure] : undefined,
      pressures: [pressure],
      color: isHi ? prefs.highlighter.color : prefs.pen.color,
      width: isHi ? prefs.highlighter.width : prefs.pen.width,
      opacity: isHi ? 35 : 100,
      inkKind: isHi ? 'highlighter' : 'pen',
      usePressure,
    };
    pointerState.current = { id: event.pointerId, mode: 'draw', stabilizer };
    paintComposite();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = pointerState.current;
    if (!state || state.id !== event.pointerId) return;
    event.stopPropagation();

    const rect = canvasRef.current!.getBoundingClientRect();
    if (state.mode === 'pan' && state.lastScreen) {
      const cx = event.clientX - rect.left, cy = event.clientY - rect.top;
      const dx = cx - state.lastScreen[0], dy = cy - state.lastScreen[1];
      state.lastScreen = [cx, cy];
      const cur = state.panCurrent ?? currentBox();
      const { limit } = pageContextFor(cur);
      const next = clampZoomBox({
        ...cur,
        x: cur.x - (dx / Math.max(1, stripSize.width)) * cur.width,
        y: cur.y - (dy / Math.max(1, stripSize.height)) * cur.height,
      }, limit);
      state.panCurrent = next;
      if (liveBoxRef) liveBoxRef.current = next;
      boxOverlaySyncRef?.current?.(next);
      scheduleComposite();
      scheduleBackdrop(100);
      return;
    }

    const activeBox = currentBox();
    const coalesced = event.nativeEvent.getCoalescedEvents?.();
    const samples = coalesced?.length ? coalesced : [event.nativeEvent];

    if (state.mode === 'erase' && state.erasePath) {
      for (const s of samples) {
        state.erasePath.push(zoomCanvasToScene(s.clientX - rect.left, s.clientY - rect.top, stripSize.width, stripSize.height, activeBox));
      }
      return;
    }

    const stroke = activeStroke.current;
    if (!stroke || !state.stabilizer) return;
    for (const s of samples) {
      const raw = zoomCanvasToScene(s.clientX - rect.left, s.clientY - rect.top, stripSize.width, stripSize.height, activeBox);
      const filtered = state.stabilizer.next(raw[0], raw[1]);
      const pressure = stroke.inkKind === 'highlighter' || !prefs.pen.pressure ? 0.5 : readPressure(s.pressure);
      const last = stroke.points[stroke.points.length - 1];
      const lastPressure = stroke.pressures[stroke.pressures.length - 1];
      const filteredChanged = !last || last[0] !== filtered[0] || last[1] !== filtered[1] || lastPressure !== pressure;
      if (stroke.rawPoints && stroke.rawPressures) {
        const lastRaw = stroke.rawPoints[stroke.rawPoints.length - 1];
        const lastRawPressure = stroke.rawPressures[stroke.rawPressures.length - 1];
        if (filteredChanged || !lastRaw || lastRaw[0] !== raw[0] || lastRaw[1] !== raw[1] || lastRawPressure !== pressure) {
          stroke.rawPoints.push(raw);
          stroke.rawPressures.push(pressure);
        }
      }
      if (!filteredChanged) continue;
      stroke.points.push(filtered);
      stroke.pressures.push(pressure);
    }
    scheduleComposite();
  };

  const finishPointer = (event: React.PointerEvent<HTMLCanvasElement>, cancelled = false) => {
    const state = pointerState.current;
    if (!state || state.id !== event.pointerId) return;
    event.stopPropagation();
    pointerState.current = null;
    window.cancelAnimationFrame(compositeFrame.current);
    compositeFrame.current = 0;
    if (state.mode !== 'pan') setZoomWriting(false);

    if (state.mode === 'pan') {
      const finalBox = cancelled ? state.panOrigin : state.panCurrent;
      if (finalBox && state.panOrigin) {
        if (liveBoxRef) liveBoxRef.current = finalBox;
        boxOverlaySyncRef?.current?.(finalBox);
        if (!cancelled && (finalBox.x !== state.panOrigin.x || finalBox.y !== state.panOrigin.y)) {
          onBoxChange(finalBox);
        } else {
          paintComposite();
          if (cancelled) requestBackdrop(true);
        }
      }
      return;
    }

    const activeBox = currentBox();
    if (state.mode === 'erase') {
      const path = [...(state.erasePath ?? [])];
      if (!cancelled) {
        const [cx, cy] = toLocalCss(event.clientX, event.clientY);
        path.push(zoomCanvasToScene(cx, cy, stripSize.width, stripSize.height, activeBox));
      }
      if (!cancelled && path.length) {
        const radius = prefs.eraser.size / factor;
        void handle.eraseScenePath(path, radius, prefs.eraser.mode === 'stroke', prefs.eraser.highlighterOnly).then(() => {
          setSceneTick(n => n + 1);
          onEraseEnd?.();
        }).catch(() => {});
      }
      return;
    }

    const stroke = activeStroke.current;
    activeStroke.current = null;
    if (cancelled || !stroke || !stroke.points.length) {
      paintComposite();
      return;
    }
    if (state.stabilizer) {
      const [cx, cy] = toLocalCss(event.clientX, event.clientY);
      const rawEnd = zoomCanvasToScene(cx, cy, stripSize.width, stripSize.height, activeBox);
      const endPt = state.stabilizer.finish(rawEnd[0], rawEnd[1]);
      const endPressure = stroke.inkKind === 'highlighter' || !prefs.pen.pressure ? 0.5 : readPressure(event.pressure);
      const last = stroke.points[stroke.points.length - 1];
      const lastPressure = stroke.pressures[stroke.pressures.length - 1];
      const filteredChanged = !last || last[0] !== endPt[0] || last[1] !== endPt[1] || lastPressure !== endPressure;
      if (stroke.rawPoints && stroke.rawPressures) {
        const lastRaw = stroke.rawPoints[stroke.rawPoints.length - 1];
        const lastRawPressure = stroke.rawPressures[stroke.rawPressures.length - 1];
        if (filteredChanged || !lastRaw || lastRaw[0] !== rawEnd[0] || lastRaw[1] !== rawEnd[1] || lastRawPressure !== endPressure) {
          stroke.rawPoints.push(rawEnd);
          stroke.rawPressures.push(endPressure);
        }
      }
      if (filteredChanged) {
        stroke.points.push(endPt);
        stroke.pressures.push(endPressure);
      }
    }

    const el = buildZoomFreedrawElement(stroke.points, stroke.pressures, {
      color: stroke.color,
      width: stroke.width,
      opacity: stroke.opacity,
      inkKind: stroke.inkKind,
      fixedPressure: stroke.inkKind === 'highlighter' || !prefs.pen.pressure,
      rawPoints: stroke.rawPoints,
      rawPressures: stroke.rawPressures,
    });
    if (!el) {
      paintComposite();
      return;
    }
    stroke.id = el.id;
    stroke.seq = ++strokeSeq.current;
    stroke.committing = true;
    if (el.type === 'freedraw') {
      const cached = getCommittedFreedrawPath(el);
      if (cached) {
        stroke.path2d = cached;
        stroke.pathCount = stroke.points.length;
      }
      stroke.elX = el.x;
      stroke.elY = el.y;
    }
    pendingStrokes.current = [...pendingStrokes.current, stroke];
    paintComposite();
    void handle.appendElements([el]).then(() => {
      stroke.committing = false;
      setSceneTick(n => n + 1);
    }).catch(() => {
      pendingStrokes.current = pendingStrokes.current.filter(s => s.id !== el.id);
      paintComposite();
    });

    if (autoAdvance) {
      const maxX = stroke.points.reduce((m, [x]) => Math.max(m, x), -Infinity);
      if (shouldAutoAdvance(maxX, activeBox)) {
        const expectedX = activeBox.x, expectedY = activeBox.y;
        cancelAutoAdvance();
        setAdvancing(true);
        advanceTimer.current = window.setTimeout(() => {
          setAdvancing(false);
          const cur = currentBox();
          if (cur.x === expectedX && cur.y === expectedY) stepBox('next');
        }, 750);
      }
    }
  };

  const activeLabel = tool === 'eraser' ? '橡皮擦' : tool === 'highlighter' ? '荧光笔' : tool === 'hand' ? '拖动框' : tool === 'pen' ? '书写笔' : '未支持工具';

  return <section ref={windowRef} tabIndex={-1} className={`ink-zoom-window${nightPaper ? ' is-night-paper' : ''}`} aria-label="放大书写框">
    <div className="ink-zoom-window-bar">
      <div className="ink-zoom-window-meta">
        <strong>放大书写框</strong>
        <span className={`ink-zoom-window-badge${!supported ? ' is-warning' : ''}`}>{activeLabel}</span>
        <Segmented
          label="放大倍率"
          value={factor}
          onChange={onFactorChange}
          options={[{ value: 2, label: '2×' }, { value: 3, label: '3×' }, { value: 4, label: '4×' }]}
        />
        <div className="ink-zoom-auto-toggle">
          <Switch label="自动推进" checked={autoAdvance} onChange={onAutoAdvanceChange}/>
        </div>
      </div>
      <div className="ink-zoom-window-nav">
        <IconButton icon="left" label="向左移动取景框" onClick={() => stepBox('prev')}/>
        <IconButton icon="right" label="向右推进取景框" onClick={() => stepBox('next')}/>
        <IconButton icon="returnKey" label="换行到下一行" onClick={() => stepBox('newline')}/>
        <IconButton icon="close" label="关闭放大书写框" onClick={onClose}/>
      </div>
    </div>
    <div className="ink-zoom-window-stage" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className="ink-zoom-window-canvas"
        style={{ cursor: !supported ? 'default' : tool === 'hand' ? 'grab' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={e => finishPointer(e, false)}
        onPointerCancel={e => finishPointer(e, true)}
        onLostPointerCapture={e => finishPointer(e, true)}
      />
      {!supported && <div className="ink-zoom-unsupported" role="status">
        <InkIcon name="info"/>
        <span>放大书写框仅支持笔、荧光笔、橡皮擦和拖动</span>
        {onSwitchToPen && <button type="button" className="mod-cta" onClick={() => { onSwitchToPen(); windowRef.current?.focus({ preventScroll: true }); }}><InkIcon name="pen"/>切回笔</button>}
      </div>}
      {autoAdvance && supported && <div className={`ink-zoom-advance-zone${advancing ? ' is-advancing' : ''}`} aria-hidden="true">
        {advancing && <div className="ink-zoom-advance-progress"/>}
        <span>{advancing ? '即将推进（落笔可取消）' : '写到此区域自动推进'}</span>
      </div>}
    </div>
  </section>;
}

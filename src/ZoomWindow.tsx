import React, { useEffect, useRef, useState } from 'react';
import { exportToSvg, getCommonBounds } from '@excalidraw/excalidraw';
import type { Rect } from './model';
import { pageRect } from './model';
import type { ScenePoint } from './geometry';
import type { Session } from './session';
import type { PdfService } from './pdf';
import type { CanvasHandle } from './InkCanvas';
import type { Preferences, ToolId } from './preferences';
import { placementAt } from './layout';
import { templateDots, templateLines, templateSpec } from './templates';
import { toScreen, useView, View, ViewStore } from './view';
import { InkStabilizer } from './ink-input';
import { IconButton } from './InkIcon';
import { Segmented } from './ui';
import {
  advanceZoomBox,
  buildZoomFreedrawElement,
  clampZoomBox,
  newlineZoomBox,
  sceneToZoomCanvas,
  shouldAutoAdvance,
  zoomBoxSize,
  zoomCanvasToScene,
  ZoomFactor,
} from './zoom-window';

interface LiveStroke {
  points: ScenePoint[];
  rawPoints?: ScenePoint[];
  rawPressures?: number[];
  pressures: number[];
  color: string;
  width: number;
  opacity: number;
  inkKind: 'pen' | 'highlighter';
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
export function ZoomBoxOverlay({ views, box, autoAdvance, onChange }: {
  views: ViewStore;
  box: Rect;
  autoAdvance: boolean;
  onChange: (next: Rect) => void;
}) {
  const screen = useView(views, (v: View) => {
    const [x, y] = toScreen(v, box.x, box.y);
    return `${x},${y},${box.width * v.zoom},${box.height * v.zoom},${v.zoom}`;
  });
  const [sx, sy, sw, sh, zoom] = screen.split(',').map(Number);
  const drag = useRef<{ id: number; startX: number; startY: number; origin: Rect } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.preventDefault();
    if (drag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, origin: box };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    event.stopPropagation();
    const z = Math.max(0.05, zoom);
    onChange({
      ...d.origin,
      x: d.origin.x + (event.clientX - d.startX) / z,
      y: d.origin.y + (event.clientY - d.startY) / z,
    });
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) {
      event.stopPropagation();
      drag.current = null;
    }
  };

  return <div
    className="ink-zoom-target-box"
    style={{ left: sx, top: sy, width: Math.max(24, sw), height: Math.max(16, sh) }}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerUp}
    role="region"
    aria-label="放大书写取景框（拖动调整位置）"
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
  factor,
  autoAdvance,
  onBoxChange,
  onFactorChange,
  onAutoAdvanceChange,
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
  factor: ZoomFactor;
  autoAdvance: boolean;
  onBoxChange: (next: Rect) => void;
  onFactorChange: (next: ZoomFactor) => void;
  onAutoAdvanceChange: (next: boolean) => void;
  onClose: () => void;
  onEraseEnd?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const backdropRef = useRef<HTMLCanvasElement | null>(null);
  const backdropBoxRef = useRef<Rect | null>(null);
  const [stripSize, setStripSize] = useState({ width: 640, height: 180 });
  const [sceneTick, setSceneTick] = useState(0);
  const activeStroke = useRef<LiveStroke | null>(null);
  const pendingStrokes = useRef<LiveStroke[]>([]);
  const pointerState = useRef<{
    id: number;
    mode: 'draw' | 'erase' | 'pan';
    strokeBox: Rect;
    stabilizer?: InkStabilizer;
    lastScreen?: [number, number];
    erasePath?: ScenePoint[];
  } | null>(null);
  const advanceTimer = useRef<number>();
  const latestBox = useRef(box); latestBox.current = box;
  const latestSize = useRef(stripSize); latestSize.current = stripSize;

  useEffect(() => {
    if (!autoAdvance) window.clearTimeout(advanceTimer.current);
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
    const bump = () => setSceneTick(n => n + 1);
    session.listeners.add(bump);
    return () => { session.listeners.delete(bump); };
  }, [session]);

  useEffect(() => () => { window.clearTimeout(advanceTimer.current); }, []);

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
    window.clearTimeout(advanceTimer.current);
    const cur = latestBox.current;
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
    if (!stroke.points.length) return;
    ctx.save();
    ctx.globalAlpha = stroke.opacity / 100;
    if (!dark && stroke.inkKind === 'highlighter') ctx.globalCompositeOperation = 'multiply';
    const drawColor = dark && stroke.inkKind === 'pen' ? darkPreviewColor(stroke.color) : stroke.color;
    ctx.strokeStyle = drawColor;
    ctx.fillStyle = drawColor;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const scaleX = w / Math.max(1, targetBox.width);
    const lineW = Math.max(1.5, stroke.width * 2.2 * scaleX);
    ctx.lineWidth = lineW;
    if (stroke.points.length === 1) {
      const [cx, cy] = sceneToZoomCanvas(stroke.points[0][0], stroke.points[0][1], w, h, targetBox);
      ctx.beginPath();
      ctx.arc(cx, cy, lineW / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      stroke.points.forEach(([sx, sy], i) => {
        const [cx, cy] = sceneToZoomCanvas(sx, sy, w, h, targetBox);
        if (i === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      });
      ctx.stroke();
    }
    ctx.restore();
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
    const targetBox = latestBox.current;
    drawBaseSurface(ctx, w, h, targetBox);
    if (backdropRef.current && backdropBoxRef.current) {
      // Project the cached backdrop into exact world-aligned coordinates of `targetBox`
      // so moving the frame never misaligns visual content with writing coordinates.
      const prev = backdropBoxRef.current;
      const dx = ((prev.x - targetBox.x) / Math.max(1, targetBox.width)) * w;
      const dy = ((prev.y - targetBox.y) / Math.max(1, targetBox.height)) * h;
      const dw = (prev.width / Math.max(1, targetBox.width)) * w;
      const dh = (prev.height / Math.max(1, targetBox.height)) * h;
      ctx.drawImage(backdropRef.current, dx, dy, dw, dh);
    }
    for (const s of pendingStrokes.current) drawStrokeOnCtx(ctx, s, w, h, targetBox);
    if (activeStroke.current) drawStrokeOnCtx(ctx, activeStroke.current, w, h, targetBox);
  }

  // Re-project immediately whenever `box` moves so the display updates synchronously before async PDF/SVG finishes.
  useEffect(() => {
    paintComposite();
  }, [box.x, box.y, box.width, box.height, stripSize.width, stripSize.height, dark]);

  // Render crisp offscreen backdrop of paper/PDF + existing scene elements inside `box`.
  useEffect(() => {
    const abort = new AbortController();
    const { width: w, height: h } = stripSize;
    if (w < 40 || h < 40 || box.width <= 0 || box.height <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
    const scaleX = bw / box.width, scaleY = bh / box.height;
    const snapBox: Rect = { ...box };

    void (async () => {
      const off = createEl('canvas');
      off.width = bw;
      off.height = bh;
      const ctx = off.getContext('2d')!;
      ctx.fillStyle = dark ? '#1f2329' : paged ? '#e7e4de' : '#faf9f5';
      ctx.fillRect(0, 0, bw, bh);

      if (paged) {
        const placements = handle.layout().placements.filter(p =>
          p.paper.x < snapBox.x + snapBox.width && p.paper.x + p.paper.width > snapBox.x &&
          p.paper.y < snapBox.y + snapBox.height && p.paper.y + p.paper.height > snapBox.y,
        );
        for (const p of placements) {
          const px = (p.paper.x - snapBox.x) * scaleX, py = (p.paper.y - snapBox.y) * scaleY;
          const pw = p.paper.width * scaleX, ph = p.paper.height * scaleY;
          ctx.fillStyle = p.page.pdfPage ? '#ffffff' : '#fcfbf7';
          ctx.fillRect(px, py, pw, ph);
          if (p.page.pdfPage && pdf) {
            const left = Math.max(0, snapBox.x - p.x);
            const top = Math.max(0, snapBox.y - p.y);
            const right = Math.min(p.page.width, snapBox.x + snapBox.width - p.x);
            const bottom = Math.min(p.page.height, snapBox.y + snapBox.height - p.y);
            if (right > left && bottom > top) {
              const pdfCanvas = createEl('canvas');
              const renderScale = Math.min(3, Math.max(scaleX, scaleY));
              try {
                await pdf.render(p.page, pdfCanvas, renderScale, { x: left, y: top, width: right - left, height: bottom - top }, abort.signal);
                if (abort.signal.aborted) return;
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

      const sceneEls = handle.elements().filter(e => {
        if (e.isDeleted) return false;
        const [x1, y1, x2, y2] = getCommonBounds([e]);
        return x2 > snapBox.x - 16 && y2 > snapBox.y - 16 && x1 < snapBox.x + snapBox.width + 16 && y1 < snapBox.y + snapBox.height + 16;
      });
      if (sceneEls.length) {
        const [ox, oy] = getCommonBounds(sceneEls);
        const svg = await exportToSvg({
          elements: sceneEls,
          files: { ...session.files, ...handle.api.getFiles() },
          appState: { exportBackground: false, exportWithDarkMode: dark },
          exportPadding: 0,
        });
        if (abort.signal.aborted) return;
        svg.setAttribute('viewBox', `${snapBox.x - ox} ${snapBox.y - oy} ${snapBox.width} ${snapBox.height}`);
        svg.setAttribute('width', String(bw));
        svg.setAttribute('height', String(bh));
        const url = URL.createObjectURL(new Blob([svg.outerHTML], { type: 'image/svg+xml' }));
        try {
          const img = new Image();
          img.src = url;
          await img.decode();
          if (abort.signal.aborted) return;
          ctx.drawImage(img, 0, 0, bw, bh);
        } finally {
          URL.revokeObjectURL(url);
        }
      }

      if (abort.signal.aborted) return;
      if (backdropRef.current) backdropRef.current.width = backdropRef.current.height = 0;
      backdropRef.current = off;
      backdropBoxRef.current = snapBox;
      pendingStrokes.current = [];
      paintComposite();
    })().catch(() => {});

    return () => abort.abort();
  }, [box.x, box.y, box.width, box.height, stripSize.width, stripSize.height, sceneTick, paged, pdf, dark]);

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
        pointerState.current = null;
      } else {
        return;
      }
    }
    window.clearTimeout(advanceTimer.current);
    event.currentTarget.setPointerCapture(event.pointerId);
    const [cx, cy] = toLocalCss(event.clientX, event.clientY);
    const strokeBox: Rect = { ...latestBox.current };

    if ((event.pointerType === 'touch' && !prefs.fingerDraws) || tool === 'hand') {
      pointerState.current = { id: event.pointerId, mode: 'pan', strokeBox, lastScreen: [cx, cy] };
      return;
    }

    const pt = zoomCanvasToScene(cx, cy, stripSize.width, stripSize.height, strokeBox);
    if (tool === 'eraser') {
      pointerState.current = { id: event.pointerId, mode: 'erase', strokeBox, erasePath: [pt] };
      return;
    }

    const isHi = tool === 'highlighter';
    const stabilize = isHi ? 0 : prefs.pen.stabilize;
    const stabilizer = new InkStabilizer(stabilize);
    const startPt = stabilizer.start(pt[0], pt[1]);
    const pressure = isHi || !prefs.pen.pressure ? 0.5 : readPressure(event.pressure);
    activeStroke.current = {
      points: [startPt],
      rawPoints: stabilize > 0 ? [pt] : undefined,
      rawPressures: stabilize > 0 ? [pressure] : undefined,
      pressures: [pressure],
      color: isHi ? prefs.highlighter.color : prefs.pen.color,
      width: isHi ? prefs.highlighter.width : prefs.pen.width,
      opacity: isHi ? 35 : 100,
      inkKind: isHi ? 'highlighter' : 'pen',
    };
    pointerState.current = { id: event.pointerId, mode: 'draw', strokeBox, stabilizer };
    paintComposite();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = pointerState.current;
    if (!state || state.id !== event.pointerId) return;
    event.stopPropagation();

    if (state.mode === 'pan' && state.lastScreen) {
      const [cx, cy] = toLocalCss(event.clientX, event.clientY);
      const dx = cx - state.lastScreen[0], dy = cy - state.lastScreen[1];
      state.lastScreen = [cx, cy];
      const cur = latestBox.current;
      const { limit } = pageContextFor(cur);
      const next = clampZoomBox({
        ...cur,
        x: cur.x - (dx / Math.max(1, stripSize.width)) * cur.width,
        y: cur.y - (dy / Math.max(1, stripSize.height)) * cur.height,
      }, limit);
      onBoxChange(next);
      return;
    }

    const coalesced = event.nativeEvent.getCoalescedEvents?.();
    const samples = coalesced?.length ? coalesced : [event.nativeEvent];

    if (state.mode === 'erase' && state.erasePath) {
      for (const s of samples) {
        const [cx, cy] = toLocalCss(s.clientX, s.clientY);
        state.erasePath.push(zoomCanvasToScene(cx, cy, stripSize.width, stripSize.height, state.strokeBox));
      }
      return;
    }

    const stroke = activeStroke.current;
    if (!stroke || !state.stabilizer) return;
    for (const s of samples) {
      const [cx, cy] = toLocalCss(s.clientX, s.clientY);
      const raw = zoomCanvasToScene(cx, cy, stripSize.width, stripSize.height, state.strokeBox);
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
    paintComposite();
  };

  const finishPointer = (event: React.PointerEvent<HTMLCanvasElement>, cancelled = false) => {
    const state = pointerState.current;
    if (!state || state.id !== event.pointerId) return;
    event.stopPropagation();
    pointerState.current = null;

    if (state.mode === 'pan') return;

    if (state.mode === 'erase') {
      const path = [...(state.erasePath ?? [])];
      if (!cancelled) {
        const [cx, cy] = toLocalCss(event.clientX, event.clientY);
        path.push(zoomCanvasToScene(cx, cy, stripSize.width, stripSize.height, state.strokeBox));
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
      const rawEnd = zoomCanvasToScene(cx, cy, stripSize.width, stripSize.height, state.strokeBox);
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
    pendingStrokes.current = [...pendingStrokes.current, stroke];
    paintComposite();
    void handle.appendElements([el]).then(() => setSceneTick(n => n + 1)).catch(() => {});

    if (autoAdvance) {
      const maxX = stroke.points.reduce((m, [x]) => Math.max(m, x), -Infinity);
      if (shouldAutoAdvance(maxX, state.strokeBox)) {
        const expectedX = state.strokeBox.x, expectedY = state.strokeBox.y;
        window.clearTimeout(advanceTimer.current);
        advanceTimer.current = window.setTimeout(() => {
          if (latestBox.current.x === expectedX && latestBox.current.y === expectedY) stepBox('next');
        }, 550);
      }
    }
  };

  const activeLabel = tool === 'eraser' ? '橡皮擦' : tool === 'highlighter' ? '荧光笔' : tool === 'hand' ? '拖动框' : '书写笔';

  return <section className={`ink-zoom-window${nightPaper ? ' is-night-paper' : ''}`} aria-label="放大书写框">
    <div className="ink-zoom-window-bar">
      <div className="ink-zoom-window-meta">
        <strong>放大书写框</strong>
        <span className="ink-zoom-window-badge">{activeLabel}</span>
        <Segmented
          label="放大倍率"
          value={factor}
          onChange={onFactorChange}
          options={[{ value: 2, label: '2×' }, { value: 3, label: '3×' }, { value: 4, label: '4×' }]}
        />
        <label className="ink-zoom-auto-toggle">
          <input type="checkbox" checked={autoAdvance} onChange={e => onAutoAdvanceChange(e.target.checked)}/>
          <span>自动推进</span>
        </label>
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
        style={{ cursor: tool === 'hand' ? 'grab' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={e => finishPointer(e, false)}
        onPointerCancel={e => finishPointer(e, true)}
      />
      {autoAdvance && <div className="ink-zoom-advance-zone" aria-hidden="true"><span>写到此区域自动推进</span></div>}
    </div>
  </section>;
}

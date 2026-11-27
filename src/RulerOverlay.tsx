import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { IconButton, InkIcon } from './InkIcon';
import { RULER_HALF_THICKNESS, RulerState, snapRulerAngle } from './ruler';
import { isolateFloatingInput } from './pointer-input';
import { isImeComposing } from './ui';

const formatAngle = (angle: number) => Math.round(angle) === 0 ? '0°' : `${Math.round(angle)}°`;
const rulerTransform = (state: RulerState) => `translate(${state.x - state.length / 2}px, ${state.y - RULER_HALF_THICKNESS}px) rotate(${state.angle}deg)`;

/**
 * Interactive translucent virtual drafting ruler rendered above the canvas.
 * Drag the body to move; drag either end handle to rotate (snaps to 0° / 45° / 90°).
 * Pen/highlighter strokes started near either edge snap cleanly to the ruler line.
 */
export function RulerOverlay({ ruler, liveRef, onChange, onClose }: {
  ruler: RulerState;
  liveRef?: React.MutableRefObject<RulerState | null>;
  onChange: (next: RulerState) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const angleRef = useRef<HTMLButtonElement>(null);
  const latest = useRef(ruler); latest.current = ruler;
  const drag = useRef<{
    id: number;
    mode: 'move' | 'rotate';
    startX: number;
    startY: number;
    origin: RulerState;
    current: RulerState;
    startPointerAngle: number;
  } | null>(null);

  useEffect(() => isolateFloatingInput(rootRef.current!), []);
  useLayoutEffect(() => {
    if (drag.current || !rootRef.current) return;
    if (liveRef) liveRef.current = ruler;
    rootRef.current.style.transform = rulerTransform(ruler);
    if (angleRef.current) angleRef.current.textContent = formatAngle(ruler.angle);
  }, [ruler, liveRef]);

  const applyLive = (next: RulerState) => {
    if (liveRef) liveRef.current = next;
    if (rootRef.current) rootRef.current.style.transform = rulerTransform(next);
    if (angleRef.current) angleRef.current.textContent = formatAngle(next.angle);
  };

  const startDrag = (mode: 'move' | 'rotate') => (event: React.PointerEvent<HTMLElement>) => {
    if (event.button > 0) return;
    event.stopPropagation();
    event.preventDefault();
    if (drag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const origin = latest.current;
    const parent = rootRef.current?.closest('.ink-canvas-area')?.getBoundingClientRect();
    const px = parent ? event.clientX - parent.left : event.clientX;
    const py = parent ? event.clientY - parent.top : event.clientY;
    const startPointerAngle = (Math.atan2(py - origin.y, px - origin.x) * 180) / Math.PI;
    drag.current = { id: event.pointerId, mode, startX: event.clientX, startY: event.clientY, origin, current: origin, startPointerAngle };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    event.stopPropagation();
    let next: RulerState;
    if (d.mode === 'move') {
      next = {
        ...d.origin,
        x: d.origin.x + (event.clientX - d.startX),
        y: d.origin.y + (event.clientY - d.startY),
      };
    } else {
      const parent = rootRef.current?.closest('.ink-canvas-area')?.getBoundingClientRect();
      const px = parent ? event.clientX - parent.left : event.clientX;
      const py = parent ? event.clientY - parent.top : event.clientY;
      const curAngle = (Math.atan2(py - d.origin.y, px - d.origin.x) * 180) / Math.PI;
      const nextAngle = snapRulerAngle(d.origin.angle + (curAngle - d.startPointerAngle));
      next = { ...d.origin, angle: nextAngle };
    }
    d.current = next;
    applyLive(next);
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    event.stopPropagation();
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled) {
      applyLive(d.origin);
      return;
    }
    if (d.current.x !== d.origin.x || d.current.y !== d.origin.y || d.current.angle !== d.origin.angle) {
      onChange(d.current);
    }
  };

  const cycleAngle = (event: React.MouseEvent) => {
    event.stopPropagation();
    const presets = [0, 45, 90, -45];
    const next = presets.find(a => Math.abs(a - ruler.angle) > 2 && a > ruler.angle) ?? presets[0];
    onChange({ ...ruler, angle: next });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    const step = event.shiftKey ? 24 : 8;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[event.key]) {
      event.preventDefault(); event.stopPropagation();
      const [dx, dy] = moves[event.key];
      onChange({ ...ruler, x: ruler.x + dx, y: ruler.y + dy });
      return;
    }
    const rotStep = event.shiftKey ? 15 : 5;
    if (event.key === '[' || event.key === '{') {
      event.preventDefault(); event.stopPropagation();
      onChange({ ...ruler, angle: snapRulerAngle(ruler.angle - rotStep) });
    } else if (event.key === ']' || event.key === '}') {
      event.preventDefault(); event.stopPropagation();
      onChange({ ...ruler, angle: snapRulerAngle(ruler.angle + rotStep) });
    }
  };

  const ticks = Math.floor(ruler.length / 12);
  const displayAngle = formatAngle(ruler.angle);

  return <div
    ref={rootRef}
    className="ink-ruler"
    role="region"
    tabIndex={0}
    aria-label={`虚拟直尺 ${displayAngle}（方向键移动，[ / ] 旋转，Esc 收起）`}
    style={{
      width: ruler.length,
      height: RULER_HALF_THICKNESS * 2,
      transform: rulerTransform(ruler),
    }}
    onKeyDown={onKeyDown}
    onPointerDown={startDrag('move')}
    onPointerMove={onPointerMove}
    onPointerUp={e => endDrag(e, false)}
    onPointerCancel={e => endDrag(e, true)}
    onLostPointerCapture={e => endDrag(e, false)}
  >
    <div className="ink-ruler-ticks is-top" aria-hidden="true">
      {Array.from({ length: ticks }, (_, i) => <span key={i} className={i % 5 === 0 ? 'is-major' : ''}/>)}
    </div>
    <div className="ink-ruler-ticks is-bottom" aria-hidden="true">
      {Array.from({ length: ticks }, (_, i) => <span key={i} className={i % 5 === 0 ? 'is-major' : ''}/>)}
    </div>
    <button
      type="button"
      className="ink-ruler-rotate is-left"
      aria-label="拖动左侧旋转直尺"
      title="拖动旋转直尺"
      onPointerDown={startDrag('rotate')}
      onPointerMove={onPointerMove}
      onPointerUp={e => endDrag(e, false)}
      onPointerCancel={e => endDrag(e, true)}
      onLostPointerCapture={e => endDrag(e, false)}
    ><InkIcon name="rotate"/></button>
    <div className="ink-ruler-center" onPointerDown={e => e.stopPropagation()}>
      <button ref={angleRef} type="button" className="ink-ruler-angle" title="点击切换 0° / 45° / 90° / -45°" onClick={cycleAngle}>{displayAngle}</button>
      <IconButton icon="close" label="收起直尺" className="ink-ruler-close" onClick={onClose}/>
    </div>
    <button
      type="button"
      className="ink-ruler-rotate is-right"
      aria-label="拖动右侧旋转直尺"
      title="拖动旋转直尺"
      onPointerDown={startDrag('rotate')}
      onPointerMove={onPointerMove}
      onPointerUp={e => endDrag(e, false)}
      onPointerCancel={e => endDrag(e, true)}
      onLostPointerCapture={e => endDrag(e, false)}
    ><InkIcon name="rotate"/></button>
  </div>;
}

import React, { useRef } from 'react';
import { IconButton } from './InkIcon';
import { RULER_HALF_THICKNESS, RulerState, snapRulerAngle } from './ruler';

/**
 * Interactive translucent virtual drafting ruler rendered above the canvas.
 * Drag the body to move; drag either end handle to rotate (snaps to 0° / 45° / 90°).
 * Pen/highlighter strokes started near either edge snap cleanly to the ruler line.
 */
export function RulerOverlay({ ruler, onChange, onClose }: {
  ruler: RulerState;
  onChange: (next: RulerState) => void;
  onClose: () => void;
}) {
  const drag = useRef<{
    id: number;
    mode: 'move' | 'rotate';
    startX: number;
    startY: number;
    origin: RulerState;
    startPointerAngle: number;
  } | null>(null);

  const startDrag = (mode: 'move' | 'rotate') => (event: React.PointerEvent<HTMLElement>) => {
    if (event.button > 0) return;
    event.stopPropagation();
    event.preventDefault();
    if (drag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const parent = event.currentTarget.closest('.ink-canvas-area')?.getBoundingClientRect();
    const px = parent ? event.clientX - parent.left : event.clientX;
    const py = parent ? event.clientY - parent.top : event.clientY;
    const startPointerAngle = (Math.atan2(py - ruler.y, px - ruler.x) * 180) / Math.PI;
    drag.current = { id: event.pointerId, mode, startX: event.clientX, startY: event.clientY, origin: ruler, startPointerAngle };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    event.stopPropagation();
    if (d.mode === 'move') {
      onChange({
        ...d.origin,
        x: d.origin.x + (event.clientX - d.startX),
        y: d.origin.y + (event.clientY - d.startY),
      });
    } else {
      const parent = event.currentTarget.closest('.ink-canvas-area')?.getBoundingClientRect();
      const px = parent ? event.clientX - parent.left : event.clientX;
      const py = parent ? event.clientY - parent.top : event.clientY;
      const curAngle = (Math.atan2(py - d.origin.y, px - d.origin.x) * 180) / Math.PI;
      const nextAngle = snapRulerAngle(d.origin.angle + (curAngle - d.startPointerAngle));
      onChange({ ...d.origin, angle: nextAngle });
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    if (drag.current?.id === event.pointerId) {
      event.stopPropagation();
      drag.current = null;
    }
  };

  const cycleAngle = (event: React.MouseEvent) => {
    event.stopPropagation();
    const presets = [0, 45, 90, -45];
    const next = presets.find(a => Math.abs(a - ruler.angle) > 2 && a > ruler.angle) ?? presets[0];
    onChange({ ...ruler, angle: next });
  };

  const ticks = Math.floor(ruler.length / 12);
  const displayAngle = Math.round(ruler.angle) === 0 ? '0°' : `${Math.round(ruler.angle)}°`;

  return <div
    className="ink-ruler"
    role="region"
    aria-label={`虚拟直尺 ${displayAngle}`}
    style={{
      width: ruler.length,
      height: RULER_HALF_THICKNESS * 2,
      transform: `translate(${ruler.x - ruler.length / 2}px, ${ruler.y - RULER_HALF_THICKNESS}px) rotate(${ruler.angle}deg)`,
    }}
    onPointerDown={startDrag('move')}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerUp}
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
      aria-label="拖动旋转直尺"
      title="拖动旋转直尺"
      onPointerDown={startDrag('rotate')}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
    <div className="ink-ruler-center" onPointerDown={e => e.stopPropagation()}>
      <button type="button" className="ink-ruler-angle" title="点击切换 0° / 45° / 90°" onClick={cycleAngle}>{displayAngle}</button>
      <IconButton icon="close" label="收起直尺" className="ink-ruler-close" onClick={onClose}/>
    </div>
    <button
      type="button"
      className="ink-ruler-rotate is-right"
      aria-label="拖动旋转直尺"
      title="拖动旋转直尺"
      onPointerDown={startDrag('rotate')}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  </div>;
}

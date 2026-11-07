import React, { useEffect, useRef, useState } from 'react';
import { Rect } from './model';
import { EditorHandle } from './Editor';
export type Point = [number, number];
export function polygonBounds(points: Point[]): Rect {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) { x = Math.min(x, p[0]); y = Math.min(y, p[1]); right = Math.max(right, p[0]); bottom = Math.max(bottom, p[1]); }
  return { x, y, width: right - x, height: bottom - y };
}
export function contains(polygon: Point[], point: Point) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function SelectionOverlay({ editor, rectangle, onSelect, onCancel }: { editor: () => EditorHandle | undefined; rectangle: boolean; onSelect: (points: Point[]) => void; onCancel: () => void }) {
  const [points, setPoints] = useState<Point[]>([]), pointer = useRef<number>();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.focus(); }, []);
  const sampled = useRef<Point[]>([]);
  const local = (e: React.PointerEvent): Point => { const box = e.currentTarget.getBoundingClientRect(); return [e.clientX - box.left, e.clientY - box.top]; };
  return <div ref={root} className="ink-selection-overlay" tabIndex={0} aria-label={rectangle ? '矩形框选区域' : '自由套索区域'} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
    onPointerDown={e => { if (pointer.current !== undefined || e.pointerType === 'touch' || (e.target as HTMLElement).closest('button')) return; pointer.current = e.pointerId; e.currentTarget.setPointerCapture(e.pointerId); sampled.current = [local(e)]; setPoints(sampled.current); }}
    onPointerMove={e => { if (e.pointerId !== pointer.current) return; const p = local(e), start = sampled.current[0]; if (rectangle) sampled.current = [start, [p[0], start[1]], p, [start[0], p[1]]]; else sampled.current.push(p); setPoints([...sampled.current]); }}
    onPointerUp={e => { if (e.pointerId !== pointer.current) return; pointer.current = undefined; const api = editor()?.api; if (!api || sampled.current.length < 3) return; const state = api.getAppState(); onSelect(sampled.current.map(p => [p[0] / state.zoom.value - state.scrollX, p[1] / state.zoom.value - state.scrollY])); }}
    onPointerCancel={() => { pointer.current = undefined; sampled.current = []; setPoints([]); }}>
    <svg width="100%" height="100%"><polygon points={points.map(p => p.join(',')).join(' ')} fill="#2867b21a" stroke="#2867b2" strokeWidth="1.5" strokeDasharray="5 4" /></svg>
    <div className="ink-selection-hint">{rectangle ? '拖动框选' : '圈选区域'}<button onClick={onCancel}>取消</button></div>
  </div>;
}

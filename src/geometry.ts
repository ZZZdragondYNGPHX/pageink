import { Element, Rect, Margins, Page, uid, MutableElement } from './model';
import type { LocalPoint, Radians } from '@excalidraw/math';
import { retargetAnchors } from './mixed';
type Point = readonly [number, number];
export type ScenePoint = [number, number];
export function polygonBounds(points: readonly Point[]): Rect {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) { x = Math.min(x, p[0]); y = Math.min(y, p[1]); right = Math.max(right, p[0]); bottom = Math.max(bottom, p[1]); }
  return { x, y, width: right - x, height: bottom - y };
}
function localBox(e: Element) {
  if ('points' in e && e.points.length) {
    let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
    for (const p of e.points) { x = Math.min(x, p[0]); y = Math.min(y, p[1]); right = Math.max(right, p[0]); bottom = Math.max(bottom, p[1]); }
    return { x, y, width: right - x, height: bottom - y };
  }
  return { x: 0, y: 0, width: e.width, height: e.height };
}
export function bounds(elements: readonly Element[]): Rect | null {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const e of elements) {
    if (e.isDeleted) continue;
    const local = localBox(e), cx = e.x + local.x + local.width / 2, cy = e.y + local.y + local.height / 2;
    const cos = Math.abs(Math.cos(e.angle)), sin = Math.abs(Math.sin(e.angle));
    const padding = e.type === 'arrow' ? Math.max(32, e.strokeWidth * 4) : e.type === 'freedraw' ? e.strokeWidth * 4.25 / 2 : e.strokeWidth;
    const w = cos * Math.abs(local.width) / 2 + sin * Math.abs(local.height) / 2 + padding;
    const h = sin * Math.abs(local.width) / 2 + cos * Math.abs(local.height) / 2 + padding;
    x = Math.min(x, cx - w); y = Math.min(y, cy - h); right = Math.max(right, cx + w); bottom = Math.max(bottom, cy + h);
  }
  return Number.isFinite(x) ? { x, y, width: right - x, height: bottom - y } : null;
}
export function constrainMargins(page: Page, margins: Margins, elements: readonly Element[]): Margins {
  const b = bounds(elements);
  return { left: Math.max(0, margins.left, b ? -b.x : 0), top: Math.max(0, margins.top, b ? -b.y : 0),
    right: Math.max(0, margins.right, b ? b.x + b.width - page.width : 0),
    bottom: Math.max(0, margins.bottom, b ? b.y + b.height - page.height : 0) };
}
/** Intersect each original segment analytically, retaining pressure at newly created endpoints. */
export function eraseStroke(element: Element, center: Point, radius: number, whole: boolean): Element[] {
  return eraseStrokeSegment(element, center, center, radius, whole);
}

function pointSegmentDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay, lenSq = vx * vx + vy * vy;
  if (lenSq <= 1e-12) return (px - ax) ** 2 + (py - ay) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lenSq));
  const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
  return dx * dx + dy * dy;
}

function segmentSegmentDistSq(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  // Check intersection first.
  const r1x = bx - ax, r1y = by - ay, r2x = dx - cx, r2y = dy - cy;
  const denom = r1x * r2y - r1y * r2x;
  if (Math.abs(denom) > 1e-12) {
    const qpx = cx - ax, qpy = cy - ay;
    const t = (qpx * r2y - qpy * r2x) / denom, u = (qpx * r1y - qpy * r1x) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(
    pointSegmentDistSq(ax, ay, cx, cy, dx, dy),
    pointSegmentDistSq(bx, by, cx, cy, dx, dy),
    pointSegmentDistSq(cx, cy, ax, ay, bx, by),
    pointSegmentDistSq(dx, dy, ax, ay, bx, by),
  );
}

/** Exact interval of t in [0, 1] where P(t) = a + t*v lies strictly inside the capsule (c0, c1, r). */
function capsuleClipInterval(ax: number, ay: number, vx: number, vy: number, c0x: number, c0y: number, c1x: number, c1y: number, r: number): [number, number] | null {
  const r2 = r * r;
  const A = vx * vx + vy * vy;
  const ux = c1x - c0x, uy = c1y - c0y;
  const uLenSq = ux * ux + uy * uy;
  // Degenerate capsule = single circle at c0.
  if (uLenSq <= 1e-12) {
    if (A <= 1e-12) return (ax - c0x) ** 2 + (ay - c0y) ** 2 < r2 ? [0, 1] : null;
    const B = 2 * ((ax - c0x) * vx + (ay - c0y) * vy);
    const C = (ax - c0x) ** 2 + (ay - c0y) ** 2 - r2;
    const disc = B * B - 4 * A * C;
    if (disc <= 0) return null;
    const sq = Math.sqrt(disc);
    const lo = Math.max(0, (-B - sq) / (2 * A)), hi = Math.min(1, (-B + sq) / (2 * A));
    return hi > lo ? [lo, hi] : null;
  }
  // A capsule is convex, so its intersection with line segment P(t) is a single interval [lo, hi],
  // equal to the union of: disk(c0, r), disk(c1, r), and the oriented rectangle around [c0, c1].
  let lo = Infinity, hi = -Infinity;
  const absorb = (a0: number, b0: number) => {
    const s = Math.max(0, a0), e = Math.min(1, b0);
    if (e > s) { if (s < lo) lo = s; if (e > hi) hi = e; }
  };
  const disk = (cx: number, cy: number) => {
    const ox = ax - cx, oy = ay - cy;
    if (A <= 1e-12) { if (ox * ox + oy * oy < r2) absorb(0, 1); return; }
    const B = 2 * (ox * vx + oy * vy), C = ox * ox + oy * oy - r2, disc = B * B - 4 * A * C;
    if (disc <= 0) return;
    const sq = Math.sqrt(disc);
    absorb((-B - sq) / (2 * A), (-B + sq) / (2 * A));
  };
  disk(c0x, c0y);
  disk(c1x, c1y);
  // Oriented rectangle: |cross(u, P(t) - c0)| < r * |u| AND 0 <= dot(u, P(t) - c0) <= |u|^2.
  const uLen = Math.sqrt(uLenSq), lim = r * uLen;
  const ox = ax - c0x, oy = ay - c0y;
  const clipLinear = (c: number, m: number, min: number, max: number, curLo: number, curHi: number): [number, number] | null => {
    if (Math.abs(m) <= 1e-12) return c > min && c < max ? [curLo, curHi] : null;
    let t0 = (min - c) / m, t1 = (max - c) / m;
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    const nLo = Math.max(curLo, t0), nHi = Math.min(curHi, t1);
    return nHi > nLo ? [nLo, nHi] : null;
  };
  const perp = clipLinear(ux * oy - uy * ox, ux * vy - uy * vx, -lim, lim, 0, 1);
  if (perp) {
    const slab = clipLinear(ux * ox + uy * oy, ux * vx + uy * vy, 0, uLenSq, perp[0], perp[1]);
    if (slab) absorb(slab[0], slab[1]);
  }
  return hi > lo ? [lo, hi] : null;
}

/** Fast conservative world-space AABB rejection for a stroke against an eraser query box. */
function strokeOutsideBox(element: Extract<Element, { type: 'freedraw' }>, minX: number, minY: number, maxX: number, maxY: number, pad: number): boolean {
  const local = localBox(element), cx = element.x + local.x + local.width / 2, cy = element.y + local.y + local.height / 2;
  const cos = Math.abs(Math.cos(element.angle)), sin = Math.abs(Math.sin(element.angle));
  const hw = cos * Math.abs(local.width) / 2 + sin * Math.abs(local.height) / 2 + pad;
  const hh = sin * Math.abs(local.width) / 2 + cos * Math.abs(local.height) / 2 + pad;
  return cx + hw < minX || cx - hw > maxX || cy + hh < minY || cy - hh > maxY;
}

/** Returns true if an element was drawn with the highlighter (or legacy low-opacity freedraw). */
export function isHighlighterElement(element: Element): boolean {
  if (element.customData?.inkKind === 'highlighter') return true;
  if (element.customData?.inkKind === 'pen') return false;
  return element.type === 'freedraw' && element.opacity <= 50;
}

/** Cut or delete a snapped line element along an eraser polyline (partial cuts produce shorter line segments). */
export function eraseLinePath(element: Element, path: readonly Point[], radius: number, whole: boolean): Element[] {
  if (element.type !== 'line' || element.isDeleted || element.locked || element.points.length < 2 || !path.length) return [element];
  const r = radius + element.strokeWidth / 2;
  const local = localBox(element), lx = local.x + local.width / 2, ly = local.y + local.height / 2;
  const cx = element.x + lx, cy = element.y + ly;
  const cos = Math.cos(element.angle), sin = Math.sin(element.angle);
  const segCount = Math.max(1, path.length - 1);
  const segs: { c0x: number; c0y: number; c1x: number; c1y: number }[] = [];
  for (let k = 0; k < segCount; k++) {
    const p0 = path[k], p1 = path[Math.min(k + 1, path.length - 1)];
    const d0x = p0[0] - cx, d0y = p0[1] - cy, d1x = p1[0] - cx, d1y = p1[1] - cy;
    segs.push({
      c0x: d0x * cos + d0y * sin + lx, c0y: -d0x * sin + d0y * cos + ly,
      c1x: d1x * cos + d1y * sin + lx, c1y: -d1x * sin + d1y * cos + ly,
    });
  }
  const r2 = r * r;
  if (whole) {
    for (let i = 1; i < element.points.length; i++) {
      const a = element.points[i - 1], b = element.points[i];
      for (const s of segs) {
        if (segmentSegmentDistSq(a[0], a[1], b[0], b[1], s.c0x, s.c0y, s.c1x, s.c1y) < r2) return [];
      }
    }
    return [element];
  }
  const pieces: Point[][] = [];
  let current: Point[] | undefined;
  let hit = false;
  for (let i = 1; i < element.points.length; i++) {
    const a = element.points[i - 1], b = element.points[i];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const cuts: [number, number][] = [];
    for (const s of segs) {
      const cut = capsuleClipInterval(a[0], a[1], vx, vy, s.c0x, s.c0y, s.c1x, s.c1y, r);
      if (cut) cuts.push(cut);
    }
    if (!cuts.length) {
      if (!current) { current = [a]; pieces.push(current); }
      current.push(b);
      continue;
    }
    hit = true;
    if (cuts.length > 1) cuts.sort((u, v) => u[0] - v[0]);
    let cursor = 0;
    for (const [lo, hi] of cuts) {
      if (hi <= cursor) continue;
      if (lo > cursor + 1e-9) {
        if (!current) { current = [[a[0] + vx * cursor, a[1] + vy * cursor]]; pieces.push(current); }
        current.push([a[0] + vx * lo, a[1] + vy * lo]);
      }
      current = undefined;
      if (hi > cursor) cursor = hi;
    }
    if (cursor < 1 - 1e-9) {
      current = [[a[0] + vx * cursor, a[1] + vy * cursor], b];
      pieces.push(current);
    }
  }
  if (!hit) return [element];
  return pieces.filter(p => p.length >= 2).map(piece => {
    const points = piece.map(p => {
      const x = p[0] - lx, y = p[1] - ly;
      return [cx + x * cos - y * sin, cy + x * sin + y * cos] as [number, number];
    });
    const origin = points[0];
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const [x, y] of points) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
    return {
      ...element, id: uid(), x: origin[0], y: origin[1], angle: 0 as Radians,
      points: points.map(p => [p[0] - origin[0], p[1] - origin[1]] as LocalPoint),
      width: right - left, height: bottom - top,
      version: 1, versionNonce: Math.floor(Math.random() * 2 ** 30), updated: Date.now(),
    };
  });
}

/** Single-pass analytical capsule eraser along segment [from, to]. Avoids stepped-circle overhead and scalloping. */
export function eraseStrokeSegment(element: Element, from: Point, to: Point, radius: number, whole: boolean): Element[] {
  return eraseStrokePath(element, from[0] === to[0] && from[1] === to[1] ? [from] : [from, to], radius, whole);
}

/**
 * Erase a stroke against an entire coalesced polyline in ONE single pass over element.points.
 * Transforms eraser segments to stroke-local space once, merges cut intervals per stroke segment,
 * and emits surviving pieces once — eliminating O(P * samples) re-scanning on long strokes.
 */
export function eraseStrokePath(element: Element, path: readonly Point[], radius: number, whole: boolean): Element[] {
  if (element.type !== 'freedraw' || element.isDeleted || element.locked || !path.length) return [element];
  // Upstream freehand size is strokeWidth * 4.25; include its visible radius.
  const r = radius + element.strokeWidth * 4.25 / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of path) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  if (strokeOutsideBox(element, minX, minY, maxX, maxY, r)) return [element];

  const local = localBox(element), lx = local.x + local.width / 2, ly = local.y + local.height / 2;
  const cx = element.x + lx, cy = element.y + ly;
  const cos = Math.cos(element.angle), sin = Math.sin(element.angle);
  const segCount = Math.max(1, path.length - 1);
  const segs: { c0x: number; c0y: number; c1x: number; c1y: number; minX: number; maxX: number; minY: number; maxY: number }[] = [];
  let pathLocalMinX = Infinity, pathLocalMaxX = -Infinity, pathLocalMinY = Infinity, pathLocalMaxY = -Infinity;
  for (let k = 0; k < segCount; k++) {
    const p0 = path[k], p1 = path[Math.min(k + 1, path.length - 1)];
    const d0x = p0[0] - cx, d0y = p0[1] - cy, d1x = p1[0] - cx, d1y = p1[1] - cy;
    const c0x = d0x * cos + d0y * sin + lx, c0y = -d0x * sin + d0y * cos + ly;
    const c1x = d1x * cos + d1y * sin + lx, c1y = -d1x * sin + d1y * cos + ly;
    const sMinX = Math.min(c0x, c1x) - r, sMaxX = Math.max(c0x, c1x) + r;
    const sMinY = Math.min(c0y, c1y) - r, sMaxY = Math.max(c0y, c1y) + r;
    if (sMinX < pathLocalMinX) pathLocalMinX = sMinX; if (sMaxX > pathLocalMaxX) pathLocalMaxX = sMaxX;
    if (sMinY < pathLocalMinY) pathLocalMinY = sMinY; if (sMaxY > pathLocalMaxY) pathLocalMaxY = sMaxY;
    segs.push({ c0x, c0y, c1x, c1y, minX: sMinX, maxX: sMaxX, minY: sMinY, maxY: sMaxY });
  }
  const r2 = r * r;

  if (element.points.length === 1) {
    const p = element.points[0];
    for (const s of segs) {
      if (pointSegmentDistSq(p[0], p[1], s.c0x, s.c0y, s.c1x, s.c1y) < r2) return [];
    }
    return [element];
  }
  if (whole) {
    for (let i = 1; i < element.points.length; i++) {
      const a = element.points[i - 1], b = element.points[i];
      if (Math.max(a[0], b[0]) < pathLocalMinX || Math.min(a[0], b[0]) > pathLocalMaxX || Math.max(a[1], b[1]) < pathLocalMinY || Math.min(a[1], b[1]) > pathLocalMaxY) continue;
      const abMinX = Math.min(a[0], b[0]), abMaxX = Math.max(a[0], b[0]);
      const abMinY = Math.min(a[1], b[1]), abMaxY = Math.max(a[1], b[1]);
      for (const s of segs) {
        if (abMaxX < s.minX || abMinX > s.maxX || abMaxY < s.minY || abMinY > s.maxY) continue;
        if (segmentSegmentDistSq(a[0], a[1], b[0], b[1], s.c0x, s.c0y, s.c1x, s.c1y) < r2) return [];
      }
    }
    return [element];
  }

  const pieces: { points: Point[]; pressures: number[] }[] = [];
  let current: typeof pieces[number] | undefined;
  let hit = false;
  const cuts: [number, number][] = [];

  for (let i = 1; i < element.points.length; i++) {
    const a = element.points[i - 1], b = element.points[i];
    const p0 = element.pressures[i - 1] ?? .5, p1 = element.pressures[i] ?? .5;
    const abMinX = Math.min(a[0], b[0]), abMaxX = Math.max(a[0], b[0]);
    const abMinY = Math.min(a[1], b[1]), abMaxY = Math.max(a[1], b[1]);
    if (abMaxX < pathLocalMinX || abMinX > pathLocalMaxX || abMaxY < pathLocalMinY || abMinY > pathLocalMaxY) {
      if (!current) { current = { points: [a], pressures: [p0] }; pieces.push(current); }
      current.points.push(b); current.pressures.push(p1);
      continue;
    }
    const vx = b[0] - a[0], vy = b[1] - a[1];
    cuts.length = 0;
    for (const s of segs) {
      if (abMaxX < s.minX || abMinX > s.maxX || abMaxY < s.minY || abMinY > s.maxY) continue;
      const cut = capsuleClipInterval(a[0], a[1], vx, vy, s.c0x, s.c0y, s.c1x, s.c1y, r);
      if (cut) cuts.push(cut);
    }
    if (!cuts.length) {
      if (!current) { current = { points: [a], pressures: [p0] }; pieces.push(current); }
      current.points.push(b); current.pressures.push(p1);
      continue;
    }
    hit = true;
    if (cuts.length > 1) cuts.sort((u, v) => u[0] - v[0]);
    // Walk surviving gaps between merged cut intervals in [0, 1].
    let cursor = 0;
    for (let c = 0; c < cuts.length; c++) {
      const lo = cuts[c][0], hi = cuts[c][1];
      if (hi <= cursor) continue;
      if (lo > cursor + 1e-9) {
        if (!current) {
          current = {
            points: [[a[0] + vx * cursor, a[1] + vy * cursor]],
            pressures: [p0 * (1 - cursor) + p1 * cursor],
          };
          pieces.push(current);
        }
        current.points.push([a[0] + vx * lo, a[1] + vy * lo]);
        current.pressures.push(p0 * (1 - lo) + p1 * lo);
      }
      current = undefined;
      if (hi > cursor) cursor = hi;
    }
    if (cursor < 1 - 1e-9) {
      current = {
        points: [[a[0] + vx * cursor, a[1] + vy * cursor], b],
        pressures: [p0 * (1 - cursor) + p1 * cursor, p1],
      };
      pieces.push(current);
    }
  }
  if (!hit) return [element];
  return pieces.map(piece => {
    // Preserve original rotation center by converting retained points into world coordinates.
    const points = piece.points.map(p => {
      const x = p[0] - lx, y = p[1] - ly;
      return [cx + x * cos - y * sin, cy + x * sin + y * cos] as [number, number];
    });
    const origin = points[0];
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const [x, y] of points) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
    const nextData = (element.customData?.inkRawPoints || element.customData?.inkRawPressures) ? (() => {
      const rest = { ...element.customData };
      delete rest.inkRawPoints;
      delete rest.inkRawPressures;
      return Object.keys(rest).length ? rest : undefined;
    })() : element.customData;
    return { ...element, customData: nextData, id: uid(), x: origin[0], y: origin[1], angle: 0 as Radians, points: points.map(p => [p[0] - origin[0], p[1] - origin[1]] as LocalPoint),
      width: right - left, height: bottom - top,
      pressures: element.simulatePressure ? [] : piece.pressures, version: 1, versionNonce: Math.floor(Math.random() * 2 ** 30), updated: Date.now() };
  });
}
export function cloneElements(elements: readonly Element[], dx = 24, dy = 24): Element[] {
  const ids = new Map(elements.map(e => [e.id, uid()]));
  const groups = new Map<string, string>();
  return elements.map(e => {
    const copy = structuredClone(e) as MutableElement;
    copy.id = ids.get(e.id)!; copy.x += dx; copy.y += dy; copy.version = 1;
    copy.groupIds = e.groupIds.map(g => { if (!groups.has(g)) groups.set(g, uid()); return groups.get(g)!; });
    copy.boundElements = e.boundElements?.filter(b => ids.has(b.id)).map(b => ({ ...b, id: ids.get(b.id)! })) ?? null;
    if ('containerId' in copy && copy.containerId) copy.containerId = ids.get(copy.containerId) ?? null;
    if ('startBinding' in copy) for (const key of ['startBinding', 'endBinding'] as const) if (copy[key]) copy[key] = ids.has(copy[key].elementId) ? { ...copy[key], elementId: ids.get(copy[key].elementId)! } : null;
    return retargetAnchors(copy, ids);
  });
}
export function removeElements(elements: readonly Element[], ids: Set<string>): Element[] {
  for (const e of elements) if (e.type === 'text' && e.containerId && ids.has(e.containerId)) ids.add(e.id);
  return elements.filter(e => !ids.has(e.id)).map(e => {
    const copy: MutableElement = { ...e }; let changed = false;
    if (e.boundElements?.some(b => ids.has(b.id))) { copy.boundElements = e.boundElements.filter(b => !ids.has(b.id)); changed = true; }
    if ('startBinding' in copy) for (const key of ['startBinding', 'endBinding'] as const) if (copy[key] && ids.has(copy[key].elementId)) { copy[key] = null; changed = true; }
    if (!changed) return e;
    return { ...copy, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 30), updated: Date.now() };
  });
}

export function polygonContains(polygon: readonly Point[], point: Point) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
/** Crossing segments count as selected, including sparse/rotated strokes. */
export function lassoHits(e: Element, polygon: readonly Point[]): boolean {
  if (e.isDeleted || e.locked || polygon.length < 3) return false;
  const box = localBox(e), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const cos = Math.cos(e.angle), sin = Math.sin(e.angle);
  const points: Point[] = ('points' in e ? e.points : e.type === 'ellipse' ? Array.from({ length: 32 }, (_, i) => [cx + box.width / 2 * Math.cos(i * Math.PI / 16), cy + box.height / 2 * Math.sin(i * Math.PI / 16)] as Point) : e.type === 'diamond' ? [[cx, 0], [e.width, cy], [cx, e.height], [0, cy]] : [[0, 0], [e.width, 0], [e.width, e.height], [0, e.height]]).map(p => [e.x + cx + (p[0] - cx) * cos - (p[1] - cy) * sin, e.y + cy + (p[0] - cx) * sin + (p[1] - cy) * cos]);
  if (points.some(p => polygonContains(polygon, p))) return true;
  const closed = !('points' in e);
  if (closed && polygon.some(p => polygonContains(points, p))) return true;
  const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < points.length - (closed ? 0 : 1); i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    for (let j = 0; j < polygon.length; j++) {
      const c = polygon[j], d = polygon[(j + 1) % polygon.length];
      if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.min(a[0], b[0]) > Math.max(c[0], d[0]) || Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.min(a[1], b[1]) > Math.max(c[1], d[1])) continue;
      if (cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0) return true;
    }
  }
  return false;
}

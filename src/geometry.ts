import { Element, Rect, Margins, Page, uid } from './model';
type Point = readonly [number, number];
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
  if (element.type !== 'freedraw' || element.isDeleted || element.locked) return [element];
  const local = localBox(element), lx = local.x + local.width / 2, ly = local.y + local.height / 2;
  const cx = element.x + lx, cy = element.y + ly;
  const dx = center[0] - cx, dy = center[1] - cy;
  const c: Point = [dx * Math.cos(element.angle) + dy * Math.sin(element.angle) + lx,
    -dx * Math.sin(element.angle) + dy * Math.cos(element.angle) + ly];
  // Upstream freehand size is strokeWidth * 4.25; include its visible radius.
  const r = radius + element.strokeWidth * 4.25 / 2;
  const pieces: { points: Point[]; pressures: number[] }[] = [];
  let current: typeof pieces[number] | undefined;
  let hit = false;
  const inside = (p: Point) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 < r * r;
  if (element.points.length === 1) return inside(element.points[0]) ? [] : [element];
  for (let i = 1; i < element.points.length; i++) {
    const a = element.points[i - 1], b = element.points[i];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const A = vx * vx + vy * vy, B = 2 * ((a[0] - c[0]) * vx + (a[1] - c[1]) * vy);
    const C = (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2 - r * r;
    const cuts = [0, 1], disc = B * B - 4 * A * C;
    if (A > 0 && disc > 0) for (const t of [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)]) if (t > 0 && t < 1) cuts.push(t);
    cuts.sort((a, b) => a - b);
    const point = (t: number): Point => [a[0] + vx * t, a[1] + vy * t];
    const pressure = (t: number) => (element.pressures[i - 1] ?? .5) * (1 - t) + (element.pressures[i] ?? .5) * t;
    for (let j = 1; j < cuts.length; j++) {
      const lo = cuts[j - 1], hi = cuts[j];
      if (inside(point((lo + hi) / 2))) { hit = true; current = undefined; continue; }
      if (!current) { current = { points: [point(lo)], pressures: [pressure(lo)] }; pieces.push(current); }
      current.points.push(point(hi)); current.pressures.push(pressure(hi));
    }
  }
  if (!hit) return [element];
  if (whole) return [];
  return pieces.map(piece => {
    // Preserve original rotation center by converting retained points into world coordinates.
    const points = piece.points.map(p => {
      const x = p[0] - lx, y = p[1] - ly;
      return [cx + x * Math.cos(element.angle) - y * Math.sin(element.angle), cy + x * Math.sin(element.angle) + y * Math.cos(element.angle)] as [number, number];
    });
    const origin = points[0];
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const [x, y] of points) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
    return { ...element, id: uid(), x: origin[0], y: origin[1], angle: 0, points: points.map(p => [p[0] - origin[0], p[1] - origin[1]]),
      width: right - left, height: bottom - top,
      pressures: element.simulatePressure ? [] : piece.pressures, version: 1, versionNonce: Math.floor(Math.random() * 2 ** 30), updated: Date.now() } as Element;
  });
}
export function cloneElements(elements: readonly Element[], dx = 24, dy = 24): Element[] {
  const ids = new Map(elements.map(e => [e.id, uid()]));
  const groups = new Map<string, string>();
  return elements.map(e => {
    const copy = structuredClone(e) as any;
    copy.id = ids.get(e.id); copy.x += dx; copy.y += dy; copy.version = 1;
    copy.groupIds = e.groupIds.map(g => { if (!groups.has(g)) groups.set(g, uid()); return groups.get(g); });
    copy.boundElements = e.boundElements?.filter(b => ids.has(b.id)).map(b => ({ ...b, id: ids.get(b.id) })) ?? null;
    if (copy.containerId) copy.containerId = ids.get(copy.containerId) ?? null;
    for (const key of ['startBinding', 'endBinding']) if (copy[key]) copy[key] = ids.has(copy[key].elementId) ? { ...copy[key], elementId: ids.get(copy[key].elementId) } : null;
    return copy;
  });
}
export function removeElements(elements: readonly Element[], ids: Set<string>): Element[] {
  for (const e of elements) if (e.type === 'text' && e.containerId && ids.has(e.containerId)) ids.add(e.id);
  return elements.filter(e => !ids.has(e.id)).map(e => {
    const copy = { ...e } as any; let changed = false;
    if (e.boundElements?.some(b => ids.has(b.id))) { copy.boundElements = e.boundElements.filter(b => !ids.has(b.id)); changed = true; }
    for (const key of ['startBinding', 'endBinding']) if (copy[key] && ids.has(copy[key].elementId)) { copy[key] = null; changed = true; }
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

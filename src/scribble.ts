import type { Element } from './model';
import { polygonBounds, polygonContains, type ScenePoint } from './geometry';

/** Recognise a deliberate, fast back-and-forth stroke. Operates on a derived copy only. */
export function scribbleRegion(points: readonly ScenePoint[], zoom: number, elapsed: number): ScenePoint[] | null {
  if (points.length < 10 || elapsed > 2500 || elapsed < 80) return null;
  const box = polygonBounds(points);
  if (Math.max(box.width, box.height) * zoom < 24 || Math.max(box.width, box.height) * zoom > 900) return null;
  // Principal axis makes the gesture work at any writing angle.
  let xx = 0, xy = 0, yy = 0;
  const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  for (const [x, y] of points) { xx += (x - cx) ** 2; xy += (x - cx) * (y - cy); yy += (y - cy) ** 2; }
  const angle = Math.atan2(2 * xy, xx - yy) / 2, cos = Math.cos(angle), sin = Math.sin(angle);
  const axis = points.map(([x, y]) => (x - cx) * cos + (y - cy) * sin);
  const across = points.map(([x, y]) => -(x - cx) * sin + (y - cy) * cos);
  const range = (values: number[]) => { let lo = Infinity, hi = -Infinity; for (const v of values) { lo = Math.min(lo, v); hi = Math.max(hi, v); } return hi - lo; };
  const span = range(axis), height = range(across);
  if (height * zoom < 6 || height > span * .85) return null;
  let direction = 0, extreme = axis[0], start = axis[0], runs = 0, length = 0, axial = 0;
  for (let i = 1; i < axis.length; i++) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    axial += Math.abs(axis[i] - axis[i - 1]);
    if (!direction) { if (Math.abs(axis[i] - start) > span * .12) { direction = Math.sign(axis[i] - start); extreme = axis[i]; } continue; }
    if ((axis[i] - extreme) * direction >= 0) extreme = axis[i];
    else if ((extreme - axis[i]) * direction > span * .18) {
      if (Math.abs(extreme - start) >= span * .55) runs++;
      start = extreme; extreme = axis[i]; direction *= -1;
    }
  }
  if (Math.abs(extreme - start) >= span * .55) runs++;
  if (runs < 5 || axial < span * 4 || axial / length < .82) return null;
  // A convex envelope avoids erasing disconnected corners of an axis-aligned box.
  const sorted = points.map(p => [...p] as ScenePoint).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a: ScenePoint, b: ScenePoint, c: ScenePoint) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = (list: ScenePoint[]) => { const hull: ScenePoint[] = []; for (const p of list) { while (hull.length > 1 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop(); hull.push(p); } hull.pop(); return hull; };
  return [...half(sorted), ...half(sorted.reverse())];
}

/** Mostly covered handwriting is removed as a stroke; nearby long lines stay intact. */
export function scribbleHits(element: Element, region: ScenePoint[]): boolean {
  if (element.type !== 'freedraw' || element.isDeleted || element.locked || !element.points.length) return false;
  const box = polygonBounds(element.points), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const cos = Math.cos(element.angle), sin = Math.sin(element.angle);
  const points = element.points.map(([x, y]) => [element.x + cx + (x - cx) * cos - (y - cy) * sin, element.y + cy + (x - cx) * sin + (y - cy) * cos] as ScenePoint);
  if (points.length === 1) return polygonContains(region, points[0]);
  let covered = 0, total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const cuts = [0, 1], dx = b[0] - a[0], dy = b[1] - a[1];
    for (let j = 0; j < region.length; j++) {
      const c = region[j], d = region[(j + 1) % region.length], ex = d[0] - c[0], ey = d[1] - c[1], det = dx * ey - dy * ex;
      if (Math.abs(det) < 1e-10) continue;
      const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / det, u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / det;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
    }
    cuts.sort((a, b) => a - b);
    for (let j = 1; j < cuts.length; j++) { const t = (cuts[j] + cuts[j - 1]) / 2; if (polygonContains(region, [a[0] + dx * t, a[1] + dy * t])) covered += length * (cuts[j] - cuts[j - 1]); }
    total += length;
  }
  return total > 0 ? covered / total >= .55 : polygonContains(region, points[0]);
}

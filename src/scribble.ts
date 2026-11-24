import type { Element } from './model';
import { uid } from './model';
import type { LocalPoint, Radians } from '@excalidraw/math';
import { isHighlighterElement, polygonBounds, polygonContains, type ScenePoint } from './geometry';

/** Recognise a deliberate, brisk back-and-forth stroke. Operates on a derived copy only. */
export function scribbleRegion(points: readonly ScenePoint[], zoom: number, elapsed: number): ScenePoint[] | null {
  if (points.length < 4 || elapsed > 3500 || elapsed < 40) return null;
  const box = polygonBounds(points);
  const maxDim = Math.max(box.width, box.height) * zoom;
  if (maxDim < 14 || maxDim > 1000) return null;
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
  if (height * zoom < 2.5 || height > span * 1.15) return null;
  let direction = 0, extreme = axis[0], start = axis[0], runs = 0, length = 0, axial = 0;
  for (let i = 1; i < axis.length; i++) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    axial += Math.abs(axis[i] - axis[i - 1]);
    if (!direction) { if (Math.abs(axis[i] - start) > span * .1) { direction = Math.sign(axis[i] - start); extreme = axis[i]; } continue; }
    if ((axis[i] - extreme) * direction >= 0) extreme = axis[i];
    else if ((extreme - axis[i]) * direction > span * .14) {
      if (Math.abs(extreme - start) >= span * .42) runs++;
      start = extreme; extreme = axis[i]; direction *= -1;
    }
  }
  if (Math.abs(extreme - start) >= span * .42) runs++;
  // Three sweeps (2 reversals) stay narrow enough to keep a hand-drawn Z as ink;
  // four or more sweeps accept taller/squarer scribbles over single CJK characters or fractions.
  if (runs < 3 || axial < span * 1.75 || axial / length < .65 || (runs === 3 && height > span * .42)) return null;
  // A convex envelope covers the scribbled region cleanly.
  const sorted = points.map(p => [...p] as ScenePoint).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a: ScenePoint, b: ScenePoint, c: ScenePoint) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = (list: ScenePoint[]) => { const hull: ScenePoint[] = []; for (const p of list) { while (hull.length > 1 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop(); hull.push(p); } hull.pop(); return hull; };
  return [...half(sorted), ...half(sorted.reverse())];
}

function segmentPolygonCuts(a: ScenePoint, b: ScenePoint, region: readonly ScenePoint[]): number[] {
  const cuts = [0, 1], dx = b[0] - a[0], dy = b[1] - a[1];
  for (let j = 0; j < region.length; j++) {
    const c = region[j], d = region[(j + 1) % region.length], ex = d[0] - c[0], ey = d[1] - c[1], det = dx * ey - dy * ex;
    if (Math.abs(det) < 1e-10) continue;
    const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / det, u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / det;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
  }
  cuts.sort((x, y) => x - y);
  return cuts;
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
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const cuts = segmentPolygonCuts(a, b, region);
    for (let j = 1; j < cuts.length; j++) { const t = (cuts[j] + cuts[j - 1]) / 2; if (polygonContains(region, [a[0] + dx * t, a[1] + dy * t])) covered += length * (cuts[j] - cuts[j - 1]); }
    total += length;
  }
  return total > 0 ? covered / total >= .55 : polygonContains(region, points[0]);
}

/**
 * Erase ALL ink strictly inside the scribbled region:
 * - Segments inside `region` are cut away cleanly right at the scribble boundary.
 * - Surviving dust stubs shorter than 6 scene units are removed so erased characters leave no crumbs,
 *   while long crossing strokes outside the scribbled region remain intact.
 * - Locked ink and non-ink objects (except snapped highlighter lines) remain untouched.
 */
export function eraseStrokeInRegion(element: Element, region: readonly ScenePoint[]): Element[] {
  if (element.isDeleted || element.locked || region.length < 3) return [element];
  const isHiLine = element.type === 'line' && isHighlighterElement(element);
  if (element.type !== 'freedraw' && !isHiLine) return [element];
  if (!element.points.length) return [element];

  const box = polygonBounds(element.points), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const cos = Math.cos(element.angle), sin = Math.sin(element.angle);
  const world = element.points.map(([x, y]) => [element.x + cx + (x - cx) * cos - (y - cy) * sin, element.y + cy + (x - cx) * sin + (y - cy) * cos] as ScenePoint);

  // Fast AABB rejection against region bounds.
  const rBox = polygonBounds(region), wBox = polygonBounds(world);
  if (wBox.x > rBox.x + rBox.width || wBox.x + wBox.width < rBox.x || wBox.y > rBox.y + rBox.height || wBox.y + wBox.height < rBox.y) return [element];

  if (world.length === 1) return polygonContains(region, world[0]) ? [] : [element];

  const pieces: { points: ScenePoint[]; pressures: number[]; length: number }[] = [];
  let current: typeof pieces[number] | undefined;
  let covered = 0;

  for (let i = 1; i < world.length; i++) {
    const a = world[i - 1], b = world[i], dx = b[0] - a[0], dy = b[1] - a[1];
    const segLen = Math.hypot(dx, dy);
    const p0 = element.type === 'freedraw' ? (element.pressures?.[i - 1] ?? .5) : .5;
    const p1 = element.type === 'freedraw' ? (element.pressures?.[i] ?? .5) : .5;
    const cuts = segmentPolygonCuts(a, b, region);
    for (let j = 1; j < cuts.length; j++) {
      const lo = cuts[j - 1], hi = cuts[j], frac = hi - lo;
      if (frac <= 1e-9) continue;
      const mid: ScenePoint = [a[0] + dx * ((lo + hi) / 2), a[1] + dy * ((lo + hi) / 2)];
      if (polygonContains(region, mid)) {
        covered += segLen * frac;
        current = undefined;
        continue;
      }
      const startPt: ScenePoint = [a[0] + dx * lo, a[1] + dy * lo];
      const endPt: ScenePoint = [a[0] + dx * hi, a[1] + dy * hi];
      if (!current) {
        current = { points: [startPt], pressures: [p0 * (1 - lo) + p1 * lo], length: 0 };
        pieces.push(current);
      }
      current.points.push(endPt);
      current.pressures.push(p0 * (1 - hi) + p1 * hi);
      current.length += segLen * frac;
    }
  }

  if (covered <= 1e-6) return [element];

  const surviving = pieces.filter(p => p.points.length >= 2 && p.length >= 6);
  if (!surviving.length) return [];

  return surviving.map(piece => {
    const origin = piece.points[0];
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const [x, y] of piece.points) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
    const localPts = piece.points.map(([x, y]) => [x - origin[0], y - origin[1]] as LocalPoint);
    if (element.type === 'freedraw') {
      return {
        ...element, id: uid(), x: origin[0], y: origin[1], angle: 0 as Radians,
        points: localPts, width: right - left, height: bottom - top,
        pressures: element.simulatePressure ? [] : piece.pressures,
        version: 1, versionNonce: Math.floor(Math.random() * 2 ** 30), updated: Date.now(),
      };
    }
    return {
      ...element, id: uid(), x: origin[0], y: origin[1], angle: 0 as Radians,
      points: localPts, width: right - left, height: bottom - top,
      version: 1, versionNonce: Math.floor(Math.random() * 2 ** 30), updated: Date.now(),
    };
  });
}

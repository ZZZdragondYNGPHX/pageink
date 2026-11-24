import type { Element } from './model';
import { polygonBounds, type ScenePoint } from './geometry';

export type RecognizedShape =
  | { kind: 'line'; start: ScenePoint; end: ScenePoint }
  | { kind: 'arrow'; start: ScenePoint; end: ScenePoint }
  | { kind: 'rectangle'; x: number; y: number; width: number; height: number }
  | { kind: 'ellipse'; x: number; y: number; width: number; height: number }
  | { kind: 'diamond'; x: number; y: number; width: number; height: number };

const dist = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function pointToSegmentDistance(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
  const vx = b[0] - a[0], vy = b[1] - a[1], lenSq = vx * vx + vy * vy;
  if (lenSq <= 1e-12) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / lenSq));
  return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
}

function segmentIntersection(a: ScenePoint, b: ScenePoint, c: ScenePoint, d: ScenePoint): ScenePoint | null {
  const r1x = b[0] - a[0], r1y = b[1] - a[1], r2x = d[0] - c[0], r2y = d[1] - c[1];
  const denom = r1x * r2y - r1y * r2x;
  if (Math.abs(denom) < 1e-9) return null;
  const qpx = c[0] - a[0], qpy = c[1] - a[1];
  const t = (qpx * r2y - qpy * r2x) / denom, u = (qpx * r1y - qpy * r1x) / denom;
  if (t > 0 && t < 1 && u > 0 && u < 1) return [a[0] + r1x * t, a[1] + r1y * t];
  return null;
}

function polygonArea(points: readonly ScenePoint[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return Math.abs(sum) / 2;
}

function pathLength(points: readonly ScenePoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
  return len;
}

/** Downsample a raw stroke to points spaced by at least `minStep` scene units without mutating the source. */
export function resampleStroke(points: readonly ScenePoint[], minStep: number): ScenePoint[] {
  if (points.length <= 2) return points.map(p => [p[0], p[1]]);
  const out: ScenePoint[] = [[points[0][0], points[0][1]]];
  for (let i = 1; i < points.length - 1; i++) {
    if (dist(out[out.length - 1], points[i]) >= minStep) out.push([points[i][0], points[i][1]]);
  }
  out.push([points[points.length - 1][0], points[points.length - 1][1]]);
  return out;
}

/** Convert a freedraw element's local points into world/scene coordinates (including rotation). */
export function strokeWorldPoints(element: Element): ScenePoint[] {
  if (element.type !== 'freedraw' || !element.points.length) return [];
  if (Math.abs(element.angle) < 1e-9) return element.points.map(([x, y]) => [element.x + x, element.y + y]);
  const box = polygonBounds(element.points);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const cos = Math.cos(element.angle), sin = Math.sin(element.angle);
  return element.points.map(([x, y]) => [element.x + cx + (x - cx) * cos - (y - cy) * sin, element.y + cy + (x - cx) * sin + (y - cy) * cos]);
}

/** Returns true if `point` lies within `tolerance` scene units of the freedraw stroke path. */
export function hitStrokePath(element: Element, point: ScenePoint, tolerance: number): boolean {
  if (element.type !== 'freedraw' || element.isDeleted || !element.points.length) return false;
  const pts = strokeWorldPoints(element);
  const pad = tolerance + element.strokeWidth * 2.2;
  const box = polygonBounds(pts);
  if (point[0] < box.x - pad || point[0] > box.x + box.width + pad || point[1] < box.y - pad || point[1] > box.y + box.height + pad) return false;
  if (pts.length === 1) return dist(point, pts[0]) <= pad;
  for (let i = 1; i < pts.length; i++) {
    if (pointToSegmentDistance(point, pts[i - 1], pts[i]) <= pad) return true;
  }
  return false;
}

/**
 * Detect whether a drawn stroke forms a closed or self-intersecting loop suitable for Circle-to-Lasso.
 * Returns the enclosed polygon in scene coordinates, or null if the stroke is open / too small / degenerate.
 */
export function closedLoopPolygon(rawPoints: readonly ScenePoint[], zoom: number): ScenePoint[] | null {
  if (rawPoints.length < 6) return null;
  const points = resampleStroke(rawPoints, Math.max(1.5 / Math.max(zoom, 0.1), 1));
  if (points.length < 5) return null;
  const box = polygonBounds(points);
  const diag = Math.hypot(box.width, box.height);
  if (Math.max(box.width, box.height) * zoom < 24 || diag * zoom < 28) return null;

  let loop: ScenePoint[] | null = null;
  const endGap = dist(points[0], points[points.length - 1]);
  const maxGap = Math.max(36 / Math.max(zoom, 0.1), diag * 0.42);
  if (endGap <= maxGap) {
    loop = points;
  } else {
    // Check for a self-intersecting loop (tails crossing each other).
    const maxScan = Math.min(points.length, 160);
    const step = points.length > maxScan ? points.length / maxScan : 1;
    const sampled: ScenePoint[] = [];
    for (let i = 0; i < points.length; i += step) sampled.push(points[Math.floor(i)]);
    outer: for (let i = 0; i < sampled.length - 4; i++) {
      for (let j = sampled.length - 2; j >= i + 3; j--) {
        const hit = segmentIntersection(sampled[i], sampled[i + 1], sampled[j], sampled[j + 1]);
        if (hit) {
          loop = [hit, ...sampled.slice(i + 1, j + 1)];
          break outer;
        }
      }
    }
  }
  if (!loop || loop.length < 4) return null;
  const loopBox = polygonBounds(loop);
  const area = polygonArea(loop);
  const boxArea = loopBox.width * loopBox.height;
  if (loopBox.width * zoom < 18 || loopBox.height * zoom < 18) return null;
  if (boxArea <= 0 || area / boxArea < 0.14 || area * zoom * zoom < 260) return null;
  return loop;
}

/** Ramer-Douglas-Peucker simplification. */
function simplify(points: readonly ScenePoint[], epsilon: number): ScenePoint[] {
  if (points.length <= 2) return [...points];
  let maxDist = 0, index = 0;
  const first = points[0], last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToSegmentDistance(points[i], first, last);
    if (d > maxDist) { maxDist = d; index = i; }
  }
  if (maxDist > epsilon) {
    const left = simplify(points.slice(0, index + 1), epsilon);
    const right = simplify(points.slice(index), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

function snapLineEndpoints(start: ScenePoint, end: ScenePoint): [ScenePoint, ScenePoint] {
  const dx = end[0] - start[0], dy = end[1] - start[1], length = Math.hypot(dx, dy);
  if (length < 1e-6) return [start, end];
  const angle = Math.atan2(dy, dx);
  const snapStep = Math.PI / 4; // snap to 0, 45, 90, ... degrees within 6 deg
  const nearest = Math.round(angle / snapStep) * snapStep;
  if (Math.abs(angle - nearest) <= (6 * Math.PI) / 180) {
    return [start, [start[0] + Math.cos(nearest) * length, start[1] + Math.sin(nearest) * length]];
  }
  return [start, end];
}

/**
 * Hold-to-Shape recognizer ("一笔成形").
 * Supports straight lines, arrows, ellipses/circles, rectangles, and diamonds.
 */
export function recognizeShape(
  rawPoints: readonly ScenePoint[],
  zoom: number,
  options: { lineOnly?: boolean; enclosesContent?: boolean } = {},
): RecognizedShape | null {
  if (rawPoints.length < 3) return null;
  const safeZoom = Math.max(zoom, 0.1);
  const points = resampleStroke(rawPoints, Math.max(2 / safeZoom, 1));
  if (points.length < 2) return null;
  const box = polygonBounds(points);
  const diag = Math.hypot(box.width, box.height);
  if (diag * safeZoom < 20) return null;
  const len = pathLength(points);
  if (len <= 1e-6) return null;

  const first = points[0], last = points[points.length - 1];
  const chord = dist(first, last);

  // 1. Straight line check (open stroke, nearly collinear).
  let maxLineDev = 0;
  for (const p of points) maxLineDev = Math.max(maxLineDev, pointToSegmentDistance(p, first, last));
  const lineTol = Math.max(8 / safeZoom, chord * 0.085);
  if (chord * safeZoom >= 20 && chord / len >= 0.91 && maxLineDev <= lineTol) {
    const [start, end] = snapLineEndpoints(first, last);
    return { kind: 'line', start, end };
  }
  if (options.lineOnly) return null;

  // 2. Single-stroke arrow check: straight shaft + small angled barb at the tip.
  if (points.length >= 6 && chord / len >= 0.55) {
    // Find the farthest point from `first` as candidate arrow tip.
    let tipIdx = 0, tipDist = 0;
    for (let i = 1; i < points.length; i++) {
      const d = dist(first, points[i]);
      if (d > tipDist) { tipDist = d; tipIdx = i; }
    }
    const tailLen = pathLength(points.slice(tipIdx));
    if (tipIdx >= 2 && tipIdx < points.length - 1 && tipDist * safeZoom >= 28 && tailLen >= tipDist * 0.08 && tailLen <= tipDist * 0.45) {
      const tip = points[tipIdx];
      let shaftDev = 0;
      for (let i = 0; i <= tipIdx; i++) shaftDev = Math.max(shaftDev, pointToSegmentDistance(points[i], first, tip));
      const shaftLen = pathLength(points.slice(0, tipIdx + 1));
      if (tipDist / Math.max(shaftLen, 1e-6) >= 0.9 && shaftDev <= Math.max(8 / safeZoom, tipDist * 0.08)) {
        const sdx = tip[0] - first[0], sdy = tip[1] - first[1];
        const bdx = last[0] - tip[0], bdy = last[1] - tip[1];
        const bLen = Math.hypot(bdx, bdy);
        if (bLen > 1e-6) {
          const cosAngle = (sdx * bdx + sdy * bdy) / (tipDist * bLen);
          // Barb must fold back toward the shaft (angle between shaft dir and barb dir > 105° and < 172°).
          if (cosAngle <= -0.25 && cosAngle >= -0.99) {
            const [start, end] = snapLineEndpoints(first, tip);
            return { kind: 'arrow', start, end };
          }
        }
      }
    }
  }

  // 3. Closed shapes (ellipse/circle, rectangle, diamond).
  const gap = dist(first, last);
  if (gap > Math.max(30 / safeZoom, diag * 0.3)) return null;
  if (box.width * safeZoom < 20 || box.height * safeZoom < 20) return null;
  const closedPts = [...points, first];
  const area = polygonArea(points);
  const boxArea = box.width * box.height;
  if (boxArea <= 0 || area / boxArea < 0.32) return null;

  // Compute radial regularity around bounding-box centre (ellipse test).
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const rx = box.width / 2, ry = box.height / 2;
  const normalizedRadii = points.map(([x, y]) => Math.hypot((x - cx) / Math.max(rx, 1e-6), (y - cy) / Math.max(ry, 1e-6)));
  const meanR = normalizedRadii.reduce((s, v) => s + v, 0) / normalizedRadii.length;
  const variance = normalizedRadii.reduce((s, v) => s + (v - meanR) ** 2, 0) / normalizedRadii.length;
  const ellipseCv = Math.sqrt(variance) / Math.max(meanR, 1e-6);

  // Measure rectangularity & diamond fit via boundary distance and simplified vertices.
  const rectEdgeError = points.reduce((sum, [x, y]) => sum + Math.min(
    Math.abs(x - box.x), Math.abs(x - (box.x + box.width)),
    Math.abs(y - box.y), Math.abs(y - (box.y + box.height)),
  ), 0) / points.length / Math.max(diag, 1e-6);

  const diamondVerts: ScenePoint[] = [[cx, box.y], [box.x + box.width, cy], [cx, box.y + box.height], [box.x, cy]];
  const diamondEdgeError = points.reduce((sum, p) => {
    let best = Infinity;
    for (let i = 0; i < 4; i++) best = Math.min(best, pointToSegmentDistance(p, diamondVerts[i], diamondVerts[(i + 1) % 4]));
    return sum + best;
  }, 0) / points.length / Math.max(diag, 1e-6);

  const fillRatio = area / boxArea;
  const simp = simplify(closedPts, Math.max(diag * 0.065, 6 / safeZoom));
  // Remove closing duplicate vertex if present.
  const corners = simp.length > 1 && dist(simp[0], simp[simp.length - 1]) < diag * 0.12 ? simp.slice(0, -1) : simp;

  // Rectangle: high box fill (> 0.78), low edge error, ~4 corners.
  const rectLimit = options.enclosesContent ? 0.042 : 0.058;
  if (fillRatio >= 0.76 && rectEdgeError <= rectLimit && corners.length >= 4 && corners.length <= 5) {
    return { kind: 'rectangle', x: box.x, y: box.y, width: box.width, height: box.height };
  }

  // Diamond: fill near 0.5 (0.36..0.64), low diamond edge error, ~4 corners.
  const diamondLimit = options.enclosesContent ? 0.04 : 0.055;
  if (fillRatio >= 0.36 && fillRatio <= 0.65 && diamondEdgeError <= diamondLimit && diamondEdgeError < ellipseCv * 0.55 && corners.length >= 4 && corners.length <= 5) {
    return { kind: 'diamond', x: box.x, y: box.y, width: box.width, height: box.height };
  }

  // Ellipse / Circle: low normalized radial CV and ~pi/4 fill ratio (0.62..0.90).
  const ellipseLimit = options.enclosesContent ? 0.115 : 0.175;
  if (ellipseCv <= ellipseLimit && fillRatio >= 0.58 && fillRatio <= 0.92) {
    const aspect = box.width / Math.max(box.height, 1e-6);
    if (aspect >= 0.84 && aspect <= 1.19) {
      const size = (box.width + box.height) / 2;
      return { kind: 'ellipse', x: cx - size / 2, y: cy - size / 2, width: size, height: size };
    }
    return { kind: 'ellipse', x: box.x, y: box.y, width: box.width, height: box.height };
  }

  return null;
}

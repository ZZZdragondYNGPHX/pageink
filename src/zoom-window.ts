import type { LocalPoint, Radians } from '@excalidraw/math';
import { Element, Rect, uid } from './model';
import type { ScenePoint } from './geometry';

export type ZoomFactor = 2 | 3 | 4;

/** Maps a zoom-strip canvas pixel point to its exact scene coordinate inside `box`. */
export function zoomCanvasToScene(cx: number, cy: number, canvasWidth: number, canvasHeight: number, box: Rect): ScenePoint {
  if (canvasWidth <= 0 || canvasHeight <= 0) return [box.x, box.y];
  return [
    box.x + (cx / canvasWidth) * box.width,
    box.y + (cy / canvasHeight) * box.height,
  ];
}

/** Maps a scene coordinate to zoom-strip canvas CSS pixels inside `box`. */
export function sceneToZoomCanvas(sx: number, sy: number, canvasWidth: number, canvasHeight: number, box: Rect): [number, number] {
  if (box.width <= 0 || box.height <= 0) return [0, 0];
  return [
    ((sx - box.x) / box.width) * canvasWidth,
    ((sy - box.y) / box.height) * canvasHeight,
  ];
}

/** Computes a target box in scene coordinates sized to match the strip aspect ratio at `factor`. */
export function zoomBoxSize(stripWidth: number, stripHeight: number, factor: ZoomFactor): { width: number; height: number } {
  const safeW = Math.max(240, stripWidth);
  const safeH = Math.max(120, stripHeight);
  return { width: safeW / factor, height: safeH / factor };
}

/** Clamps a target box inside optional page bounds while preserving box dimensions when possible. */
export function clampZoomBox(box: Rect, limit?: Rect): Rect {
  if (!limit) return box;
  const maxX = limit.x + Math.max(0, limit.width - box.width);
  const maxY = limit.y + Math.max(0, limit.height - box.height);
  return {
    x: Math.max(limit.x, Math.min(box.x, maxX)),
    y: Math.max(limit.y, Math.min(box.y, maxY)),
    width: box.width,
    height: box.height,
  };
}

/** Advances the target box horizontally by `fraction` of its width; wraps to the next line at the right edge of `limit`. */
export function advanceZoomBox(box: Rect, limit: Rect | undefined, direction: 1 | -1 = 1, lineStep?: number): Rect {
  const stepX = box.width * 0.65 * direction;
  const nextX = box.x + stepX;
  if (!limit) return { ...box, x: nextX };
  if (direction > 0) {
    const rightEdge = limit.x + limit.width;
    if (box.x + box.width >= rightEdge - 4) {
      return newlineZoomBox(box, limit, lineStep);
    }
    return clampZoomBox({ ...box, x: Math.min(nextX, rightEdge - box.width) }, limit);
  }
  return clampZoomBox({ ...box, x: Math.max(limit.x, nextX) }, limit);
}

/** Moves the target box back to the left edge and down by one writing row. */
export function newlineZoomBox(box: Rect, limit?: Rect, lineStep?: number): Rect {
  const dy = lineStep && lineStep > 0 ? lineStep : box.height * 0.72;
  const nextX = limit ? limit.x + Math.min(24, Math.max(0, limit.width - box.width)) : box.x;
  const candidate: Rect = { ...box, x: nextX, y: box.y + dy };
  return limit ? clampZoomBox(candidate, limit) : candidate;
}

/** Returns true when a completed stroke extends into the right-side auto-advance trigger zone. */
export function shouldAutoAdvance(strokeMaxX: number, box: Rect, threshold = 0.72): boolean {
  return box.width > 0 && strokeMaxX >= box.x + box.width * threshold;
}

/** Builds a valid Excalidraw freedraw element from world-space points captured inside the Zoom Window. */
export function buildZoomFreedrawElement(
  worldPoints: readonly ScenePoint[],
  pressures: readonly number[],
  options: { color: string; width: number; opacity: number; inkKind: 'pen' | 'highlighter'; fixedPressure: boolean; rawPoints?: readonly ScenePoint[]; rawPressures?: readonly number[] },
): Element | null {
  if (!worldPoints.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of worldPoints) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const localPoints: LocalPoint[] = worldPoints.map(([x, y]) => [x - minX, y - minY] as LocalPoint);
  if (localPoints.length === 1) localPoints.push([0.01, 0.01] as LocalPoint);
  const rawLocal = options.rawPoints?.length
    ? options.rawPoints.map(([x, y]) => [x - minX, y - minY] as [number, number])
    : undefined;
  const rawPressures = rawLocal && options.rawPressures?.length === rawLocal.length
    ? [...options.rawPressures]
    : undefined;
  const finalPressures = options.fixedPressure
    ? localPoints.map(() => 0.5)
    : localPoints.map((_, i) => pressures[Math.min(i, pressures.length - 1)] ?? 0.5);
  const now = Date.now();
  return {
    id: uid(),
    type: 'freedraw',
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    angle: 0 as Radians,
    strokeColor: options.color,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: options.width,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: options.opacity,
    groupIds: [],
    frameId: null,
    index: null as unknown as Element['index'],
    roundness: null,
    seed: Math.floor(Math.random() * 2 ** 30),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 30),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    points: localPoints,
    pressures: finalPressures,
    simulatePressure: false,
    lastCommittedPoint: localPoints[localPoints.length - 1],
    customData: {
      inkKind: options.inkKind,
      inkFixedWidth: options.fixedPressure,
      ...(rawLocal ? { inkRawPoints: rawLocal } : {}),
      ...(rawPressures ? { inkRawPressures: rawPressures } : {}),
    },
  };
}

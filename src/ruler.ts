import type { LocalPoint, Radians } from '@excalidraw/math';
import { Element, uid } from './model';
import type { ScenePoint } from './geometry';

export interface RulerState {
  /** Center X in editor-local CSS pixels. */
  x: number;
  /** Center Y in editor-local CSS pixels. */
  y: number;
  /** Angle in degrees (-180..180). */
  angle: number;
  /** Visual length in CSS pixels. */
  length: number;
}

export const RULER_HALF_THICKNESS = 28;
const SNAP_ANGLES = [-180, -135, -90, -45, 0, 45, 90, 135, 180] as const;

/** Normalizes angle into [-180, 180] and snaps within `tolerance` degrees of standard drafting angles. */
export function snapRulerAngle(deg: number, tolerance = 3): number {
  let a = ((deg + 180) % 360 + 360) % 360 - 180;
  for (const target of SNAP_ANGLES) {
    if (Math.abs(a - target) <= tolerance) {
      a = target === -180 ? 180 : target;
      break;
    }
  }
  return Math.round(a * 10) / 10;
}

/**
 * Checks whether a screen-space point is within `snapBand` pixels of the ruler's top or bottom edge.
 * Returns the snapped edge (-1 top / 1 bottom) and exact projected screen coordinate on that edge.
 */
export function rulerEdgeProjection(
  pt: [number, number],
  ruler: RulerState,
  halfThickness = RULER_HALF_THICKNESS,
  snapBand = 24,
): { edge: -1 | 1; projected: [number, number]; along: number } | null {
  const rad = (ruler.angle * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = pt[0] - ruler.x, dy = pt[1] - ruler.y;
  const along = dx * cos + dy * sin;
  const perp = -dx * sin + dy * cos;
  if (Math.abs(along) > ruler.length / 2 + 18) return null;
  const distTop = Math.abs(perp + halfThickness);
  const distBot = Math.abs(perp - halfThickness);
  if (Math.min(distTop, distBot) > snapBand) return null;
  const edge: -1 | 1 = distTop <= distBot ? -1 : 1;
  const offset = edge * halfThickness;
  return {
    edge,
    along,
    projected: [ruler.x + along * cos - offset * sin, ruler.y + along * sin + offset * cos],
  };
}

/** Projects any screen-space point directly onto the locked ruler edge line. */
export function projectAlongRulerEdge(
  pt: [number, number],
  ruler: RulerState,
  edge: -1 | 1,
  halfThickness = RULER_HALF_THICKNESS,
): [number, number] {
  const rad = (ruler.angle * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = pt[0] - ruler.x, dy = pt[1] - ruler.y;
  const along = dx * cos + dy * sin;
  const offset = edge * halfThickness;
  return [ruler.x + along * cos - offset * sin, ruler.y + along * sin + offset * cos];
}

/** Builds a clean Excalidraw straight line element drawn along the virtual ruler. */
export function createRulerLineElement(
  start: ScenePoint,
  end: ScenePoint,
  options: { color: string; width: number; opacity: number; inkKind: 'pen' | 'highlighter' },
): Element {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const now = Date.now();
  return {
    id: uid(),
    type: 'line',
    x: start[0],
    y: start[1],
    width: Math.abs(dx),
    height: Math.abs(dy),
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
    points: [[0, 0] as LocalPoint, [dx, dy] as LocalPoint],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
    customData: { inkKind: options.inkKind },
  };
}

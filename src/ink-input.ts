interface PointerHandler {
  (event: PointerEvent): void;
  flush(): void;
  cancel(): void;
}
const batches = new WeakMap<PointerEvent, readonly PointerEvent[]>();

/** Keep every delivered/coalesced pen sample while scheduling one update per frame. */
export function preserveInkSamples(schedule: (consume: (event: PointerEvent) => void) => PointerHandler, consume: (event: PointerEvent) => void, pointerId?: number): PointerHandler {
  let pending: PointerEvent[] = [];
  const run = schedule(event => {
    const samples = pending; pending = [];
    batches.set(event, samples);
    try { consume(event); } finally { batches.delete(event); }
  });
  return Object.assign((event: PointerEvent) => {
    if (pointerId !== undefined && event.pointerId !== pointerId) return;
    const coalesced = event.getCoalescedEvents?.();
    for (const sample of coalesced?.length ? coalesced : [event]) pending.push(sample);
    run(event);
  }, {
    flush: () => run.flush(),
    cancel: () => { pending = []; run.cancel(); },
  });
}

export function inkPointerSamples(event: PointerEvent): readonly PointerEvent[] { return batches.get(event) ?? [event]; }

export type StabilizeLevel = 0 | 1 | 2;
const STABILIZE_ALPHA: Record<StabilizeLevel, number> = { 0: 1, 1: 0.65, 2: 0.42 };

/**
 * Low-latency exponential moving average stroke stabilizer.
 * Level 0 passes raw coordinates through untouched; higher levels smooth micro-tremor
 * while keeping the exact start point anchored and allowing raw lift endpoints.
 */
export class InkStabilizer {
  private x = 0;
  private y = 0;
  private active = false;
  constructor(readonly level: StabilizeLevel) {}
  start(x: number, y: number): [number, number] {
    this.x = x; this.y = y; this.active = true;
    return [x, y];
  }
  next(x: number, y: number): [number, number] {
    if (this.level === 0) return [x, y];
    if (!this.active) return this.start(x, y);
    const a = STABILIZE_ALPHA[this.level];
    this.x += a * (x - this.x);
    this.y += a * (y - this.y);
    return [this.x, this.y];
  }
  finish(x: number, y: number): [number, number] {
    this.active = false;
    return [x, y];
  }
}

const strokeStabilizers = new WeakMap<object, { filter: InkStabilizer; raw: [number, number][] }>();

/** Per-stroke stateful stabilizer keyed by the active freedraw element object; also retains raw coordinates. */
export function stabilizeInkPoint(stroke: object, level: StabilizeLevel, x: number, y: number, originX = 0, originY = 0): [number, number] {
  if (level === 0) return [x, y];
  let entry = strokeStabilizers.get(stroke);
  if (!entry || entry.filter.level !== level) {
    const filter = new InkStabilizer(level);
    filter.start(originX, originY);
    entry = { filter, raw: [[originX, originY]] };
    strokeStabilizers.set(stroke, entry);
  }
  entry.raw.push([x, y]);
  return entry.filter.next(x, y);
}

/** Returns an immutable copy of raw local coordinates recorded for a stabilized stroke. */
export function stabilizedRawPoints(stroke: object): readonly [number, number][] | undefined {
  const entry = strokeStabilizers.get(stroke);
  return entry ? entry.raw.map(([x, y]) => [x, y] as [number, number]) : undefined;
}

/** The same closed quadratic outline as the kernel SVG path, without serialization. */
export function strokeOutlineToPath2D(outlinePoints: readonly (readonly [number, number])[]): Path2D {
  const path = new Path2D();
  if (!outlinePoints.length) return path;
  const first = outlinePoints[0];
  path.moveTo(first[0], first[1]);
  for (let i = 0; i < outlinePoints.length; i++) {
    const point = outlinePoints[i], next = outlinePoints[(i + 1) % outlinePoints.length];
    path.quadraticCurveTo(point[0], point[1], (point[0] + next[0]) / 2, (point[1] + next[1]) / 2);
  }
  path.lineTo(first[0], first[1]);
  path.closePath();
  return path;
}

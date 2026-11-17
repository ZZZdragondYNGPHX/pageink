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

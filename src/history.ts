import { Element, Manifest } from './model';
export type Layout = Pick<Manifest, 'pages' | 'regions'>;
interface Part { surface: string; start: number; before: readonly Element[]; after: readonly Element[] }
interface Step { parts: Part[]; beforeLayout?: Layout; afterLayout?: Layout }
export interface SurfaceState { surface: string; elements: readonly Element[] }
export interface AppliedStep { parts: SurfaceState[]; layout?: Layout; surface: string; elements: readonly Element[] }
const same = (a: readonly Element[], b: readonly Element[]) => a.length === b.length && a.every((e, i) => e.id === b[i].id && e.version === b[i].version);

/** One body timeline across pages; a step may span several pages (e.g. moving ink between pages).
 * Retain changed ranges, not 100 copies of a 200k-object array. */
export class History {
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private heads = new Map<string, readonly Element[]>();
  constructor(private limit = 100) {}
  push(surface: string, before: readonly Element[], after: readonly Element[]) { this.pushMany([{ surface, before, after }]); }
  pushMany(changes: readonly { surface: string; before: readonly Element[]; after: readonly Element[] }[]) {
    const parts: Part[] = [];
    for (const { surface, before, after } of changes) {
      if (same(before, after)) continue;
      let start = 0, tail = 0;
      while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
      while (tail < Math.min(before.length, after.length) - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
      parts.push({ surface, start, before: before.slice(start, before.length - tail), after: after.slice(start, after.length - tail) });
      this.heads.set(surface, after);
    }
    if (!parts.length) return;
    this.undoStack.push({ parts }); this.redoStack = []; this.trim();
  }
  layout(beforeLayout: Layout, afterLayout: Layout) { this.undoStack.push({ parts: [], beforeLayout, afterLayout }); this.redoStack = []; this.trim(); }
  private trim() {
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    const retained = new Set([...this.undoStack, ...this.redoStack].flatMap(step => step.parts.map(c => c.surface)));
    for (const id of this.heads.keys()) if (!retained.has(id)) this.heads.delete(id);
  }
  private apply(step: Step, redo: boolean): AppliedStep {
    const order = redo ? step.parts : [...step.parts].reverse();
    const parts = order.map(c => {
      const current = this.heads.get(c.surface) ?? [], remove = redo ? c.before : c.after, insert = redo ? c.after : c.before;
      const elements = current.slice(0, c.start).concat(insert, current.slice(c.start + remove.length));
      this.heads.set(c.surface, elements);
      return { surface: c.surface, elements };
    });
    return { parts, layout: redo ? step.afterLayout : step.beforeLayout, surface: parts[0]?.surface ?? '@layout', elements: parts[0]?.elements ?? [] };
  }
  undo() { const step = this.undoStack.pop(); if (step) { this.redoStack.push(step); return this.apply(step, false); } }
  redo() { const step = this.redoStack.pop(); if (step) { this.undoStack.push(step); return this.apply(step, true); } }
  clear() { this.undoStack = []; this.redoStack = []; this.heads.clear(); }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}

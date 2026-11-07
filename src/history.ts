import { Element, Manifest } from './model';
type Layout = Pick<Manifest, 'pages' | 'regions'>;
interface Change { surface: string; start: number; before: readonly Element[]; after: readonly Element[]; beforeLayout?: Layout; afterLayout?: Layout }
/** One body timeline across pages. Retain changed ranges, not 100 copies of a 200k-object array. */
export class History {
  private undoStack: Change[] = [];
  private redoStack: Change[] = [];
  private heads = new Map<string, readonly Element[]>();
  constructor(private limit = 100) {}
  push(surface: string, before: readonly Element[], after: readonly Element[]) {
    if (before.length === after.length && before.every((e, i) => e.id === after[i].id && e.version === after[i].version)) return;
    let start = 0, tail = 0;
    while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
    while (tail < Math.min(before.length, after.length) - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    this.undoStack.push({ surface, start, before: before.slice(start, before.length - tail), after: after.slice(start, after.length - tail) }); this.redoStack = [];
    this.heads.set(surface, after); this.trim();
  }
  private trim() {
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    const retained = new Set([...this.undoStack, ...this.redoStack].map(c => c.surface));
    for (const id of this.heads.keys()) if (!retained.has(id)) this.heads.delete(id);
  }
  layout(beforeLayout: Layout, afterLayout: Layout) { this.undoStack.push({ surface: '@layout', start: 0, before: [], after: [], beforeLayout, afterLayout }); this.redoStack = []; this.trim(); }
  private apply(c: Change, redo: boolean) {
    const current = this.heads.get(c.surface) ?? [], remove = redo ? c.before : c.after, insert = redo ? c.after : c.before;
    const elements = current.slice(0, c.start).concat(insert, current.slice(c.start + remove.length));
    if (c.surface !== '@layout') this.heads.set(c.surface, elements);
    return { surface: c.surface, elements, layout: redo ? c.afterLayout : c.beforeLayout };
  }
  undo() { const c = this.undoStack.pop(); if (c) { this.redoStack.push(c); return this.apply(c, false); } }
  redo() { const c = this.redoStack.pop(); if (c) { this.undoStack.push(c); return this.apply(c, true); } }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}

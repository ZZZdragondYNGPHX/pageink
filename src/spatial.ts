import type { Element, Rect } from './model';
type Scene = { getNonDeletedElements(): readonly Element[] };
/** Conservative bounds avoid false negatives for rotated strokes and negative local points. */
function extent(e: Element): Rect {
  const first = 'points' in e ? e.points[0] ?? [0, 0] : [0, 0];
  const radius = 2 * Math.hypot(e.width, e.height) + Math.hypot(first[0], first[1]) + e.strokeWidth * 2 + 32;
  return { x: e.x - radius, y: e.y - radius, width: radius * 2, height: radius * 2 };
}
export class InkSpatialIndex {
  private cells = new Map<string, Set<Element>>();
  private membership = new Map<string, { element: Element; keys: string[] }>();
  private global = new Set<Element>();
  private embedded = new Map<string, Element>();
  constructor(elements: readonly Element[], private cellSize = 512) { for (const e of elements) this.update(e); }
  reconcile(elements: readonly Element[]) {
    const present = new Set<string>();
    for (const e of elements) {
      present.add(e.id);
      if (this.membership.get(e.id)?.element !== e) this.update(e);
    }
    for (const [id, item] of this.membership) if (!present.has(id)) this.update({ ...item.element, isDeleted: true });
  }
  private keys(rect: Rect): string[] | null {
    const x0 = Math.floor(rect.x / this.cellSize), x1 = Math.floor((rect.x + rect.width) / this.cellSize);
    const y0 = Math.floor(rect.y / this.cellSize), y1 = Math.floor((rect.y + rect.height) / this.cellSize);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) return null;
    const result = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) result.push(`${x},${y}`); return result;
  }
  update(e: Element) {
    if (!e.isDeleted && (e.type === 'embeddable' || e.type === 'iframe')) this.embedded.set(e.id, e); else this.embedded.delete(e.id);
    const before = this.membership.get(e.id);
    if (before) { this.global.delete(before.element); for (const key of before.keys) { const cell = this.cells.get(key)!; cell.delete(before.element); if (!cell.size) this.cells.delete(key); } }
    if (e.isDeleted) { this.membership.delete(e.id); return; }
    const keys = this.keys(extent(e));
    if (!keys) this.global.add(e);
    else for (const key of keys) { let cell = this.cells.get(key); if (!cell) this.cells.set(key, cell = new Set()); cell.add(e); }
    this.membership.set(e.id, { element: e, keys: keys ?? [] });
  }
  query(rect: Rect): Element[] {
    const keys = this.keys(rect);
    if (!keys) return [...this.membership.values()].map(item => item.element);
    const result = new Set(this.global);
    for (const key of keys) for (const e of this.cells.get(key) ?? []) result.add(e);
    return [...result].sort((a, b) => (a.index ?? '') < (b.index ?? '') ? -1 : (a.index ?? '') > (b.index ?? '') ? 1 : 0);
  }
  embeds() { return [...this.embedded.values()]; }
}
const indices = new WeakMap<Scene, InkSpatialIndex>();
export function resetInkScene(scene: Scene) { indices.get(scene)?.reconcile(scene.getNonDeletedElements()); }
export function updateInkElement(scene: Scene | null | undefined, element: Element) { if (scene) indices.get(scene)?.update(element); }
export function queryInkScene(scene: Scene, rect: Rect) {
  let index = indices.get(scene); if (!index) { index = new InkSpatialIndex(scene.getNonDeletedElements()); indices.set(scene, index); }
  return index.query(rect);
}
export function getInkEmbeds(scene: Scene) {
  let index = indices.get(scene); if (!index) { index = new InkSpatialIndex(scene.getNonDeletedElements()); indices.set(scene, index); }
  return index.embeds();
}
/** Read-only Map projection: exclusions affect iteration, not the authoritative scene. */
export class InkRenderMap extends Map<string, Element> {
  private excluded: Set<string>;
  constructor(private source: ReadonlyMap<string, Element>, ids: (string | null | undefined)[]) { super(); this.excluded = new Set(ids.filter((id): id is string => !!id)); }
  override has(id: string) { return !this.excluded.has(id) && this.source.has(id); }
  override get(id: string) { return this.excluded.has(id) ? undefined : this.source.get(id); }
  override get size() { let size = this.source.size; for (const id of this.excluded) if (this.source.has(id)) size--; return size; }
  override *entries(): MapIterator<[string, Element]> { for (const entry of this.source) if (!this.excluded.has(entry[0])) yield entry; }
  override *values(): MapIterator<Element> { for (const value of this.source.values()) if (!this.excluded.has(value.id)) yield value; }
  override *keys(): MapIterator<string> { for (const key of this.source.keys()) if (!this.excluded.has(key)) yield key; }
  override [Symbol.iterator]() { return this.entries(); }
  override forEach(callback: (value: Element, key: string, map: Map<string, Element>) => void, thisArg?: unknown) { for (const [id, e] of this.entries()) callback.call(thisArg, e, id, this); }
}

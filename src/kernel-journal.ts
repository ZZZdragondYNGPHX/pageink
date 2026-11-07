import type { Element } from './model';
type Scene = { getElementsMapIncludingDeleted(): Map<string, Element> };
const journals = new WeakMap<Map<string, Element>, { observer?: Map<string, Element>; dirty: Map<string, Element> }>();
/** A scene owns one kernel Store; replacement invalidates the incremental baseline. */
export function resetInkJournal(scene: Scene) { journals.set(scene.getElementsMapIncludingDeleted(), { dirty: new Map() }); }
export function recordInkMutation(scene: Scene | null | undefined, element: Element) { if (scene) journals.get(scene.getElementsMapIncludingDeleted())?.dirty.set(element.id, element); }
export function inkSnapshotChanges(source: Map<string, Element>, retained: Map<string, Element>): Element[] | null {
  if (source === retained) return [];
  const journal = journals.get(source); if (!journal) return null;
  const result = journal.observer === retained ? [...journal.dirty.values()] : null;
  journal.observer = retained; journal.dirty.clear(); return result;
}

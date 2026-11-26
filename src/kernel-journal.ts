import type { Element } from './model';
type Scene = { getElementsMapIncludingDeleted(): Map<string, Element> };
const journals = new WeakMap<Map<string, Element>, { observer?: Map<string, Element>; dirty: Map<string, Element>; hostDirty: Map<string, Element> | null; revision: number }>();
let revision = 0;
function journalFor(source: Map<string, Element>) {
  let journal = journals.get(source);
  if (!journal) { journal = { dirty: new Map(), hostDirty: null, revision: ++revision }; journals.set(source, journal); }
  return journal;
}
/** A scene owns one kernel Store; replacement invalidates the incremental baseline. */
export function resetInkJournal(scene: Scene) {
  const source = scene.getElementsMapIncludingDeleted();
  journals.set(source, { dirty: new Map(), hostDirty: null, revision: ++revision });
}
export function recordInkMutation(scene: Scene | null | undefined, element: Element) {
  const journal = scene && journalFor(scene.getElementsMapIncludingDeleted());
  if (journal) { journal.dirty.set(element.id, element); journal.hostDirty?.set(element.id, element); journal.revision = ++revision; }
}
/** Independent of snapshot consumption: a viewport preview must never hide an edit. */
export function inkSceneRevision(source: Map<string, Element>) { return journalFor(source).revision; }
export function inkSnapshotChanges(source: Map<string, Element>, retained: Map<string, Element>): Element[] | null {
  if (source === retained) return [];
  const journal = journals.get(source); if (!journal) return null;
  const result = journal.observer === retained ? [...journal.dirty.values()] : null;
  journal.observer = retained; journal.dirty.clear(); return result;
}

/** Host consumption must not advance the kernel Store's snapshot cursor. */
export function inkHostChanges(source: Map<string, Element>): Element[] | null {
  const journal = journalFor(source);
  if (journal.hostDirty === null) { journal.hostDirty = new Map(); return null; }
  const result = [...journal.hostDirty.values()];
  journal.hostDirty.clear();
  return result;
}

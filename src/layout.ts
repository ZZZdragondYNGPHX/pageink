import type { Element, Page, Rect } from './model';
import { pageRect, uid } from './model';
import { bounds } from './geometry';

/** Vertical gap between stacked pages, in page units. */
export const PAGE_GAP = 40;

/** Where a page sits in the shared scene: `x`/`y` is the scene position of its page-local origin. */
export interface PagePlacement { page: Page; index: number; x: number; y: number; paper: Rect; band: [number, number] }
export interface PageLayout { placements: PagePlacement[]; byId: Map<string, PagePlacement>; bounds: Rect; maxWidth: number }

/** Stacks pages top to bottom, centred on the first page; page 1 keeps its own coordinates. */
export function layoutPages(pages: readonly Page[], gap = PAGE_GAP): PageLayout {
  const placements: PagePlacement[] = [];
  const first = pageRect(pages[0]), centre = first.x + first.width / 2;
  let top = first.y, maxWidth = 0, left = Infinity, right = -Infinity;
  pages.forEach((page, index) => {
    const local = pageRect(page);
    const x = index === 0 ? 0 : Math.round(centre - local.width / 2 - local.x);
    const y = index === 0 ? 0 : Math.round(top - local.y);
    const paper = { x: x + local.x, y: y + local.y, width: local.width, height: local.height };
    placements.push({ page, index, x, y, paper, band: [paper.y - gap / 2, paper.y + paper.height + gap / 2] });
    top = paper.y + paper.height + gap;
    maxWidth = Math.max(maxWidth, paper.width); left = Math.min(left, paper.x); right = Math.max(right, paper.x + paper.width);
  });
  placements[0].band[0] = -Infinity; placements[placements.length - 1].band[1] = Infinity;
  const last = placements[placements.length - 1].paper;
  return { placements, byId: new Map(placements.map(p => [p.page.id, p])), maxWidth,
    bounds: { x: left, y: placements[0].paper.y, width: right - left, height: last.y + last.height - placements[0].paper.y } };
}

/** The page whose vertical band contains scene `y` (gaps are split halfway). */
export function placementAt(layout: PageLayout, y: number): PagePlacement {
  const list = layout.placements;
  let lo = 0, hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (y >= list[mid].band[1]) lo = mid + 1; else hi = mid;
  }
  return list[lo];
}

export const toLocalRect = (rect: Rect, p: PagePlacement): Rect => ({ ...rect, x: rect.x - p.x, y: rect.y - p.y });
export const toSceneRect = (rect: Rect, p: PagePlacement): Rect => ({ ...rect, x: rect.x + p.x, y: rect.y + p.y });

/** A kernel-owned copy in scene coordinates. Freehand points are frozen and shared; other
 * structures are cloned because the kernel may edit them in place. */
export function sceneCopy(e: Element, dx = 0, dy = 0): Element {
  const copy = e.type === 'freedraw' ? { ...e } : structuredClone(e);
  (copy as any).x = e.x + dx; (copy as any).y = e.y + dy;
  return copy as Element;
}

const signature = (e: Element) => `${e.x},${e.y},${e.width},${e.height},${e.angle}`;
const byIndex = (a: { e: Element; order: number }, b: { e: Element; order: number }) => {
  const x = a.e.index, y = b.e.index;
  if (x && y && x !== y) return x < y ? -1 : 1;
  return a.order - b.order;
};

/** Maps a single kernel scene to page-local surfaces and back.
 * Elements stay with the page they were loaded from until the user moves them; moved or new
 * elements belong to the page under their centre. Groups and bound text move together. */
export class PageScene {
  private owner = new Map<string, string>();
  private geometry = new Map<string, string>();
  private locals = new WeakMap<Element, { version: number; x: number; y: number; local: Element }>();
  constructor(public layout: PageLayout) {}

  /** Scene elements for every page, ordered by fractional index so stored indices stay valid. */
  build(surface: (pageId: string) => readonly Element[], layout = this.layout): Element[] {
    this.layout = layout; this.owner.clear(); this.geometry.clear();
    const taken = new Set<string>(), items: { e: Element; order: number }[] = [];
    for (const placement of layout.placements) {
      let elements = surface(placement.page.id).filter(e => !e.isDeleted);
      if (elements.some(e => taken.has(e.id))) elements = reidentify(elements, taken);
      for (const e of elements) {
        taken.add(e.id);
        const copy = sceneCopy(e, placement.x, placement.y);
        this.owner.set(e.id, placement.page.id); this.geometry.set(e.id, signature(copy));
        items.push({ e: copy, order: items.length });
      }
    }
    return items.sort(byIndex).map(item => item.e);
  }

  /** Records the kernel's current geometry as unmoved (absorbs restore-time normalisation). */
  settle(elements: readonly Element[]) { for (const e of elements) if (this.owner.has(e.id)) this.geometry.set(e.id, signature(e)); }

  pageOf(id: string) { return this.owner.get(id); }

  /** Page-local, non-deleted elements per page, in scene order. Every page gets an entry. */
  partition(elements: readonly Element[]): Map<string, Element[]> {
    const live = elements.filter(e => !e.isDeleted);
    const byId = new Map(live.map(e => [e.id, e]));
    const moved = (e: Element) => !this.owner.has(e.id) || this.geometry.get(e.id) !== signature(e) || !this.layout.byId.has(this.owner.get(e.id)!);
    const locate = (rect: Rect | null) => placementAt(this.layout, rect ? rect.y + rect.height / 2 : 0).page.id;
    // Groups: decide once per outermost group from the union of its members.
    const groups = new Map<string, Element[]>();
    for (const e of live) { const g = e.groupIds?.[e.groupIds.length - 1]; if (g) { let list = groups.get(g); if (!list) groups.set(g, list = []); list.push(e); } }
    const groupPage = new Map<string, string>();
    for (const [g, members] of groups) {
      const anchor = members.find(m => !moved(m));
      groupPage.set(g, members.some(moved) || !anchor ? locate(bounds(members)) : this.owner.get(anchor.id)!);
    }
    const decide = (e: Element): string => {
      const container = e.type === 'text' && e.containerId ? byId.get(e.containerId) : undefined;
      if (container) return decide(container);
      const g = e.groupIds?.[e.groupIds.length - 1];
      if (g && groupPage.has(g)) return groupPage.get(g)!;
      return moved(e) ? locate(bounds([e])) : this.owner.get(e.id)!;
    };
    const result = new Map<string, Element[]>(this.layout.placements.map(p => [p.page.id, []]));
    for (const e of live) {
      const pageId = decide(e), placement = this.layout.byId.get(pageId)!;
      this.owner.set(e.id, pageId); this.geometry.set(e.id, signature(e));
      result.get(pageId)!.push(this.local(e, placement));
    }
    for (const id of [...this.owner.keys()]) if (!byId.has(id)) { this.owner.delete(id); this.geometry.delete(id); }
    return result;
  }

  private local(e: Element, p: PagePlacement): Element {
    const cached = this.locals.get(e);
    if (cached && cached.version === e.version && cached.x === p.x && cached.y === p.y) return cached.local;
    const local = { ...e, x: e.x - p.x, y: e.y - p.y } as Element;
    this.locals.set(e, { version: e.version, x: p.x, y: p.y, local });
    return local;
  }
}

/** New identities for elements whose id is already used elsewhere in the scene. */
function reidentify(elements: readonly Element[], taken: ReadonlySet<string>): Element[] {
  const ids = new Map(elements.filter(e => taken.has(e.id)).map(e => [e.id, uid()]));
  const map = (id: string) => ids.get(id) ?? id;
  return elements.map(e => {
    const copy = structuredClone(e) as any;
    copy.id = map(e.id);
    if (copy.containerId) copy.containerId = map(copy.containerId);
    if (copy.boundElements) copy.boundElements = copy.boundElements.map((b: any) => ({ ...b, id: map(b.id) }));
    for (const key of ['startBinding', 'endBinding']) if (copy[key]) copy[key] = { ...copy[key], elementId: map(copy[key].elementId) };
    if (ids.has(e.id)) { copy.version = (e.version ?? 1) + 1; copy.versionNonce = Math.floor(Math.random() * 2 ** 30); }
    return copy as Element;
  });
}

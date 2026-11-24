import { Element, Rect, uid } from './model';
import { bounds, isHighlighterElement } from './geometry';
import { inkAnchor } from './mixed';
import { isTapeElement } from './tape';

export type LayerOrderAction = 'front' | 'forward' | 'backward' | 'back';

export interface LayerSummaryItem {
  key: string;
  kind: 'group' | 'ink' | 'shape' | 'text' | 'image';
  label: string;
  ids: string[];
  count: number;
  locked: boolean;
  color?: string;
}

const bump = <T extends Element>(e: T, patch: Partial<T>): T => ({
  ...e,
  ...patch,
  version: e.version + 1,
  versionNonce: Math.floor(Math.random() * 2 ** 30),
  updated: Date.now(),
});

const rectsOverlap = (a: Rect | null, b: Rect | null): boolean =>
  !!(a && b && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y);

/** Expand a selection to include bound text children, container parents, and siblings sharing any selected outermost group. */
export function expandSelectionIds(elements: readonly Element[], rawIds: ReadonlySet<string>): Set<string> {
  const expanded = new Set<string>(rawIds);
  const live = elements.filter(e => !e.isDeleted);
  const byId = new Map(live.map(e => [e.id, e]));
  let grew = true;
  while (grew) {
    grew = false;
    const outerGroups = new Set<string>();
    for (const id of expanded) {
      const e = byId.get(id);
      if (!e) continue;
      if (e.groupIds.length) outerGroups.add(e.groupIds[e.groupIds.length - 1]);
      if (e.type === 'text' && e.containerId && byId.has(e.containerId) && !expanded.has(e.containerId)) {
        expanded.add(e.containerId); grew = true;
      }
      for (const b of e.boundElements ?? []) {
        if (b.type === 'text' && byId.has(b.id) && !expanded.has(b.id)) { expanded.add(b.id); grew = true; }
      }
    }
    if (outerGroups.size) {
      for (const e of live) {
        if (!expanded.has(e.id) && e.groupIds.some(g => outerGroups.has(g))) {
          expanded.add(e.id); grew = true;
        }
      }
    }
  }
  return expanded;
}

/** Group selected elements into a unified movable/layerable group. */
export function groupElements(elements: readonly Element[], selectedIds: ReadonlySet<string>): { elements: Element[]; changed: boolean; groupId?: string } {
  const ids = expandSelectionIds(elements, selectedIds);
  const liveSelected = elements.filter(e => !e.isDeleted && ids.has(e.id));
  if (liveSelected.length < 2) return { elements: [...elements], changed: false };
  // Avoid creating a redundant duplicate outer group if all selected items already share the exact same outermost group.
  const firstOuter = liveSelected[0].groupIds[liveSelected[0].groupIds.length - 1];
  if (firstOuter && liveSelected.every(e => e.groupIds[e.groupIds.length - 1] === firstOuter)) {
    return { elements: [...elements], changed: false };
  }
  const groupId = uid();
  const next = elements.map(e => (!e.isDeleted && ids.has(e.id)) ? bump(e, { groupIds: [...e.groupIds, groupId] }) : e);
  return { elements: next, changed: true, groupId };
}

/** Ungroup selected grouped elements by peeling off their outermost group layer. */
export function ungroupElements(elements: readonly Element[], selectedIds: ReadonlySet<string>): { elements: Element[]; changed: boolean } {
  const ids = expandSelectionIds(elements, selectedIds);
  const outer = new Set<string>();
  for (const e of elements) {
    if (!e.isDeleted && ids.has(e.id) && e.groupIds.length) outer.add(e.groupIds[e.groupIds.length - 1]);
  }
  if (!outer.size) return { elements: [...elements], changed: false };
  const next = elements.map(e => {
    if (e.isDeleted || !e.groupIds.some(g => outer.has(g))) return e;
    return bump(e, { groupIds: e.groupIds.filter(g => !outer.has(g)) });
  });
  return { elements: next, changed: true };
}

/**
 * Reorder selected elements in z-order (front / forward / backward / back).
 * Preserves relative order of selected items, keeps groups & bound text intact,
 * and jumps past the next visually overlapping sibling on forward/backward so one click produces a visible change.
 * Clears `index: null` on moved elements so Excalidraw's syncInvalidIndices assigns valid monotonic fractional indices.
 */
export function reorderElements(elements: readonly Element[], selectedIds: ReadonlySet<string>, action: LayerOrderAction): { elements: Element[]; changed: boolean } {
  const ids = expandSelectionIds(elements, selectedIds);
  const live = elements.filter(e => !e.isDeleted);
  const deleted = elements.filter(e => e.isDeleted);
  const selected = live.filter(e => ids.has(e.id));
  if (!selected.length || selected.length === live.length) return { elements: [...elements], changed: false };

  const others = live.filter(e => !ids.has(e.id));
  let ordered: Element[];

  if (action === 'front') {
    ordered = [...others, ...selected];
  } else if (action === 'back') {
    ordered = [...selected, ...others];
  } else {
    // Group unselected items into atomic units by outermost group or bound-text container
    // so moving a layer never slices inside a group or separates a shape from its bound text.
    const liveById = new Map(live.map(e => [e.id, e]));
    const units: { items: Element[]; box: Rect | null; firstPos: number; lastPos: number }[] = [];
    const seenUnit = new Map<string, number>();
    let firstSel = Infinity, lastSel = -1;
    const unitKey = (e: Element): string => {
      const g = e.groupIds[e.groupIds.length - 1];
      if (g) return `g:${g}`;
      if (e.type === 'text' && e.containerId && liveById.has(e.containerId)) return `c:${e.containerId}`;
      if (e.boundElements?.some(b => b.type === 'text' && liveById.has(b.id))) return `c:${e.id}`;
      return `e:${e.id}`;
    };
    live.forEach((e, idx) => {
      if (ids.has(e.id)) {
        if (idx < firstSel) firstSel = idx;
        if (idx > lastSel) lastSel = idx;
        return;
      }
      const key = unitKey(e);
      if (seenUnit.has(key)) {
        const u = units[seenUnit.get(key)!];
        u.items.push(e);
        u.lastPos = idx;
      } else {
        seenUnit.set(key, units.length);
        units.push({ items: [e], box: null, firstPos: idx, lastPos: idx });
      }
    });
    const selBox = bounds(selected);
    for (const u of units) u.box = bounds(u.items);

    if (action === 'forward') {
      // Only consider units strictly above the highest selected item so no selected item ever moves downward.
      // Sort by ascending lastPos and split `live` by original index so unselected elements keep their exact order.
      const above = units.filter(u => u.lastPos > lastSel).sort((a, b) => a.lastPos - b.lastPos);
      if (!above.length) {
        ordered = [...others, ...selected];
      } else {
        const target = above.find(u => rectsOverlap(selBox, u.box)) ?? above[0];
        const beforeTarget = live.filter((e, idx) => !ids.has(e.id) && idx <= target.lastPos);
        const afterTarget = live.filter((e, idx) => !ids.has(e.id) && idx > target.lastPos);
        ordered = [...beforeTarget, ...selected, ...afterTarget];
      }
    } else {
      // Only consider units strictly below the lowest selected item so no selected item ever moves upward.
      const below = units.filter(u => u.firstPos < firstSel).sort((a, b) => b.firstPos - a.firstPos);
      if (!below.length) {
        ordered = [...selected, ...others];
      } else {
        const target = below.find(u => rectsOverlap(selBox, u.box)) ?? below[0];
        const beforeTarget = live.filter((e, idx) => !ids.has(e.id) && idx < target.firstPos);
        const afterTarget = live.filter((e, idx) => !ids.has(e.id) && idx >= target.firstPos);
        ordered = [...beforeTarget, ...selected, ...afterTarget];
      }
    }
  }

  const sameOrder = ordered.every((e, i) => e.id === live[i].id);
  if (sameOrder) return { elements: [...elements], changed: false };

  // Mark moved (selected) elements with index: null & bumped version so kernel syncInvalidIndices
  // generates clean fractional indices while keeping unmoved elements untouched.
  const reindexed = ordered.map(e => ids.has(e.id) ? bump(e, { index: null as unknown as Element['index'] }) : e);
  return { elements: [...deleted, ...reindexed], changed: true };
}

/** Lock or unlock selected elements (including group members and bound text). */
export function setElementsLocked(elements: readonly Element[], selectedIds: ReadonlySet<string>, locked: boolean): { elements: Element[]; changed: boolean } {
  const ids = expandSelectionIds(elements, selectedIds);
  let changed = false;
  const next = elements.map(e => {
    if (e.isDeleted || !ids.has(e.id) || e.locked === locked) return e;
    changed = true;
    return bump(e, { locked });
  });
  return { elements: next, changed };
}

const STROKE_STYLE_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'line', 'arrow']);
const FILL_TYPES = new Set(['rectangle', 'ellipse', 'diamond']);

/** Apply uniform visual style changes (color / strokeWidth / opacity / strokeStyle / backgroundColor) to selected elements. */
export function restyleElements(
  elements: readonly Element[],
  selectedIds: ReadonlySet<string>,
  patch: { strokeColor?: string; strokeWidth?: number; opacity?: number; strokeStyle?: 'solid' | 'dashed' | 'dotted'; backgroundColor?: string },
): { elements: Element[]; changed: boolean } {
  const ids = expandSelectionIds(elements, selectedIds);
  let changed = false;
  const next = elements.map(e => {
    if (e.isDeleted || !ids.has(e.id)) return e;
    const update: {
      strokeColor?: string;
      strokeWidth?: number;
      opacity?: number;
      strokeStyle?: 'solid' | 'dashed' | 'dotted';
      backgroundColor?: string;
      fillStyle?: 'solid';
      customData?: Element['customData'];
    } = {};
    if (patch.strokeColor !== undefined && e.type !== 'image' && e.strokeColor !== patch.strokeColor) update.strokeColor = patch.strokeColor;
    if (patch.strokeWidth !== undefined && e.type !== 'image' && e.type !== 'text' && e.strokeWidth !== patch.strokeWidth) update.strokeWidth = patch.strokeWidth;
    if (patch.strokeStyle !== undefined && STROKE_STYLE_TYPES.has(e.type) && e.strokeStyle !== patch.strokeStyle) update.strokeStyle = patch.strokeStyle;
    if (patch.backgroundColor !== undefined && FILL_TYPES.has(e.type) && (e.backgroundColor !== patch.backgroundColor || (patch.backgroundColor !== 'transparent' && e.fillStyle !== 'solid'))) {
      update.backgroundColor = patch.backgroundColor;
      if (patch.backgroundColor !== 'transparent') update.fillStyle = 'solid';
    }
    if (patch.opacity !== undefined && e.opacity !== patch.opacity) {
      update.opacity = patch.opacity;
      // Preserve legacy stroke kind before opacity changes so lowering a pen stroke's opacity never turns it into a highlighter.
      if (e.type === 'freedraw' && !e.customData?.inkKind) {
        update.customData = { ...e.customData, inkKind: isHighlighterElement(e) ? 'highlighter' : 'pen' };
      }
    }
    if (!Object.keys(update).length) return e;
    changed = true;
    return bump(e, update);
  });
  return { elements: next, changed };
}

const SHAPE_NAMES: Record<string, string> = {
  rectangle: '矩形', ellipse: '椭圆', diamond: '菱形', line: '直线', arrow: '箭头',
};

/**
 * Produce a scannable top-to-bottom stack summary for the Layers panel.
 * Groups stay together as single rows; contiguous ungrouped freedraw strokes are clustered so
 * dense handwriting pages stay fast and tidy.
 */
export function summarizeLayers(elements: readonly Element[]): LayerSummaryItem[] {
  const live = elements.filter(e => !e.isDeleted);
  const byId = new Map(live.map(e => [e.id, e]));
  const items: LayerSummaryItem[] = [];
  const handledGroups = new Set<string>();
  const handledIds = new Set<string>();

  for (let i = 0; i < live.length; i++) {
    const e = live[i];
    if (handledIds.has(e.id)) continue;
    if (e.type === 'text' && e.containerId && byId.has(e.containerId)) continue;

    const outerGroup = e.groupIds[e.groupIds.length - 1];
    if (outerGroup) {
      if (handledGroups.has(outerGroup)) continue;
      handledGroups.add(outerGroup);
      const members = live.filter(m => m.groupIds[m.groupIds.length - 1] === outerGroup);
      for (const m of members) handledIds.add(m.id);
      const inkCount = members.filter(m => m.type === 'freedraw').length;
      const label = inkCount === members.length ? `笔迹组合 (${members.length} 笔)` : `对象组合 (${members.length} 项)`;
      items.push({
        key: `group:${outerGroup}`,
        kind: 'group',
        label,
        ids: members.map(m => m.id),
        count: members.length,
        locked: members.every(m => m.locked),
        color: members.find(m => m.type !== 'image')?.strokeColor,
      });
      continue;
    }

    if (e.type === 'freedraw') {
      // Cluster contiguous ungrouped freedraw strokes sharing the same lock state.
      const cluster: Element[] = [e];
      handledIds.add(e.id);
      while (i + 1 < live.length) {
        const next = live[i + 1];
        if (next.type !== 'freedraw' || next.groupIds.length || next.locked !== e.locked) break;
        cluster.push(next);
        handledIds.add(next.id);
        i++;
      }
      items.push({
        key: `ink:${cluster[0].id}`,
        kind: 'ink',
        label: cluster.length === 1 ? '单条笔迹' : `手写笔迹 (${cluster.length} 笔)`,
        ids: cluster.map(c => c.id),
        count: cluster.length,
        locked: e.locked,
        color: e.strokeColor,
      });
      continue;
    }

    handledIds.add(e.id);
    const boundText = e.boundElements?.find(b => b.type === 'text');
    const ids = boundText && byId.has(boundText.id) ? [e.id, boundText.id] : [e.id];
    if (boundText) handledIds.add(boundText.id);

    if (e.type === 'image') {
      items.push({ key: e.id, kind: 'image', label: '图片', ids, count: 1, locked: e.locked });
    } else if (e.type === 'text') {
      const preview = e.text.trim().split('\n')[0].slice(0, 14) || '文字';
      items.push({ key: e.id, kind: 'text', label: `文字「${preview}」`, ids, count: 1, locked: e.locked, color: e.strokeColor });
    } else if (isTapeElement(e)) {
      items.push({ key: e.id, kind: 'shape', label: e.customData?.inkTape?.revealed ? '遮挡胶带（已揭开）' : '遮挡胶带', ids, count: 1, locked: e.locked, color: e.backgroundColor });
    } else {
      items.push({ key: e.id, kind: 'shape', label: SHAPE_NAMES[e.type] ?? '图形', ids, count: 1, locked: e.locked, color: e.strokeColor });
    }
  }

  // Return top-most layer first (visual stacking order).
  return items.reverse();
}

/**
 * Shift all unlocked elements (keeping groups, bound text, and paragraph-anchored ink transitively intact)
 * at or below `yThreshold` vertically by `deltaY` (positive inserts space, negative closes space).
 */
export function insertVerticalSpace(
  elements: readonly Element[],
  yThreshold: number,
  deltaY: number,
  scopeIds?: ReadonlySet<string>,
): { elements: Element[]; changed: boolean; movedCount: number; movedIds: string[] } {
  if (Math.abs(deltaY) < 2) return { elements: [...elements], changed: false, movedCount: 0, movedIds: [] };
  const live = elements.filter(e => !e.isDeleted && (!scopeIds || scopeIds.has(e.id)));
  const byId = new Map(live.map(e => [e.id, e]));

  // Union-Find so groups, bound text containers, and anchored paragraph annotations always stay together transitively.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let cur = id;
    while (parent.has(cur) && parent.get(cur) !== cur) cur = parent.get(cur)!;
    let p = id;
    while (p !== cur) { const next = parent.get(p)!; parent.set(p, cur); p = next; }
    return cur;
  };
  const union = (a: string, b: string) => {
    if (!byId.has(a) || !byId.has(b)) return;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const groupLeader = new Map<string, string>();
  for (const e of live) {
    parent.set(e.id, e.id);
  }
  for (const e of live) {
    for (const g of e.groupIds) {
      const first = groupLeader.get(g);
      if (first) union(e.id, first);
      else groupLeader.set(g, e.id);
    }
    const anchor = inkAnchor(e);
    if (anchor) union(e.id, anchor.elementId);
    if (e.type === 'text' && e.containerId) union(e.id, e.containerId);
  }

  const units = new Map<string, Element[]>();
  for (const e of live) {
    const root = find(e.id);
    let list = units.get(root);
    if (!list) units.set(root, list = []);
    list.push(e);
  }
  const moveIds = new Set<string>();
  for (const members of units.values()) {
    if (members.some(m => m.locked)) continue;
    const box = bounds(members);
    if (box && box.y + box.height * 0.5 >= yThreshold) {
      for (const m of members) moveIds.add(m.id);
    }
  }
  if (!moveIds.size) return { elements: [...elements], changed: false, movedCount: 0, movedIds: [] };
  const next = elements.map(e => moveIds.has(e.id) ? bump(e, { y: e.y + deltaY }) : e);
  return { elements: next, changed: true, movedCount: moveIds.size, movedIds: [...moveIds] };
}

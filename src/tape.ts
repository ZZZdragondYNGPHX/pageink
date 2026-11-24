import type { Radians } from '@excalidraw/math';
import { Element, uid } from './model';
import type { ScenePoint } from './geometry';

/** Returns true when an element is a study recall occlusion tape. */
export function isTapeElement(e: Element): boolean {
  return !e.isDeleted && e.type === 'rectangle' && e.customData?.inkTape?.version === 1;
}

/** Returns true when a study tape is currently peeled open to peek underneath. */
export function isTapeRevealed(e: Element): boolean {
  return isTapeElement(e) && !!e.customData?.inkTape?.revealed;
}

/** Creates an opaque rounded strip element tagged as a study recall tape. */
export function createTapeElement(x: number, y: number, width: number, height: number, color: string): Element {
  const now = Date.now();
  return {
    id: uid(),
    type: 'rectangle',
    x,
    y,
    width: Math.max(12, width),
    height: Math.max(10, height),
    angle: 0 as Radians,
    strokeColor: color,
    backgroundColor: color,
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null as unknown as Element['index'],
    roundness: { type: 3 },
    seed: Math.floor(Math.random() * 2 ** 30),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 30),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    customData: { inkTape: { version: 1, revealed: false } },
  };
}

function applyTapeState(e: Element, revealed: boolean): Element {
  const coverColor = e.backgroundColor && e.backgroundColor !== 'transparent' ? e.backgroundColor : e.strokeColor;
  return {
    ...e,
    backgroundColor: coverColor,
    fillStyle: 'solid',
    opacity: revealed ? 16 : 100,
    strokeStyle: revealed ? 'dashed' : 'solid',
    customData: { ...e.customData, inkTape: { version: 1, revealed } },
    version: e.version + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 30),
    updated: Date.now(),
  };
}

function isTapeVisuallyCovered(e: Element): boolean {
  return !isTapeRevealed(e) && e.opacity === 100 && e.fillStyle === 'solid' && e.backgroundColor !== 'transparent';
}

function isTapeVisuallyRevealed(e: Element): boolean {
  return isTapeRevealed(e) && e.opacity <= 25;
}

/** Toggles one study tape between covered (opaque) and peeked (translucent dashed outline). */
export function toggleTapeElement(elements: readonly Element[], id: string): { elements: Element[]; changed: boolean; revealed: boolean } {
  let changed = false;
  let revealed = false;
  const next = elements.map(e => {
    if (e.id !== id || !isTapeElement(e)) return e;
    revealed = isTapeVisuallyCovered(e);
    changed = true;
    return applyTapeState(e, revealed);
  });
  return { elements: next, changed, revealed };
}

/** Sets revealed state for all study tapes (optionally scoped to one page's element IDs). */
export function setAllTapesRevealed(
  elements: readonly Element[],
  revealed: boolean,
  scopeIds?: ReadonlySet<string>,
): { elements: Element[]; changed: boolean; count: number } {
  let count = 0;
  const next = elements.map(e => {
    if (!isTapeElement(e)) return e;
    if (scopeIds && !scopeIds.has(e.id)) return e;
    const alreadyMatches = revealed ? isTapeVisuallyRevealed(e) : isTapeVisuallyCovered(e);
    if (alreadyMatches) return e;
    count++;
    return applyTapeState(e, revealed);
  });
  return { elements: next, changed: count > 0, count };
}

/** Hit-tests the topmost study tape covering a scene point (supporting rotation). */
export function findTapeAt(elements: readonly Element[], point: ScenePoint, pad = 4): Element | undefined {
  for (let i = elements.length - 1; i >= 0; i--) {
    const e = elements[i];
    if (!isTapeElement(e)) continue;
    const cx = e.x + e.width / 2, cy = e.y + e.height / 2;
    const dx = point[0] - cx, dy = point[1] - cy;
    const cos = Math.cos(e.angle), sin = Math.sin(e.angle);
    const rx = dx * cos + dy * sin;
    const ry = -dx * sin + dy * cos;
    if (Math.abs(rx) <= e.width / 2 + pad && Math.abs(ry) <= e.height / 2 + pad) return e;
  }
  return undefined;
}

/** Summarizes tape counts (total & currently hidden) within a list of elements. */
export function countTapes(elements: readonly Element[]): { total: number; covered: number; revealed: number } {
  let total = 0, revealed = 0;
  for (const e of elements) {
    if (!isTapeElement(e)) continue;
    total++;
    if (isTapeRevealed(e)) revealed++;
  }
  return { total, covered: total - revealed, revealed };
}

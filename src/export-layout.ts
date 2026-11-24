import type { Element, Rect } from './model';
import { bounds } from './geometry';

export const PAPER_SIZES_PT = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
} as const;

const MAX_EXPORT_TILES = 64;

function segmentIntersectsRect(x1: number, y1: number, x2: number, y2: number, r: Rect): boolean {
  const minX = r.x, maxX = r.x + r.width, minY = r.y, maxY = r.y + r.height;
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, x1 - minX) && clip(dx, maxX - x1) && clip(-dy, y1 - minY) && clip(dy, maxY - y1);
}

function elementIntersectsRect(e: Element, b: Rect, tile: Rect): boolean {
  if (!(b.x < tile.x + tile.width && b.x + b.width > tile.x && b.y < tile.y + tile.height && b.y + b.height > tile.y)) {
    return false;
  }
  // For 2-point straight lines/arrows (including reversed & rotated ones), verify actual segment intersection so diagonal lines skip empty corner tiles.
  if ((e.type === 'line' || e.type === 'arrow') && e.points.length === 2 && !e.roundness) {
    const pad = Math.max(e.type === 'arrow' ? 24 : 4, e.strokeWidth * 2);
    const expanded: Rect = { x: tile.x - pad, y: tile.y - pad, width: tile.width + pad * 2, height: tile.height + pad * 2 };
    const [p0, p1] = e.points;
    const cx = e.x + (Math.min(p0[0], p1[0]) + Math.max(p0[0], p1[0])) / 2;
    const cy = e.y + (Math.min(p0[1], p1[1]) + Math.max(p0[1], p1[1])) / 2;
    const cos = Math.cos(e.angle), sin = Math.sin(e.angle);
    const worldPt = (p: readonly [number, number]): [number, number] => {
      const dx = e.x + p[0] - cx, dy = e.y + p[1] - cy;
      return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
    };
    const [x1, y1] = worldPt(p0);
    const [x2, y2] = worldPt(p1);
    return segmentIntersectsRect(x1, y1, x2, y2, expanded);
  }
  return true;
}

/**
 * Splits a large infinite-canvas bounding box into printable row-major tiles sized proportionally
 * to the chosen paper aspect ratio, skipping empty tiles so stray marks or diagonals never produce blank pages.
 */
export function tileCanvasRect(
  box: Rect,
  paper: 'a4' | 'letter',
  elements: readonly Element[],
  overlap = 24,
  getBounds: (e: Element) => Rect | null = e => bounds([e]),
): Rect[] {
  const baseW = PAPER_SIZES_PT[paper].width * (4 / 3);
  const baseH = PAPER_SIZES_PT[paper].height * (4 / 3);
  if (box.width <= baseW * 1.15 && box.height <= baseH * 1.15) return [box];

  let tileW = baseW, tileH = baseH;
  const stepOf = (w: number, h: number) => ({ sx: Math.max(64, w - overlap), sy: Math.max(64, h - overlap) });
  let { sx, sy } = stepOf(tileW, tileH);
  let cols = Math.max(1, Math.ceil((box.width - overlap) / sx));
  let rows = Math.max(1, Math.ceil((box.height - overlap) / sy));
  while (cols * rows > MAX_EXPORT_TILES) {
    tileW *= 1.25;
    tileH *= 1.25;
    ({ sx, sy } = stepOf(tileW, tileH));
    cols = Math.max(1, Math.ceil((box.width - overlap) / sx));
    rows = Math.max(1, Math.ceil((box.height - overlap) / sy));
  }

  const elementBoxes = elements
    .filter(e => !e.isDeleted)
    .map(e => ({ e, b: getBounds(e) }))
    .filter((item): item is { e: Element; b: Rect } => !!item.b);

  const tiles: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tile: Rect = {
        x: box.x + c * sx,
        y: box.y + r * sy,
        width: tileW,
        height: tileH,
      };
      if (elementBoxes.some(({ e, b }) => elementIntersectsRect(e, b, tile))) {
        tiles.push(tile);
      }
    }
  }
  return tiles.length ? tiles : [box];
}

/** Filters elements whose true geometry intersects `rect`. */
export function filterElementsInRect(
  elements: readonly Element[],
  rect: Rect,
  pad = 16,
  getBounds: (e: Element) => Rect | null = e => bounds([e]),
): Element[] {
  const padded: Rect = { x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
  return elements.filter(e => {
    if (e.isDeleted) return false;
    const b = getBounds(e);
    return !!(b && elementIntersectsRect(e, b, padded));
  });
}

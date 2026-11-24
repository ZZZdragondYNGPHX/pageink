import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTapeElement, findTapeAt, isTapeElement, isTapeRevealed, setAllTapesRevealed, toggleTapeElement, countTapes } from '../src/tape';
import { ElementsLibraryStore, MAX_LIBRARY_ITEMS, normalizeLibraryItems, prepareLibraryInsert, sanitizeForLibrary } from '../src/elements-library';
import { createRulerLineElement, projectAlongRulerEdge, rulerEdgeProjection, snapRulerAngle, type RulerState } from '../src/ruler';
import { filterElementsInRect, tileCanvasRect } from '../src/export-layout';
import { DEFAULT_PREFERENCES, normalizePreferences } from '../src/preferences';
import type { Element, Rect } from '../src/model';

const dummyRect = (id: string, x: number, y: number, w = 80, h = 40, customData?: Element['customData']): Element => ({
  id,
  type: 'rectangle',
  x,
  y,
  width: w,
  height: h,
  angle: 0,
  strokeColor: '#1f2329',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index: 'a0' as Element['index'],
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  ...(customData ? { customData } : {}),
} as unknown as Element);

describe('P2: Study Tape (复习遮挡胶带)', () => {
  it('creates, hit-tests, toggles individual and bulk study tapes cleanly', () => {
    const t1 = createTapeElement(100, 200, 140, 28, '#6366f1');
    const t2 = createTapeElement(300, 200, 120, 28, '#14b8a6');
    const normal = dummyRect('r1', 100, 200);
    assert.equal(isTapeElement(t1), true);
    assert.equal(isTapeElement(normal), false);
    assert.equal(isTapeRevealed(t1), false);
    assert.equal(t1.opacity, 100);

    const hit = findTapeAt([normal, t1, t2], [150, 212]);
    assert.equal(hit?.id, t1.id);

    const toggled = toggleTapeElement([normal, t1, t2], t1.id);
    assert.equal(toggled.changed, true);
    assert.equal(toggled.revealed, true);
    assert.equal(isTapeRevealed(toggled.elements[1]), true);
    assert.equal(toggled.elements[1].opacity, 16);
    assert.equal(toggled.elements[1].strokeStyle, 'dashed');
    assert.deepEqual(countTapes(toggled.elements), { total: 2, covered: 1, revealed: 1 });

    const allOpen = setAllTapesRevealed(toggled.elements, true);
    assert.equal(allOpen.changed, true);
    assert.equal(allOpen.count, 1);
    assert.deepEqual(countTapes(allOpen.elements), { total: 2, covered: 0, revealed: 2 });

    const allClosed = setAllTapesRevealed(allOpen.elements, false);
    assert.equal(allClosed.count, 2);
    assert.equal(allClosed.elements[1].opacity, 100);
    assert.equal(allClosed.elements[1].strokeStyle, 'solid');

    // Re-covering a tape whose fill was cleared to transparent must still restore solid opaque coverage.
    const transparentTape = { ...allClosed.elements[1], backgroundColor: 'transparent' };
    const restored = setAllTapesRevealed([transparentTape], false);
    assert.equal(restored.changed, true);
    assert.equal(restored.elements[0].backgroundColor, transparentTape.strokeColor);
    assert.equal(restored.elements[0].opacity, 100);

    // Re-revealing a revealed tape whose opacity was manually raised back to 100% must still make it transparent.
    const opaqueRevealed = { ...allOpen.elements[1], opacity: 100 };
    const reRevealed = setAllTapesRevealed([opaqueRevealed], true);
    assert.equal(reRevealed.changed, true);
    assert.equal(reRevealed.elements[0].opacity, 16);
  });
});

describe('P2: Reusable Elements Library (常用元素库)', () => {
  it('normalizes coordinates and strips document-private references on save', () => {
    const withPrivateRefs = dummyRect('e1', 420, 310, 100, 50, {
      inkKind: 'pen',
      pageinkText: { version: 1, path: 'Note.md', blockId: 'b1', snapshotAsset: 'asset-1', width: 200 },
      pageinkAnchor: { version: 1, elementId: 'p1' },
      source: { document: 'doc-1', page: 'page-1' },
    });
    const item = sanitizeForLibrary([withPrivateRefs], {});
    assert.ok(item);
    assert.equal(item.elements.length, 1);
    assert.ok(item.elements[0].x >= 0 && item.elements[0].x <= 4);
    assert.ok(item.elements[0].y >= 0 && item.elements[0].y <= 4);
    assert.equal(item.elements[0].customData?.pageinkText, undefined);
    assert.equal(item.elements[0].customData?.pageinkAnchor, undefined);
    assert.equal(item.elements[0].customData?.source, undefined);
    assert.equal(item.elements[0].customData?.inkKind, 'pen');
  });

  it('persists serially, mints fresh image fileIds on insert, rejects over-limit, and rolls back on persist failure', async () => {
    const writes: string[][] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(r => { releaseFirst = r; });
    let callNum = 0;
    const store = new ElementsLibraryStore([], async items => {
      const n = ++callNum;
      if (n === 1) await firstGate;
      writes.push(items.map(i => i.name));
    });
    const p1 = store.add([dummyRect('e1', 50, 60)], {}, 'A');
    const p2 = store.add([dummyRect('e2', 50, 60)], {}, 'B');
    releaseFirst();
    const [savedA, savedB] = await Promise.all([p1, p2]);
    assert.ok(savedA && savedB);
    assert.deepEqual(writes, [['A'], ['B', 'A']]);
    assert.deepEqual(store.get().map(i => i.name), ['B', 'A']);

    const parsed = normalizeLibraryItems([...store.get(), null, { id: '', name: 'bad' }]);
    assert.equal(parsed.length, 2);

    // prepareLibraryInsert mints unique fileIds so reused images never collide or read stale assets.
    const imgEl = { ...dummyRect('img1', 10, 10), type: 'image', fileId: 'orig-file-id' } as unknown as Element;
    const itemWithImg = sanitizeForLibrary([imgEl], {
      'orig-file-id': { id: 'orig-file-id', dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png', created: 1 } as never,
    }, '贴图')!;
    const prep1 = prepareLibraryInsert(itemWithImg);
    const prep2 = prepareLibraryInsert(itemWithImg);
    const f1 = (prep1.elements[0] as Extract<Element, { type: 'image' }>).fileId!;
    const f2 = (prep2.elements[0] as Extract<Element, { type: 'image' }>).fileId!;
    assert.notEqual(f1, 'orig-file-id');
    assert.notEqual(f1, f2);
    assert.ok(prep1.files[f1] && prep2.files[f2]);

    // Missing or zero-byte image assets are refused on save, normalize, and insert preparation.
    assert.throws(() => sanitizeForLibrary([imgEl], {}, 'missing'), /图片资源/);
    assert.throws(() => sanitizeForLibrary([imgEl], {
      'orig-file-id': { id: 'orig-file-id', dataURL: 'data:image/png;base64,', mimeType: 'image/png', created: 1 } as never,
    }, 'empty-img'), /图片资源/);
    assert.throws(() => prepareLibraryInsert({ ...itemWithImg, files: {} }), /图片资源/);
    assert.equal(normalizeLibraryItems([{ ...itemWithImg, files: {} }]).length, 0);

    // Rollback on persist failure & explicit rejection at MAX_LIBRARY_ITEMS.
    const failing = new ElementsLibraryStore([], () => { throw new Error('disk full'); });
    await assert.rejects(() => failing.add([dummyRect('x', 0, 0)], {}, 'fail'), /disk full/);
    assert.equal(failing.get().length, 0);

    const fullSeed = Array.from({ length: MAX_LIBRARY_ITEMS }, (_, i) => sanitizeForLibrary([dummyRect(`k${i}`, 0, 0)], {}, `item-${i}`)!);
    const fullStore = new ElementsLibraryStore(fullSeed);
    await assert.rejects(() => fullStore.add([dummyRect('extra', 0, 0)], {}, 'overflow'), /已满/);
    assert.equal(fullStore.get().length, MAX_LIBRARY_ITEMS);

    await store.remove(savedA.id);
    assert.deepEqual(store.get().map(i => i.name), ['B']);
  });
});

describe('P2: Virtual Screen Ruler (虚拟直尺)', () => {
  const ruler: RulerState = { x: 400, y: 300, angle: 0, length: 400 };

  it('snaps angles near standard drafting angles (0, 45, 90, -45)', () => {
    assert.equal(snapRulerAngle(1.8), 0);
    assert.equal(snapRulerAngle(43.2), 45);
    assert.equal(snapRulerAngle(92.5), 90);
    assert.equal(snapRulerAngle(-46.5), -45);
    assert.equal(snapRulerAngle(23.4), 23.4);
  });

  it('detects top/bottom ruler edge and projects subsequent moves strictly onto the edge', () => {
    const topHit = rulerEdgeProjection([420, 266], ruler);
    assert.ok(topHit);
    assert.equal(topHit.edge, -1);
    assert.equal(topHit.projected[0], 420);
    assert.equal(topHit.projected[1], 272);

    const far = rulerEdgeProjection([420, 200], ruler);
    assert.equal(far, null);

    const projected = projectAlongRulerEdge([510, 240], ruler, -1);
    assert.deepEqual(projected, [510, 272]);

    const line = createRulerLineElement([420, 272], [510, 272], { color: '#2463c8', width: 2, opacity: 100, inkKind: 'pen' });
    assert.equal(line.type, 'line');
    assert.equal(line.customData?.inkKind, 'pen');
    assert.deepEqual(line.points, [[0, 0], [90, 0]]);
  });
});

describe('P2: Infinite Canvas PDF Tiling & Preferences', () => {
  it('splits large infinite canvases into non-empty printable tiles and skips empty quadrants', () => {
    const topLeft = dummyRect('a', 0, 0, 200, 200);
    const bottomRight = dummyRect('b', 1800, 2400, 200, 200);
    const bigBox: Rect = { x: 0, y: 0, width: 2000, height: 2600 };
    const tiles = tileCanvasRect(bigBox, 'a4', [topLeft, bottomRight]);
    assert.ok(tiles.length >= 2 && tiles.length < 9);
    for (const tile of tiles) {
      assert.ok(filterElementsInRect([topLeft, bottomRight], tile).length > 0);
    }
    const smallBox: Rect = { x: 0, y: 0, width: 500, height: 400 };
    assert.deepEqual(tileCanvasRect(smallBox, 'a4', [topLeft]), [smallBox]);

    // Diagonal and rotated 2-point straight lines skip empty corner tiles instead of emitting all AABB tiles.
    const diag = createRulerLineElement([0, 0], [2000, 2400], { color: '#1f2329', width: 2, opacity: 100, inkKind: 'pen' });
    const diagTiles = tileCanvasRect({ x: 0, y: 0, width: 2000, height: 2400 }, 'a4', [diag]);
    assert.ok(diagTiles.length < 9);

    const rotLine = {
      ...createRulerLineElement([0, 1000], [3000, 1000], { color: '#1f2329', width: 2, opacity: 100, inkKind: 'pen' }),
      angle: Math.PI / 4,
    } as unknown as Element;
    const rotTiles = tileCanvasRect({ x: 0, y: 0, width: 2200, height: 2200 }, 'a4', [rotLine]);
    assert.ok(rotTiles.length < 6);

    // Reversed line rotated 90 degrees rotates around its true midpoint (x=1000), never gets dropped.
    const revRot = {
      ...createRulerLineElement([2000, 1000], [0, 1000], { color: '#1f2329', width: 2, opacity: 100, inkKind: 'pen' }),
      angle: Math.PI / 2,
    } as unknown as Element;
    const hitRev = filterElementsInRect([revRot], { x: 800, y: 0, width: 400, height: 2000 }, 16, () => ({ x: 990, y: 0, width: 20, height: 2000 }));
    assert.equal(hitRev.length, 1);
  });

  it('normalizes tape and gridSnap preferences safely', () => {
    const ok = normalizePreferences({ tool: 'tape', tape: { color: '#14b8a6', height: 40 }, gridSnap: true });
    assert.equal(ok.tool, 'tape');
    assert.equal(ok.tape.color, '#14b8a6');
    assert.equal(ok.tape.height, 40);
    assert.equal(ok.gridSnap, true);

    const bad = normalizePreferences({ tape: { color: 'bad', height: 999 }, gridSnap: 'nope' });
    assert.equal(bad.tape.color, DEFAULT_PREFERENCES.tape.color);
    assert.equal(bad.tape.height, DEFAULT_PREFERENCES.tape.height);
    assert.equal(bad.gridSnap, false);
  });
});

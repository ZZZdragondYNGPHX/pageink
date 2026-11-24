import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupElements, ungroupElements, reorderElements, setElementsLocked, restyleElements, summarizeLayers, insertVerticalSpace } from '../src/layers';
import { copyInkClipboard, prepareClipboardForSession, readInkClipboard, clearInkClipboard } from '../src/clipboard';
import { isHighlighterElement } from '../src/geometry';
import { normalizePreferences } from '../src/preferences';
import type { Element } from '../src/model';

const el = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'freedraw', x: 0, y: 0, width: 100, height: 100, angle: 0, strokeColor: '#1f2329', strokeWidth: 2, opacity: 100,
  isDeleted: false, locked: false, version: 1, versionNonce: 1, updated: 1, index: `a${id}`, groupIds: [], boundElements: null,
  points: [[0, 0], [100, 100]], pressures: [], simulatePressure: true, ...extra,
}) as unknown as Element;

test('groupElements and ungroupElements manage unified groups including nested levels', () => {
  const a = el('1'), b = el('2'), c = el('3');
  const g1 = groupElements([a, b, c], new Set(['1', '2']));
  assert.equal(g1.changed, true);
  assert.ok(g1.groupId);
  assert.deepEqual(g1.elements[0].groupIds, [g1.groupId]);
  assert.deepEqual(g1.elements[1].groupIds, [g1.groupId]);
  assert.deepEqual(g1.elements[2].groupIds, []);
  // Re-grouping the exact same group is a no-op.
  assert.equal(groupElements(g1.elements, new Set(['1', '2'])).changed, false);
  // Nesting a third element into an outer group, then ungrouping peels one level.
  const g2 = groupElements(g1.elements, new Set(['1', '3']));
  assert.equal(g2.changed, true);
  assert.equal(g2.elements[0].groupIds.length, 2);
  assert.equal(g2.elements[1].groupIds.length, 2); // sibling in inner group expanded automatically
  assert.equal(g2.elements[2].groupIds.length, 1);
  const u1 = ungroupElements(g2.elements, new Set(['1']));
  assert.equal(u1.changed, true);
  assert.deepEqual(u1.elements[0].groupIds, [g1.groupId]);
  assert.deepEqual(u1.elements[2].groupIds, []);
  const u2 = ungroupElements(u1.elements, new Set(['1']));
  assert.equal(u2.changed, true);
  assert.deepEqual(u2.elements[0].groupIds, []);
  assert.deepEqual(u2.elements[1].groupIds, []);
});

test('reorderElements handles front/back and skips unrelated non-overlapping objects on forward/backward', () => {
  const bottom = el('1', { x: 0, y: 0 });
  const unrelatedFar = el('2', { x: 2000, y: 2000 });
  const overlappingTop = el('3', { x: 20, y: 20 });
  const scene = [bottom, unrelatedFar, overlappingTop];

  // Forward jumps past overlappingTop in one step!
  const fwd = reorderElements(scene, new Set(['1']), 'forward');
  assert.equal(fwd.changed, true);
  assert.deepEqual(fwd.elements.map(e => e.id), ['2', '3', '1']);
  assert.equal(fwd.elements[2].index, null);

  // Back sends overlappingTop all the way to the bottom.
  const back = reorderElements(scene, new Set(['3']), 'back');
  assert.equal(back.changed, true);
  assert.deepEqual(back.elements.map(e => e.id), ['3', '1', '2']);

  // Front moves bottom to top; calling front again is a no-op.
  const front = reorderElements(scene, new Set(['1']), 'front');
  assert.deepEqual(front.elements.map(e => e.id), ['2', '3', '1']);
  assert.equal(reorderElements(front.elements, new Set(['1']), 'front').changed, false);

  // Backward from top jumps behind overlapping bottom.
  const bwd = reorderElements(scene, new Set(['3']), 'backward');
  assert.deepEqual(bwd.elements.map(e => e.id), ['3', '1', '2']);

  // Non-contiguous multi-selection never moves any selected item downward on forward.
  const stack = ['A', 'B', 'C', 'D', 'E'].map(id => el(id, { x: 0, y: 0 }));
  const multiFwd = reorderElements(stack, new Set(['A', 'D']), 'forward');
  assert.deepEqual(multiFwd.elements.map(e => e.id), ['B', 'C', 'E', 'A', 'D']);

  // Container and its bound text remain atomic when another stroke moves forward past them.
  const strokeLow = el('S', { x: 0, y: 0 });
  const container = el('R', { type: 'rectangle', x: 0, y: 0, boundElements: [{ id: 'T', type: 'text' }] });
  const boundText = el('T', { type: 'text', x: 0, y: 0, containerId: 'R' });
  const atomicFwd = reorderElements([strokeLow, container, boundText], new Set(['S']), 'forward');
  assert.deepEqual(atomicFwd.elements.map(e => e.id), ['R', 'T', 'S']);

  // Non-contiguous group [G1, B, C, S, G2] keeps unselected order intact and moves S strictly upward.
  const g1 = el('G1', { groupIds: ['grp'] }), b = el('B'), c = el('C'), s = el('S'), g2 = el('G2', { groupIds: ['grp'] });
  const nonContig = reorderElements([g1, b, c, s, g2], new Set(['S']), 'forward');
  assert.deepEqual(nonContig.elements.map(e => e.id), ['G1', 'B', 'C', 'G2', 'S']);
});

test('setElementsLocked, restyleElements and summarizeLayers preserve coherence and order', () => {
  const s1 = el('1', { groupIds: ['g1'] }), s2 = el('2', { groupIds: ['g1'] });
  const img = el('3', { type: 'image' });
  const inkA = el('4'), inkB = el('5');
  const scene = [s1, s2, img, inkA, inkB];

  // Locking one member locks the entire group.
  const locked = setElementsLocked(scene, new Set(['1']), true);
  assert.equal(locked.changed, true);
  assert.equal(locked.elements[0].locked, true);
  assert.equal(locked.elements[1].locked, true);

  // Restyle updates color/width on strokes, opacity on image, without touching image strokeColor.
  const styled = restyleElements(scene, new Set(['3', '4']), { strokeColor: '#2463c8', strokeWidth: 4, opacity: 35 });
  assert.equal(styled.changed, true);
  assert.equal(styled.elements[2].strokeColor, '#1f2329');
  assert.equal(styled.elements[2].opacity, 35);
  assert.equal(styled.elements[3].strokeColor, '#2463c8');
  assert.equal(styled.elements[3].strokeWidth, 4);
  assert.equal(styled.elements[3].opacity, 35);
  // Legacy pen stroke lowered to 35% keeps pen identity instead of becoming a highlighter.
  assert.equal(isHighlighterElement(styled.elements[3]), false);

  // Summary returns top-to-bottom stack, clustering contiguous ungrouped strokes.
  const summary = summarizeLayers(locked.elements);
  assert.equal(summary.length, 3);
  assert.equal(summary[0].kind, 'ink');
  assert.equal(summary[0].count, 2);
  assert.equal(summary[1].kind, 'image');
  assert.equal(summary[2].kind, 'group');
  assert.equal(summary[2].locked, true);
});

test('normalizePreferences fills new gesture, eraser, penSlots, zoomLock and lasso defaults for older profiles', () => {
  const prefs = normalizePreferences({ pen: { pressure: true }, eraser: { mode: 'stroke' } });
  assert.equal(prefs.pen.circleLasso, true);
  assert.equal(prefs.pen.holdToShape, true);
  assert.equal(prefs.eraser.highlighterOnly, false);
  assert.equal(prefs.eraser.autoReturn, false);
  assert.equal(prefs.zoomLock, false);
  assert.equal(prefs.penSlots.length, 4);
  assert.equal(prefs.activeSlot, 0);
  assert.equal(prefs.lasso.filter, 'all');
  const custom = normalizePreferences({ pen: { color: '#abcdef', width: 4, circleLasso: false, holdToShape: false }, eraser: { highlighterOnly: true, autoReturn: true }, zoomLock: true, lasso: { filter: 'ink' } });
  assert.equal(custom.pen.circleLasso, false);
  assert.equal(custom.pen.holdToShape, false);
  assert.equal(custom.eraser.highlighterOnly, true);
  assert.equal(custom.eraser.autoReturn, true);
  assert.equal(custom.zoomLock, true);
  assert.equal(custom.activeSlot, -1); // Custom migrated pen does not falsely highlight a mismatched default slot.
  assert.equal(custom.lasso.filter, 'ink');
});

test('insertVerticalSpace shifts unlocked units below threshold while preserving groups, anchored ink and locked items', () => {
  const above = el('above', { y: 10, height: 40 });
  const belowA = el('belowA', { y: 200, height: 40, groupIds: ['g1'] });
  const belowB = el('belowB', { y: 160, height: 100, groupIds: ['g1'] }); // group centre at 210 >= 150
  const lockedBelow = el('locked', { y: 260, height: 40, locked: true });
  const res = insertVerticalSpace([above, belowA, belowB, lockedBelow], 150, 80);
  assert.equal(res.changed, true);
  assert.equal(res.movedCount, 2);
  assert.equal(res.elements[0].y, 10);
  assert.equal(res.elements[1].y, 280);
  assert.equal(res.elements[2].y, 240);
  assert.equal(res.elements[3].y, 260);

  // Grouped stroke anchored to a paragraph stays transitively tied to the paragraph (never pulled apart).
  const { points: _unused, ...paraBase } = el('para', { type: 'text', y: 20, height: 40 }) as unknown as Record<string, unknown>;
  void _unused;
  const para = paraBase as unknown as Element;
  const groupedNote = el('note', { y: 140, height: 20, points: [[0, 0], [20, 20]], groupIds: ['gn'], customData: { pageinkAnchor: { version: 1, elementId: 'para' } } });
  const peer = el('peer', { y: 145, height: 20, points: [[0, 0], [20, 20]], groupIds: ['gn'] });
  // Threshold at y=110 (between para and note): union box spans y=20..165, centre=92.5 < 110 -> whole component stays put.
  assert.equal(insertVerticalSpace([para, groupedNote, peer], 110, 50).changed, false);
  // Threshold at y=10: whole connected component moves together by +50.
  const allMoved = insertVerticalSpace([para, groupedNote, peer], 10, 50);
  assert.equal(allMoved.movedCount, 3);
  assert.deepEqual(allMoved.elements.map(e => e.y), [70, 190, 195]);
});

test('cross-document ink clipboard snapshots elements, strips document-private asset refs across notes, and keeps them in-note', () => {
  clearInkClipboard();
  assert.equal(readInkClipboard(), null);
  const img = el('img1', { type: 'image', fileId: 'f1', customData: { pageinkCard: { version: 1, kind: 'ink', archiveAsset: 'a1' } } });
  const para = el('t1', { type: 'text', customData: { pageinkText: { version: 1, path: 'a.md', blockId: 'b', snapshotAsset: 's1', width: 300 } } });
  const files = { f1: { id: 'f1', dataURL: 'data:image/png;base64,AA==', mimeType: 'image/png', created: 1 } } as any;
  const copied = copyInkClipboard([img, para], files, 'doc-A');
  assert.ok(copied && copied.elements.length === 2 && copied.token.startsWith('pageink:clipboard:'));
  const payload = readInkClipboard()!;
  assert.equal(payload.files.f1.id, 'f1');
  // Same-session paste keeps refs intact.
  const sameDoc = prepareClipboardForSession(payload, 'doc-A');
  assert.ok(sameDoc[0].customData?.pageinkCard);
  assert.ok(sameDoc[1].customData?.pageinkText);
  // Cross-session paste detaches private asset refs so target doc stays valid on reopen.
  const otherDoc = prepareClipboardForSession(payload, 'doc-B');
  assert.equal(otherDoc[0].customData?.pageinkCard, undefined);
  assert.equal(otherDoc[1].customData?.pageinkText, undefined);
  clearInkClipboard();
});

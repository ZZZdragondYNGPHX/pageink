import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detachParagraph, findParagraph, moveParagraph, paragraphs, reflowParagraphs, textReference, validateMixed } from '../src/mixed';
import { Element, newManifest } from '../src/model';
import { cloneElements } from '../src/geometry';
import { Session } from '../src/session';
import { DocumentStore, FileIO } from '../src/storage';
import { layoutPages, PageScene } from '../src/layout';
import { wrapParagraph } from '../src/text-layout';
import { searchDocument } from '../src/search';

const paragraph = (id: string, y: number, height = 40, x = 48): Element => ({ id, type: 'text', version: 1, x, y, width: 200, height, angle: 0, strokeWidth: 1, groupIds: [], text: id, customData: { pageinkText: { version: 1, path: '原文.md', blockId: id, snapshotAsset: 'md', width: 200 } } }) as unknown as Element;
const ink = (id: string, anchor?: string): Element => ({ id, type: 'freedraw', version: 1, x: 290, y: 150, width: 30, height: 20, angle: .3, strokeWidth: 2, groupIds: [], points: [[0, 0], [30, 20]], pressures: [.2, .9], lastCommittedPoint: [30, 20], customData: anchor ? { pageinkAnchor: { version: 1, elementId: anchor } } : {} }) as unknown as Element;

test('mixed text wraps long Chinese and Latin content without splitting emoji or combining characters', () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' }), measure = (s: string) => [...segmenter.segment(s)].length;
  const source = '中文内容 hello superlongword 👩‍💻 é'.repeat(4);
  const wrapped = wrapParagraph(source, 12, measure);
  assert.ok(wrapped.split('\n').every(line => measure(line) <= 12));
  assert.equal(wrapped.replaceAll('\n', ''), source);
  assert.equal(wrapParagraph('first\n\nsecond', 20, measure), 'first\n\nsecond');
  assert.ok(wrapped.includes('👩‍💻')); assert.ok(wrapped.includes('é'));
});

test('search finds a source phrase across inserted soft line breaks in its projection', async () => {
  const session = new Session(new DocumentStore({} as FileIO, 'x', newManifest('Search', 'pages'))), id = session.manifest.pages[0].id;
  session.surfaces.set(id, [{ ...paragraph('a', 60), text: '观测\n结果', originalText: '观测结果' } as Element]);
  const hits = await searchDocument(session, undefined, '观测结果', new AbortController().signal, () => {});
  assert.equal(hits.length, 1); assert.equal(hits[0].page, id); assert.equal(hits[0].snippet, '观测结果');
});

test('paragraph identities preserve source offsets, Unicode/CRLF and reject missing/duplicate IDs', () => {
  const source = '---\r\ntitle: 测试\r\n---\r\n\r\n# 标题 ^title\r\n\r\n中文 😀 first\r\nsecond ^body\r\n\r\n```md\r\nignore ^code\r\n```\r\n\r\n- list\r\n- items\r\n';
  const result = paragraphs(source);
  assert.deepEqual(result.map(p => p.blockId), ['title', 'body']);
  const body = findParagraph(source, 'body');
  assert.equal(source.slice(body.from, body.to), '中文 😀 first\r\nsecond ^body');
  assert.equal(body.text, '中文 😀 first\nsecond');
  assert.throws(() => findParagraph(source, 'code'), /已删除/);
  assert.throws(() => findParagraph(source + '\r\n重复 ^body\r\n', 'body'), /重复/);
});

test('reflow moves only subsequent same-column paragraphs and their anchors, sharing all raw ink geometry', () => {
  const a = paragraph('a', 60), b = paragraph('b', 140), c = paragraph('c', 220), side = paragraph('side', 140, 40, 600);
  const annotation = ink('anchored', 'b'), free = ink('free');
  const elements = [a, b, c, side, annotation, free];
  const moved = reflowParagraphs(elements, new Map([['a', { ...a, height: 120, version: 2 } as Element]]));
  assert.deepEqual(moved.slice(0, 4).map(e => e.y), [60, 220, 300, 140]);
  assert.equal(moved[4].y, annotation.y + 80); assert.equal(moved[5], free);
  for (const property of ['points', 'pressures', 'lastCommittedPoint']) assert.equal((moved[4] as any)[property], (annotation as any)[property]);
  assert.equal(moved[4].angle, annotation.angle);
  assert.equal(annotation.y, 150);
  const shrunk = reflowParagraphs(moved, new Map([['a', a]]));
  assert.deepEqual(shrunk.slice(0, 4).map(e => e.y), [60, 140, 220, 140]);
  assert.equal(shrunk[4].y, annotation.y);
});

test('moving, deleting and copying paragraphs preserve ink and retarget only copied anchors', () => {
  const a = paragraph('a', 60), attached = ink('attached', 'a'), free = ink('free');
  const moved = moveParagraph([a, attached, free], 'a', 10, 20);
  assert.deepEqual(moved.map(e => [e.x, e.y]), [[58, 80], [300, 170], [290, 150]]);
  const detached = detachParagraph(moved, 'a');
  assert.equal(detached.length, 2); assert.equal(detached[0].customData?.pageinkAnchor, undefined);
  assert.equal((detached[0] as any).points, (attached as any).points);
  const copies = cloneElements([a, attached]);
  assert.equal(copies[1].customData?.pageinkAnchor!.elementId, copies[0].id);
  assert.equal(textReference(copies[0])?.blockId, 'a');
  assert.equal(cloneElements([attached])[0].customData?.pageinkAnchor, undefined);
});

test('anchored ink stays on its paragraph page even when it extends into the following page band', () => {
  const m = newManifest('Mixed', 'pages'), page = m.pages[0], other = { ...structuredClone(page), id: 'next' };
  const a = paragraph('a', 60), attached = { ...ink('attached', 'a'), y: 1400 } as Element;
  const scene = new PageScene(layoutPages([page, other]));
  const elements = scene.build(id => id === page.id ? [a, attached] : []);
  (elements[1] as any).x += 20;
  const grouped = scene.partition(elements);
  assert.equal(grouped.get(page.id)?.length, 2); assert.equal(grouped.get(other.id)?.length, 0);
});

test('text reflow and page margin growth undo/redo together, without touching scratch history', async () => {
  const m = newManifest('History', 'pages'), id = m.pages[0].id;
  const session = new Session(new DocumentStore({} as FileIO, 'x', m)), a = paragraph('a', 60);
  session.change(id, [a]); session.bodyHistory.clear();
  session.change('scratch', [ink('scratch')]);
  session.editContent(new Map([[id, [{ ...a, height: 1400, version: 2 } as Element]]]), () => { session.manifest.pages[0].margins.bottom = 400; });
  clearTimeout(session.timer);
  const undo = session.bodyHistory.undo()!;
  assert.equal(undo.parts[0].elements[0].height, 40); assert.equal(undo.layout?.pages[0].margins.bottom, 0);
  const redo = session.bodyHistory.redo()!;
  assert.equal(redo.parts[0].elements[0].height, 1400); assert.equal(redo.layout?.pages[0].margins.bottom, 400);
  assert.equal(session.scratchHistory.undo()?.elements.length, 0);
});

test('damaged source/anchor metadata refuses to load instead of losing editable sources', () => {
  const m = newManifest('Validate', 'pages'), a = paragraph('a', 60);
  assert.throws(() => validateMixed([a], m), /文字引用/);
  m.assets.md = { path: 'snapshot.bin', mimeType: 'text/markdown', created: 1 };
  validateMixed([a], m);
  assert.throws(() => validateMixed([{ ...a, customData: { pageinkText: { ...textReference(a)!, path: '../private.md' } } }], m), /不安全/);
  assert.throws(() => validateMixed([{ ...ink('a'), customData: { pageinkAnchor: { version: 4, elementId: 'a' } } } as unknown as Element], m), /锚定/);
});

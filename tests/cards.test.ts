import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paragraphEdit } from '../src/mixed';
import { cardReference, cardText, INK_PACK_MIME, validateCards, type CardReference } from '../src/cards';
import { Element, newManifest } from '../src/model';
import { cloneElements, removeElements } from '../src/geometry';
import { PageScene, layoutPages } from '../src/layout';

test('inline paragraph transaction preserves unrelated Markdown, CRLF and stable block ID', () => {
  const source = '# Heading\r\n\r\n原文 😀 ^block\r\n\r\n```js\r\nconst x = 1\r\n```\r\n';
  const edit = paragraphEdit(source, 'block', '修改后的内容 é');
  assert.equal(edit.next, source.replace('原文 😀', '修改后的内容 é'));
  assert.equal(source.slice(edit.from, edit.to), '原文 😀');
  assert.equal(paragraphEdit(source, 'block', '原文 😀').next, source);
  for (const text of ['', 'first\n\nsecond', '- list', '```md\ncode\n```', 'content ^another']) assert.throws(() => paragraphEdit(source, 'block', text));
});

const root = { id: 'card', version: 1, type: 'rectangle', x: 30, y: 40, width: 300, height: 120, angle: 0, strokeWidth: 1, groupIds: ['pair'], boundElements: [{ id: 'text', type: 'text' }, { id: 'arrow', type: 'arrow' }], customData: { pageinkCard: { version: 1, kind: 'text' } } } as unknown as Element;
const text = { id: 'text', version: 1, type: 'text', x: 46, y: 56, width: 268, height: 30, angle: 0, strokeWidth: 1, groupIds: ['pair'], containerId: 'card', customData: { pageinkText: { version: 1, path: 'source.md', blockId: 'block', snapshotAsset: 'md', width: 268 } } } as unknown as Element;
const arrow = { id: 'arrow', type: 'arrow', version: 1, x: 0, y: 0, width: 100, height: 100, angle: 0, strokeWidth: 1, points: [[0, 0], [100, 100]], groupIds: [], startBinding: { elementId: 'card', focus: 0, gap: 8 }, endBinding: null } as unknown as Element;

test('card copy remaps only internal text, group and arrow identities; source remains shared', () => {
  const copy = cloneElements([root, text, arrow]);
  const copiedRoot = copy.find(e => cardReference(e))!, copiedText = cardText(copiedRoot, copy)!;
  assert.notEqual(copiedRoot.id, root.id); assert.notEqual(copiedText.id, text.id);
  assert.deepEqual(copiedText.customData?.pageinkText, text.customData?.pageinkText);
  assert.equal((copy[2] as any).startBinding.elementId, copiedRoot.id);
  assert.equal(copiedRoot.boundElements?.find(e => e.type === 'text')?.id, copiedText.id);
  assert.equal(copiedRoot.groupIds[0], copiedText.groupIds[0]); assert.notEqual(copiedRoot.groupIds[0], 'pair');
  const removed = removeElements(copy, new Set([copiedRoot.id]));
  assert.equal(removed.length, 1); assert.equal((removed[0] as any).startBinding, null);
});

test('card native bindings round trip through scene partition without losing bound text', () => {
  const manifest = newManifest('board', 'canvas'), layout = layoutPages(manifest.pages), scene = new PageScene(layout);
  const elements = [root, text, arrow]; const built = scene.build(() => elements), parts = scene.partition(built);
  const result = parts.get(manifest.pages[0].id)!;
  assert.equal(cardText(result[0], result)?.id, 'text'); assert.equal((result[2] as any).startBinding.elementId, root.id);
});

test('ink cards require typed full source archive and preview assets before opening', () => {
  const manifest = newManifest('board', 'canvas');
  manifest.assets.pack = { path: 'archive.bin', mimeType: INK_PACK_MIME, created: 1 };
  manifest.assets.image = { path: 'image.bin', mimeType: 'image/png', created: 1 };
  const image = { id: 'ink', type: 'image', fileId: 'image', customData: { pageinkCard: { version: 1, kind: 'ink', document: 'source', path: 'source.inknote', page: 'page', region: 'region', title: '手写', archiveAsset: 'pack' } } } as unknown as Element;
  validateCards([root, image], manifest);
  const copy = structuredClone(manifest); delete copy.assets.pack; assert.throws(() => validateCards([image], copy), /完整原件/);
  copy.assets.pack = { ...manifest.assets.pack, mimeType: 'image/png' }; assert.throws(() => validateCards([image], copy));
  assert.throws(() => validateCards([{ ...image, customData: { pageinkCard: { ...image.customData!.pageinkCard! as Extract<CardReference, { kind: 'ink' }>, path: '../source.inknote' } } }], manifest), /不安全/);
  assert.throws(() => validateCards([{ ...root, customData: { pageinkCard: { version: 2, kind: 'text' } } } as unknown as Element], manifest));
});

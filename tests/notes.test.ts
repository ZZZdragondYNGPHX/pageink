import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockInsertion, drawingRegionCode, filterNotes, folderNotes, NoteEntry } from '../src/notes';

test('inserting a drawing reference keeps paragraph boundaries and exact reference identity', () => {
  const reference = { document: 'doc-1', file: '课程/引号"与中文.inknote', region: 'region-1' };
  const block = drawingRegionCode(reference);
  const result = '文字前半段' + blockInsertion('文字前半段', '后半段', block) + '后半段';
  assert.equal(result, '文字前半段\n\n' + block + '\n\n后半段');
  assert.deepEqual(JSON.parse(result.split('\n')[3]), reference);
  assert.equal(blockInsertion('前文\n\n', '\n\n后文', block), block);
  assert.equal(blockInsertion('', '', block), block + '\n\n');
});

test('catalogue searches name and path without hiding damaged documents or changing the input', () => {
  const entries: NoteEntry[] = [
    { path: 'Physics/课堂.md', name: '课堂', kind: 'text', modified: 1 },
    { path: '课堂.inknote', name: '课堂', kind: 'pages', modified: 3 },
    { path: '待恢复.inknote', name: '待恢复', kind: 'unavailable', modified: 2 },
  ];
  assert.deepEqual(filterNotes(entries, 'all', '').map(entry => entry.kind), ['pages', 'unavailable', 'text']);
  assert.deepEqual(filterNotes(entries, 'text', 'PHYSICS 课堂').map(entry => entry.path), ['Physics/课堂.md']);
  assert.equal(filterNotes(entries, 'canvas', '').length, 0);
  assert.equal(entries[0].modified, 1);
});

test('folder browsing and recursive search share exact vault paths', () => {
  const entries: NoteEntry[] = ['课程.md', '学习/课堂.md', '学习/阅读/摘录.md', '学习笔记/其他.md'].map(path => ({ path, name: path, kind: 'text', modified: 1 }));
  assert.deepEqual(folderNotes(entries, '/').map(e => e.path), ['课程.md']);
  assert.deepEqual(folderNotes(entries, '学习').map(e => e.path), ['学习/课堂.md']);
  assert.deepEqual(folderNotes(entries, '学习', true).map(e => e.path), ['学习/课堂.md', '学习/阅读/摘录.md']);
  assert.equal(folderNotes(entries, '/', true).length, 4);
});

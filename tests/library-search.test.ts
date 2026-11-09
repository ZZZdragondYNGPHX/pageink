import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyNotePath, scanLibrary, SearchSegment, searchSnippet } from '../src/library-search';
import type { NoteEntry } from '../src/notes';

const entry = (path: string, kind: NoteEntry['kind'] = 'text'): NoteEntry => ({ path, name: path, kind, modified: 1 });
test('library AND search combines path and distinct content segments and keeps first content destination', async () => {
  const notes = [entry('课程/a.md'), entry('课程/b.inknote', 'pages'), entry('elsewhere/c.md')];
  const result = await scanLibrary(notes, '课程 极限 属性', new AbortController().signal, async function* (file) {
    yield { text: '属性: 计划', label: '属性' };
    if (file.path.includes('a.md')) yield { text: '极限的定义', label: '正文', target: { line: 17 } };
    if (file.path.includes('c.md')) yield { text: '课程 极限', label: '正文', target: { line: 9 } };
  }, () => {});
  assert.deepEqual(result.matches.map(hit => hit.entry.path), ['课程/a.md', 'elsewhere/c.md']);
  assert.equal(result.matches[0].label, '属性');
  assert.equal(result.done, 3); assert.deepEqual(result.issues, []);
});
test('a PDF result closes its generator after the first match and retains page coordinates', async () => {
  let closed = false;
  const target = { pdfPage: 4, rect: { x: 10, y: 20, width: 30, height: 10 } };
  const result = await scanLibrary([entry('教材.pdf', 'pdf')], 'QUERY', new AbortController().signal, async function* () {
    try { yield { text: 'query in text layer', label: 'PDF', target }; throw Error('Unnecessary read'); }
    finally { closed = true; }
  }, () => {});
  assert.equal(closed, true); assert.deepEqual(result.matches[0].target, target); assert.deepEqual(result.issues, []);
});
test('read failures report incomplete files without hiding other results or claiming a complete no-match', async () => {
  const result = await scanLibrary([entry('missing.inknote', 'pages'), entry('good.md')], 'needle', new AbortController().signal, async function* (file) {
    if (file.path.startsWith('missing')) throw Error('等待同步资源');
    yield { text: 'needle', label: '正文', target: { line: 2 } };
  }, () => {});
  assert.deepEqual(result.issues, [{ path: 'missing.inknote', message: '等待同步资源' }]);
  assert.equal(result.matches.length, 1); assert.equal(result.matches[0].target?.line, 2);
});
test('cancellation during a segment read closes resources and never publishes stale results', async () => {
  const controller = new AbortController(); let closed = false, updates = 0;
  await assert.rejects(scanLibrary([entry('file.md')], 'needle', controller.signal, async function* (): AsyncGenerator<SearchSegment> {
    try { controller.abort(); yield { text: 'needle', label: '正文' }; }
    finally { closed = true; }
  }, () => { updates++; }), { name: 'AbortError' });
  assert.equal(closed, true); assert.equal(updates, 0);
});
test('name matches require no content reads, preserve damaged entry visibility and do not mutate inputs', async () => {
  const notes = [entry('QUERY.md'), entry('query.inknote', 'unavailable')], before = structuredClone(notes);
  const result = await scanLibrary(notes, 'query', new AbortController().signal, async function* () { throw Error('Must not read'); }, () => {});
  assert.equal(result.matches.length, 2); assert.deepEqual(result.issues, []); assert.deepEqual(notes, before);
  assert.equal(searchSnippet('前'.repeat(200) + 'QUERY' + '后'.repeat(200), ['query']).includes('QUERY'), true);
});
test('daily note uses the local calendar date with a stable path including leap days', () => {
  assert.equal(dailyNotePath(new Date(2024, 1, 29, 23, 59)), 'PageInk Daily/2024-02-29.md');
  assert.equal(dailyNotePath(new Date(2026, 0, 1, 0, 1)), 'PageInk Daily/2026-01-01.md');
});

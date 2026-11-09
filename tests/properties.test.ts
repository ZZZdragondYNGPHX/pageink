import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { App, TFile } from 'obsidian';
import {
  applyPropertyChanges, copyProperties, parsePropertyNumber, propertiesSnapshot, propertyChanges, propertyType,
  PropertiesConflict, validateProperties, type JsonProperties, type PropertyChange,
} from '../src/properties';
import { newManifest, parseManifest, type Element } from '../src/model';
import { DocumentStore, forkDocument, type FileIO } from '../src/storage';
import { Session } from '../src/session';
import { pack, unpack } from '../src/archive';

// Obsidian is a types-only npm package. This public-API double uses JSON frontmatter
// (valid YAML) and an atomic callback. Real host/YAML/editor behavior needs host tests.
const obsidianStub = `
export class App {}
export class TFile {
  constructor(path) { this.path = path; this.extension = path.split('.').pop(); }
}
export class MarkdownView {
  constructor(file, save) { this.file = file; this.save = save; }
}
export class Modal {
  static instances = [];
  constructor(app) { this.app = app; this.wasClosed = false; this.contentEl = { replaceChildren() {} }; Modal.instances.push(this); }
  open() { this.onOpen?.(); }
  close() { this.wasClosed = true; this.onClose?.(); }
}
export function getFrontMatterInfo(text) {
  const match = /^(?:\\uFEFF)?---\\r?\\n([\\s\\S]*?)\\r?\\n---(?:\\r?\\n|$)/.exec(text);
  return match ? { exists: true, frontmatter: match[1], contentStart: match[0].length } : { exists: false, frontmatter: '', contentStart: 0 };
}
export const parseYaml = JSON.parse;
`;
const bundled = await build({
  stdin: { contents: `export * from './src/properties-host'; export { TFile, MarkdownView, Modal, getFrontMatterInfo } from 'obsidian';`, resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022',
  plugins: [{ name: 'obsidian-public-api-double', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'properties-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'properties-test' }, () => ({ contents: obsidianStub, loader: 'js' }));
  } }],
});
const api = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const NoteProperties: typeof import('../src/properties-host').NoteProperties = api.NoteProperties;
const set = (key: string, value: string | number | boolean | string[]): PropertyChange => ({ key, op: 'set', value });
const remove = (key: string): PropertyChange => ({ key, op: 'delete' });

class Memory implements FileIO {
  files = new Map<string, string>(); dirs = new Set<string>(); fail = ''; writes: string[] = [];
  beforeWrite?: (path: string, data: string) => void | Promise<void>;
  async read(path: string) { if (!this.files.has(path)) throw Error(`missing: ${path}`); return this.files.get(path)!; }
  async write(path: string, data: string) {
    await this.beforeWrite?.(path, data);
    if (path === this.fail) throw Error('disk full');
    this.files.set(path, data); this.writes.push(path);
  }
  async exists(path: string) { return this.files.has(path) || this.dirs.has(path); }
  async mkdir(path: string) { this.dirs.add(path); }
  async remove(path: string) { this.files.delete(path); }
  async list(path: string) { return [...this.files.keys()].filter(key => key.startsWith(path + '/')); }
  async readBinary(path: string) { return new TextEncoder().encode(await this.read(path)).buffer as ArrayBuffer; }
  async writeBinary(path: string, value: ArrayBuffer) { await this.write(path, new TextDecoder().decode(value)); }
}

class HostDouble {
  files = new Map<string, TFile>(); views: { view: { file: TFile; save(): Promise<void> } }[] = [];
  processCalls = 0; nativeSaves = 0;
  beforeProcess?: () => Promise<void>;
  constructor(readonly io: Memory) {}
  add(path: string) { const file = new api.TFile(path) as TFile; this.files.set(path, file); return file; }
  vault = {
    getAbstractFileByPath: (path: string) => this.files.get(path),
    read: (file: TFile) => this.io.read(file.path),
  };
  workspace = { getLeavesOfType: () => this.views };
  fileManager = { processFrontMatter: async (file: TFile, callback: (properties: Record<string, unknown>) => void) => {
    this.processCalls++;
    await this.beforeProcess?.();
    const text = await this.io.read(file.path), info = api.getFrontMatterInfo(text);
    const current = info.exists ? JSON.parse(info.frontmatter) : {};
    callback(current);
    await this.io.write(file.path, markdown(current, text.slice(info.contentStart)));
  } };
  open(file: TFile, save: () => Promise<void>) {
    this.views.push({ view: new api.MarkdownView(file, async () => { this.nativeSaves++; await save(); }) });
  }
  service(session: (path: string) => Session | undefined = () => undefined) { return new NoteProperties(this as unknown as App, this.io, session); }
}

const markdown = (properties: unknown, body = '# 正文\n') => `---\n${JSON.stringify(properties)}\n---\n${body}`;
const readMarkdown = async (io: Memory, path = 'note.md') => {
  const text = await io.read(path), info = api.getFrontMatterInfo(text);
  return { properties: JSON.parse(info.frontmatter), body: text.slice(info.contentStart) };
};
async function textFixture(properties: unknown = {}, body?: string) {
  const io = new Memory(), app = new HostDouble(io), file = app.add('note.md');
  await io.write(file.path, markdown(properties, body));
  return { io, app, file, host: app.service() };
}
const rawInk = { id: 'raw', type: 'freedraw', version: 1, x: 10, y: 20, points: [[0, 0], [12.25, -6.75], [30, 4]], pressures: [.12, .83, .41], simulatePressure: false, lastCommittedPoint: [30, 4] } as unknown as Element;
async function drawingFixture(properties?: JsonProperties, mode: 'pages' | 'canvas' = 'pages') {
  const io = new Memory(), app = new HostDouble(io), file = app.add('note.inknote');
  const manifest = newManifest('属性测试', mode);
  if (properties !== undefined) manifest.properties = properties;
  const store = new DocumentStore(io, file.path, manifest);
  await store.commit(new Map([[manifest.pages[0].id + '/000000', [rawInk]]]));
  const session = new Session(store);
  return { io, app, file, store, session, host: app.service(), liveHost: app.service(() => session) };
}

test('optional manifest properties accept all JSON values without migrating old documents', () => {
  const m = newManifest('old', 'pages');
  assert.equal(Object.hasOwn(parseManifest(JSON.stringify(m)), 'properties'), false);
  const properties = JSON.parse('{"text":"中文","n":12.5,"done":false,"list":["","a\\nb"],"null":null,"complex":{"a":[1,true,null]},"__proto__":{"polluted":true}}');
  assert.deepEqual(parseManifest(JSON.stringify({ ...m, properties })).properties, properties);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  for (const invalid of [null, [], 'text', 1, true]) assert.throws(() => parseManifest(JSON.stringify({ ...m, properties: invalid })), /属性/);
  assert.throws(() => parseManifest(JSON.stringify(m).replace(/}$/, ',"properties":{"n":1e999}}')), /JSON/);
});

test('JSON validation rejects lossy values, accessors, sparse arrays and cycles', () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const sparse = new Array(2); sparse[1] = 'value';
  const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get() { throw Error('getter must not run'); } });
  const symbolArray = Object.assign(['value'], { [Symbol('extra')]: true });
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), cyclic, sparse, accessor, symbolArray]) {
    assert.throws(() => validateProperties({ key: value }), /属性/);
  }
  validateProperties({ nested: { constructor: { prototype: { inert: true } } } });
});

test('editable values preserve number/boolean types, empty lists, whitespace and multiline items', () => {
  for (const [value, type] of [['', 'text'], [1.5, 'number'], [false, 'boolean'], [[], 'list'], [['', ' a ', 'b\nc'], 'list']] as const) assert.equal(propertyType(value), type);
  for (const value of [null, undefined, NaN, Infinity, {}, [1], ['a', null], new Date(), new Array(1)]) assert.equal(propertyType(value), undefined);
  assert.equal(parsePropertyNumber(' -3.5 '), -3.5);
  assert.equal(parsePropertyNumber('1e3'), 1000);
  for (const text of ['', ' ', 'NaN', 'Infinity', '1e999', '0xff', '1,2', '1x']) assert.throws(() => parsePropertyNumber(text), /数字/);
  const current = {};
  applyPropertyChanges(current, {}, [set('text', ''), set('n', 0), set('bool', false), set('list', ['', ' a ', 'b\nc'])]);
  assert.deepEqual(current, { text: '', n: 0, bool: false, list: ['', ' a ', 'b\nc'] });
});

test('only changed keys are applied; unchanged and complex properties keep latest values and identity', () => {
  const complex = { nested: [1, true, null] }, current = { changed: 'old', untouched: 'new remote', complex, list: ['a'], gone: false };
  const base = { changed: 'old', untouched: 'old remote', complex: { previous: true }, list: ['a'], gone: false };
  assert.deepEqual(propertyChanges(base, [set('list', ['a']), remove('absent')]), []);
  applyPropertyChanges(current, base, [set('changed', 'new'), set('list', ['a']), remove('gone')]);
  assert.deepEqual(current, { changed: 'new', untouched: 'new remote', complex, list: ['a'] });
  assert.equal(current.complex, complex);
  assert.throws(() => applyPropertyChanges(current, base, [remove('complex')]), /只读/);
});

test('concurrent add/change/delete conflicts reject the whole batch before mutating any key', () => {
  const cases = [
    { base: { key: 'old' }, current: { key: 'remote' }, change: set('key', 'local') },
    { base: { key: 'old' }, current: {}, change: set('key', 'local') },
    { base: { key: 'old' }, current: { key: 'remote' }, change: remove('key') },
    { base: {}, current: { key: 'remote' }, change: set('key', 'local') },
    { base: { key: 'old' }, current: { key: 'local' }, change: set('key', 'local') },
    { base: { key: ['a'] }, current: { key: ['b'] }, change: set('key', ['c']) },
  ];
  for (const { base, current, change } of cases) {
    const before = structuredClone(current);
    assert.throws(() => applyPropertyChanges(current, base, [set('first', 'must not be written'), change]), PropertiesConflict);
    assert.deepEqual(current, before);
  }
});

test('reserved own keys remain inert; edits cannot pollute prototypes or evaluate accessors', () => {
  const base = JSON.parse('{"__proto__":{"polluted":true},"constructor":"original","prototype":"original","normal":"old"}');
  const current = copyProperties(base);
  applyPropertyChanges(current, base, [set('normal', 'new'), set('toString', 'own data')]);
  assert.deepEqual(current.__proto__, { polluted: true });
  for (const key of ['__proto__', 'constructor', 'prototype', '', '  ', 'line\nbreak']) {
    assert.throws(() => applyPropertyChanges(current, base, [set(key, 'bad')]), /属性名/);
    assert.throws(() => applyPropertyChanges(current, base, [remove(key)]), /属性名/);
  }
  assert.throws(() => propertyChanges({}, [set('dup', 1), set('dup', 2)]), /重复/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const snapshot = propertiesSnapshot('note', 'markdown', { list: ['a'] });
  assert.throws(() => (snapshot.properties.list as string[]).push('mutated'), TypeError);
});

test('Markdown uses native save and atomic frontmatter; latest body and unrelated properties survive', async () => {
  const { io, app, file, host } = await textFixture({ state: 'old', untouched: 'old', complex: { first: true } });
  let nativeText: string | undefined;
  app.open(file, async () => { if (nativeText !== undefined) { await io.write(file.path, nativeText); nativeText = undefined; } });
  nativeText = markdown({ state: 'old', untouched: 'opening', complex: { first: true } }, '# 原生未保存正文\n');
  const snapshot = await host.read(file.path);
  assert.equal(snapshot.properties.untouched, 'opening');
  nativeText = markdown({ state: 'old', untouched: 'native latest', complex: { latest: [1, null] } }, '# 最新原生正文\n\n- 原始格式\n');
  app.beforeProcess = async () => {
    const latest = await readMarkdown(io);
    await io.write(file.path, markdown({ ...latest.properties, incoming: 'during atomic read' }, latest.body + '同步到达的正文\n'));
  };
  await host.save(snapshot, [set('state', 'new'), set('list', ['', 'one\ntwo']), set('count', 3.5), set('done', false)]);
  assert.deepEqual(await readMarkdown(io), {
    properties: { state: 'new', untouched: 'native latest', complex: { latest: [1, null] }, incoming: 'during atomic read', list: ['', 'one\ntwo'], count: 3.5, done: false },
    body: '# 最新原生正文\n\n- 原始格式\n同步到达的正文\n',
  });
  assert.equal(app.nativeSaves, 2); assert.equal(app.processCalls, 1);
  assert.equal(snapshot.properties.state, 'old');
});

test('Markdown conflict in the atomic callback neither partially saves nor overwrites latest body', async () => {
  const { io, app, file, host } = await textFixture({ key: 'old', keep: true });
  const snapshot = await host.read(file.path);
  const remote = markdown({ key: 'remote', keep: false }, '最新正文\r\n');
  app.beforeProcess = async () => { await io.write(file.path, remote); };
  await assert.rejects(host.save(snapshot, [set('new', 'must not appear'), remove('key')]), /打开后已变化/);
  assert.equal(await io.read(file.path), remote);
});

test('Markdown read rejects invalid roots; no-op preserves bytes and never rewrites frontmatter', async () => {
  for (const value of [null, [], 'scalar', 1]) {
    const { host, file } = await textFixture(value);
    await assert.rejects(host.read(file.path), /属性必须/);
  }
  const { io, app, file, host } = await textFixture({ n: 1 });
  const original = await io.read(file.path), snapshot = await host.read(file.path), writes = io.writes.length;
  await host.save(snapshot, [set('n', 1), remove('absent')]);
  assert.equal(await io.read(file.path), original); assert.equal(io.writes.length, writes); assert.equal(app.processCalls, 0);
  await io.write(file.path, '正文无属性\r\n');
  const empty = await host.read(file.path);
  await host.save(empty, [set('first', 'property')]);
  assert.equal((await readMarkdown(io)).body, '正文无属性\r\n');
});

test('Markdown save failures retain the opening snapshot and retry; native save failure prevents frontmatter writes', async () => {
  const { io, app, file, host } = await textFixture({ key: 'old' });
  const snapshot = await host.read(file.path), original = await io.read(file.path);
  io.fail = file.path;
  await assert.rejects(host.save(snapshot, [set('key', 'new')]), /disk full/);
  assert.equal(await io.read(file.path), original); assert.equal(snapshot.properties.key, 'old');
  io.fail = ''; await host.save(snapshot, [set('key', 'new')]);
  assert.equal((await readMarkdown(io)).properties.key, 'new');
  const next = await host.read(file.path), calls = app.processCalls;
  app.open(file, async () => { throw Error('native save failed'); });
  await assert.rejects(host.save(next, [set('key', 'third')]), /native save failed/);
  assert.equal(app.processCalls, calls);
});

test('renamed/replaced files and copied snapshots are refused; PDFs are read-only', async () => {
  const { app, file, host } = await textFixture({ key: 'old' });
  const snapshot = await host.read(file.path);
  await assert.rejects(host.save({ ...snapshot }, [set('key', 'new')]), /原始属性快照/);
  app.add(file.path);
  await assert.rejects(host.save(snapshot, [set('key', 'new')]), /替换/);
  const pdf = app.add('source.pdf'), pdfSnapshot = await host.read(pdf.path);
  assert.equal(pdfSnapshot.kind, 'pdf');
  await assert.rejects(host.save(pdfSnapshot, []), /PDF 只读/);
  const unknown = app.add('native.canvas');
  await assert.rejects(host.read(unknown.path), /不支持/);
});

test('closed drawings merge against latest manifest and preserve exact raw ink/chunk bytes', async () => {
  for (const mode of ['pages', 'canvas'] as const) {
    const { io, file, host, store } = await drawingFixture({ key: 'old', untouched: 'old', complex: { x: [1, true] } }, mode);
    const snapshot = await host.read(file.path), rawPath = Object.values(store.manifest.chunks)[0], raw = await io.read(rawPath);
    const remote = await DocumentStore.open(io, file.path);
    remote.manifest.title = '外部新标题'; remote.manifest.properties!.untouched = 'latest';
    remote.manifest.properties!.arrived = { nested: true };
    await remote.commit(new Map());
    await host.save(snapshot, [set('key', 'new'), set('count', 2), set('list', ['a', ''])]);
    const current = parseManifest(await io.read(file.path));
    assert.equal(current.title, '外部新标题'); assert.equal(current.mode, mode);
    assert.deepEqual(current.properties, { key: 'new', untouched: 'latest', complex: { x: [1, true] }, arrived: { nested: true }, count: 2, list: ['a', ''] });
    assert.deepEqual(current.chunks, store.manifest.chunks); assert.equal(await io.read(rawPath), raw);
  }
});

test('closed drawing same-key conflict has no publication or recovery side effects', async () => {
  const { io, file, host } = await drawingFixture({ key: 'old' });
  const snapshot = await host.read(file.path), remote = await DocumentStore.open(io, file.path);
  remote.manifest.properties!.key = 'remote'; await remote.commit(new Map());
  const writes = io.writes.length;
  await assert.rejects(host.save(snapshot, [set('added', 1), set('key', 'local')]), /打开后已变化/);
  assert.equal(io.writes.length, writes);
  assert.equal(parseManifest(await io.read(file.path)).properties!.key, 'remote');
});

test('live session flushes pending ink once, saves metadata and leaves raw sampling intact', async () => {
  const { io, file, liveHost: host, session } = await drawingFixture({ key: 'old', untouched: 'old' });
  const snapshot = await host.read(file.path), id = session.manifest.pages[0].id;
  await session.load(id);
  let flushes = 0;
  session.flushers.set('body', async () => { flushes++; session.change(id, [rawInk, { ...rawInk, id: 'pending-stroke' }]); });
  session.manifest.title = '最新会话标题'; session.manifest.properties!.untouched = 'live latest'; session.metadataChanged();
  await host.save(snapshot, [set('key', 'new'), set('done', true)]);
  assert.equal(flushes, 1); assert.equal(session.saveState, 'saved');
  assert.deepEqual((await DocumentStore.open(io, file.path)).manifest.properties, { key: 'new', untouched: 'live latest', done: true });
  assert.equal(parseManifest(await io.read(file.path)).title, '最新会话标题');
  assert.deepEqual(await session.store.readSurface(id), [rawInk, { ...rawInk, id: 'pending-stroke' }]);
  assert.deepEqual({ ...session.manifest.properties }, { key: 'new', untouched: 'live latest', done: true });
});

test('live write failure restores only staged keys, preserves concurrent metadata and allows retry', async () => {
  const { io, file, liveHost: host, session } = await drawingFixture({ key: 'old', gone: false });
  const snapshot = await host.read(file.path);
  io.fail = file.path;
  io.beforeWrite = path => { if (path === file.path) { session.manifest.properties!.incoming = 'keep'; session.metadataChanged(); } };
  await assert.rejects(host.save(snapshot, [set('key', 'new'), remove('gone'), set('added', true)]), /disk full/);
  assert.deepEqual({ ...session.manifest.properties }, { key: 'old', gone: false, incoming: 'keep' });
  assert.equal(snapshot.properties.key, 'old'); assert.equal(session.saveState, 'failed');
  assert.deepEqual(parseManifest(await io.read(file.path)).properties, { key: 'old', gone: false });
  io.fail = ''; io.beforeWrite = undefined;
  await host.save(snapshot, [set('key', 'new'), remove('gone'), set('added', true)]);
  assert.deepEqual(parseManifest(await io.read(file.path)).properties, { key: 'new', incoming: 'keep', added: true });
});

test('live failed add restores optional-field absence and kernel flush failure never stages a draft', async () => {
  const { io, file, session, liveHost: host } = await drawingFixture();
  const snapshot = await host.read(file.path);
  io.fail = file.path;
  await assert.rejects(host.save(snapshot, [set('new', 'draft')]), /disk full/);
  assert.equal(Object.hasOwn(session.manifest, 'properties'), false);
  io.fail = ''; await session.save();
  session.flushers.set('broken', async () => { throw Error('kernel flush failed'); });
  await assert.rejects(host.save(snapshot, [set('new', 'draft')]), /kernel flush failed/);
  assert.equal(Object.hasOwn(session.manifest, 'properties'), false);
});

test('live same-key change and external revisions refuse stale property overwrites', async () => {
  const { io, file, session, liveHost: host } = await drawingFixture({ key: 'old' });
  const snapshot = await host.read(file.path);
  session.manifest.properties!.key = 'live remote'; session.metadataChanged();
  await assert.rejects(host.save(snapshot, [set('key', 'local')]), /打开后已变化/);
  const next = await host.read(file.path), remote = await DocumentStore.open(io, file.path);
  remote.manifest.properties!.untouched = 'external'; await remote.commit(new Map());
  const original = await io.read(file.path);
  await assert.rejects(host.save(next, [set('key', 'local')]), /外部已变化/);
  assert.equal(await io.read(file.path), original);
});

test('live session does not overwrite unversioned external properties', async () => {
  const { io, file, liveHost: host } = await drawingFixture({ key: 'old', untouched: 'old' });
  const snapshot = await host.read(file.path), disk = parseManifest(await io.read(file.path));
  disk.properties!.untouched = 'unversioned external'; await io.write(file.path, JSON.stringify(disk));
  await assert.rejects(host.save(snapshot, [set('key', 'local')]), /外部已变化/);
  assert.equal(parseManifest(await io.read(file.path)).properties!.untouched, 'unversioned external');
});

test('a drawing opened during read/save uses its new live session and changed document identities are rejected', async () => {
  const { io, app, file, session } = await drawingFixture({ key: 'old' });
  let live: Session | undefined;
  const host = app.service(() => live), snapshot = await host.read(file.path);
  live = session;
  await host.save(snapshot, [set('key', 'live')]);
  assert.equal(session.manifest.properties!.key, 'live');
  live = undefined;
  const replacement = newManifest('replacement', 'pages'); replacement.properties = { key: 'old' };
  await io.write(file.path, JSON.stringify(replacement));
  await assert.rejects(host.save(snapshot, [set('key', 'should not write')]), /笔记已替换/);
});

test('same-service concurrent saves serialize, merge distinct keys and reject same-key races', async () => {
  const { io, file, host } = await textFixture({ a: 'old', b: 'old' });
  const first = await host.read(file.path), second = await host.read(file.path);
  await Promise.all([host.save(first, [set('a', 'one')]), host.save(second, [set('b', 'two')])]);
  assert.deepEqual((await readMarkdown(io)).properties, { a: 'one', b: 'two' });
  const a = await host.read(file.path), b = await host.read(file.path);
  const outcomes = await Promise.allSettled([host.save(a, [set('a', 'three')]), host.save(b, [set('a', 'four')])]);
  assert.deepEqual(outcomes.map(result => result.status), ['fulfilled', 'rejected']);
});

test('dispose closes only owned modals, rejects stale snapshots and prevents queued writes', async () => {
  const { io, app, file, host } = await textFixture({ key: 'old' });
  const snapshot = await host.read(file.path), original = await io.read(file.path);
  // Lifecycle-only Modal double: actual rendering/keyboard behavior is checked in the host.
  const onOpen = api.NotePropertiesModal.prototype.onOpen;
  api.NotePropertiesModal.prototype.onOpen = () => {};
  try {
    const unrelated = new api.Modal(app); unrelated.open();
    await host.open(file.path); const own = api.Modal.instances.at(-1);
    const saving = host.save(snapshot, [set('key', 'new')]);
    host.dispose(); host.dispose();
    await assert.rejects(saving, /已卸载/);
    assert.equal(own.wasClosed, true); assert.equal(unrelated.wasClosed, false);
    await assert.rejects(host.read(file.path), /已卸载/);
    await assert.rejects(host.open(file.path), /已卸载/);
    await assert.rejects(host.save(snapshot, [set('key', 'new')]), /已卸载/);
    assert.equal(await io.read(file.path), original); assert.equal(app.processCalls, 0);
  } finally { api.NotePropertiesModal.prototype.onOpen = onOpen; }
});

test('dispose during native save/read or before the atomic callback prevents stale property writes', async () => {
  {
    const { app, file, host } = await textFixture();
    app.open(file, async () => { host.dispose(); });
    await assert.rejects(host.read(file.path), /已卸载/);
  }
  {
    const { io, app, file, host } = await textFixture({ key: 'old' });
    const read = app.vault.read;
    app.vault.read = async file => { const text = await read(file); host.dispose(); return text; };
    await assert.rejects(host.read(file.path), /已卸载/);
    assert.equal((await readMarkdown(io)).properties.key, 'old');
  }
  {
    const { io, app, file, host } = await textFixture({ key: 'old' });
    const snapshot = await host.read(file.path), original = await io.read(file.path);
    app.beforeProcess = async () => { host.dispose(); };
    await assert.rejects(host.save(snapshot, [set('key', 'new')]), /已卸载/);
    assert.equal(await io.read(file.path), original);
  }
  {
    const { session, file, liveHost: host } = await drawingFixture({ key: 'old' });
    const snapshot = await host.read(file.path);
    session.flushers.set('dispose', async () => { host.dispose(); });
    await assert.rejects(host.save(snapshot, [set('key', 'new')]), /已卸载/);
    assert.equal(session.manifest.properties!.key, 'old');
  }
  {
    const { io, session, file, liveHost: host } = await drawingFixture({ key: 'old' });
    const snapshot = await host.read(file.path), original = await io.read(file.path);
    session.listeners.add(() => { if (session.manifest.properties!.key === 'new') host.dispose(); });
    await assert.rejects(host.save(snapshot, [set('key', 'new')]), /已卸载/);
    assert.equal(session.manifest.properties!.key, 'old');
    assert.equal(await io.read(file.path), original);
  }
});

test('complete packages, restore and recovery forks retain all properties and original ink', async () => {
  const properties = JSON.parse('{"text":"课程","number":1.25,"boolean":false,"list":["","a\\nb"],"complex":{"nested":[null,3]},"__proto__":{"inert":true}}');
  for (const mode of ['pages', 'canvas'] as const) {
    const { io, file, session, liveHost: host } = await drawingFixture(properties, mode);
    const snapshot = await host.read(file.path);
    await host.save(snapshot, [set('text', '更新课程')]);
    const current = structuredClone(session.manifest.properties);
    const archive = await pack(session), restoredIO = new Memory();
    const restored = await unpack(restoredIO, archive, 'restored.inknote');
    assert.deepEqual(restored.properties, current);
    assert.deepEqual(await (await DocumentStore.open(restoredIO, 'restored.inknote')).readSurface(restored.pages[0].id), [rawInk]);
    const record = (await session.store.recoveryRecords())[0];
    const recovery = await forkDocument(io, record.manifest, 'recovered.inknote');
    assert.deepEqual(recovery.properties, current);
    assert.deepEqual(await (await DocumentStore.open(io, 'recovered.inknote')).readSurface(recovery.pages[0].id), [rawInk]);
    assert.equal(({} as Record<string, unknown>).inert, undefined);
  }
});

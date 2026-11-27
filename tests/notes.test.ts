import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { blockInsertion, drawingRegionCode, filterNotes, folderNotes, NoteEntry } from '../src/notes';
import type { FileIO } from '../src/storage';

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

test('native ink subpaths round trip pages and encoded bookmarks', async () => {
  const { formatInkSubpath, parseInkSubpath } = await import('../src/notes');
  assert.equal(formatInkSubpath({}), '');
  assert.equal(formatInkSubpath({ pageNumber: 0 }), '');
  assert.equal(formatInkSubpath({ pageNumber: 2 }), '#page=2');
  assert.equal(formatInkSubpath({ region: '中文 & %' }), '#region=%E4%B8%AD%E6%96%87%20%26%20%25');
  assert.deepEqual(parseInkSubpath(formatInkSubpath({ pageNumber: 2, region: '中文 & %' })), { pageNumber: 2, region: '中文 & %' });
  assert.deepEqual(parseInkSubpath('#^2'), { pageNumber: 2 });
  assert.deepEqual(parseInkSubpath('#page=page-id&region=100%25'), { pageId: 'page-id', region: '100%' });
  assert.deepEqual(parseInkSubpath('#page=0'), {});
  assert.deepEqual(parseInkSubpath(''), {});
});

test('embed sizes accept native alt suffixes and clamp only explicit dimensions', async () => {
  const { parseEmbedSize } = await import('../src/notes');
  assert.deepEqual(parseEmbedSize('标题|480x320'), { width: 480, height: 320 });
  assert.deepEqual(parseEmbedSize(' 20X9999 '), { width: 80, height: 2400 });
  assert.deepEqual(parseEmbedSize('560'), { width: 560 });
  assert.deepEqual(parseEmbedSize('标题', 700), { width: 700 });
  assert.deepEqual(parseEmbedSize(null), {});
  assert.deepEqual(parseEmbedSize(undefined), {});
  assert.deepEqual(parseEmbedSize('5x100', 560), { width: 560 });
});

// The Obsidian npm package only provides types. Keep host rendering simulated;
// document storage, complete archives and reference validation below are real.
const mainPath = (await import('node:url')).fileURLToPath(new URL('../src/main.tsx', import.meta.url));
const mainSource = await (await import('node:fs/promises')).readFile(mainPath, 'utf8');
const ts = await import('typescript');
const mainStubs = new Map<string, string>();
for (const statement of ts.createSourceFile(mainPath, mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX).statements) {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
  const clause = statement.importClause;
  if (!clause || clause.isTypeOnly) continue;
  const bindings = clause.namedBindings;
  const names = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter(binding => !binding.isTypeOnly).map(binding => (binding.propertyName ?? binding.name).text) : [];
  mainStubs.set(statement.moduleSpecifier.text, (clause.name ? 'export default class {};' : '') + names.map(name => `export class ${name} {}`).join(''));
}
const hostBundle = await (await import('esbuild')).build({
  stdin: { contents: `export { registerInkEmbeds } from './src/embed-host'; export { BoardSources, WHOLE_PAGE_REGION } from './src/cards-host'; export { LibrarySources } from './src/library-search-host'; export { default as DrawingPlugin, DrawingView } from './src/main'; export { Session } from './src/session'; export { DocumentStore, Conflict } from './src/storage'; export { TFile, TFolder, MarkdownView } from 'obsidian'; export { renderCalls, selections, notices } from 'host-test-state';`, resolveDir: (await import('node:url')).fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022',
  plugins: [{ name: 'host-public-api-double', setup(builder) {
    builder.onLoad({ filter: /\/src\/main\.tsx$/ }, () => ({ loader: 'tsx', contents: mainSource + '\nexport { DrawingView };', resolveDir: mainPath.slice(0, mainPath.lastIndexOf('/')) }));
    builder.onResolve({ filter: /.*/ }, args => args.importer === mainPath && mainStubs.has(args.path) && args.path !== 'obsidian' && !/^\.\/(storage|model|session|notes)$/.test(args.path)
      ? { path: args.path, namespace: 'host-main-stub' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'host-main-stub' }, args => ({ loader: 'js', contents: mainStubs.get(args.path)! }));
    builder.onResolve({ filter: /^(obsidian|host-test-state)$/ }, args => ({ path: args.path, namespace: 'host-test' }));
    builder.onResolve({ filter: /\/preview$/ }, () => ({ path: 'preview', namespace: 'host-test' }));
    builder.onResolve({ filter: /\/pdf$/ }, () => ({ path: 'pdf', namespace: 'host-test' }));
    builder.onResolve({ filter: /\/mixed-host$/ }, () => ({ path: 'mixed-host', namespace: 'host-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'host-test' }, args => ({ loader: 'js', contents: {
      obsidian: `import {notices} from 'host-test-state'; export class App {} export class Plugin {} export class FileView {} export class WorkspaceLeaf {} export class TFile {} export class TFolder {} export class MarkdownView {} export class Notice { constructor(message) { notices.push(message); } } export class Modal {} export class FuzzySuggestModal {} export class Menu {} export const normalizePath = path => path; export const setIcon = () => {}; export const parseLinktext = path => ({path}); export class MarkdownRenderChild { constructor(el) { this.containerEl = el; } register() {} registerEvent() {} }`,
      'host-test-state': `export const renderCalls = []; export const selections = []; export const notices = [];`,
      preview: `import {renderCalls} from 'host-test-state'; export async function renderArea(session, page, area) { renderCalls.push({page: page.id, area}); return { width: 100, height: 100, toDataURL() { return 'data:image/png;base64,cHJldmlldw=='; } }; }`,
      pdf: `export class PdfService { static open() { throw Error('Unexpected PDF rendering'); } }`,
      'mixed-host': `import {selections} from 'host-test-state'; export class Choice { constructor(app, label, items, display, resolve) { this.items = items; this.resolve = resolve; selections.push(items.map(display)); } open() { this.resolve(this.items.find(item => item.region === '__page__') ?? this.items[0]); } }`,
    }[args.path]! }));
  } }],
});
const hostApi = await import('data:text/javascript;base64,' + Buffer.from(hostBundle.outputFiles[0].text).toString('base64'));
const BoardSources: typeof import('../src/cards-host').BoardSources = hostApi.BoardSources;
const LibrarySources: typeof import('../src/library-search-host').LibrarySources = hostApi.LibrarySources;
const HostFile: typeof import('obsidian').TFile = hostApi.TFile;

class HostMemory implements FileIO {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();
  async read(path: string) { return new TextDecoder().decode(await this.readBinary(path)); }
  async readBinary(path: string) { const bytes = this.files.get(path); if (!bytes) throw Error(`Missing ${path}`); return bytes.slice().buffer as ArrayBuffer; }
  async write(path: string, value: string) { this.files.set(path, new TextEncoder().encode(value)); }
  async writeBinary(path: string, bytes: ArrayBuffer) { this.files.set(path, new Uint8Array(bytes.slice(0))); }
  async exists(path: string) { return this.files.has(path) || this.dirs.has(path); }
  async mkdir(path: string) { this.dirs.add(path); }
  async remove(path: string) { this.files.delete(path); }
  async list(path: string) { return [...this.files.keys()].filter(file => file.startsWith(path + '/')); }
}

const hostFile = (path: string) => Object.assign(new HostFile(), { path, extension: path.split('.').pop()!, basename: path.replace(/\.[^.]+$/, ''), name: path.split('/').pop()! });

test('whole-page ink cards preserve complete raw backups, validate, reveal pages and report deletion', async () => {
  const { newManifest, newPage, pageRect } = await import('../src/model');
  const { DocumentStore } = await import('../src/storage');
  const { Session } = await import('../src/session');
  const { unpack } = await import('../src/archive');
  const { validateCards, INK_PACK_MIME } = await import('../src/cards');
  const io = new HostMemory(), file = hostFile('whole.inknote'), manifest = newManifest('整页', 'pages'), page = manifest.pages[0];
  const raw = { id: 'raw', type: 'freedraw', version: 1, x: 1, y: 2, points: [[0, 0], [4, 7]], pressures: [.2, .8], customData: { inkRawPoints: [[0, 0], [2, 3], [4, 7]], inkRawPressures: [.2, .5, .8] } } as unknown as import('../src/model').Element;
  const store = new DocumentStore(io, file.path, manifest);
  await store.commit(new Map([[`${page.id}/000000`, [raw]]]));
  const session = new Session(store), reveals: unknown[][] = [];
  const app = { vault: { getAbstractFileByPath: () => file, getFiles: () => [file] } } as unknown as import('obsidian').App;
  const sources = new BoardSources(app, { io, live: () => session, resolve: async () => file.path,
    reveal: async (...args) => { reveals.push(args); }, unique: async () => 'copy.inknote' });
  assert.equal(hostApi.WHOLE_PAGE_REGION, '__page__');
  const source = await sources.pickFromPath(file.path); assert.ok(source);
  assert.equal(source.reference.region, '__page__'); assert.equal(source.reference.page, page.id);
  assert.deepEqual(hostApi.selections.at(-1), ['整页：第 1 页']);
  assert.deepEqual(hostApi.renderCalls.at(-1).area, pageRect(page));
  assert.equal(source.width, page.width); assert.equal(source.height, page.height);
  const restoredIO = new HostMemory(), restored = await unpack(restoredIO, source.archive, 'restored.inknote');
  assert.deepEqual(await (await DocumentStore.open(restoredIO, 'restored.inknote')).readSurface(restored.pages[0].id), [raw]);
  const target = newManifest('卡片', 'canvas');
  target.assets.archive = { path: `${target.resourceDir}/assets/source.inkpack`, mimeType: INK_PACK_MIME, created: 1 };
  target.assets.preview = { path: `${target.resourceDir}/assets/preview.png`, mimeType: 'image/png', created: 1 };
  const reference = { ...source.reference, archiveAsset: 'archive' };
  const card = { id: 'card', type: 'image', fileId: 'preview', customData: { pageinkCard: reference } } as unknown as import('../src/model').Element;
  assert.doesNotThrow(() => validateCards([card], target));
  await sources.openInk(reference); assert.deepEqual(reveals, [[file.path, page.id, undefined]]);
  session.manifest.pages = [newPage()];
  session.metadataChanged(); await session.flush();
  await assert.rejects(sources.readInk(reference), /原页面已删除。卡片预览与完整备份仍保留，可另存当时的原件副本。/);
});

test('whole canvas cards use complete live element bounds and minimum display dimensions', async () => {
  const { newManifest } = await import('../src/model'), { DocumentStore } = await import('../src/storage');
  const io = new HostMemory(), file = hostFile('canvas.inknote'), manifest = newManifest('画布', 'canvas');
  await new DocumentStore(io, file.path, manifest).commit(new Map([[`${manifest.pages[0].id}/000000`, [
    { id: 'far', type: 'rectangle', x: 9000, y: -4000, width: 20, height: 10, angle: 0, strokeWidth: 1, version: 1 },
    { id: 'deleted', type: 'rectangle', x: -9000, y: -9000, width: 500, height: 500, angle: 0, strokeWidth: 1, version: 1, isDeleted: true },
  ] as import('../src/model').Element[]]]));
  const sources = new BoardSources({ vault: { getAbstractFileByPath: () => file } } as unknown as import('obsidian').App,
    { io, live: () => undefined, resolve: async () => file.path, reveal: async () => {}, unique: async () => 'copy.inknote' });
  const source = await sources.pickFromPath(file.path); assert.ok(source);
  assert.deepEqual(hostApi.selections.at(-1), ['整张无边画布']);
  assert.equal(source.width, 120); assert.equal(source.height, 80);
  assert.ok(hostApi.renderCalls.at(-1).area.x > 8000);
});

test('queued library previews abort immediately without consuming slots or delaying visible items', async () => {
  const files = ['one.md', 'two.md', 'hidden.md', 'visible.md'].map(hostFile), started: string[] = [], finish = new Map<string, () => void>();
  const app = { vault: {
    getAbstractFileByPath: (path: string) => files.find(file => file.path === path),
    cachedRead: (file: import('obsidian').TFile) => { started.push(file.path); return new Promise<string>(resolve => finish.set(file.path, () => resolve(file.path))); },
  }, workspace: { getLeavesOfType: () => [] } } as unknown as import('obsidian').App;
  const sources = new LibrarySources(app, new HostMemory(), () => undefined);
  const preview = (index: number, signal = new AbortController().signal) => sources.preview({ path: files[index].path, name: files[index].basename, modified: 1, kind: 'text' }, signal);
  const first = preview(0), second = preview(1), controller = new AbortController();
  const cancelled = preview(2, controller.signal), rejected = assert.rejects(cancelled, { name: 'AbortError' });
  const visible = preview(3);
  controller.abort(); await rejected;
  assert.equal((sources as unknown as { waiting: unknown[] }).waiting.length, 1);
  assert.deepEqual(started, ['one.md', 'two.md']);
  finish.get('one.md')!(); await first;
  assert.deepEqual(started, ['one.md', 'two.md', 'visible.md']);
  finish.get('two.md')!(); finish.get('visible.md')!(); await Promise.all([second, visible]);
  assert.equal((sources as unknown as { previews: number }).previews, 0);
  assert.equal((sources as unknown as { waiting: unknown[] }).waiting.length, 0);
});


test('simulated embed host follows bookmark and manually selected page identities after insertion', async () => {
  const { newManifest, newPage } = await import('../src/model');
  const { DocumentStore } = await import('../src/storage');
  const { Session } = await import('../src/session');
  const manifest = newManifest('嵌入', 'pages'), target = newPage();
  manifest.pages.push(target);
  manifest.regions.push({ id: 'bookmark', title: '书签', pageId: target.id, x: 0, y: 0, width: 100, height: 100 });
  const session = new Session(new DocumentStore(new HostMemory(), 'embed.inknote', manifest), manifest);
  const buttons = new Map<string, { onclick?: () => void }>();
  const element = () => ({
    width: 100, height: 100, ownerDocument: { activeElement: null },
    addClass() {}, setAttribute() {}, removeAttribute() {}, setCssStyles() {},
    getAttribute() { return null; }, replaceChildren() { buttons.clear(); },
    getContext() { return { drawImage() {} }; }, getBoundingClientRect() { return { height: 100 }; },
    addEventListener() {}, createSpan() {},
    createEl(_tag: string, options: { attr: Record<string, string> }) { const button = {}; buttons.set(options.attr['data-ink-action'], button); return button; },
    createDiv() { return element(); },
    empty() { assert.fail('embed rendering failed'); },
  });
  let factory!: (context: unknown, file: unknown, subpath: string) => { loadFile(): Promise<void>; renderContent(): Promise<void> };
  const plugin = { register() {}, registerMarkdownCodeBlockProcessor() {}, registerMarkdownPostProcessor() {}, app: {
    metadataCache: { getFirstLinkpathDest: () => ({ path: 'embed.inknote' }) },
    vault: { on() {} }, embedRegistry: { registerExtension(_extension: string, callback: typeof factory) { factory = callback; } },
  } };
  const originalCreateEl = globalThis.createEl;
  globalThis.createEl = (() => element()) as unknown as typeof createEl;
  try {
    hostApi.registerInkEmbeds(plugin, { io: new HostMemory(), prefs: { get: () => ({ embedMaxWidth: 560 }) }, live: () => session, resolve: async () => 'embed.inknote' });
    const bookmark = factory({ containerEl: element(), sourcePath: 'source.md' }, { path: 'embed.inknote' }, '#region=bookmark');
    await bookmark.loadFile();
    assert.equal(hostApi.renderCalls.at(-1).page, target.id);
    manifest.pages.unshift(newPage()); manifest.revision += '-insert';
    await bookmark.renderContent();
    assert.equal(hostApi.renderCalls.at(-1).page, target.id);
    const whole = factory({ containerEl: element(), sourcePath: 'source.md' }, { path: 'embed.inknote' }, '');
    await whole.loadFile();
    buttons.get('next')!.onclick!();
    await whole.renderContent();
    const selected = manifest.pages[1].id;
    manifest.pages.unshift(newPage()); manifest.revision += '-insert';
    await whole.renderContent();
    assert.equal(hostApi.renderCalls.at(-1).page, selected);
  } finally { globalThis.createEl = originalCreateEl; }
});

const RenameSession: typeof import('../src/session').Session = hostApi.Session;
const RenameStore: typeof import('../src/storage').DocumentStore = hostApi.DocumentStore;
const stroke = (id: string) => ({ id, type: 'freedraw', version: 1, x: 1, y: 2, points: [[0, 0], [4, 7]], pressures: [.2, .8],
  customData: { inkRawPoints: [[0, 0], [2, 3], [4, 7]], inkRawPressures: [.2, .5, .8] } }) as unknown as import('../src/model').Element;

async function renameFixture(t: TestContext) {
  const { newManifest } = await import('../src/model');
  const io = new HostMemory(), file = hostFile('shared.inknote'), manifest = newManifest('多窗格', 'pages'), page = manifest.pages[0].id;
  manifest.pdf = { path: 'Sources/source.pdf', sha256: '0'.repeat(64), size: 1 };
  manifest.assets.md = { path: `${manifest.resourceDir}/assets/source.md`, mimeType: 'text/markdown', created: 1 };
  await io.write(manifest.assets.md.path, '原段落 ^paragraph');
  const paragraph = (id: string) => ({ id, type: 'text', version: 1, customData: {
    pageinkText: { version: 1, path: 'Sources/note.md', blockId: id, snapshotAsset: 'md', width: 200 },
  } }) as unknown as import('../src/model').Element;
  await new RenameStore(io, file.path, manifest).commit(new Map([[`${page}/000000`, [paragraph('paragraph')]], ['scratch/000000', [paragraph('scratch')]]]));
  const a = new RenameSession(await RenameStore.open(io, file.path)), b = new RenameSession(await RenameStore.open(io, file.path));
  t.after(() => { window.clearTimeout(a.timer); window.clearTimeout(b.timer); });
  for (const session of [a, b]) { session.keepers.add(() => true); await session.load(page); }
  const rebuilds = { a: 0, b: 0 };
  const views = [
    { file, session: b, isPreview: true, actions: { rebuildScenes: async () => { rebuilds.b++; } } },
    { file, session: a, isPreview: false, actions: { rebuildScenes: async () => { rebuilds.a++; } } },
  ];
  const plugin: Pick<import('../src/main').default, 'maintainPdfPath'> = Object.assign(Object.create(hostApi.DrawingPlugin.prototype), {
    io, unsavedSessions: new Map(), views: () => views,
    app: { vault: { getAbstractFileByPath: (path: string) => path === 'Renamed' ? new hostApi.TFolder() : undefined, getFiles: () => [file] } },
  });
  const noticeCount = hostApi.notices.length;
  t.after(() => assert.equal(hostApi.notices.length, noticeCount, 'rename maintenance must not report a swallowed conflict'));
  return { io, file, page, a, b, plugin, rebuilds };
}

test('simulated rename host refreshes clean panes with newly saved ink before their next same-block edit', async t => {
  const { io, file, page, a, b, plugin, rebuilds } = await renameFixture(t);
  a.flushers.set('body', async () => {
    a.change(page, [...a.surfaces.get(page)!, stroke('a')]); a.flushers.delete('body');
  });
  const oldStore = b.store;
  await plugin.maintainPdfPath('Sources', 'Renamed');
  assert.notEqual(b.store, oldStore);
  assert.equal(b.store.manifest.revision, a.store.manifest.revision);
  assert.equal(b.manifest.pdf?.path, 'Renamed/source.pdf');
  assert.equal(b.surfaces.get(page)![0].customData?.pageinkText?.path, 'Renamed/note.md');
  assert.deepEqual(b.surfaces.get(page)!.map(element => element.id), ['paragraph', 'a']);
  assert.deepEqual(b.surfaces.get(page)![1], stroke('a'));
  assert.equal((await b.load('scratch'))[0].customData?.pageinkText?.path, 'Renamed/note.md');
  assert.equal(b.dirty.size, 0); assert.equal(b.metadataDirty, false);
  assert.deepEqual(rebuilds, { a: 1, b: 1 });
  b.change(page, [...b.surfaces.get(page)!, stroke('b')]);
  await b.save();
  const disk = await RenameStore.open(io, file.path);
  assert.deepEqual((await disk.readSurface(page)).map(element => element.id), ['paragraph', 'a', 'b']);
  assert.deepEqual((await disk.readSurface(page)).slice(1), [stroke('a'), stroke('b')]);
});

test('simulated rename host clears stale secondary undo after adopting primary unsaved ink', async t => {
  const { io, file, page, a, b, plugin } = await renameFixture(t);
  b.change(page, [...b.surfaces.get(page)!, stroke('b')]);
  await b.save();
  assert.equal(b.bodyHistory.canUndo, true);
  a.store = await RenameStore.open(io, file.path);
  a.manifest = structuredClone(a.store.manifest);
  a.surfaces.clear(); a.trackers.clear();
  const saved = await a.load(page);
  const linked = { ...saved[0], id: 'linked' };
  a.change(page, [...saved, stroke('a'), linked]);
  await plugin.maintainPdfPath('Sources', 'Renamed');
  for (const session of [a, b]) {
    assert.deepEqual(session.surfaces.get(page)!.map(element => element.id), ['paragraph', 'b', 'a', 'linked']);
    assert.equal(session.surfaces.get(page)![3].customData?.pageinkText?.path, 'Renamed/note.md');
  }
  assert.equal(b.bodyHistory.canUndo, false);
  assert.equal(b.bodyHistory.undo(), undefined);
  assert.equal(a.bodyHistory.canUndo, true);
  const undo = a.bodyHistory.undo()!;
  assert.deepEqual(undo.elements.map(element => element.id), ['paragraph', 'b']);
  assert.equal(undo.elements[0].customData?.pageinkText?.path, 'Renamed/note.md');
  assert.equal(a.bodyHistory.redo()!.elements[3].customData?.pageinkText?.path, 'Renamed/note.md');
});

test('simulated rename host clears secondary undo when primary flush collects new ink after rename starts clean', async t => {
  const { io, file, page, a, b, plugin } = await renameFixture(t);
  b.change(page, [...b.surfaces.get(page)!, stroke('b')]);
  await b.save();
  a.store = await RenameStore.open(io, file.path);
  a.manifest = structuredClone(a.store.manifest);
  a.surfaces.clear(); a.trackers.clear();
  await a.load(page);
  assert.equal(b.bodyHistory.canUndo, true);
  let calls = 0;
  a.flushers.set('body', async () => {
    if (++calls === 2) {
      assert.equal(a.store.manifest.revision, b.store.manifest.revision);
      a.change(page, [...a.surfaces.get(page)!, stroke('a')]);
    }
  });
  assert.equal(a.dirty.size, 0); assert.equal(a.metadataDirty, false);
  await plugin.maintainPdfPath('Sources', 'Renamed');
  assert.equal(calls, 2);
  assert.deepEqual(b.surfaces.get(page)!.map(element => element.id), ['paragraph', 'b', 'a']);
  assert.equal(b.bodyHistory.canUndo, false);
});

test('simulated rename host clears secondary undo when retargeted versions match but element contents differ', async t => {
  const { io, file, page, a, b, plugin } = await renameFixture(t);
  b.change(page, [...b.surfaces.get(page)!, stroke('b')]);
  await b.save();
  a.store = await RenameStore.open(io, file.path);
  a.manifest = structuredClone(a.store.manifest);
  a.surfaces.clear(); a.trackers.clear();
  const saved = await a.load(page), paragraph = saved[0];
  const rewritten = { ...paragraph, version: paragraph.version + 1, customData: {
    ...paragraph.customData, pageinkText: { ...paragraph.customData!.pageinkText!, path: 'Other/note.md' },
  } };
  a.change(page, [rewritten, ...saved.slice(1)]);
  assert.equal(b.bodyHistory.canUndo, true);
  await plugin.maintainPdfPath('Sources', 'Renamed');
  assert.equal(b.surfaces.get(page)![0].id, paragraph.id);
  assert.equal(b.surfaces.get(page)![0].version, paragraph.version + 1);
  assert.equal(b.surfaces.get(page)![0].customData?.pageinkText?.path, 'Other/note.md');
  assert.equal(b.bodyHistory.canUndo, false);
});

test('simulated rename host preserves independently dirty panes and leaves conflict protection intact', async t => {
  const { io, file, page, a, b, plugin, rebuilds } = await renameFixture(t);
  a.change(page, [...a.surfaces.get(page)!, stroke('a')]);
  b.change(page, [...b.surfaces.get(page)!, stroke('b')]);
  const oldStore = b.store, baseRevision = oldStore.manifest.revision;
  await plugin.maintainPdfPath('Sources', 'Renamed');
  assert.equal(b.store, oldStore); assert.equal(b.store.manifest.revision, baseRevision);
  for (const session of [a, b]) {
    assert.equal(session.manifest.pdf?.path, 'Renamed/source.pdf');
    assert.equal(session.surfaces.get(page)![0].customData?.pageinkText?.path, 'Renamed/note.md');
    assert.equal((await session.load('scratch'))[0].customData?.pageinkText?.path, 'Renamed/note.md');
  }
  assert.ok(b.dirty.size > 0); assert.equal(b.metadataDirty, true); assert.equal(b.saveState, 'pending');
  assert.equal(b.conflictPath, '');
  assert.deepEqual(rebuilds, { a: 1, b: 1 });
  await assert.rejects(b.save(), hostApi.Conflict);
  assert.deepEqual((await (await RenameStore.open(io, file.path)).readSurface(page)).map(element => element.id), ['paragraph', 'a']);
  const copy = await RenameStore.open(io, b.conflictPath);
  assert.equal(copy.manifest.pdf?.path, 'Renamed/source.pdf');
  assert.deepEqual((await copy.readSurface(page)).map(element => element.id), ['paragraph', 'b']);
});

test('simulated rename host retains ink buffered while a clean pane reads the new disk revision', async t => {
  const { io, file, page, a, b, plugin } = await renameFixture(t);
  a.change(page, [...a.surfaces.get(page)!, stroke('a')]);
  const baseRevision = b.store.manifest.revision, read = io.read.bind(io);
  let buffered = false, injected = false;
  b.flushers.set('body', async () => {
    if (buffered) { b.change(page, [...b.surfaces.get(page)!, stroke('late')]); buffered = false; }
  });
  io.read = async path => {
    if (!injected && a.store.manifest.revision !== baseRevision && path === a.store.manifest.chunks[`${page}/000000`]) {
      injected = true; buffered = true;
    }
    return read(path);
  };
  await plugin.maintainPdfPath('Sources', 'Renamed');
  assert.equal(injected, true); assert.equal(buffered, false);
  assert.equal(b.store.manifest.revision, baseRevision);
  assert.equal(b.manifest.pdf?.path, 'Renamed/source.pdf');
  assert.equal(b.surfaces.get(page)![0].customData?.pageinkText?.path, 'Renamed/note.md');
  assert.deepEqual(b.surfaces.get(page)!.map(element => element.id), ['paragraph', 'late']);
  assert.ok(b.dirty.size > 0); assert.equal(b.metadataDirty, true); assert.equal(b.saveState, 'pending');
  await assert.rejects(b.save(), hostApi.Conflict);
  assert.deepEqual((await (await RenameStore.open(io, file.path)).readSurface(page)).map(element => element.id), ['paragraph', 'a']);
  assert.deepEqual((await (await RenameStore.open(io, b.conflictPath)).readSurface(page)).map(element => element.id), ['paragraph', 'late']);
});

test('simulated companion insertion bypasses an unrelated pane that has switched to source mode', async t => {
  const { file, a } = await renameFixture(t);
  const writes: string[] = [], saved: string[] = [], opened: string[] = [];
  const markdown = (path: string) => Object.assign(new hostApi.MarkdownView(), {
    file: hostFile(path), getMode: () => 'source', save: async () => { saved.push(path); },
    editor: { getValue: () => '', getCursor: () => ({ line: 0, ch: 0 }), posToOffset: () => 0,
      offsetToPos: () => ({ line: 0, ch: 0 }), replaceRange: () => { writes.push(path); } },
  });
  const unrelated = markdown('unrelated.md'), companionPath = 'shared.md';
  const leaf = { view: unrelated, openFile: async (target: import('obsidian').TFile) => { opened.push(target.path); leaf.view = markdown(target.path); } };
  const view = Object.assign(Object.create(hostApi.DrawingView.prototype), {
    file, session: a, leaf: {}, adjacentMarkdown: () => unrelated, currentPage: () => a.manifest.pages[0].id,
    plugin: { prefs: { get: () => ({ embedMaxWidth: 560 }) } },
    app: {
      vault: { getAbstractFileByPath: () => undefined, create: async (path: string) => hostFile(path) },
      workspace: { getLeavesOfType: () => [{ view: unrelated }], createLeafBySplit: () => leaf },
      fileManager: { generateMarkdownLink: () => '[[shared.inknote#page=1|560]]' },
    },
  });
  assert.equal(await view.sendToMarkdown({ createSplitIfMissing: true }), companionPath);
  assert.deepEqual(opened, [companionPath]); assert.deepEqual(writes, [companionPath]); assert.deepEqual(saved, [companionPath]);
});

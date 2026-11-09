import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pack, unpack } from '../src/archive';
import { Session } from '../src/session';
import { DocumentStore, FileIO } from '../src/storage';
import { newManifest, newPage, Manifest, Element, digest, toArrayBuffer } from '../src/model';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
class Memory implements FileIO {
  files = new Map<string, Uint8Array>(); dirs = new Set<string>();
  async read(p: string) { return new TextDecoder().decode(await this.readBinary(p)); }
  async write(p: string, text: string) { this.files.set(p, new TextEncoder().encode(text)); }
  async readBinary(p: string) { const data = this.files.get(p); if (!data) throw Error('missing ' + p); return data.slice().buffer as ArrayBuffer; }
  async writeBinary(p: string, bytes: ArrayBuffer) { this.files.set(p, new Uint8Array(bytes).slice()); }
  async exists(p: string) { return this.files.has(p) || this.dirs.has(p); }
  async mkdir(p: string) { this.dirs.add(p); }
  async remove(p: string) { this.files.delete(p); }
  async list(p: string) { return [...this.files.keys()].filter(k => k.startsWith(p + '/')); }
}

const originalPath = 'Notes/混合笔记.md';
function linkedText(id: string, snapshotAsset = 'snapshot-v1'): Element {
  return { id, version: 7, versionNonce: 42, type: 'text', text: '投影段落', originalText: '投影段落',
    x: 24, y: 50, width: 300, height: 24, isDeleted: false, customData: {
      preserved: { value: 'unrelated metadata' },
      pageinkText: { version: 1, path: originalPath, blockId: 'block-1', snapshotAsset, width: 300 },
    } } as unknown as Element;
}

async function mixedNotebook() {
  const io = new Memory(), m = newManifest('混合笔记', 'pages');
  m.pages.push(newPage({ template: 'grid' }));
  m.regions.push({ id: 'region', pageId: m.pages[1].id, title: '摘录', x: 0, y: 0, width: 300, height: 200 });
  // Include BOM, CRLF, combining characters and unprojected Markdown to detect normalization or truncation.
  const first = '\uFEFF---\r\ntitle: 完整原件\r\n---\r\n\r\n# 中文 🖋️\r\n\r\n投影段落 e\u0301 ^block-1\r\n\r\n未投影段落 ^block-2\r\n\r\n```ts\r\nconst value = "保留";\r\n```\r\n';
  const snapshots: Record<string, Uint8Array> = {
    'snapshot-v1': strToU8(first),
    'snapshot-v2': strToU8(first.replace('投影段落 e\u0301', '第二版段落 é').replace('未投影段落', '第二版未投影段落')),
    'unreferenced-snapshot': strToU8('历史完整原件\n\n保留 ^old-block\n'),
  };
  for (const [id, bytes] of Object.entries(snapshots)) {
    const path = `${m.resourceDir}/assets/${id}.bin`;
    m.assets[id] = { path, mimeType: 'text/markdown', created: 123 };
    await io.writeBinary(path, toArrayBuffer(bytes));
  }
  await io.write(originalPath, '当前外部原文已更新，不能替代任何快照。 ^block-1\n');
  const ink = { id: 'raw-ink', version: 4, versionNonce: 17, type: 'freedraw', x: 31, y: 87,
    width: 12.5, height: 20, angle: 0.25, points: [[0, 0], [0.125, 3.875], [12.5, 20]],
    pressures: [0.02, 0.731, 0.43], simulatePressure: false, lastCommittedPoint: [12.5, 20],
    customData: { pageinkAnchor: { version: 1, elementId: 'page-text' },
      source: { document: m.id, page: m.pages[1].id, polygon: [[0, 0], [10, 0], [10, 10]] } },
  } as unknown as Element;
  const scratch = linkedText('scratch-text');
  scratch.customData!.source = { document: m.id, page: m.pages[0].id, region: 'region' };
  const external = { ...ink, id: 'external-ink', customData: { ...ink.customData,
    source: { document: 'another-document', page: 'another-page' } } } as Element;
  const chunks = new Map<string, Element[]>([
    [`${m.pages[0].id}/000000`, [linkedText('page-text'), ink]],
    [`${m.pages[0].id}/000001`, [linkedText('later-chunk')]],
    [`${m.pages[1].id}/000000`, [linkedText('another-page')]],
    ['scratch/000000', [scratch, external]],
    ['scratch/000001', [{ ...linkedText('second-version', 'snapshot-v2'), isDeleted: true }]],
  ]);
  const store = new DocumentStore(io, 'mixed.inknote', m);
  await store.commit(chunks);
  return { io, store, chunks, snapshots };
}

test('complete package restores editable body, scratch, binary assets and PDF into a clean vault', async () => {
  const io = new Memory(), m = newManifest('Portable', 'pages'), source = new Uint8Array([0, 255, 128, 1]);
  await io.writeBinary('source.pdf', source.buffer); await io.writeBinary('image.png', source.buffer);
  m.pdf = { path: 'source.pdf', sha256: await digest(source.buffer), size: source.length };
  m.assets.image = { path: 'image.png', mimeType: 'image/png', created: 1 };
  const store = new DocumentStore(io, 'source.inknote', m);
  await store.commit(new Map([[m.pages[0].id + '/000000', [{id:'body',version:1,type:'text',text:'中文'} as Element]], ['scratch/000000', [{id:'scratch',version:1,type:'image',fileId:'image',customData:{source:{document:m.id,page:m.pages[0].id,polygon:[[0,0],[10,0],[10,10]]}}} as unknown as Element]]]));
  const archive = await pack(new Session(store)), clean = new Memory();
  const restored = await unpack(clean, archive, 'restored.inknote'), open = await DocumentStore.open(clean, 'restored.inknote');
  assert.notEqual(restored.id, m.id); assert.equal((await open.readSurface(m.pages[0].id))[0].id, 'body');
  assert.equal((await open.readSurface('scratch'))[0].id, 'scratch');
  assert.equal((await open.readSurface('scratch'))[0].customData?.source.document,restored.id);
  assert.deepEqual(new Uint8Array(await clean.readBinary(restored.assets.image.path)), source);
  assert.equal(await digest(await clean.readBinary(restored.pdf!.path)), m.pdf.sha256);
  await assert.rejects(unpack(clean, archive, 'restored.inknote'), /已存在/);
});
test('pack refuses a changed source and honors cancellation before reading resources', async () => {
  const io=new Memory(),m=newManifest('Changed','pages'),bytes=new Uint8Array([1,2]);
  m.pdf={path:'source.pdf',sha256:await digest(bytes.buffer),size:2};await io.writeBinary('source.pdf',new Uint8Array([3,4]).buffer);
  const store=new DocumentStore(io,'changed.inknote',m);await store.commit(new Map());const session=new Session(store);
  await assert.rejects(pack(session),/内容已变化/);
  const controller=new AbortController();controller.abort();await assert.rejects(pack(session,undefined,controller.signal),{name:'AbortError'});
});
test('incomplete or unsafe packages never publish a restored entry', async () => {
  const io = new Memory(), m = newManifest('Broken', 'pages'); m.chunks['scratch/000000'] = 'missing';
  await assert.rejects(unpack(io, zipSync({'document.json':strToU8(JSON.stringify(m))}), 'bad.inknote'), /缺少资源/);
  await assert.rejects(unpack(io, zipSync({'../escape':new Uint8Array([1])}), 'unsafe.inknote'), /不安全/);
  assert.equal(io.files.size, 0);
});

test('restore cancellation during resource writes publishes no entry and cleans its files', async () => {
  const source=new Memory(),m=newManifest('Cancel restore','pages');
  const store=new DocumentStore(source,'source.inknote',m);
  await store.commit(new Map([['scratch/000000',[{id:'s',version:1,type:'text',text:'retain in archive'} as Element]]]));
  const bytes=await pack(new Session(store)),target=new Memory(),abort=new AbortController();
  await assert.rejects(unpack(target,bytes,'cancelled.inknote',()=>abort.abort(),abort.signal),{name:'AbortError'});
  assert.equal(target.files.size,0);assert.ok(bytes.byteLength>0);
});

test('restore removes partially written entry and resources after adapter failure', async () => {
  const source=new Memory(),store=new DocumentStore(source,'source.inknote',newManifest('Interrupted restore','pages'));
  await store.commit(new Map([['scratch/000000',[{id:'s',version:1,type:'text',text:'archive remains intact'} as Element]]]));
  const bytes=await pack(new Session(store));
  for(const entryFailure of [true,false]){
    const target=new Memory();
    if(entryFailure)target.write=async(path)=>{target.files.set(path,strToU8('{'));throw Error('injected entry failure');};
    else target.writeBinary=async(path)=>{target.files.set(path,new Uint8Array([1]));throw Error('injected resource failure');};
    await assert.rejects(unpack(target,bytes,'partial.inknote'),/injected/);
    assert.equal(target.files.size,0);
  }
  const clean=new Memory();await unpack(clean,bytes,'retry.inknote');assert.ok(await clean.exists('retry.inknote'));
});

test('shared text snapshots restore to one Markdown path across pages, chunks and scratch without changing raw elements', async () => {
  const { io, store, chunks, snapshots } = await mixedNotebook();
  const session = new Session(store), before = structuredClone(session.manifest);
  const bytes = await pack(session), files = unzipSync(bytes), packed: Manifest = JSON.parse(strFromU8(files['document.json']));
  for (const [key, path] of Object.entries(packed.chunks)) {
    assert.deepEqual(files[path], new Uint8Array(await io.readBinary(before.chunks[key])));
  }
  for (const [id, snapshot] of Object.entries(snapshots)) assert.deepEqual(files[packed.assets[id].path], snapshot);
  assert.deepEqual(session.manifest, before);

  const existing = new Map(io.files), progress: [number, number][] = [];
  const restored = await unpack(io, bytes, 'restored-mixed.inknote', (current, total) => progress.push([current, total]));
  const resourceCount = chunks.size + Object.keys(snapshots).length;
  assert.deepEqual(progress, Array.from({ length: resourceCount }, (_, i) => [i + 1, resourceCount]));
  assert.deepEqual(restored.pages, before.pages);
  assert.deepEqual(restored.regions, before.regions);
  assert.deepEqual(Object.keys(restored.chunks), [...chunks.keys()]);
  const shared: string[] = [], editable = new Map<string, string>();
  for (const [key, elements] of chunks) {
    const actual: Element[] = JSON.parse(await io.read(restored.chunks[key]));
    for (const element of actual) {
      const ref = element.customData?.pageinkText;
      if (!ref) continue;
      assert.ok(ref.path.startsWith(`${restored.resourceDir}/restored/`));
      assert.ok(ref.path.endsWith('.md'));
      assert.notEqual(ref.path, restored.assets[ref.snapshotAsset].path);
      if (editable.has(ref.snapshotAsset)) assert.equal(ref.path, editable.get(ref.snapshotAsset));
      else editable.set(ref.snapshotAsset, ref.path);
      assert.deepEqual(new Uint8Array(await io.readBinary(ref.path)), snapshots[ref.snapshotAsset]);
    }
    const expected = structuredClone(elements);
    for (const element of expected) {
      const ref = element.customData?.pageinkText;
      if (ref) ref.path = editable.get(ref.snapshotAsset);
      const source = element.customData?.source;
      if (source?.document === before.id) source.document = restored.id;
    }
    assert.deepEqual(actual, expected); // Includes IDs, block IDs, raw ink samples, anchors and other metadata.
    for (const element of actual) if (element.customData?.pageinkText?.snapshotAsset === 'snapshot-v1') shared.push(element.customData.pageinkText.path);
  }
  assert.equal(shared.length, 4);
  assert.deepEqual([...new Set(shared)], [editable.get('snapshot-v1')]);
  assert.equal(new Set(editable.values()).size, 2);
  for (const [id, snapshot] of Object.entries(snapshots)) {
    const asset = restored.assets[id];
    assert.ok(asset.path.startsWith(`${restored.resourceDir}/restored/`));
    assert.ok(asset.path.endsWith('.bin'));
    assert.equal(asset.mimeType, 'text/markdown');
    assert.equal(asset.created, before.assets[id].created);
    assert.deepEqual(new Uint8Array(await io.readBinary(asset.path)), snapshot);
  }
  for (const [path, data] of existing) assert.deepEqual(io.files.get(path), data, `existing file changed: ${path}`);
});

test('two snapshot versions stay immutable when restored Markdown is edited and projections are repacked unchanged', async () => {
  const { store, snapshots } = await mixedNotebook(), target = new Memory();
  const first = await unpack(target, await pack(new Session(store)), 'first.inknote');
  const open = await DocumentStore.open(target, 'first.inknote');
  const body = (await open.readSurface(first.pages[0].id))[0];
  const scratch = (await open.readSurface('scratch')).find(e => e.id === 'second-version')!;
  assert.equal(body.customData!.pageinkText.blockId, scratch.customData!.pageinkText.blockId);
  assert.notEqual(body.customData!.pageinkText.path, scratch.customData!.pageinkText.path);
  const editable = [body, scratch].map(element => element.customData!.pageinkText);
  assert.notEqual(first.assets['snapshot-v1'].path, first.assets['snapshot-v2'].path);
  for (const ref of editable) {
    assert.ok(ref.path.endsWith('.md'));
    assert.notEqual(ref.path, first.assets[ref.snapshotAsset].path);
    assert.deepEqual(new Uint8Array(await target.readBinary(ref.path)), snapshots[ref.snapshotAsset]);
    // Simulate native source editing without updating the saved text projection or its snapshot asset.
    await target.write(ref.path, `已编辑 ${ref.snapshotAsset}，尚未刷新投影。 ^block-1\n`);
    assert.deepEqual(new Uint8Array(await target.readBinary(first.assets[ref.snapshotAsset].path)), snapshots[ref.snapshotAsset]);
  }
  const repacked = await pack(new Session(open)), files = unzipSync(repacked);
  const packed: Manifest = JSON.parse(strFromU8(files['document.json']));
  for (const [id, snapshot] of Object.entries(snapshots)) assert.deepEqual(files[packed.assets[id].path], snapshot);
  for (const [key, path] of Object.entries(packed.chunks)) {
    assert.deepEqual(files[path], new Uint8Array(await target.readBinary(first.chunks[key])));
  }
  const again = new Memory(), second = await unpack(again, repacked, 'second.inknote');
  assert.notEqual(second.resourceDir, first.resourceDir);
  assert.notEqual(second.assets['snapshot-v1'].path, first.assets['snapshot-v1'].path);
  for (const [id, snapshot] of Object.entries(snapshots)) assert.deepEqual(new Uint8Array(await again.readBinary(second.assets[id].path)), snapshot);
  const reopened = await DocumentStore.open(again, 'second.inknote');
  const restoredScratch = await reopened.readSurface('scratch');
  for (const element of restoredScratch) {
    const ref = element.customData?.pageinkText;
    if (!ref) continue;
    assert.notEqual(ref.path, second.assets[ref.snapshotAsset].path);
    assert.deepEqual(new Uint8Array(await again.readBinary(ref.path)), snapshots[ref.snapshotAsset]);
    assert.equal((element as Extract<Element, { type: 'text' }>).text, '投影段落');
  }
  assert.equal(restoredScratch[0].customData!.source.document, second.id);
  // An editable source is never a fallback for a missing immutable snapshot.
  await target.remove(first.assets['snapshot-v1'].path);
  await assert.rejects(pack(new Session(open)), /missing/);
});

test('pack reads immutable snapshots after the external source is deleted, including unreferenced originals', async () => {
  const { io, store, snapshots } = await mixedNotebook();
  await io.remove(originalPath);
  const reads: string[] = [], read = io.readBinary.bind(io);
  io.readBinary = async path => { reads.push(path); return read(path); };
  const target = new Memory(), restored = await unpack(target, await pack(new Session(store)), 'offline.inknote');
  assert.ok(!reads.includes(originalPath));
  for (const [id, snapshot] of Object.entries(snapshots)) {
    assert.equal(reads.filter(path => path === store.manifest.assets[id].path).length, 1);
    assert.deepEqual(new Uint8Array(await target.readBinary(restored.assets[id].path)), snapshot);
  }
});

test('pack and unpack reject malformed text references and missing or invalid snapshots, including in scratch', async t => {
  type Mutation = (m: Manifest, element: Element, files: Record<string, Uint8Array>) => void;
  const ref = (patch: Record<string, unknown>): Mutation => (_m, element) => {
    Object.assign(element.customData!.pageinkText, patch);
  };
  const cases: { name: string; mutate: Mutation; error: RegExp }[] = [
    ...[null, [], 'invalid'].map(value => ({ name: `non-object reference ${JSON.stringify(value)}`,
      mutate: ((_m, element) => { element.customData!.pageinkText = value; }) as Mutation, error: /文字引用损坏/ })),
    ...[
      { version: 2 }, { version: '1' }, { path: 3 }, { blockId: '' }, { blockId: '^block-1' },
      { blockId: 'invalid block' }, { snapshotAsset: '' }, { snapshotAsset: 123 },
      { width: 0 }, { width: -1 }, { width: '300' }, { width: null },
    ].map(patch => ({ name: `invalid field ${JSON.stringify(patch)}`, mutate: ref(patch), error: /文字引用损坏/ })),
    ...['path', 'blockId', 'snapshotAsset', 'width', 'version'].map(field => ({ name: `missing ${field}`,
      mutate: ((_m, element) => { delete element.customData!.pageinkText[field]; }) as Mutation, error: /文字引用损坏/ })),
    ...['../escape.md', '/absolute.md', 'Notes\\escape.md', 'Notes/../escape.md', 'Notes/unsafe\u0000.md'].map(path => ({
      name: `unsafe source path ${JSON.stringify(path)}`, mutate: ref({ path }), error: /不安全/,
    })),
    { name: 'reference attached to non-text element', mutate: (_m, element) => { Object.assign(element, { type: 'freedraw' }); }, error: /文字引用损坏/ },
    { name: 'snapshot absent from manifest', mutate: m => { delete m.assets['snapshot-v1']; }, error: /缺少快照/ },
    { name: 'inherited asset name is not a snapshot', mutate: ref({ snapshotAsset: 'toString' }), error: /缺少快照/ },
    { name: 'snapshot bytes absent', mutate: (m, _element, files) => { delete files[m.assets['snapshot-v1'].path]; }, error: /missing|缺少资源/ },
    { name: 'unreferenced snapshot bytes absent', mutate: (m, _element, files) => { delete files[m.assets['unreferenced-snapshot'].path]; }, error: /missing|缺少资源/ },
    { name: 'snapshot has wrong MIME', mutate: m => { m.assets['snapshot-v1'].mimeType = 'image/png'; }, error: /MIME/ },
    { name: 'snapshot has no MIME', mutate: m => { Reflect.deleteProperty(m.assets['snapshot-v1'], 'mimeType'); }, error: /MIME/ },
    { name: 'unsafe snapshot path', mutate: m => { m.assets['snapshot-v1'].path = '../snapshot.md'; }, error: /不安全/ },
    { name: 'snapshot aliases a chunk', mutate: m => { m.assets['snapshot-v1'].path = m.chunks['scratch/000000']; }, error: /不能同时/ },
    { name: 'snapshot aliases a PDF', mutate: m => { m.pdf = { path: m.assets['snapshot-v1'].path, sha256: '', size: 0 }; }, error: /不能同时/ },
  ];
  const valid = await mixedNotebook(), archive = await pack(new Session(valid.store));
  for (const { name, mutate, error } of cases) await t.test(name, async () => {
    const source = await mixedNotebook(), m = source.store.manifest, sourceFiles = Object.fromEntries(source.io.files);
    const chunkPath = m.chunks['scratch/000000'], chunk: Element[] = JSON.parse(strFromU8(sourceFiles[chunkPath]));
    mutate(m, chunk[0], sourceFiles);
    sourceFiles[chunkPath] = strToU8(JSON.stringify(chunk));
    source.io.files = new Map(Object.entries(sourceFiles));
    const before = new Map(source.io.files);
    await assert.rejects(pack(new Session(source.store)), error);
    assert.deepEqual(source.io.files, before);

    const files = unzipSync(archive), packed: Manifest = JSON.parse(strFromU8(files['document.json']));
    const packedPath = packed.chunks['scratch/000000'], packedChunk: Element[] = JSON.parse(strFromU8(files[packedPath]));
    mutate(packed, packedChunk[0], files);
    files[packedPath] = strToU8(JSON.stringify(packedChunk));
    files['document.json'] = strToU8(JSON.stringify(packed));
    const target = new Memory();
    await target.write(originalPath, 'existing source must survive');
    const existing = new Map(target.files);
    await assert.rejects(unpack(target, zipSync(files), 'invalid.inknote'), error);
    assert.deepEqual(target.files, existing);
    assert.equal(target.dirs.size, 0);
  });
});

test('mixed restore cancellation and partial write failures clean both snapshots and editable copies', async t => {
  const { store, snapshots } = await mixedNotebook(), archive = await pack(new Session(store)), originalArchive = archive.slice();
  for (const failure of ['cancel-snapshot', 'cancel-markdown', 'cancel-entry', 'fail-snapshot', 'fail-markdown', 'fail-entry']) await t.test(failure, async () => {
    const target = new Memory(), controller = new AbortController();
    await target.write(originalPath, 'existing source');
    const existing = new Map(target.files), writeBinary = target.writeBinary.bind(target), write = target.write.bind(target);
    const writes = { snapshot: 0, markdown: 0 };
    target.writeBinary = async (path, bytes) => {
      const data = new Uint8Array(bytes);
      const type = path.endsWith('.md') ? 'markdown' :
        Object.values(snapshots).some(snapshot => snapshot.length === data.length && snapshot.every((byte, i) => byte === data[i])) ? 'snapshot' : undefined;
      if (type && ++writes[type] === 2) {
        if (failure === `fail-${type}`) {
          await writeBinary(path, bytes.slice(0, 3));
          throw Error(`injected ${type} failure`);
        }
        if (failure === `cancel-${type}`) controller.abort();
      }
      await writeBinary(path, bytes);
    };
    target.write = async (path, text) => {
      assert.equal(writes.snapshot, Object.keys(snapshots).length);
      assert.equal(writes.markdown, Object.keys(snapshots).length);
      await write(path, failure === 'fail-entry' ? '{' : text);
      if (failure === 'fail-entry') throw Error('injected entry failure');
      if (failure === 'cancel-entry') controller.abort();
    };
    await assert.rejects(unpack(target, archive, 'interrupted.inknote', undefined, controller.signal),
      failure.startsWith('cancel') ? { name: 'AbortError' } : /injected/);
    assert.ok(writes.snapshot >= 2);
    assert.ok(writes.markdown >= 1);
    assert.deepEqual(target.files, existing);
    assert.deepEqual(archive, originalArchive);
  });
  const retry = new Memory(), restored = await unpack(retry, archive, 'retry.inknote');
  for (const [id, snapshot] of Object.entries(snapshots)) assert.deepEqual(new Uint8Array(await retry.readBinary(restored.assets[id].path)), snapshot);
});

test('restore keeps a source file that appears at a snapshot destination and removes only its own writes', async () => {
  const { store } = await mixedNotebook(), target = new Memory(), exists = target.exists.bind(target);
  const externalBytes = strToU8('arrived during restoration ^block-1\n');
  let occupied = '';
  target.exists = async path => {
    if (!occupied && path.endsWith('.md')) { occupied = path; target.files.set(path, externalBytes); }
    return exists(path);
  };
  await assert.rejects(unpack(target, await pack(new Session(store)), 'collision.inknote'), /恢复资源已存在/);
  assert.ok(occupied.endsWith('.md'));
  assert.deepEqual(target.files, new Map([[occupied, externalBytes]]));
});

test('failed snapshot cleanup identifies retained files and leaves the archive recoverable', async () => {
  const { store } = await mixedNotebook(), archive = await pack(new Session(store)), target = new Memory();
  const controller = new AbortController(), writeBinary = target.writeBinary.bind(target), remove = target.remove.bind(target);
  let retained = '';
  target.writeBinary = async (path, bytes) => {
    await writeBinary(path, bytes);
    if (path.endsWith('.md')) { retained = path; controller.abort(); }
  };
  target.remove = async path => { if (path === retained) throw Error('injected cleanup failure'); await remove(path); };
  await assert.rejects(unpack(target, archive, 'cleanup.inknote', undefined, controller.signal), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /未能清理/);
    assert.ok(retained && error.message.includes(retained));
    return true;
  });
  assert.deepEqual([...target.files.keys()], [retained]);
  await unpack(new Memory(), archive, 'recovered.inknote');
});

test('board package preserves full nested ink source, raw samples and linked-card bindings through a second restore', async () => {
  const original = await mixedNotebook(), raw = await pack(new Session(original.store));
  const io = new Memory(), m = newManifest('board', 'canvas');
  await io.writeBinary('source.bin', toArrayBuffer(raw)); await io.writeBinary('preview.bin', new Uint8Array([0, 1, 2]).buffer);
  m.assets.pack = { path: 'source.bin', mimeType: 'application/x-pageink', created: 1 };
  m.assets.preview = { path: 'preview.bin', mimeType: 'image/png', created: 1 };
  const card = { id: 'ink-card', type: 'image', version: 1, fileId: 'preview', customData: { pageinkCard: {
    version: 1, kind: 'ink', document: original.store.manifest.id, page: original.store.manifest.pages[1].id, region: 'region', path: 'mixed.inknote', title: '摘录', archiveAsset: 'pack',
  } } } as unknown as Element;
  const store = new DocumentStore(io, 'board.inknote', m); await store.commit(new Map([[m.pages[0].id + '/000000', [card]]]));
  const clean = new Memory(), restored = await unpack(clean, await pack(new Session(store)), 'board-restored.inknote');
  const preserved = new Uint8Array(await clean.readBinary(restored.assets.pack.path)); assert.deepEqual(preserved, raw);
  const source = await unpack(clean, preserved, 'source-restored.inknote');
  const reopened = await DocumentStore.open(clean, 'source-restored.inknote');
  const ink = (await reopened.readSurface(source.pages[0].id)).find(e => e.id === 'raw-ink')!;
  const before = original.chunks.get(original.store.manifest.pages[0].id + '/000000')!.find(e => e.id === 'raw-ink')!;
  for (const key of ['points', 'pressures', 'lastCommittedPoint', 'angle']) assert.deepEqual((ink as any)[key], (before as any)[key]);
  const broken = unzipSync(await pack(new Session(store))), manifest = JSON.parse(strFromU8(broken['document.json'])); delete broken[manifest.assets.pack.path];
  await assert.rejects(unpack(new Memory(), zipSync(broken), 'broken-card.inknote'), /缺少资源/);
});

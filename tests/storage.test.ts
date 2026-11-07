import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentStore, FileIO, SurfaceBlocks, Conflict, MissingDependency, forkDocument } from '../src/storage';
import { newManifest, Element } from '../src/model';
class Memory implements FileIO {
  files = new Map<string, string>(); dirs = new Set<string>(); fail = ''; truncate = false;
  async read(p: string) { if (!this.files.has(p)) throw Error('missing'); return this.files.get(p)!; }
  async write(p: string, d: string) { if (p === this.fail) { if (this.truncate) this.files.set(p, '{'); throw Error('disk full'); } this.files.set(p, d); }
  async exists(p: string) { return this.files.has(p) || this.dirs.has(p); }
  async mkdir(p: string) { this.dirs.add(p); }
  async remove(p: string) { this.files.delete(p); }
  async list(p: string) { return [...this.files.keys()].filter(x => x.startsWith(p + '/')); }
  async readBinary(p: string) { return new TextEncoder().encode(await this.read(p)).buffer as ArrayBuffer; }
  async writeBinary(p: string, bytes: ArrayBuffer) { await this.write(p, new TextDecoder().decode(bytes)); }
}
const e = (id: string, version = 1) => ({ id, version, type: 'freedraw' }) as Element;
test('failed entry publication leaves previous document readable; retry commits dependencies', async () => {
  const io = new Memory(), m = newManifest('Test', 'pages');
  const store = new DocumentStore(io, 'test.inknote', m);
  await store.commit(new Map([['p/000000', [e('a')]]]));
  const previous = await io.read(store.path); io.fail = store.path;
  await assert.rejects(store.commit(new Map([['p/000000', [e('b')]]])), /disk full/);
  assert.equal(await io.read(store.path), previous);
  assert.equal((await store.readSurface('p'))[0].id, 'a');
  io.fail = ''; await store.commit(new Map([['p/000000', [e('b')]]]));
  assert.equal((await (await DocumentStore.open(io, store.path)).readSurface('p'))[0].id, 'b');
});
test('external modification preserves both remote and local contents', async () => {
  const io = new Memory(), store = new DocumentStore(io, 'test.inknote', newManifest('Test', 'pages'));
  await store.commit(new Map()); const remote = { ...store.manifest, revision: 'remote' };
  await io.write(store.path, JSON.stringify(remote));
  await assert.rejects(store.commit(new Map([['p/000000', [e('local')]]])), (err: unknown) => {
    assert.ok(err instanceof Conflict); assert.ok(io.files.has(err.copyPath)); return true;
  });
  assert.equal(JSON.parse(await io.read(store.path)).revision, 'remote');
  const copy = [...io.files.keys()].find(path => path.includes(' conflict ') && path.endsWith('.inknote'))!;
  assert.equal((await (await DocumentStore.open(io, copy)).readSurface('p'))[0].id, 'local');
});
test('missing synchronized chunks do not become empty surfaces', async () => {
  const io = new Memory(), m = newManifest('Test', 'pages'); m.chunks['p/000000'] = 'missing.json';
  m.chunks['p/000001'] = 'later.json';
  const store = new DocumentStore(io, 'x', m);
  await assert.rejects(store.readSurface('p'), MissingDependency);
  await io.write('later.json', JSON.stringify([e('second')]));
  await assert.rejects(store.readSurface('p'), MissingDependency);
  await io.write('missing.json', JSON.stringify([e('first')]));
  assert.deepEqual((await store.readSurface('p')).map(element => element.id), ['first', 'second']);
});
test('one edited element only serializes its block and truncation publishes empty tail', () => {
  const tracker = new SurfaceBlocks('p'); const elements = Array.from({length: 50000}, (_, i) => e(String(i)));
  tracker.reset(elements); const next = elements.slice(); next[777] = e('777', 2);
  const dirty = tracker.changes(next); assert.equal(dirty.size, 1); assert.equal([...dirty.values()][0].length, 256);
  const removed = tracker.changes(next.slice(0, 10)); assert.equal(removed.get('p/000195')?.length, 0);
});
test('truncated entry publication leaves a readable last-good manifest for separate recovery', async () => {
  const io = new Memory(), store = new DocumentStore(io, 'test.inknote', newManifest('Test','pages'));
  await store.commit(new Map([['p/000000',[e('saved')]]]));
  io.fail = store.path; io.truncate = true;
  await assert.rejects(store.commit(new Map([['p/000000',[e('new')]]])), /disk full/);
  const backup = JSON.parse(await io.read('test.inknote.last-good.json'));
  await forkDocument(io, backup, 'recovered.inknote');
  assert.equal((await (await DocumentStore.open(io,'recovered.inknote')).readSurface('p'))[0].id,'saved');
  assert.equal(await io.read('test.inknote'),'{');
});
test('recovery retention is bounded and keeps each retained snapshot dependency', async () => {
  const io = new Memory(), store = new DocumentStore(io,'retention.inknote',newManifest('Retention','pages'));
  for(let i=0;i<25;i++) await store.commit(new Map([['p/000000',[e(String(i))]]]));
  const records=await store.recoveryRecords();assert.equal(records.length,20);
  for(const record of records) for(const path of Object.values(record.manifest.chunks)) assert.ok(await io.exists(path));
  assert.equal((await io.list(`${store.manifest.resourceDir}/revisions`)).length,40);
});

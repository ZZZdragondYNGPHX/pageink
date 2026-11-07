import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pack, unpack } from '../src/archive';
import { Session } from '../src/session';
import { DocumentStore, FileIO } from '../src/storage';
import { newManifest, Element, digest } from '../src/model';
import { zipSync, strToU8 } from 'fflate';
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

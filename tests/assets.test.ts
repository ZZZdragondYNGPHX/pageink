import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'fflate';
import { AssetStore } from '../src/asset-store';

function store() {
  const bytes = new TextEncoder().encode('PageInk 中文资源');
  return { bytes, assets: new AssetStore({ 'fonts/test.otf': [Buffer.from(deflateSync(bytes)).toString('base64'), bytes.length, 'font/otf'] }) };
}
test('worker transfers cannot detach or modify the next embedded asset read', () => {
  const { bytes, assets } = store(), first = assets.bytes('fonts/test.otf');
  structuredClone(first, { transfer: [first.buffer] });
  assert.equal(first.byteLength, 0);
  assert.deepEqual(assets.bytes('fonts/test.otf'), bytes);
  assert.throws(() => assets.bytes('../missing'), /缺少随包资源/);
});
test('asset URLs are reused until unload, revoked on unload, and recreated when needed', async () => {
  const { bytes, assets } = store(), url = assets.url('./fonts/test.otf');
  assert.equal(assets.url('fonts/test.otf'), url);
  assert.deepEqual(new Uint8Array(await (await fetch(url)).arrayBuffer()), bytes);
  assets.dispose();
  await assert.rejects(fetch(url));
  const reloaded = assets.url('fonts/test.otf');
  assert.notEqual(reloaded, url);
  assert.equal((await fetch(reloaded)).headers.get('content-type'), 'font/otf');
  assets.dispose();
});

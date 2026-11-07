import { zip, unzip, strToU8, strFromU8 } from 'fflate';
import type { Session } from './session';
import { Manifest, parseManifest, safePath, uid, digest, retargetInternalSources, toArrayBuffer } from './model';
import { FileIO, ensureDir } from './storage';

export async function pack(session: Session, onProgress: (current: number, total: number) => void = () => {}, signal?: AbortSignal): Promise<Uint8Array> {
  await session.flush();
  const m = structuredClone(session.manifest), files: Record<string, Uint8Array> = {};
  const paths = new Set([...Object.values(m.chunks), ...Object.values(m.assets).map(a => a.path), ...(m.pdf ? [m.pdf.path] : [])]);
  const mapping = new Map<string, string>(); let i = 0;
  for (const path of paths) {
    signal?.throwIfAborted();
    const target = `resources/${String(i++).padStart(6, '0')}`;
    mapping.set(path, target); files[target] = new Uint8Array(await session.store.io.readBinary(path));
    if (path === m.pdf?.path && await digest(toArrayBuffer(files[target])) !== m.pdf.sha256) throw Error('源 PDF 内容已变化，未生成身份不一致的完整打包。请先重新关联同一原件。');
    onProgress(i, paths.size);
  }
  m.chunks = Object.fromEntries(Object.entries(m.chunks).map(([key, path]) => [key, mapping.get(path)!]));
  for (const asset of Object.values(m.assets)) asset.path = mapping.get(asset.path)!;
  if (m.pdf) m.pdf.path = mapping.get(m.pdf.path)!;
  files['document.json'] = strToU8(JSON.stringify(m));
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const terminate = zip(files, { level: 6 }, (err, data) => { signal?.removeEventListener('abort', abort); err ? reject(err) : resolve(data); });
    const abort = () => { terminate(); reject(new DOMException('打包已取消', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export async function unpack(io: FileIO, bytes: Uint8Array, entryPath: string, onProgress: (current: number, total: number) => void = () => {}, signal?: AbortSignal): Promise<Manifest> {
  signal?.throwIfAborted();
  safePath(entryPath);
  if (await io.exists(entryPath)) throw Error('恢复目标已存在；请使用新文件名。');
  let expanded = 0;
  const files: Record<string, Uint8Array> = await new Promise((resolve, reject) => {
    const terminate = unzip(bytes, { filter: file => {
    safePath(file.name); expanded += file.originalSize;
    if (expanded > 2_000_000_000) throw Error('打包解压超过 2 GB 内存保护预算；未恢复或省略任何资源。');
    return true;
    } }, (err, data) => { signal?.removeEventListener('abort', abort); err ? reject(err) : resolve(data); });
    const abort = () => { terminate(); reject(new DOMException('恢复已取消', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
  signal?.throwIfAborted();
  for (const path of Object.keys(files)) safePath(path);
  if (!files['document.json']) throw Error('打包缺少 document.json。');
  const m = parseManifest(strFromU8(files['document.json']));
  const previousId = m.id, chunks = new Set(Object.values(m.chunks));
  m.id = uid(); m.revision = uid(); m.parent = null; m.resourceDir = `Drawing Resources/${m.id}`;
  const paths = new Set([...Object.values(m.chunks), ...Object.values(m.assets).map(a => a.path), ...(m.pdf ? [m.pdf.path] : [])]);
  for (const path of paths) if (!Object.hasOwn(files,path) || !(files[path] instanceof Uint8Array)) throw Error(`打包缺少资源：${path}`);
  for (const path of Object.values(m.chunks)) if (!Array.isArray(JSON.parse(strFromU8(files[path])))) throw Error(`打包数据块损坏：${path}`);
  if (m.pdf && await digest(toArrayBuffer(files[m.pdf.path])) !== m.pdf.sha256) throw Error('打包中的 PDF 与记录的原件身份不一致。');
  await ensureDir(io, `${m.resourceDir}/restored`);
  const mapping = new Map<string, string>(), written: string[] = []; let index = 0;
  try { for (const path of paths) {
    signal?.throwIfAborted();
    const target = `${m.resourceDir}/restored/${index++}${path === m.pdf?.path ? '.pdf' : '.bin'}`; mapping.set(path, target);
    const data = chunks.has(path) ? strToU8(JSON.stringify(retargetInternalSources(JSON.parse(strFromU8(files[path])), previousId, m.id))) : files[path];
    written.push(target); // Include a partially written resource if the adapter throws.
    await io.writeBinary(target, toArrayBuffer(data));
    onProgress(index, paths.size);
  }
  signal?.throwIfAborted();
  m.chunks = Object.fromEntries(Object.entries(m.chunks).map(([key, path]) => [key, mapping.get(path)!]));
  for (const asset of Object.values(m.assets)) asset.path = mapping.get(asset.path)!;
  if (m.pdf) m.pdf.path = mapping.get(m.pdf.path)!;
  if (await io.exists(entryPath)) throw Error('恢复期间目标文件已出现；请使用新文件名。');
  written.push(entryPath);
  await io.write(entryPath, JSON.stringify(m, null, 2)); return m;
  } catch (error) {
    const failed: string[] = [];
    for (const path of written.reverse()) try { if (await io.exists(path)) await io.remove(path); } catch { failed.push(path); }
    if (failed.length) throw new Error(`${(error as Error).message}；未能清理本次恢复的文件：${failed.join('、')}。原打包未修改。`);
    throw error;
  }
}

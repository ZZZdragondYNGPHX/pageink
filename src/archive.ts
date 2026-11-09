import { zip, unzip, strToU8, strFromU8 } from 'fflate';
import type { Session } from './session';
import { Manifest, Element, parseManifest, safePath, uid, digest, retargetInternalSources, toArrayBuffer } from './model';
import type { TextReference } from './mixed';
import { validateCards } from './cards';
import { FileIO, ensureDir } from './storage';

function archiveResources(m: Manifest) {
  const chunks = new Set(Object.values(m.chunks));
  const markdown = new Set(Object.values(m.assets).filter(a => a.mimeType === 'text/markdown').map(a => a.path));
  const paths = new Set([...chunks, ...Object.values(m.assets).map(a => a.path), ...(m.pdf ? [m.pdf.path] : [])]);
  for (const path of paths) safePath(path);
  // A snapshot must stay byte-for-byte intact, even if an archive aliases resource paths.
  for (const path of markdown) if (chunks.has(path) || path === m.pdf?.path) throw Error(`Markdown 快照不能同时用作数据块或 PDF：${path}`);
  return { paths, chunks, markdown };
}

function readChunk(bytes: Uint8Array, path: string, m: Manifest): Element[] {
  const elements: Element[] = JSON.parse(strFromU8(bytes));
  if (!Array.isArray(elements)) throw Error(`打包数据块损坏：${path}`);
  for (const element of elements) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) throw Error(`打包数据块损坏：${path}`);
    if (!element.customData || !Object.hasOwn(element.customData, 'pageinkText')) continue;
    const ref = element.customData.pageinkText;
    if (element.type !== 'text' || !ref || typeof ref !== 'object' || Array.isArray(ref) || ref.version !== 1 ||
      typeof ref.path !== 'string' || typeof ref.blockId !== 'string' || !/^[A-Za-z0-9-]+$/.test(ref.blockId) ||
      typeof ref.snapshotAsset !== 'string' || !ref.snapshotAsset || !Number.isFinite(ref.width) || ref.width <= 0) {
      throw Error(`打包文字引用损坏：${path}（${element.id}）`);
    }
    safePath(ref.path);
    const asset = Object.hasOwn(m.assets, ref.snapshotAsset) ? m.assets[ref.snapshotAsset] : undefined;
    if (!asset) throw Error(`文字引用缺少快照资源：${ref.snapshotAsset}`);
    if (asset.mimeType !== 'text/markdown') throw Error(`文字快照 MIME 必须是 text/markdown：${ref.snapshotAsset}`);
  }
  validateCards(elements, m);
  return elements;
}

function restoreChunk(bytes: Uint8Array, previousId: string, m: Manifest, editable: ReadonlyMap<string, string>): Uint8Array {
  const elements = retargetInternalSources(JSON.parse(strFromU8(bytes)), previousId, m.id);
  return strToU8(JSON.stringify(elements.map(element => {
    const ref: TextReference | undefined = element.customData?.pageinkText;
    if (!ref) return element;
    return { ...element, customData: { ...element.customData, pageinkText: {
      ...ref, path: editable.get(m.assets[ref.snapshotAsset].path)!,
    } } };
  })));
}

export async function pack(session: Session, onProgress: (current: number, total: number) => void = () => {}, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  await session.flush();
  const m = structuredClone(session.manifest), files: Record<string, Uint8Array> = {};
  const { paths, chunks } = archiveResources(m);
  const mapping = new Map<string, string>(); let i = 0;
  for (const path of paths) {
    signal?.throwIfAborted();
    const target = `resources/${String(i++).padStart(6, '0')}`;
    mapping.set(path, target); files[target] = new Uint8Array(await session.store.io.readBinary(path));
    if (chunks.has(path)) readChunk(files[target], path, m);
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
  const previousId = m.id;
  const { paths, chunks, markdown } = archiveResources(m);
  m.id = uid(); m.revision = uid(); m.parent = null; m.resourceDir = `Drawing Resources/${m.id}`;
  for (const path of paths) if (!Object.hasOwn(files,path) || !(files[path] instanceof Uint8Array)) throw Error(`打包缺少资源：${path}`);
  for (const path of chunks) readChunk(files[path], path, m);
  if (m.pdf && await digest(toArrayBuffer(files[m.pdf.path])) !== m.pdf.sha256) throw Error('打包中的 PDF 与记录的原件身份不一致。');
  if (await io.exists(m.resourceDir)) throw Error('恢复资源目录已存在；请重试以使用新目录。');
  signal?.throwIfAborted();
  await ensureDir(io, `${m.resourceDir}/restored`);
  const mapping = new Map<string, string>(), editable = new Map<string, string>(), written: string[] = []; let index = 0;
  // Chunks precede assets in the archive, so resolve every destination before rewriting references.
  for (const path of paths) {
    const base = `${m.resourceDir}/restored/${mapping.size}`;
    mapping.set(path, `${base}${path === m.pdf?.path ? '.pdf' : '.bin'}`);
    // Native Markdown editing must never mutate the snapshot used by the saved projection.
    if (markdown.has(path)) editable.set(path, `${base}.md`);
  }
  try { for (const path of paths) {
    const data = chunks.has(path) ? restoreChunk(files[path], previousId, m, editable) : files[path];
    const targets = [mapping.get(path)!];
    if (editable.has(path)) targets.push(editable.get(path)!);
    for (const target of targets) {
      signal?.throwIfAborted();
      if (await io.exists(target)) throw Error(`恢复资源已存在：${target}`);
      written.push(target); // Include either partially written copy if the adapter throws.
      await io.writeBinary(target, toArrayBuffer(data));
    }
    onProgress(++index, paths.size);
  }
  signal?.throwIfAborted();
  m.chunks = Object.fromEntries(Object.entries(m.chunks).map(([key, path]) => [key, mapping.get(path)!]));
  for (const asset of Object.values(m.assets)) asset.path = mapping.get(asset.path)!;
  if (m.pdf) m.pdf.path = mapping.get(m.pdf.path)!;
  if (await io.exists(entryPath)) throw Error('恢复期间目标文件已出现；请使用新文件名。');
  signal?.throwIfAborted();
  written.push(entryPath);
  await io.write(entryPath, JSON.stringify(m, null, 2));
  signal?.throwIfAborted(); return m;
  } catch (error) {
    const failed: string[] = [];
    for (const path of written.reverse()) try { if (await io.exists(path)) await io.remove(path); } catch { failed.push(path); }
    if (failed.length) throw new Error(`${(error as Error).message}；未能清理本次恢复的文件：${failed.join('、')}。原打包未修改。`);
    throw error;
  }
}

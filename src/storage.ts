import { Manifest, Element, parseManifest, uid, retargetInternalSources, safePath } from './model';

/** Vault-compatible I/O. Entry publication happens only after immutable dependencies exist. */
export interface FileIO {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, bytes: ArrayBuffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<string[]>;
}
export class MissingDependency extends Error {}
export class Conflict extends Error {
  constructor(public copyPath: string) { super(`检测到外部修改；本地内容已保存为冲突副本：${copyPath}`); }
}
export async function ensureDir(io: FileIO, path: string): Promise<void> {
  const parts = path.split('/');
  for (let n = 1; n <= parts.length; n++) {
    const dir = parts.slice(0, n).join('/');
    if (!(await io.exists(dir))) await io.mkdir(dir);
  }
}
export class DocumentStore {
  private queue: Promise<unknown> = Promise.resolve();
  private recoveryCache = new Map<string, Manifest>();
  constructor(public io: FileIO, public path: string, public manifest: Manifest) {}
  static async open(io: FileIO, path: string) {
    return new DocumentStore(io, path, parseManifest(await io.read(path)));
  }
  async readSurface(id: string): Promise<Element[]> {
    const keys = Object.keys(this.manifest.chunks).filter(key => key.startsWith(`${id}/`)).sort();
    const elements: Element[] = [];
    for (const key of keys) {
      const path = this.manifest.chunks[key];
      if (!(await this.io.exists(path))) throw new MissingDependency(`等待同步资源：${path}`);
      const chunk = JSON.parse(await this.io.read(path));
      if (!Array.isArray(chunk)) throw new Error(`损坏的数据块：${path}`);
      elements.push(...chunk);
    }
    return elements;
  }
  commit(dirty: Map<string, readonly Element[]>, metadata?: Manifest): Promise<Manifest> {
    // Callers pass immutable element snapshots; concurrent edits wait behind the current publication.
    const snapshot = new Map(dirty);
    const operation = this.queue.then(() => this.publish(snapshot, metadata));
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  conflictCopy(dirty: Map<string, readonly Element[]>, metadata: Manifest): Promise<string> {
    const snapshot = new Map(dirty);
    const operation = this.queue.then(async () => {
      const next = await this.prepare(snapshot, metadata);
      const path = this.path.replace(/\.inknote$/, '') + ` conflict ${next.revision}.inknote`;
      await forkDocument(this.io, next, path); return path;
    });
    this.queue = operation.catch(() => undefined); return operation;
  }
  private async prepare(dirty: Map<string, readonly Element[]>, metadata?: Manifest): Promise<Manifest> {
    const previous = this.manifest;
    const next = structuredClone(metadata ?? previous);
    next.chunks = { ...previous.chunks };
    next.revision = uid(); next.parent = previous.revision; next.modified = Math.max(Date.now(), previous.modified + 1);
    const dir = `${next.resourceDir}/revisions`;
    await ensureDir(this.io, dir);
    for (const [key, elements] of dirty) {
      const path = `${dir}/${next.revision}-${key.replaceAll('/', '-')}.json`;
      await this.io.write(path, JSON.stringify(elements));
      next.chunks[key] = path;
    }
    // Snapshot remains independently recoverable even if entry publication is interrupted.
    await this.io.write(`${dir}/${next.revision}.manifest.json`, JSON.stringify(next));
    this.recoveryCache.set(`${dir}/${next.revision}.manifest.json`, next);
    return next;
  }
  private async publish(dirty: Map<string, readonly Element[]>, metadata?: Manifest): Promise<Manifest> {
    const previous = this.manifest, next = await this.prepare(dirty, metadata);
    if (await this.io.exists(this.path)) {
      const remote = parseManifest(await this.io.read(this.path));
      if (remote.revision !== previous.revision) {
        const copyPath = this.path.replace(/\.inknote$/, '') + ` conflict ${next.revision}.inknote`;
        await forkDocument(this.io, next, copyPath);
        throw new Conflict(copyPath);
      }
    }
    // Keep a separately readable publication record if an adapter truncates the entry
    // before throwing or the host exits during its non-atomic write.
    await this.io.write(`${this.path}.last-good.json`, JSON.stringify(previous));
    await this.io.write(this.path, JSON.stringify(next, null, 2));
    this.manifest = next;
    // Garbage collection is separate from commit success and serialized with publication.
    try { await this.pruneRecovery(); } catch (error) { this.maintenanceError = `恢复记录清理失败：${(error as Error).message}`; }
    return next;
  }
  maintenanceError = '';
  private async pruneRecovery() {
    const records = await this.recoveryRecords(), keep = records.slice(0, 20);
    const referenced = new Set(Object.values(this.manifest.chunks));
    for (const record of keep) for (const path of Object.values(record.manifest.chunks)) referenced.add(path);
    for (const record of records.slice(20)) { await this.io.remove(record.path); this.recoveryCache.delete(record.path); }
    const retainedManifests = new Set(keep.map(record => record.path));
    for (const path of await this.io.list(`${this.manifest.resourceDir}/revisions`)) {
      if (path.endsWith('.manifest.json')) { if (!retainedManifests.has(path)) await this.io.remove(path); }
      else if (!referenced.has(path)) await this.io.remove(path);
    }
  }
  async recoveryRecords(): Promise<{ path: string; manifest: Manifest }[]> {
    const dir = `${this.manifest.resourceDir}/revisions`;
    if (!(await this.io.exists(dir))) return [];
    const records = [], paths = await this.io.list(dir), present = new Set(paths);
    for (const path of this.recoveryCache.keys()) if (!present.has(path)) this.recoveryCache.delete(path);
    for (const path of paths) {
      if (path.endsWith('.manifest.json')) {
        // Revision UUID paths are immutable. Read newly arrived sync records once;
        // do not reparse 20 large manifests after every handwritten stroke.
        let manifest = this.recoveryCache.get(path);
        if (!manifest) { manifest = parseManifest(await this.io.read(path)); this.recoveryCache.set(path, manifest); }
        records.push({ path, manifest });
      }
    }
    return records.sort((a, b) => b.manifest.modified - a.manifest.modified);
  }
}
export async function forkDocument(io: FileIO, source: Manifest, path: string): Promise<Manifest> {
  safePath(path);
  if (await io.exists(path)) throw Error('另存目标已存在。');
  const next = structuredClone(source); next.id = uid(); next.revision = uid(); next.parent = null;
  next.resourceDir = `Drawing Resources/${next.id}`;
  await ensureDir(io, `${next.resourceDir}/restored`);
  const resources = new Set([...Object.values(next.chunks), ...Object.values(next.assets).map(asset => asset.path)]);
  const chunks = new Set(Object.values(next.chunks));
  const mapping = new Map<string, string>(); let index = 0;
  for (const resource of resources) {
    const target = `${next.resourceDir}/restored/${index++}.bin`;
    if (chunks.has(resource)) await io.write(target, JSON.stringify(retargetInternalSources(JSON.parse(await io.read(resource)), source.id, next.id)));
    else await io.writeBinary(target, await io.readBinary(resource));
    mapping.set(resource, target);
  }
  next.chunks = Object.fromEntries(Object.entries(next.chunks).map(([key, path]) => [key, mapping.get(path)!]));
  for (const asset of Object.values(next.assets)) asset.path = mapping.get(asset.path)!;
  await io.write(path, JSON.stringify(next, null, 2)); return next;
}

/** Stable slots bound serialization to changed 256-object blocks, preserving global order. */
export class SurfaceBlocks {
  private previous: readonly Element[] = [];
  constructor(public id: string, readonly size = 256) {}
  reset(elements: readonly Element[]) {
    this.previous = elements;
  }
  changes(elements: readonly Element[]): Map<string, readonly Element[]> {
    const dirty = new Set<number>();
    for (let i = 0; i < Math.max(elements.length, this.previous.length); i++) {
      const e = elements[i];
      if (!e || e.id !== this.previous[i]?.id || this.previous[i]?.version !== e.version) dirty.add(Math.floor(i / this.size));
    }
    const result = new Map<string, readonly Element[]>();
    for (const block of dirty) result.set(`${this.id}/${String(block).padStart(6, '0')}`, elements.slice(block * this.size, (block + 1) * this.size));
    this.reset(elements);
    return result;
  }
}

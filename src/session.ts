import { BinaryFiles } from '@excalidraw/excalidraw/types';
import { Element, Manifest, Rect, uid } from './model';
import { DocumentStore, SurfaceBlocks, ensureDir, Conflict } from './storage';
import { History } from './history';
import { snapshotElement } from './element-snapshot';

export class Session {
  surfaces = new Map<string, readonly Element[]>();
  trackers = new Map<string, SurfaceBlocks>();
  dirty = new Map<string, readonly Element[]>();
  bodyHistory = new History(); scratchHistory = new History();
  files: BinaryFiles = {};
  status = '已保存到本地';
  listeners = new Set<() => void>();
  timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private generation = 0;
  flushers = new Map<string, () => Promise<void>>();
  metadataDirty = false;
  sourceIssue = '';
  conflictPath = '';
  conflictResolved = false;
  navigation?: { page: string; region?: string; rect?: Rect; token: string };
  constructor(public store: DocumentStore, public manifest = structuredClone(store.manifest)) {}
  notify() { for (const callback of this.listeners) callback(); }
  navigate(page: string, region?: string, rect?: Rect) { this.navigation = { page, region, rect, token: uid() }; this.notify(); }
  async read(id: string) { return this.surfaces.get(id) ?? this.store.readSurface(id); }
  async flush() { await Promise.all([...this.flushers.values()].map(flush => flush())); await this.save(); }
  async load(id: string) {
    if (this.surfaces.has(id)) return this.surfaces.get(id)!;
    const elements = await this.store.readSurface(id);
    this.surfaces.set(id, elements);
    const tracker = new SurfaceBlocks(id); tracker.reset(elements); this.trackers.set(id, tracker);
    return elements;
  }
  change(id: string, elements: readonly Element[], record = true) {
    if (!this.surfaces.has(id) && Object.keys(this.manifest.chunks).some(key => key.startsWith(`${id}/`))) throw Error('编辑前必须加载该页，不能把未加载内容当作空页。');
    const previous = this.surfaces.get(id) ?? [];
    if (previous.length === elements.length && previous.every((e, i) => e.id === elements[i].id && e.version === elements[i].version)) return;
    const tracker = this.trackers.get(id) ?? new SurfaceBlocks(id);
    this.trackers.set(id, tracker);
    // Kernel elements can be mutated in place. Keep committed/history objects independent,
    // copying only changed objects rather than all sample points in the surface.
    let prior: Map<string, Element> | undefined;
    const snapshot = elements.map((e, i) => {
      let old = previous[i];
      if (old && old.id !== e.id) { prior ??= new Map(previous.map(item => [item.id, item])); old = prior.get(e.id)!; }
      return old?.id === e.id && old.version === e.version ? old : snapshotElement(e);
    });
    const changes = tracker.changes(snapshot);
    if (!changes.size) return;
    if (record) (id === 'scratch' ? this.scratchHistory : this.bodyHistory).push(id, previous, snapshot);
    this.surfaces.set(id, snapshot);
    for (const [key, value] of changes) this.dirty.set(key, value);
    this.schedule();
  }
  metadataChanged() { this.metadataDirty = true; this.schedule(); }
  editLayout(edit: () => void) {
    const before = structuredClone({ pages: this.manifest.pages, regions: this.manifest.regions });
    edit();
    const after = structuredClone({ pages: this.manifest.pages, regions: this.manifest.regions });
    this.bodyHistory.layout(before, after); this.metadataChanged();
  }
  schedule() {
    this.generation++; this.status = '待保存'; this.notify();
    clearTimeout(this.timer); this.timer = setTimeout(() => void this.save().catch(() => {}), 350);
  }
  async loadFiles(elements?: readonly Element[]) {
    const wanted = elements ? new Set(elements.filter(e => e.type === 'image').map(e => (e as any).fileId)) : null;
    for (const [id, asset] of Object.entries(this.manifest.assets)) {
      if (this.files[id] || wanted && !wanted.has(id)) continue;
      const bytes = await this.store.io.readBinary(asset.path);
      const dataURL = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject;
        reader.readAsDataURL(new Blob([bytes], { type: asset.mimeType }));
      });
      this.files[id] = { id: id as any, dataURL: dataURL as any, mimeType: asset.mimeType as any, created: asset.created };
    }
    this.pruneFiles(wanted ?? new Set(Object.keys(this.files)));
  }
  private pruneFiles(wanted = new Set<string>()) {
    for (const [surface, elements] of this.surfaces) if (surface === 'scratch' || this.flushers.has(surface)) for (const e of elements) if (e.type === 'image' && e.fileId) wanted.add(e.fileId);
    let bytes = Object.values(this.files).reduce((sum, file) => sum + file.dataURL.length * 2, 0);
    for (const [id, file] of Object.entries(this.files)) {
      if (bytes <= 48 * 1024 * 1024) break;
      if (!wanted.has(id)) { bytes -= file.dataURL.length * 2; delete this.files[id]; }
    }
  }
  releaseSurface(id: string) {
    if (id === 'scratch' || this.flushers.has(id) || [...this.dirty.keys()].some(key => key.startsWith(`${id}/`))) return;
    this.surfaces.delete(id); this.trackers.delete(id);
    this.pruneFiles();
  }
  async acceptFiles(files: BinaryFiles) {
    for (const [id, file] of Object.entries(files)) {
      if (this.manifest.assets[id]) continue;
      const dir = `${this.manifest.resourceDir}/assets`; await ensureDir(this.store.io, dir);
      const path = `${dir}/${uid()}.bin`;
      const response = await fetch(file.dataURL); await this.store.io.writeBinary(path, await response.arrayBuffer());
      this.manifest.assets[id] = { path, mimeType: file.mimeType, created: file.created }; this.files[id] = file;
      this.metadataChanged();
    }
  }
  async save(): Promise<void> {
    clearTimeout(this.timer);
    if (this.conflictPath) { if (this.conflictResolved) return; throw new Conflict(this.conflictPath); }
    if (this.pending) { await this.pending; if (this.dirty.size || this.metadataDirty) return this.save(); return; }
    if (!this.dirty.size && !this.metadataDirty) return;
    const batch = new Map(this.dirty), generation = this.generation;
    const metadata = structuredClone(this.manifest);
    this.status = '保存中'; this.notify();
    this.pending = (async () => {
      try {
        const next = await this.store.commit(batch, metadata);
        for (const [key, value] of batch) if (this.dirty.get(key) === value) this.dirty.delete(key);
        this.manifest.revision = next.revision; this.manifest.parent = next.parent; this.manifest.chunks = next.chunks;
        if (generation === this.generation) this.metadataDirty = false;
        this.status = this.dirty.size || this.metadataDirty ? '待保存' : '已保存到本地';
        for (const id of this.surfaces.keys()) this.releaseSurface(id);
      } catch (error) { if (error instanceof Conflict) this.conflictPath = error.copyPath; this.status = `保存失败：${(error as Error).message}`; throw error; }
      finally { this.pending = undefined; this.notify(); }
    })();
    return this.pending;
  }
  async preserveConflict() {
    await Promise.all([...this.flushers.values()].map(flush => flush()));
    clearTimeout(this.timer);
    this.conflictPath = await this.store.conflictCopy(this.dirty, structuredClone(this.manifest));
    return this.conflictPath;
  }
}

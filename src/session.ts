import { BinaryFiles } from '@excalidraw/excalidraw/types';
import { Element, Rect, uid } from './model';
import { DocumentStore, SurfaceBlocks, ensureDir, Conflict } from './storage';
import { History } from './history';
import { snapshotElement } from './element-snapshot';
import { dataUrlBytes, imageFile, readDataURL } from './binary';

export type SaveState = 'saved' | 'pending' | 'saving' | 'failed';
export const SAVE_IDLE_MS = 180000;
export const SAVE_MAX_WAIT_MS = 900000;
interface Applied { surface: string; before: readonly Element[]; after: readonly Element[] }

export class Session {
  surfaces = new Map<string, readonly Element[]>();
  trackers = new Map<string, SurfaceBlocks>();
  dirty = new Map<string, readonly Element[]>();
  bodyHistory = new History(); scratchHistory = new History();
  files: BinaryFiles = {};
  saveState: SaveState = 'saved';
  saveError = '';
  listeners = new Set<() => void>();
  timer?: number;
  private pending?: Promise<void>;
  private generation = 0;
  private dirtySince?: number;
  private writing = new Set<string>();
  /** Editors that hold unflushed kernel state, keyed by owner (e.g. body, scratch). */
  flushers = new Map<string, () => Promise<void>>();
  /** Predicates for surfaces that mounted editors keep in memory. */
  keepers = new Set<(surface: string) => boolean>();
  /** Increments whenever a surface's committed content changes (used for previews). */
  revisions = new Map<string, number>();
  metadataDirty = false;
  sourceIssue = '';
  conflictPath = '';
  conflictResolved = false;
  navigation?: { page: string; region?: string; rect?: Rect; token: string };
  constructor(public store: DocumentStore, public manifest = structuredClone(store.manifest)) {}
  get status() { return this.saveState === 'failed' ? `保存失败：${this.saveError}` : { saved: '已保存', pending: '待保存', saving: '保存中' }[this.saveState]; }
  notify() { for (const callback of this.listeners) callback(); }
  navigate(page: string, region?: string, rect?: Rect) { this.navigation = { page, region, rect, token: uid() }; this.notify(); }
  revision(surface: string) { return this.revisions.get(surface) ?? 0; }
  async read(id: string) { return this.surfaces.get(id) ?? this.store.readSurface(id); }
  async flush() { await Promise.all([...this.flushers.values()].map(flush => flush())); await this.save(); }
  async load(id: string) {
    if (this.surfaces.has(id)) return this.surfaces.get(id)!;
    const elements = await this.store.readSurface(id);
    this.surfaces.set(id, elements);
    const tracker = new SurfaceBlocks(id); tracker.reset(elements); this.trackers.set(id, tracker);
    return elements;
  }
  private apply(id: string, elements: readonly Element[]): Applied | undefined {
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
    this.surfaces.set(id, snapshot);
    this.revisions.set(id, this.revision(id) + 1);
    for (const [key, value] of changes) this.dirty.set(key, value);
    return { surface: id, before: previous, after: snapshot };
  }
  change(id: string, elements: readonly Element[], record = true) { this.changeMany(new Map([[id, elements]]), record); }
  /** Commits several surfaces as one undo step (ink moved between pages stays one action). */
  changeMany(groups: ReadonlyMap<string, readonly Element[]>, record = true) {
    const applied: Applied[] = [];
    for (const [id, elements] of groups) { const change = this.apply(id, elements); if (change) applied.push(change); }
    if (!applied.length) return;
    if (record) {
      const scratch = applied.filter(c => c.surface === 'scratch'), body = applied.filter(c => c.surface !== 'scratch');
      if (body.length) this.bodyHistory.pushMany(body);
      if (scratch.length) this.scratchHistory.pushMany(scratch);
    }
    this.schedule();
  }
  metadataChanged() { this.metadataDirty = true; this.schedule(); }
  editLayout(edit: () => void) {
    const before = structuredClone({ pages: this.manifest.pages, regions: this.manifest.regions });
    edit();
    const after = structuredClone({ pages: this.manifest.pages, regions: this.manifest.regions });
    this.bodyHistory.layout(before, after); this.metadataChanged();
  }
  /** Text reflow and page growth share one body undo step. Assets are immutable and retained. */
  editContent(groups: ReadonlyMap<string, readonly Element[]>, edit: () => void = () => {}) {
    if (groups.has('scratch')) throw Error('正文排版不能修改草稿纸历史。');
    const before = structuredClone({ pages: this.manifest.pages, regions: this.manifest.regions });
    const applied: Applied[] = [];
    for (const [id, elements] of groups) { const change = this.apply(id, elements); if (change) applied.push(change); }
    edit();
    const after = structuredClone({ pages: this.manifest.pages, regions: this.manifest.regions });
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    this.bodyHistory.pushMany(applied, changed ? before : undefined, changed ? after : undefined);
    if (changed) this.metadataDirty = true;
    if (applied.length || changed) this.schedule();
  }
  schedule() {
    this.generation++; if (this.saveState !== 'failed') this.saveState = 'pending'; this.notify();
    this.dirtySince ??= Date.now();
    this.armSave();
  }
  /** Disk writes wait for pen-up; history and in-memory snapshots remain immediate. */
  setWriting(owner: string, active: boolean) {
    if (active) { this.writing.add(owner); window.clearTimeout(this.timer); }
    else { this.writing.delete(owner); this.armSave(); }
  }
  private armSave() {
    window.clearTimeout(this.timer);
    if (this.dirtySince === undefined || this.writing.size || this.conflictPath) return;
    const delay = Math.min(SAVE_IDLE_MS, Math.max(0, SAVE_MAX_WAIT_MS - (Date.now() - this.dirtySince)));
    this.timer = window.setTimeout(() => void this.save().catch(() => {}), delay);
  }
  async loadFiles(elements?: readonly Element[]) {
    const wanted = elements ? new Set<string>(elements.flatMap(e => e.type === 'image' && e.fileId ? [e.fileId] : [])) : null;
    for (const [id, asset] of Object.entries(this.manifest.assets)) {
      if (!asset.mimeType.startsWith('image/')) continue;
      if (this.files[id] || wanted && !wanted.has(id)) continue;
      const bytes = await this.store.io.readBinary(asset.path);
      const dataURL = await readDataURL(new Blob([bytes], { type: asset.mimeType }));
      this.files[id] = imageFile(id, dataURL, asset.mimeType, asset.created);
    }
    this.pruneFiles(wanted ?? new Set(Object.keys(this.files)));
  }
  private kept(id: string) { for (const keep of this.keepers) if (keep(id)) return true; return false; }
  private pruneFiles(wanted = new Set<string>()) {
    for (const [surface, elements] of this.surfaces) if (this.kept(surface)) for (const e of elements) if (e.type === 'image' && e.fileId) wanted.add(e.fileId);
    let bytes = Object.values(this.files).reduce((sum, file) => sum + file.dataURL.length * 2, 0);
    for (const [id, file] of Object.entries(this.files)) {
      if (bytes <= 48 * 1024 * 1024) break;
      if (!wanted.has(id)) { bytes -= file.dataURL.length * 2; delete this.files[id]; }
    }
  }
  releaseSurface(id: string) {
    if (this.kept(id) || [...this.dirty.keys()].some(key => key.startsWith(`${id}/`))) return;
    this.surfaces.delete(id); this.trackers.delete(id);
    this.pruneFiles();
  }
  async acceptFiles(files: BinaryFiles) {
    for (const [id, file] of Object.entries(files)) {
      if (this.manifest.assets[id]) continue;
      const dir = `${this.manifest.resourceDir}/assets`; await ensureDir(this.store.io, dir);
      const path = `${dir}/${uid()}.bin`;
      await this.store.io.writeBinary(path, dataUrlBytes(file.dataURL));
      this.manifest.assets[id] = { path, mimeType: file.mimeType, created: file.created }; this.files[id] = file;
      this.metadataChanged();
    }
  }
  async save(): Promise<void> {
    window.clearTimeout(this.timer);
    if (this.conflictPath) { if (this.conflictResolved) return; throw new Conflict(this.conflictPath); }
    if (this.pending) { await this.pending; if (this.dirty.size || this.metadataDirty) return this.save(); return; }
    if (!this.dirty.size && !this.metadataDirty) { if (this.saveState !== 'saved') { this.saveState = 'saved'; this.saveError = ''; this.notify(); } return; }
    const batch = new Map(this.dirty), generation = this.generation;
    this.dirtySince = undefined;
    const metadata = structuredClone(this.manifest);
    this.saveState = 'saving'; this.notify();
    this.pending = (async () => {
      try {
        const next = await this.store.commit(batch, metadata);
        for (const [key, value] of batch) if (this.dirty.get(key) === value) this.dirty.delete(key);
        this.manifest.revision = next.revision; this.manifest.parent = next.parent; this.manifest.chunks = next.chunks;
        if (generation === this.generation) this.metadataDirty = false;
        this.saveState = this.dirty.size || this.metadataDirty ? 'pending' : 'saved'; this.saveError = '';
        for (const id of this.surfaces.keys()) this.releaseSurface(id);
      } catch (error) { if (error instanceof Conflict) this.conflictPath = error.copyPath; this.saveState = 'failed'; this.saveError = (error as Error).message; throw error; }
      finally { this.pending = undefined; this.notify(); }
    })();
    return this.pending;
  }
  async preserveConflict() {
    await Promise.all([...this.flushers.values()].map(flush => flush()));
    window.clearTimeout(this.timer);
    this.conflictPath = await this.store.conflictCopy(this.dirty, structuredClone(this.manifest));
    return this.conflictPath;
  }
}

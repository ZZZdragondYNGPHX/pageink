import type { BinaryFileData } from '@excalidraw/excalidraw/types';
import { Element, uid } from './model';
import { bounds, cloneElements } from './geometry';
import { dataUrlBytes } from './binary';

export interface SavedElementItem {
  id: string;
  name: string;
  created: number;
  elements: Element[];
  files: Record<string, BinaryFileData>;
}

export const MAX_LIBRARY_ITEMS = 48;

function hasValidImageData(file: BinaryFileData | undefined): file is BinaryFileData {
  if (!file || typeof file.dataURL !== 'string' || !file.dataURL.startsWith('data:image/')) return false;
  try {
    return dataUrlBytes(file.dataURL).byteLength > 0;
  } catch {
    return false;
  }
}

/**
 * Prepares a selection for storage in the cross-document reusable elements library:
 * normalizes coordinates to (0, 0), clones IDs, keeps only referenced image files,
 * and strips document-private references so pasted items never reference foreign note assets.
 */
export function sanitizeForLibrary(
  elements: readonly Element[],
  files: Record<string, BinaryFileData>,
  name?: string,
): SavedElementItem | null {
  const live = elements.filter(e => !e.isDeleted);
  if (!live.length) return null;
  const box = bounds(live);
  if (!box) return null;
  const cloned = cloneElements(live, -box.x, -box.y).map(e => {
    if (!e.customData) return { ...e, locked: false };
    const data = { ...e.customData };
    delete data.pageinkText;
    delete data.pageinkCard;
    delete data.pageinkAnchor;
    delete data.source;
    return { ...e, locked: false, customData: Object.keys(data).length ? data : undefined };
  });
  const usedFiles: Record<string, BinaryFileData> = {};
  for (const e of cloned) {
    if (e.type === 'image') {
      const file = e.fileId ? files[e.fileId] : undefined;
      if (!e.fileId || !hasValidImageData(file)) {
        throw new Error('所选图片资源尚未加载完成或内容为空，无法存入常用元素库。');
      }
      usedFiles[e.fileId] = structuredClone(file);
    }
  }
  return {
    id: uid(),
    name: name?.trim() || defaultItemName(cloned),
    created: Date.now(),
    elements: cloned,
    files: usedFiles,
  };
}

/**
 * Prepares a library item for insertion into a target note by minting fresh unique `fileId`s
 * for every embedded image so it never collides with existing or unloaded assets in the target note.
 */
export function prepareLibraryInsert(item: SavedElementItem): { elements: Element[]; files: Record<string, BinaryFileData> } {
  const fileIdMap = new Map<string, string>();
  const files: Record<string, BinaryFileData> = {};
  for (const [oldId, file] of Object.entries(item.files)) {
    if (!hasValidImageData(file)) continue;
    const freshId = uid();
    fileIdMap.set(oldId, freshId);
    files[freshId] = { ...structuredClone(file), id: freshId as BinaryFileData['id'] };
  }
  const elements = item.elements.map(e => {
    if (e.type === 'image') {
      const mapped = e.fileId ? fileIdMap.get(e.fileId) : undefined;
      if (!mapped) throw new Error('该收藏缺少有效图片资源，无法插入。');
      return { ...e, fileId: mapped as Extract<Element, { type: 'image' }>['fileId'] };
    }
    return e;
  });
  return { elements, files };
}

function defaultItemName(elements: readonly Element[]): string {
  const textEl = elements.find(e => e.type === 'text' && e.text.trim());
  if (textEl && textEl.type === 'text') return textEl.text.trim().split('\n')[0].slice(0, 16);
  if (elements.every(e => e.type === 'freedraw')) return `手写图形 (${elements.length} 笔)`;
  if (elements.length === 1 && elements[0].type === 'image') return '贴纸图片';
  return `常用元素 (${elements.length} 项)`;
}

/** Validates persisted JSON from disk/localStorage without throwing on malformed entries. */
export function normalizeLibraryItems(raw: unknown): SavedElementItem[] {
  if (!Array.isArray(raw)) return [];
  const valid: SavedElementItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id || typeof r.name !== 'string' || !Array.isArray(r.elements) || !r.elements.length) continue;
    const files = r.files && typeof r.files === 'object' && !Array.isArray(r.files) ? r.files as Record<string, BinaryFileData> : {};
    const elements = r.elements as Element[];
    const missingImageAsset = elements.some(e => e?.type === 'image' && (!e.fileId || !hasValidImageData(files[e.fileId])));
    if (missingImageAsset) continue;
    valid.push({
      id: r.id,
      name: r.name.trim() || '常用元素',
      created: typeof r.created === 'number' && Number.isFinite(r.created) ? r.created : Date.now(),
      elements,
      files,
    });
  }
  return valid;
}

/** Observable reusable elements store with serialized persistence and rollback on save failure. */
export class ElementsLibraryStore {
  private listeners = new Set<() => void>();
  private items: SavedElementItem[];
  private writeChain: Promise<void> = Promise.resolve();
  constructor(initial: SavedElementItem[] = [], private persist: (items: SavedElementItem[]) => Promise<void> | void = () => {}) {
    this.items = [...initial];
  }
  get = (): readonly SavedElementItem[] => this.items;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify() { for (const listener of this.listeners) listener(); }
  private enqueuePersist(mutate: (current: SavedElementItem[]) => SavedElementItem[]): Promise<void> {
    const task = this.writeChain.then(async () => {
      const previous = this.items;
      const next = mutate(previous);
      await this.persist(next);
      this.items = next;
      this.notify();
    });
    // Keep the chain alive for subsequent operations even if one write rejects.
    this.writeChain = task.catch(() => {});
    return task;
  }
  async add(elements: readonly Element[], files: Record<string, BinaryFileData>, name?: string): Promise<SavedElementItem | null> {
    const item = sanitizeForLibrary(elements, files, name);
    if (!item) return null;
    await this.enqueuePersist(current => {
      if (current.length >= MAX_LIBRARY_ITEMS) {
        throw new Error(`常用元素库已满（最多 ${MAX_LIBRARY_ITEMS} 项），请先删除不需要的收藏再添加。`);
      }
      return [item, ...current];
    });
    return item;
  }
  async remove(id: string): Promise<void> {
    await this.enqueuePersist(current => current.filter(item => item.id !== id));
  }
}

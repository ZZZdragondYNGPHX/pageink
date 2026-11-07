import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

export type Element = ExcalidrawElement;
export type Rect = { x: number; y: number; width: number; height: number };
export type Margins = { top: number; right: number; bottom: number; left: number };
export interface Page {
  id: string;
  width: number;
  height: number;
  margins: Margins;
  template: 'blank' | 'ruled' | 'grid';
  pdfPage?: number;
}
export interface Region extends Rect { id: string; pageId: string; title: string }
export interface Asset { path: string; mimeType: string; created: number }
export interface Manifest {
  format: 'drawing-local';
  schema: 1;
  id: string;
  revision: string;
  parent: string | null;
  title: string;
  mode: 'pages' | 'canvas';
  resourceDir: string;
  pages: Page[];
  regions: Region[];
  chunks: Record<string, string>;
  assets: Record<string, Asset>;
  pdf?: { path: string; sha256: string; size: number };
  modified: number;
}
export const uid = () => crypto.randomUUID();
export function newPage(): Page {
  return { id: uid(), width: 794, height: 1123, margins: { top: 48, right: 48, bottom: 48, left: 48 }, template: 'blank' };
}
export function newManifest(title: string, mode: Manifest['mode']): Manifest {
  const id = uid();
  return { format: 'drawing-local', schema: 1, id, revision: uid(), parent: null, title, mode,
    resourceDir: `Drawing Resources/${id}`, pages: [newPage()], regions: [], chunks: {}, assets: {}, modified: Date.now() };
}
export function parseManifest(text: string): Manifest {
  const value = JSON.parse(text) as Manifest;
  if (!value || value.format !== 'drawing-local' || value.schema !== 1 || !value.id || !value.revision || !Array.isArray(value.pages) || !value.pages.length || !['pages', 'canvas'].includes(value.mode) || !value.chunks || !value.assets || !Array.isArray(value.regions)) {
    throw new Error('文档格式损坏或版本不受支持；原文件未修改。');
  }
  const ids = new Set<string>();
  for (const page of value.pages) {
    if (typeof page.id !== 'string' || !page.id || ids.has(page.id) || !Number.isFinite(page.width) || page.width <= 0 || !Number.isFinite(page.height) || page.height <= 0 || !page.margins || ['top','right','bottom','left'].some(key => !Number.isFinite(page.margins[key as keyof Margins]) || page.margins[key as keyof Margins] < 0)) throw Error('文档页面参数损坏；原文件未修改。');
    ids.add(page.id);
  }
  if (value.mode === 'canvas' && value.pages.length !== 1) throw Error('无边记入口只能包含一个画布面。');
  for (const region of value.regions) if (!region.id || typeof region.title !== 'string' || ![region.x,region.y,region.width,region.height].every(Number.isFinite) || region.width <= 0 || region.height <= 0) throw Error('文档区域参数损坏；原文件未修改。');
  safePath(value.resourceDir);
  for (const path of Object.values(value.chunks)) safePath(path);
  for (const asset of Object.values(value.assets)) safePath(asset.path);
  if (value.pdf) safePath(value.pdf.path);
  return value;
}
export function safePath(path: string): string {
  if (typeof path !== 'string' || !path || path.startsWith('/') || /[\\:\x00-\x1f]/.test(path) || path.split('/').some(p => p === '..' || p === '.')) {
    throw new Error(`不安全的资源路径：${path}`);
  }
  return path;
}
export function pageRect(page: Page): Rect {
  return { x: -page.margins.left, y: -page.margins.top,
    width: page.width + page.margins.left + page.margins.right,
    height: page.height + page.margins.top + page.margins.bottom };
}
export async function digest(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer as ArrayBuffer;
}
export function retargetInternalSources(elements: Element[], previous: string, next: string): Element[] {
  return elements.map(e => { const source = e.customData?.source; return source?.document === previous ? { ...e, customData: { ...e.customData, source: { ...source, document: next } } } : e; });
}

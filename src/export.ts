import { exportToBlob } from '@excalidraw/excalidraw';
import { Session } from './session';
import { Element, Page, pageRect, digest, Rect, toArrayBuffer } from './model';
import { bounds } from './geometry';
import { vectorLayer } from './vector-export';
import { assetBytes } from './assets';
import type { ExportRequest, ExportResponse } from './export-messages';
import { renderArea } from './preview';
import type { PdfService } from './pdf';

const PIXEL_BUDGET = 16_000_000;
/** Largest scale up to 2× that keeps the bitmap within the pixel budget. */
export const fittingScale = (width: number, height: number, preferred = 2) => Math.min(preferred, Math.sqrt(PIXEL_BUDGET / Math.max(1, width * height)));

/** Transparent PNG of the given objects. */
export async function png(session: Session, elements: readonly Element[]): Promise<{ blob: Blob; scale: number }> {
  const live = elements.filter(e => !e.isDeleted);
  if (!live.length) throw Error('没有可导出的内容。');
  await session.loadFiles(live);
  const b = bounds(live)!, padding = live.reduce((max, e) => Math.max(max, e.strokeWidth * 4), 8);
  const scale = fittingScale(b.width + padding * 2, b.height + padding * 2);
  const blob = await exportToBlob({ elements: live, files: { ...session.files }, mimeType: 'image/png', appState: { exportBackground: false }, exportPadding: padding, getDimensions: (w: number, h: number) => ({ width: w * scale, height: h * scale, scale }) });
  return { blob, scale };
}

/** One page as it looks on screen: paper, template, PDF and ink (including ink beyond the paper). */
export async function pagePng(session: Session, page: Page, pdf?: PdfService, signal?: AbortSignal): Promise<{ blob: Blob; scale: number }> {
  const ink = bounds((await session.read(page.id)).filter(e => !e.isDeleted));
  const paper = pageRect(page), area = ink ? union(paper, ink) : paper;
  const scale = fittingScale(area.width, area.height);
  const canvas = await renderArea(session, page, area, scale, pdf, signal);
  try { return { blob: await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(Error('图片编码失败。')), 'image/png')), scale }; }
  finally { canvas.width = canvas.height = 0; }
}
const union = (a: Rect, b: Rect): Rect => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }; };

export interface PdfExportOptions {
  paper?: 'original' | 'a4' | 'letter';
  /** Page ids to include (default: every page). */
  pages?: readonly string[];
  /** Export only these objects on a single page. */
  selection?: readonly Element[];
}
export async function readingPdf(session: Session, onProgress: (current: number, total: number) => void, signal?: AbortSignal, options: PdfExportOptions = {}) {
  signal?.throwIfAborted();
  const freeform = !!options.selection || session.manifest.mode === 'canvas';
  const pages = freeform ? [session.manifest.pages[0]] : session.manifest.pages.filter(p => !options.pages || options.pages.includes(p.id));
  if (!pages.length) throw Error('没有可导出的页面。');
  let source: ArrayBuffer | undefined;
  if (session.manifest.pdf && !freeform) {
    source = await session.store.io.readBinary(session.manifest.pdf.path);
    if (await digest(source) !== session.manifest.pdf.sha256) throw Error('原 PDF 已变化，无法导出批注版。请先重新关联同一原件。');
  }
  signal?.throwIfAborted();
  const workerUrl = URL.createObjectURL(new Blob([assetBytes('pdf-export.worker.mjs')], { type: 'text/javascript' }));
  let worker: Worker;
  try { worker = new Worker(workerUrl, { type: 'module' }); } catch (error) { URL.revokeObjectURL(workerUrl); throw error; }
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: ArrayBuffer | undefined) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => { for (const task of pending.values()) task.reject(error); pending.clear(); };
  const abort = () => { worker.terminate(); fail(new DOMException('导出已取消', 'AbortError')); };
  worker.onmessage = (event: MessageEvent<ExportResponse>) => { const task = pending.get(event.data.id); if (!task) return; pending.delete(event.data.id); event.data.error ? task.reject(new Error(event.data.error)) : task.resolve(event.data.result); };
  worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'PDF 后台导出失败。')); };
  worker.onmessageerror = () => fail(new Error('PDF 后台导出消息损坏。'));
  signal?.addEventListener('abort', abort, { once: true });
  const call = (message: Omit<Extract<ExportRequest, { kind: 'init' }>, 'id'> | Omit<Extract<ExportRequest, { kind: 'page' }>, 'id'> | Omit<Extract<ExportRequest, { kind: 'finish' }>, 'id'>, transfer: Transferable[] = []) => new Promise<ArrayBuffer | undefined>((resolve, reject) => { signal?.throwIfAborted(); const id = ++nextId; pending.set(id, { resolve, reject }); worker.postMessage({ id, ...message }, transfer); });
  try {
    const font = toArrayBuffer(assetBytes('fonts/NotoSansCJKsc-Regular.otf'));
    await call({ kind: 'init', data: { source, font } }, source ? [source, font] : [font]);
    for (const [i, page] of pages.entries()) {
      signal?.throwIfAborted();
      const elements = (options.selection ?? await session.read(page.id)).filter(e => !e.isDeleted);
      await session.loadFiles(elements); signal?.throwIfAborted();
      let box = freeform ? bounds(elements) : pageRect(page);
      if (!box) { if (freeform) throw Error(options.selection ? '没有可导出的内容。' : '画布还是空的。'); continue; }
      const layer = elements.length ? await vectorLayer(session, elements) : undefined;
      // The editor also permits marks outside the paper. Include the complete padded vector
      // layer rather than silently clipping those marks at export.
      if (layer) {
        const x = Math.min(box.x, layer.x), y = Math.min(box.y, layer.y);
        box = { x, y, width: Math.max(box.x + box.width, layer.x + layer.width) - x, height: Math.max(box.y + box.height, layer.y + layer.height) - y };
      }
      await call({ kind: 'page', data: { page: freeform ? { ...page, pdfPage: undefined } : page, box, paper: options.paper, paginated: !freeform, layer } });
      onProgress(i + 1, pages.length);
      await new Promise(resolve => window.setTimeout(resolve, 0));
    }
    const bytes = await call({ kind: 'finish' }); signal?.throwIfAborted(); if (!bytes) throw Error('PDF 后台导出没有返回文件。'); return new Uint8Array(bytes);
  } finally { signal?.removeEventListener('abort', abort); worker.terminate(); URL.revokeObjectURL(workerUrl); }
}
export { pack, unpack } from './archive';

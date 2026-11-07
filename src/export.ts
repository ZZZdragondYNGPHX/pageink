import { exportToBlob } from '@excalidraw/excalidraw';
import { Session } from './session';
import { Element, pageRect, digest } from './model';
import { bounds } from './geometry';
import { vectorLayer } from './vector-export';
import { assetBytes, assetUrl } from './assets';

export async function png(session: Session, elements: readonly Element[]) {
  await session.loadFiles(elements);
  if (!elements.some(e => !e.isDeleted)) throw Error('请先选择要导出的内容。');
  const b = bounds(elements)!;
  const padding = elements.reduce((max, e) => Math.max(max, e.strokeWidth * 4), 8);
  if ((b.width + padding * 2) * (b.height + padding * 2) * 4 > 16_000_000) throw Error('选区超过 1600 万像素，请明确缩小选区后重新导出；未自动降低质量。');
  return exportToBlob({ elements, files: { ...session.files }, mimeType: 'image/png', appState: { exportBackground: false }, exportPadding: padding, getDimensions: (w: number, h: number) => ({ width: w * 2, height: h * 2, scale: 2 }) });
}
export interface PdfExportOptions { selection?: readonly Element[]; paper?: 'original' | 'a4' | 'letter' }
export async function readingPdf(session: Session, onProgress: (current: number, total: number) => void, signal?: AbortSignal, options: PdfExportOptions = {}) {
  signal?.throwIfAborted();
  if (session.manifest.mode === 'canvas' && !options.selection?.some(e => !e.isDeleted)) throw Error('无边记 PDF 请先选择要导出的对象。');
  let source: ArrayBuffer | undefined;
  if (session.manifest.pdf) {
    source = await session.store.io.readBinary(session.manifest.pdf.path);
    if (await digest(source) !== session.manifest.pdf.sha256) throw Error('源 PDF 已变化，不能导出为原教材批注。请重新关联同一原件。');
  }
  signal?.throwIfAborted();
  const workerUrl = URL.createObjectURL(new Blob([assetBytes('pdf-export.worker.mjs')], { type: 'text/javascript' }));
  let worker: Worker;
  try { worker = new Worker(workerUrl, { type: 'module' }); } catch (error) { URL.revokeObjectURL(workerUrl); throw error; }
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => { for (const task of pending.values()) task.reject(error); pending.clear(); };
  const abort = () => { worker.terminate(); fail(new DOMException('导出已取消', 'AbortError')); };
  worker.onmessage = event => { const task = pending.get(event.data.id); if (!task) return; pending.delete(event.data.id); event.data.error ? task.reject(new Error(event.data.error)) : task.resolve(event.data.result); };
  worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'PDF 后台导出失败。')); };
  worker.onmessageerror = () => fail(new Error('PDF 后台导出消息损坏。'));
  signal?.addEventListener('abort', abort, { once: true });
  const call = (kind: string, data?: unknown, transfer: Transferable[] = []) => new Promise<any>((resolve, reject) => { signal?.throwIfAborted(); const id = ++nextId; pending.set(id, { resolve, reject }); worker.postMessage({ id, kind, data }, transfer); });
  try {
    await call('init', { source, fontUrl: assetUrl('fonts/NotoSansCJKsc-Regular.otf') }, source ? [source] : []);
    for (const [i, page] of session.manifest.pages.entries()) {
      signal?.throwIfAborted();
      const elements = (session.manifest.mode === 'canvas' ? options.selection! : await session.read(page.id)).filter(e => !e.isDeleted);
      await session.loadFiles(elements); signal?.throwIfAborted();
      let box = session.manifest.mode === 'pages' ? pageRect(page) : bounds(elements);
      if (!box) continue;
      const layer = elements.length ? await vectorLayer(session, elements) : undefined;
      // The editor also permits marks outside the current paper. Include the complete
      // padded vector layer rather than silently clipping those marks at export.
      if (layer) {
        const x = Math.min(box.x, layer.x), y = Math.min(box.y, layer.y);
        box = { x, y, width: Math.max(box.x + box.width, layer.x + layer.width) - x,
          height: Math.max(box.y + box.height, layer.y + layer.height) - y };
      }
      await call('page', { page, box, paper: options.paper, paginated: session.manifest.mode === 'pages', layer });
      onProgress(i + 1, session.manifest.pages.length);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const bytes: ArrayBuffer = await call('finish'); signal?.throwIfAborted(); return new Uint8Array(bytes);
  } finally { signal?.removeEventListener('abort', abort); worker.terminate(); URL.revokeObjectURL(workerUrl); }
}
export { pack, unpack } from './archive';

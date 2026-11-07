import * as pdfjs from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { digest, Page, Rect } from './model';
import { FileIO } from './storage';
export class PdfService {
  document!: pdfjs.PDFDocumentProxy;
  private constructor() {}
  static async open(io: FileIO, source: { path: string; sha256: string }, assetBase: string) {
    const bytes = await io.readBinary(source.path);
    if (await digest(bytes) !== source.sha256) throw new Error('源 PDF 内容已变化。旧批注未自动迁移；请重新关联同一原件或为新版另建文档。');
    return this.fromBytes(bytes, assetBase);
  }
  static async fromBytes(bytes: ArrayBuffer, base: string) {
    pdfjs.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
    const service = new PdfService();
    service.document = await pdfjs.getDocument({ data: new Uint8Array(bytes), cMapUrl: `${base}cmaps/`, cMapPacked: true,
      standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, useSystemFonts: true }).promise;
    return service;
  }
  async render(page: Page, canvas: HTMLCanvasElement, scale: number, rect?: Rect, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const pdfPage = await this.document.getPage(page.pdfPage!);
    signal?.throwIfAborted();
    const viewport = pdfPage.getViewport({ scale });
    canvas.width = Math.ceil((rect?.width ?? viewport.width / scale) * scale);
    canvas.height = Math.ceil((rect?.height ?? viewport.height / scale) * scale);
    const task = pdfPage.render({ canvasContext: canvas.getContext('2d')!, canvas, viewport,
      transform: rect ? [1, 0, 0, 1, -rect.x * scale, -rect.y * scale] : undefined });
    const abort = () => task.cancel(); signal?.addEventListener('abort', abort, { once: true });
    try { await task.promise; } finally { signal?.removeEventListener('abort', abort); pdfPage.cleanup(); }
  }
  async text(page: Page) {
    const pdfPage = await this.document.getPage(page.pdfPage!);
    try { const content = await pdfPage.getTextContent(); return content.items.filter((item): item is TextItem => 'str' in item); }
    finally { pdfPage.cleanup(); }
  }
  destroy() { return this.document.destroy(); }
}

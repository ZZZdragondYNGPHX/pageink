import * as pdfjs from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { digest, Page, Rect } from './model';
import { FileIO } from './storage';
import { assetUrl, EmbeddedCMapReader, EmbeddedStandardFonts, EmbeddedWasm } from './assets';
export class PdfService {
  document!: pdfjs.PDFDocumentProxy;
  private constructor() {}
  static async open(io: FileIO, source: { path: string; sha256: string }) {
    const bytes = await io.readBinary(source.path);
    if (await digest(bytes) !== source.sha256) throw new Error('源 PDF 内容已变化。旧批注未自动迁移；请重新关联同一原件或为新版另建文档。');
    return this.fromBytes(bytes);
  }
  static async fromBytes(bytes: ArrayBuffer) {
    pdfjs.GlobalWorkerOptions.workerSrc = assetUrl('pdf.worker.min.mjs');
    const service = new PdfService();
    service.document = await pdfjs.getDocument({ data: new Uint8Array(bytes), cMapPacked: true, useWorkerFetch: false,
      CMapReaderFactory: EmbeddedCMapReader, StandardFontDataFactory: EmbeddedStandardFonts,
      WasmFactory: EmbeddedWasm, useSystemFonts: true }).promise;
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
  /** Text runs with their page-local rectangles (scale 1, rotation applied). */
  async textRuns(page: Page): Promise<{ text: string; rect: Rect }[]> {
    const pdfPage = await this.document.getPage(page.pdfPage!);
    try {
      const viewport = pdfPage.getViewport({ scale: 1 }), content = await pdfPage.getTextContent();
      return content.items.filter((item): item is TextItem => 'str' in item && !!item.str.trim()).map(item => {
        const [, , c, d, e, f] = item.transform as number[], height = Math.hypot(c, d) || item.height;
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([e, f - height * 0.2, e + item.width, f + height * 0.9]) as number[];
        return { text: item.str, rect: { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) } };
      });
    } finally { pdfPage.cleanup(); }
  }
  destroy() { return this.document.destroy(); }
}

import { App, MarkdownView, TFile } from 'obsidian';
import type { NoteEntry } from './notes';
import type { SearchSegment } from './library-search';
import type { FileIO } from './storage';
import { DocumentStore } from './storage';
import type { Session } from './session';
import { newPage, Page } from './model';
import { PdfService } from './pdf';
import { bounds } from './geometry';

/** Read-only, bounded by one drawing page / PDF at a time; current native editor text wins. */
export class LibrarySources {
  constructor(private app: App, private io: FileIO, private live: (path: string) => Session | undefined) {}
  async *segments(entry: NoteEntry, signal: AbortSignal): AsyncGenerator<SearchSegment> {
    signal.throwIfAborted();
    const file = this.app.vault.getAbstractFileByPath(entry.path);
    if (!(file instanceof TFile)) throw Error('文件已移动或删除，请重新搜索。');
    if (entry.kind === 'unavailable') throw Error(entry.detail ?? '文档暂不可用。');
    if (file.extension === 'md') {
      let view: MarkdownView | undefined;
      this.app.workspace.iterateAllLeaves(leaf => { if (leaf.view instanceof MarkdownView && leaf.view.file === file) view ??= leaf.view; });
      const text = view?.editor.getValue() ?? await this.app.vault.cachedRead(file);
      const lines = text.split('\n');
      for (let line = 0; line < lines.length; line++) {
        signal.throwIfAborted();
        yield { text: lines[line], label: `正文 / 属性 · 第 ${line + 1} 行`, target: { line } };
        if (line % 128 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      return;
    }
    if (file.extension === 'pdf') {
      const pdf = await PdfService.fromBytes(await this.app.vault.readBinary(file));
      try {
        for (let number = 1; number <= pdf.document.numPages; number++) {
          const page = { ...newPage(), pdfPage: number };
          yield* this.pdfSegments(pdf, page, signal, false);
        }
      } finally { await pdf.destroy(); }
      return;
    }
    const session = this.live(file.path), store = session?.store ?? await DocumentStore.open(this.io, file.path);
    const manifest = session?.manifest ?? store.manifest;
    yield { text: `${manifest.title}\n${JSON.stringify(manifest.properties ?? {})}`, label: '标题 / 属性' };
    for (const region of manifest.regions) yield { text: region.title, label: '区域书签', target: { page: region.pageId, region: region.id, rect: region } };
    for (const [index, page] of manifest.pages.entries()) {
      signal.throwIfAborted();
      const elements = session ? await session.read(page.id) : await store.readSurface(page.id);
      for (const element of elements) {
        if (element.type !== 'text' || element.isDeleted) continue;
        yield { text: element.originalText ?? element.text, label: manifest.mode === 'pages' ? `画面文字 · 第 ${index + 1} 页` : '画布文字',
          target: { page: page.id, rect: bounds([element]) ?? undefined } };
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (manifest.pdf) {
      signal.throwIfAborted();
      const pdf = await PdfService.open(this.io, manifest.pdf);
      try { for (const page of manifest.pages) if (page.pdfPage) yield* this.pdfSegments(pdf, page, signal, true); }
      finally { await pdf.destroy(); }
    }
  }
  private async *pdfSegments(pdf: PdfService, page: Page, signal: AbortSignal, drawing: boolean): AsyncGenerator<SearchSegment> {
    signal.throwIfAborted();
    const runs = await pdf.textRuns(page);
    signal.throwIfAborted();
    const target = drawing ? { page: page.id } : { pdfPage: page.pdfPage };
    for (const run of runs) yield { text: run.text, label: `PDF 文本 · 第 ${page.pdfPage} 页`, target: { ...target, rect: run.rect } };
    // CJK PDFs often put each character in a separate run. Also cover phrases split across runs.
    yield { text: runs.map(run => run.text).join(''), label: `PDF 文本 · 第 ${page.pdfPage} 页`, target };
    yield { text: runs.map(run => run.text).join(' '), label: `PDF 文本 · 第 ${page.pdfPage} 页`, target };
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

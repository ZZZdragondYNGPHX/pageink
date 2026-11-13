import type { Rect } from './model';
import type { Session } from './session';
import type { PdfService } from './pdf';
import { bounds } from './geometry';

export interface SearchHit { page: string; pageIndex: number; kind: 'pdf' | 'text' | 'bookmark'; snippet: string; at: number; rect?: Rect; region?: string }

const snippet = (text: string, at: number, length: number) => {
  const start = Math.max(0, at - 18), end = Math.min(text.length, at + length + 42);
  return { text: (start ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : ''), at: at - start + (start ? 1 : 0) };
};

/** Searches PDF text, typed text and bookmark titles; yields between pages and honours cancellation. */
export async function searchDocument(session: Session, pdf: PdfService | undefined, query: string, signal: AbortSignal, onProgress: (done: number, total: number) => void): Promise<SearchHit[]> {
  const term = query.trim().toLocaleLowerCase(); if (!term) return [];
  const hits: SearchHit[] = [], pages = session.manifest.pages;
  for (const r of session.manifest.regions) {
    const at = r.title.toLocaleLowerCase().indexOf(term), index = pages.findIndex(p => p.id === r.pageId);
    if (at >= 0 && index >= 0) hits.push({ page: r.pageId, pageIndex: index, kind: 'bookmark', snippet: r.title, at, region: r.id, rect: r });
  }
  for (const [index, page] of pages.entries()) {
    signal.throwIfAborted(); onProgress(index, pages.length);
    for (const e of await session.read(page.id)) {
      if (e.type !== 'text' || e.isDeleted) continue;
      const text = e.originalText ?? e.text, at = text.toLocaleLowerCase().indexOf(term);
      if (at >= 0) { const s = snippet(text, at, term.length); hits.push({ page: page.id, pageIndex: index, kind: 'text', snippet: s.text, at: s.at, rect: bounds([e]) ?? undefined }); }
    }
    if (pdf && page.pdfPage) {
      const runs = await pdf.textRuns(page);
      let found = 0;
      for (const run of runs) {
        const at = run.text.toLocaleLowerCase().indexOf(term);
        if (at < 0) continue;
        const s = snippet(run.text, at, term.length);
        hits.push({ page: page.id, pageIndex: index, kind: 'pdf', snippet: s.text, at: s.at, rect: run.rect });
        if (++found >= 30) break;
      }
      if (!found) {
        const joined = runs.map(r => r.text).join(''), at = joined.toLocaleLowerCase().indexOf(term);
        if (at >= 0) { const s = snippet(joined, at, term.length); hits.push({ page: page.id, pageIndex: index, kind: 'pdf', snippet: s.text, at: s.at }); }
      }
    }
    await new Promise(resolve => window.setTimeout(resolve, 0));
  }
  onProgress(pages.length, pages.length);
  return hits.sort((a, b) => a.pageIndex - b.pageIndex);
}

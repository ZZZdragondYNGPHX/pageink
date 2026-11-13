import type { Rect } from './model';
import type { NoteEntry } from './notes';

export interface NoteTarget { line?: number; page?: string; pdfPage?: number; region?: string; rect?: Rect }
export interface SearchSegment { text: string; label: string; target?: NoteTarget }
export interface LibraryMatch { entry: NoteEntry; snippet: string; label: string; target?: NoteTarget }
export interface LibrarySearchState {
  matches: LibraryMatch[];
  issues: { path: string; message: string }[];
  done: number;
  total: number;
}
export const searchTerms = (query: string) => [...new Set(query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))];

export function searchSnippet(text: string, terms: readonly string[]) {
  const flat = text.replace(/\s+/g, ' '), lower = flat.toLocaleLowerCase();
  const positions = terms.map(term => lower.indexOf(term)).filter(at => at >= 0);
  const at = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, at - 28), end = Math.min(flat.length, Math.max(at + 100, start + 140));
  return (start ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

/** File-level AND search, with the first matching content location. No content index is persisted.
 * The generator can stop as soon as every term is found, releasing PDF resources in its finally. */
export async function scanLibrary(entries: readonly NoteEntry[], query: string, signal: AbortSignal,
  segments: (entry: NoteEntry, signal: AbortSignal) => AsyncIterable<SearchSegment>,
  progress: (state: LibrarySearchState) => void): Promise<LibrarySearchState> {
  const terms = searchTerms(query), matches: LibraryMatch[] = [], issues: LibrarySearchState['issues'] = [];
  let done = 0;
  const snapshot = () => ({ matches: [...matches], issues: [...issues], done, total: entries.length });
  signal.throwIfAborted();
  if (!terms.length) return snapshot();
  for (const entry of entries) {
    signal.throwIfAborted();
    const heading = `${entry.name}\n${entry.path}`.toLocaleLowerCase();
    const missing = new Set(terms.filter(term => !heading.includes(term)));
    const contentTerms = [...missing];
    let first: SearchSegment | undefined, bestScore = 0;
    try {
      if (missing.size) for await (const segment of segments(entry, signal)) {
        signal.throwIfAborted();
        const lower = segment.text.toLocaleLowerCase();
        const score = contentTerms.filter(term => lower.includes(term)).length;
        if (score > bestScore) { first = segment; bestScore = score; }
        for (const term of missing) if (lower.includes(term)) missing.delete(term);
        if (!missing.size) break;
      }
    } catch (error) {
      signal.throwIfAborted();
      issues.push({ path: entry.path, message: (error as Error).message });
    }
    signal.throwIfAborted();
    if (!missing.size) matches.push({ entry, snippet: first ? searchSnippet(first.text, terms) : entry.path,
      label: first?.label ?? '名称 / 路径', target: first?.target });
    done++; progress(snapshot());
    await new Promise(resolve => window.setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  return snapshot();
}

/** Local calendar date: UTC conversion would open the wrong daily note around midnight. */
export function dailyNotePath(date: Date) {
  const part = (value: number) => String(value).padStart(2, '0');
  return `PageInk Daily/${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}.md`;
}

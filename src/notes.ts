/** Shared catalogue and reference values. Markdown remains owned by its native file/editor. */
export type NoteKind = 'text' | 'pages' | 'canvas' | 'pdf' | 'unavailable';
export interface NoteEntry {
  path: string;
  name: string;
  modified: number;
  kind: NoteKind;
  detail?: string;
}
export type NoteFilter = 'all' | Exclude<NoteKind, 'unavailable'>;
export const NOTE_LABELS: Record<NoteKind, string> = {
  text: '文字笔记', pages: '笔记本', canvas: '自由画布', pdf: 'PDF', unavailable: '待检查',
};

export function filterNotes(entries: readonly NoteEntry[], filter: NoteFilter, query: string): NoteEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => (filter === 'all' || entry.kind === filter)
    && terms.every(term => `${entry.name}\n${entry.path}`.toLocaleLowerCase().includes(term)))
    .sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
}

export interface DrawingReference { document: string; file: string; region: string }
/** Same stable-ID reference as the existing Markdown processor; no copied drawing data. */
export function drawingRegionCode(ref: DrawingReference): string {
  return '```drawing-region\n' + JSON.stringify(ref) + '\n```';
}

/** Standalone embeds need blank lines even when inserted in the middle of a paragraph. */
export function blockInsertion(before: string, after: string, block: string): string {
  const gapBefore = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const gapAfter = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  return gapBefore + block + gapAfter;
}

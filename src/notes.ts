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
export type NoteCreateKind = 'text' | 'pages' | 'canvas';
/** Product names travel with their concrete meaning, across creation, lists and host commands. */
export const NOTE_TYPES = {
  text: { label: '文字笔记', description: '文字、链接与清单', shortDescription: '.md 文件', detail: 'Markdown', icon: 'docText', hostIcon: 'file-text', action: '开始写作' },
  pages: { label: '手写笔记', description: '逐页书写与绘画', shortDescription: '分页绘写', detail: '分页画布', icon: 'notebook', hostIcon: 'notebook', action: '开始书写' },
  canvas: { label: '无边画布', description: '自由排布想法与资料', shortDescription: '无边画布', detail: '无边画布', icon: 'canvas', hostIcon: 'layout-dashboard', action: '展开画布' },
} as const;
export const NOTE_LABELS: Record<NoteKind, string> = {
  text: NOTE_TYPES.text.label, pages: NOTE_TYPES.pages.label, canvas: NOTE_TYPES.canvas.label, pdf: 'PDF', unavailable: '无法读取',
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

/** Empty queries browse direct children; searches include descendants, never sibling prefixes. */
export function folderNotes(entries: readonly NoteEntry[], folder: string, recursive = false) {
  const prefix = folder === '/' ? '' : folder + '/';
  return entries.filter(entry => entry.path.startsWith(prefix) && (recursive || !entry.path.slice(prefix.length).includes('/')));
}

import { App, Component, EditorSuggest, Notice, parseLinktext, type Editor, type EditorPosition, type EditorSuggestContext, type TFile } from 'obsidian';
import { parseManifest, type Manifest } from './model';
import { parseInkSubpath } from './notes';
import type { BacklinkEntry } from './host';

/** Metadata events keep the index aligned with native Markdown links. */
export class BacklinkTracker extends Component {
  private listeners = new Set<() => void>();
  constructor(private app: App) { super(); }
  onload() {
    const changed = () => { for (const listener of this.listeners) listener(); };
    this.registerEvent(this.app.metadataCache.on('changed', changed));
    this.registerEvent(this.app.metadataCache.on('deleted', changed));
    this.registerEvent(this.app.vault.on('rename', changed));
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async entries(path: string, manifest: Manifest): Promise<BacklinkEntry[]> {
    const entries: BacklinkEntry[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const text = await this.app.vault.cachedRead(file), lines = text.split('\n');
      const add = (line: number, subpath: string) => {
        const sub = parseInkSubpath(subpath), region = manifest.regions.find(r => r.id === sub.region || r.title === sub.region);
        entries.push({ sourcePath: file.path, sourceName: file.basename, line, page: sub.pageId ?? region?.pageId, pageNumber: sub.pageNumber, regionId: region?.id ?? sub.region, regionTitle: region?.title, snippet: lines[line]?.trim() });
      };
      for (const link of [...cache?.links ?? [], ...cache?.embeds ?? []]) {
        const parsed = parseLinktext(link.link);
        if (this.app.metadataCache.getFirstLinkpathDest(parsed.path, file.path)?.path === path) add(link.position.start.line, parsed.subpath);
      }
      for (const match of text.matchAll(/^```drawing-region\s*\n([\s\S]*?)^```/gm)) {
        try {
          const ref = JSON.parse(match[1]) as { file?: string; document?: string; region?: string };
          if (ref && (ref.file === path || ref.document === manifest.id)) add(text.slice(0, match.index).split('\n').length - 1, ref.region ? `#region=${encodeURIComponent(ref.region)}` : '');
        } catch (error) { if (!(error instanceof SyntaxError)) throw error; /* Incomplete user-authored JSON has no reference yet. */ }
      }
    }
    return entries.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || (a.line ?? 0) - (b.line ?? 0));
  }
}
interface Suggestion { label: string; value: string; alias: string }
export class InkSubpathSuggest extends EditorSuggest<Suggestion> {
  constructor(app: App, private live: (path: string) => Manifest | undefined, private width: () => number) { super(app); }
  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null) {
    if (!file) return null;
    const match = /\[\[([^[\]#|]+)#([^[\]|]*)$/.exec(editor.getLine(cursor.line).slice(0, cursor.ch));
    if (!match || this.app.metadataCache.getFirstLinkpathDest(match[1], file.path)?.extension !== 'inknote') return null;
    return { start: { line: cursor.line, ch: cursor.ch - match[2].length }, end: cursor, query: match[1] + '#' + match[2] };
  }
  async getSuggestions(context: EditorSuggestContext) {
    const [path, query = ''] = context.query.split('#');
    const file = this.app.metadataCache.getFirstLinkpathDest(path, context.file.path);
    if (!file || file.extension !== 'inknote') return [];
    try {
      const manifest = this.live(file.path) ?? parseManifest(await this.app.vault.read(file));
      return [
        ...manifest.regions.map(r => ({ label: `书签：${r.title}`, value: `region=${encodeURIComponent(r.id)}`, alias: r.title })),
        ...(manifest.mode === 'pages' ? manifest.pages.map((_, i) => ({ label: `第 ${i + 1} 页`, value: `page=${i + 1}`, alias: `第 ${i + 1} 页` })) : []),
      ].filter(item => !query || item.value.includes(query) || item.label.includes(query));
    } catch (error) { new Notice(`无法读取笔记：${(error as Error).message}`); return []; }
  }
  renderSuggestion(item: Suggestion, el: HTMLElement) { el.setText(item.label); }
  selectSuggestion(item: Suggestion) {
    const context = this.context; if (!context) return;
    const before = context.editor.getLine(context.start.line).slice(0, context.start.ch);
    const embed = /!\[\[[^\]]*#$/.test(before);
    const tail = context.editor.getLine(context.end.line).slice(context.end.ch);
    const close = tail.startsWith(']]') ? { line: context.end.line, ch: context.end.ch + 2 } : context.end;
    context.editor.replaceRange(`${item.value}|${embed ? this.width() : item.alias}]]`, context.start, close);
  }
}

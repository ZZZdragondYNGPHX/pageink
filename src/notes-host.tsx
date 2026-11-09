import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { App, Component, FileView, FuzzySuggestModal, ItemView, MarkdownView, Notice, Plugin, Scope, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import { Library, LibraryHost } from './Library';
import { blockInsertion, drawingRegionCode, NOTE_TYPES, NoteCreateKind, NoteEntry } from './notes';
import { parseManifest, Region } from './model';
import { ErrorBoundary } from './ui';
import { LibrarySearchState, NoteTarget, scanLibrary, SearchSegment } from './library-search';

const LIBRARY_VIEW = 'pageink-library';
export interface NotesActions {
  create(kind?: NoteCreateKind): Promise<void>;
  createText(): void;
  flushDrawing(path: string): Promise<void>;
  daily(): Promise<void>;
  properties(path: string): Promise<void>;
  segments(entry: NoteEntry, signal: AbortSignal): AsyncIterable<SearchSegment>;
  reveal(path: string, target: NoteTarget): Promise<void>;
}

class Picker<T> extends FuzzySuggestModal<T> {
  constructor(app: App, placeholder: string, private items: T[], private label: (item: T) => string, private choose: (item: T) => Promise<void>) {
    super(app); this.setPlaceholder(placeholder);
  }
  getItems() { return this.items; }
  getItemText(item: T) { return this.label(item); }
  onChooseItem(item: T) { void this.choose(item).catch(e => new Notice((e as Error).message)); }
}

class LibraryView extends ItemView {
  private root?: Root;
  private renderVersion = 0;
  constructor(leaf: WorkspaceLeaf, private host: LibraryHost) {
    super(leaf);
    this.scope = new Scope(this.app.scope);
    // The library owns Find and Escape. Let its DOM controls handle these keys
    // instead of inheriting the host's Escape shortcut that returns to the editor.
    this.scope.register([], 'Escape', () => {});
    this.scope.register(['Mod'], 'f', () => {});
  }
  getViewType() { return LIBRARY_VIEW; }
  getDisplayText() { return 'PageInk 笔记库'; }
  getIcon() { return 'notebook'; }
  async onOpen() {
    this.contentEl.addClass('ink-view');
    this.root = createRoot(this.contentEl);
    this.render();
  }
  private render() { this.root?.render(<ErrorBoundary key={this.renderVersion} onReload={() => { this.renderVersion++; this.render(); }}><Library host={this.host}/></ErrorBoundary>); }
  async onClose() { this.root?.unmount(); this.root = undefined; }
}

/** Native MarkdownView keeps ownership of content, history, focus, plugins and saves. */
class MarkdownTools extends Component {
  private mode?: HTMLButtonElement;
  private insert?: HTMLButtonElement;
  private link?: HTMLButtonElement;
  constructor(readonly view: MarkdownView, private host: NotesHost) { super(); }
  onload() {
    const view = this.view;
    const bar = view.containerEl.ownerDocument.createElement('div');
    bar.className = 'ink-native-tools'; bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', `PageInk ${NOTE_TYPES.text.label}工具`);
    const button = (icon: string, text: string, action: () => void, cls = '') => {
      const el = bar.createEl('button', { cls, attr: { type: 'button', 'aria-label': text, title: text } });
      setIcon(el.createSpan({ attr: { 'aria-hidden': 'true' } }), icon); el.createSpan({ text }); el.onclick = action;
      return el;
    };
    button('notebook', '笔记库', () => this.host.run(() => this.host.openLibrary()), 'ink-native-home');
    bar.createSpan({ cls: 'ink-native-label', text: `${NOTE_TYPES.text.label} · Markdown` });
    this.link = button('link', '插入笔记链接', () => this.host.pickLink(view));
    this.insert = button('notebook-pen', '插入手写区域', () => this.host.pickRegion(view));
    button('sliders-horizontal', '笔记属性', () => { if (view.file) this.host.run(() => this.host.properties(view.file!.path)); });
    this.mode = button('book-open', '阅读模式', () => this.host.run(async () => {
      const state = view.leaf.getViewState();
      await view.leaf.setViewState({ ...state, state: { ...state.state, mode: view.getMode() === 'source' ? 'preview' : 'source' } });
      this.update();
      if (view.getMode() === 'source') view.editor.focus();
    }));
    view.containerEl.insertBefore(bar, view.contentEl);
    this.register(() => bar.remove()); this.update();
  }
  update() {
    const reading = this.view.getMode() === 'preview';
    if (this.insert) this.insert.disabled = reading || !this.view.file;
    if (this.link) this.link.disabled = reading || !this.view.file;
    if (this.mode) {
      const label = reading ? '继续编辑' : '阅读模式';
      this.mode.setAttribute('aria-label', label); this.mode.title = label;
      this.mode.setAttribute('aria-pressed', String(reading));
      this.mode.lastElementChild!.textContent = reading ? '编辑' : '阅读';
      setIcon(this.mode.firstElementChild as HTMLElement, reading ? 'pencil' : 'book-open');
    }
  }
}

/** Obsidian-facing services for the shared library and native text workspace. */
export class NotesHost extends Component implements LibraryHost {
  private listeners = new Set<() => void>();
  private tools = new Map<MarkdownView, MarkdownTools>();
  private summaries = new Map<string, { modified: number; size: number; kind: NoteEntry['kind']; detail?: string }>();
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private navigation = 0;
  constructor(private plugin: Plugin, private actions: NotesActions) { super(); }
  private get app() { return this.plugin.app; }
  run(task: () => unknown) { void Promise.resolve().then(task).catch(e => new Notice((e as Error).message)); }
  create = (kind?: NoteCreateKind) => this.actions.create(kind);
  daily = () => this.actions.daily();
  properties = (path: string) => this.actions.properties(path);
  search = (entries: NoteEntry[], query: string, signal: AbortSignal, progress: (state: LibrarySearchState) => void) =>
    scanLibrary(entries, query, signal, (entry, task) => this.actions.segments(entry, task), progress);
  quickOpen = () => this.run(async () => {
    const entries = await this.list(new AbortController().signal);
    if (this.disposed) return;
    new Picker(this.app, '查找文笺、手札、长卷或 PDF', entries.sort((a, b) => b.modified - a.modified), entry => entry.path, entry => this.open(entry.path)).open();
  });
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { for (const listener of this.listeners) listener(); }

  onload() {
    const { app, plugin } = this;
    plugin.registerView(LIBRARY_VIEW, leaf => new LibraryView(leaf, this));
    plugin.addRibbonIcon('notebook', '打开 PageInk 笔记库', () => this.run(() => this.openLibrary()));
    plugin.addCommand({ id: 'open-library', name: '打开笔记库', callback: () => this.run(() => this.openLibrary()) });
    plugin.addCommand({ id: 'search-library', name: '搜索整个笔记库', callback: () => this.run(() => this.openLibrary()) });
    plugin.addCommand({ id: 'quick-open', name: '快速打开笔记…', callback: () => this.quickOpen() });
    plugin.addCommand({ id: 'daily-note', name: '打开今日记录', callback: () => this.run(() => this.daily()) });
    plugin.addCommand({ id: 'note-properties', name: '编辑笔记属性…', checkCallback: checking => {
      const file = app.workspace.getActiveFile();
      if (!file || !['md', 'inknote'].includes(file.extension)) return false;
      if (!checking) this.run(() => this.properties(file.path)); return true;
    } });
    plugin.addCommand({ id: 'new-text-note', name: `新建${NOTE_TYPES.text.label}（Markdown）`, callback: () => this.actions.createText() });
    plugin.addCommand({ id: 'insert-drawing-region', name: '插入手写区域', editorCheckCallback: (checking, _editor, info) => {
      if (!(info instanceof MarkdownView)) return false;
      if (!checking) this.pickRegion(info); return true;
    } });
    const schedule = () => {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.refreshTools(), 0);
    };
    this.registerEvent(app.workspace.on('layout-change', schedule));
    this.registerEvent(app.workspace.on('file-open', schedule));
    this.registerEvent(app.workspace.on('active-leaf-change', schedule));
    this.registerEvent(app.vault.on('create', () => this.changed()));
    this.registerEvent(app.vault.on('modify', file => { this.summaries.delete(file.path); this.changed(); }));
    this.registerEvent(app.vault.on('rename', () => { this.summaries.clear(); this.changed(); schedule(); }));
    this.registerEvent(app.vault.on('delete', () => { this.summaries.clear(); this.changed(); }));
    this.registerEvent(app.workspace.on('editor-change', () => this.changed()));
    this.registerEvent(app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && ['md', 'inknote'].includes(file.extension)) menu.addItem(item => item.setTitle('PageInk 笔记属性…').setIcon('sliders-horizontal').onClick(() => this.run(() => this.properties(file.path))));
    }));
    app.workspace.onLayoutReady(() => { if (!this.disposed) this.refreshTools(); });
  }
  onunload() { this.disposed = true; clearTimeout(this.refreshTimer); this.tools.clear(); this.listeners.clear(); this.summaries.clear(); }
  private refreshTools() {
    if (this.disposed) return;
    const views = new Set(this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView));
    for (const [view, tools] of this.tools) if (!views.has(view)) { this.removeChild(tools); this.tools.delete(view); }
    for (const view of views) {
      if (!this.tools.has(view)) this.tools.set(view, this.addChild(new MarkdownTools(view, this)));
      this.tools.get(view)!.update();
    }
  }
  async openLibrary() {
    const navigation = ++this.navigation;
    const existing = this.app.workspace.getLeavesOfType(LIBRARY_VIEW)[0];
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    if (!existing) await leaf.setViewState({ type: LIBRARY_VIEW, active: true });
    if (this.disposed || navigation !== this.navigation) return;
    await this.app.workspace.revealLeaf(leaf);
    if (this.disposed || navigation !== this.navigation) return;
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    requestAnimationFrame(() => {
      if (!this.disposed && navigation === this.navigation && this.app.workspace.activeLeaf === leaf) {
        (leaf.view.containerEl.querySelector('.ink-library-search input') as HTMLInputElement | null)?.focus();
      }
    });
  }
  open = async (path: string, target?: NoteTarget) => {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw Error('文件已移动、删除，或尚未同步到这台设备。请刷新笔记库。');
    const navigation = ++this.navigation;
    let existing: WorkspaceLeaf | undefined;
    this.app.workspace.iterateAllLeaves(leaf => { if (leaf.view instanceof FileView && leaf.view.file === file) existing ??= leaf; });
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    if (!existing) await leaf.openFile(file, { active: true, eState: target?.pdfPage ? { subpath: `#page=${target.pdfPage}` } : undefined });
    if (this.disposed || navigation !== this.navigation) return;
    await this.app.workspace.revealLeaf(leaf);
    if (this.disposed || navigation !== this.navigation) return;
    this.app.workspace.setActiveLeaf(leaf, { focus: true }); this.refreshTools();
    if (target?.page) await this.actions.reveal(path, target);
    else if (target?.pdfPage && existing) leaf.setEphemeralState({ subpath: `#page=${target.pdfPage}` });
    else if (target?.line !== undefined && leaf.view instanceof MarkdownView) {
      if (leaf.view.getMode() !== 'source') {
        const state = leaf.getViewState(); await leaf.setViewState({ ...state, state: { ...state.state, mode: 'source' } });
      }
      if (this.disposed || navigation !== this.navigation || this.app.workspace.activeLeaf !== leaf) return;
      const editor = (leaf.view as MarkdownView).editor, line = Math.min(target.line, editor.lastLine());
      const from = { line, ch: 0 }, to = { line, ch: editor.getLine(line).length };
      editor.setSelection(from, to); editor.scrollIntoView({ from, to }, true); editor.focus();
    }
  };
  async list(signal: AbortSignal): Promise<NoteEntry[]> {
    const files = this.app.vault.getFiles().filter(file => ['md', 'inknote', 'pdf'].includes(file.extension));
    const entries: NoteEntry[] = [];
    // Small batches avoid unbounded vault reads. Only lightweight summaries are cached.
    for (let i = 0; i < files.length; i += 12) {
      signal.throwIfAborted();
      const batch = await Promise.all(files.slice(i, i + 12).map(async file => {
        const entry: NoteEntry = { path: file.path, name: file.basename, modified: file.stat.mtime, kind: file.extension === 'md' ? 'text' : 'pdf' };
        if (file.extension !== 'inknote') return entry;
        let summary = this.summaries.get(file.path);
        if (!summary || summary.modified !== file.stat.mtime || summary.size !== file.stat.size) {
          const modified = file.stat.mtime, size = file.stat.size;
          try {
            const manifest = parseManifest(await this.app.vault.read(file));
            summary = { modified, size, kind: manifest.mode, detail: manifest.mode === 'pages' ? `${manifest.pages.length} 页` : undefined };
          } catch (e) { summary = { modified, size, kind: 'unavailable', detail: (e as Error).message }; }
          if (!signal.aborted) this.summaries.set(file.path, summary);
        }
        return { ...entry, kind: summary.kind, detail: summary.detail };
      }));
      signal.throwIfAborted(); entries.push(...batch);
    }
    return entries;
  }

  /** An async chooser must not write to another file or a selection that changed underneath it. */
  private insertion(view: MarkdownView) {
    if (!view.file || view.getMode() !== 'source') return null;
    const file = view.file, editor = view.editor, original = editor.getValue();
    const from = editor.getCursor('from'), to = editor.getCursor('to');
    return { file, insert: async (text: string, block = false) => {
      if (this.disposed || view.leaf.view !== view || view.file !== file || view.getMode() !== 'source' || editor.getValue() !== original) {
        throw Error('笔记或正文已变化，请回到需要插入的位置再试一次。');
      }
      const addition = block ? blockInsertion(original.slice(0, editor.posToOffset(from)), original.slice(editor.posToOffset(to)), text) : text;
      editor.replaceRange(addition, from, to); editor.focus();
      // TextFileView owns persistence; do not call Vault.modify on an open editor.
      await view.save();
    } };
  }
  pickLink(view: MarkdownView) {
    const target = this.insertion(view); if (!target) return;
    const files = this.app.vault.getFiles().filter(file => ['md', 'inknote', 'pdf', 'canvas'].includes(file.extension)).sort((a, b) => b.stat.mtime - a.stat.mtime);
    new Picker(this.app, '选择要链接的笔记', files, file => file.path, async file => {
      if (this.app.vault.getAbstractFileByPath(file.path) !== file) throw Error('引用的文件已删除，请重新选择。');
      await target.insert(this.app.fileManager.generateMarkdownLink(file, target.file.path));
    }).open();
  }
  pickRegion(view: MarkdownView) {
    const target = this.insertion(view); if (!target) return;
    const files = this.app.vault.getFiles().filter(file => file.extension === 'inknote').sort((a, b) => b.stat.mtime - a.stat.mtime);
    if (!files.length) { new Notice('先在手札或长卷中为一处内容加书签，再来插入这块区域。'); return; }
    new Picker(this.app, '选择手札、长卷或 PDF 批注', files, file => file.path, async file => {
      await this.actions.flushDrawing(file.path);
      const manifest = parseManifest(await this.app.vault.read(file));
      if (!manifest.regions.length) { new Notice('这份笔记还没有区域书签。打开笔记，圈选内容后选择「加书签」，再回到这里插入。'); return; }
      new Picker<Region>(this.app, '选择要插入的手写区域', manifest.regions, region => region.title, async region => {
        if (this.app.vault.getAbstractFileByPath(file.path) !== file) throw Error('手写笔记已删除，请重新选择。');
        // The real Markdown link participates in Obsidian's metadata and rename handling.
        const link = this.app.fileManager.generateMarkdownLink(file, target.file.path);
        await target.insert(link + '\n\n' + drawingRegionCode({ document: manifest.id, file: file.path, region: region.id }), true);
      }).open();
    }).open();
  }
}

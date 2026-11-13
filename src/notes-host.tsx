import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { App, Component, FileView, FuzzySuggestModal, ItemView, MarkdownView, Notice, Plugin, Scope, TFile, TFolder, Menu, WorkspaceLeaf, ViewStateResult, setIcon } from 'obsidian';
import { Library, LibraryHost } from './Library';
import { blockInsertion, drawingRegionCode, NOTE_TYPES, NoteCreateKind, NoteEntry } from './notes';
import { parseManifest, Region } from './model';
import { ErrorBoundary } from './ui';
import { LibrarySearchState, NoteTarget, scanLibrary, SearchSegment } from './library-search';

const LIBRARY_VIEW = 'pageink-library';
export interface NotesActions {
  create(kind?: NoteCreateKind, folder?: string): Promise<void>;
  preview(entry: NoteEntry, signal: AbortSignal): Promise<{ image?: string; text?: string }>;
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
    this.navigation = true;
    this.scope = new Scope(this.app.scope);
    // The library owns Find and Escape. Let its DOM controls handle these keys
    // instead of inheriting the host's Escape shortcut that returns to the editor.
    this.scope.register([], 'Escape', () => {});
    this.scope.register(['Mod'], 'f', () => {});
  }
  getViewType() { return LIBRARY_VIEW; }
  getDisplayText() { return this.folder === '/' ? this.app.vault.getName() : this.folder.split('/').pop()!; }
  folder = '/';
  private display: 'grid' | 'list' = 'grid';
  private search = false;
  getState() { return { folder: this.folder, display: this.display, search: this.search }; }
  async setState(state: Record<string, unknown>, result: ViewStateResult) {
    const path = typeof state.folder === 'string' && state.folder ? state.folder : '/';
    this.folder = this.app.vault.getAbstractFileByPath(path) instanceof TFolder ? path : '/';
    if (state.display === 'list' || state.display === 'grid') this.display = state.display;
    this.search = !!state.search;
    this.host.selectFolder(this.folder);
    this.render(); result.history = true; await super.setState(state, result);
    this.containerEl.querySelector('.view-header-title')?.setText(this.getDisplayText());
  }
  navigate = (folder: string) => this.leaf.setViewState({ type: LIBRARY_VIEW, state: { ...this.getState(), folder, search: false } });
  getIcon() { return 'layout-grid'; }
  async onOpen() {
    this.contentEl.addClass('ink-view');
    this.root = createRoot(this.contentEl);
    this.render();
  }
  private render() { this.root?.render(<ErrorBoundary key={this.renderVersion} onReload={() => { this.renderVersion++; this.render(); }}><Library key={`${this.folder}:${this.search}`} host={this.host} folder={this.folder} onFolder={this.navigate} initialSearch={this.search} display={this.display} onDisplay={display => { this.display = display; this.app.workspace.requestSaveLayout(); this.render(); }}/></ErrorBoundary>); }
  async onClose() { this.root?.unmount(); this.root = undefined; }
}

/** Obsidian-facing services for the shared library and native text workspace. */
export class NotesHost extends Component implements LibraryHost {
  private listeners = new Set<() => void>();
  private summaries = new Map<string, { modified: number; size: number; kind: NoteEntry['kind']; detail?: string }>();
  private disposed = false;
  private navigation = 0;
  private explorers = new Map<HTMLElement, () => void>();
  private selectedFolder?: string;
  private contentLeaf?: WorkspaceLeaf;
  constructor(private plugin: Plugin, private actions: NotesActions) { super(); }
  private get app() { return this.plugin.app; }
  run(task: () => unknown) { void Promise.resolve().then(task).catch(e => new Notice((e as Error).message)); }
  create = (kind?: NoteCreateKind, folder?: string) => this.actions.create(kind, folder);
  preview = (entry: NoteEntry, signal: AbortSignal) => this.actions.preview(entry, signal);
  selectFolder = (path: string) => { this.selectedFolder = path; };
  folderName = () => this.app.vault.getName();
  folders = (path: string) => {
    const folder = this.app.vault.getAbstractFileByPath(path || "/");
    return folder instanceof TFolder ? folder.children.filter((f): f is TFolder => f instanceof TFolder).map(f => ({ path: f.path, name: f.name })).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")) : [];
  };
  fileMenu = (path: string, event: MouseEvent) => {
    const file = this.app.vault.getAbstractFileByPath(path); if (!file) return;
    const menu = new Menu();
    if (file instanceof TFile) {
      menu.addItem(item => item.setTitle("在新标签页打开").setIcon("file-plus").onClick(() => this.run(() => this.open(path, undefined, "tab"))));
      menu.addItem(item => item.setTitle("在右侧打开").setIcon("separator-vertical").onClick(() => this.run(() => this.open(path, undefined, "split"))));
    }
    // Host dialogs keep rename/link updates and deletion preferences consistent with the tree.
    const manager = this.app.fileManager as typeof this.app.fileManager & { promptForFileRename?: (file: import('obsidian').TAbstractFile) => void; promptForDeletion?: (file: import('obsidian').TAbstractFile) => void };
    if (manager.promptForFileRename) menu.addItem(item => item.setTitle('重命名').setIcon('pencil').onClick(() => manager.promptForFileRename!(file)));
    if (manager.promptForDeletion) menu.addItem(item => item.setTitle('删除').setIcon('trash').onClick(() => manager.promptForDeletion!(file)));
    this.app.workspace.trigger("file-menu", menu, file, "pageink-folder");
    menu.showAtMouseEvent(event);
  };
  daily = () => this.actions.daily();
  properties = (path: string) => this.actions.properties(path);
  search = (entries: NoteEntry[], query: string, signal: AbortSignal, progress: (state: LibrarySearchState) => void) =>
    scanLibrary(entries, query, signal, (entry, task) => this.actions.segments(entry, task), progress);
  quickOpen = () => this.run(async () => {
    if ((this.app as App & { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById("switcher:open")) return;
    const entries = await this.list(new AbortController().signal);
    if (this.disposed) return;
    new Picker(this.app, '查找文字笔记、手写笔记、无边画布或 PDF', entries.sort((a, b) => b.modified - a.modified), entry => entry.path, entry => this.open(entry.path)).open();
  });
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { for (const listener of this.listeners) listener(); }

  onload() {
    const { app, plugin } = this;
    plugin.registerView(LIBRARY_VIEW, leaf => new LibraryView(leaf, this));
    plugin.addCommand({ id: 'open-library', name: '浏览当前文件夹', callback: () => this.run(() => this.openLibrary()) });
    plugin.addCommand({ id: 'search-library', name: '搜索笔记内容（含绘写与 PDF）', callback: () => this.run(() => this.openLibrary('/', true)) });
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
    plugin.addCommand({ id: 'insert-note-link', name: '插入笔记链接', editorCheckCallback: (checking, _editor, info) => {
      if (!(info instanceof MarkdownView)) return false;
      if (!checking) this.pickLink(info); return true;
    } });
    this.registerEvent(app.workspace.on('editor-menu', (menu, _editor, info) => {
      if (!(info instanceof MarkdownView) || info.getMode() !== 'source') return;
      menu.addItem(item => item.setTitle('插入手写区域').setIcon('notebook-pen').onClick(() => this.pickRegion(info)));
    }));
    this.registerEvent(app.vault.on('create', () => this.changed()));
    this.registerEvent(app.vault.on('modify', file => { this.summaries.delete(file.path); this.changed(); }));
    this.registerEvent(app.vault.on('rename', (file, oldPath) => { this.summaries.clear(); this.changed(); this.relocateFolders(file, oldPath); }));
    this.registerEvent(app.vault.on('delete', () => { this.summaries.clear(); this.changed(); this.relocateFolders(); }));
    this.registerEvent(app.workspace.on('editor-change', () => this.changed()));
    this.registerEvent(app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFolder) menu.addItem(item => item.setTitle('以缩略图浏览').setIcon('layout-grid').onClick(() => this.run(() => this.openLibrary(file.path))));
      if (file instanceof TFile && ['inknote'].includes(file.extension)) menu.addItem(item => item.setTitle('笔记属性…').setIcon('sliders-horizontal').onClick(() => this.run(() => this.properties(file.path))));
    }));
    this.registerEvent(app.workspace.on('layout-change', () => this.mountExplorers()));
    this.registerEvent(app.workspace.on('active-leaf-change', leaf => {
      if (leaf?.view instanceof LibraryView || leaf?.view instanceof FileView) this.contentLeaf = leaf;
    }));
    this.registerEvent(app.workspace.on('file-open', file => { if (file) this.selectedFolder = file.parent?.path; }));
    app.workspace.onLayoutReady(() => this.mountExplorers());
  }
  onunload() { this.disposed = true; for (const cleanup of this.explorers.values()) cleanup(); this.explorers.clear(); this.listeners.clear(); this.summaries.clear(); }
  /** The file explorer has no public toolbar extension API. Keep its DOM adapter local and reversible. */
  private mountExplorers() {
    if (this.disposed) return;
    const roots = new Set(this.app.workspace.getLeavesOfType('file-explorer').map(leaf => leaf.view.containerEl));
    for (const [root, cleanup] of this.explorers) if (!roots.has(root)) { cleanup(); this.explorers.delete(root); }
    for (const root of roots) {
      if (this.explorers.has(root)) continue;
      const toolbar = root.querySelector<HTMLElement>('.nav-buttons-container');
      const create = toolbar?.querySelector<HTMLElement>('.nav-action-button');
      if (!toolbar || !create) continue;
      const original = new Map(['aria-label', 'role', 'tabindex'].map(name => [name, create.getAttribute(name)]));
      create.setAttribute('aria-label', '新建笔记');
      create.setAttribute('role', 'button'); create.tabIndex = 0;
      const browse = toolbar.createEl('button', { cls: 'clickable-icon nav-action-button ink-folder-action', attr: { type: 'button', 'aria-label': '以缩略图浏览', title: '以缩略图浏览' } });
      setIcon(browse, 'layout-grid');
      const folder = () => this.selectedFolder ?? this.app.workspace.getActiveFile()?.parent?.path ?? '/';
      browse.onclick = () => this.run(() => this.openLibrary(folder()));
      const click = (event: MouseEvent) => {
        const target = event.target as HTMLElement;
        if (create.contains(target)) {
          event.preventDefault(); event.stopImmediatePropagation();
          const path = folder(), menu = new Menu();
          for (const kind of ['text', 'pages', 'canvas'] as const) menu.addItem(item => item.setTitle(`新建${NOTE_TYPES[kind].label}`).setIcon(NOTE_TYPES[kind].hostIcon).onClick(() => this.run(() => this.create(kind, path))));
          menu.addSeparator();
          menu.addItem(item => item.setTitle('纸张设置与导入…').setIcon('import').onClick(() => this.run(() => this.create(undefined, path))));
          const rect = create.getBoundingClientRect(); menu.showAtPosition({ x: rect.left, y: rect.bottom });
          return;
        }
        const path = target.closest<HTMLElement>('.nav-folder-title[data-path]')?.dataset.path;
        if (!path) return;
        this.selectedFolder = path;
        const active = this.contentLeaf?.view;
        if (active instanceof LibraryView) this.run(async () => {
          await active.navigate(path);
          this.app.workspace.setActiveLeaf(active.leaf, { focus: false });
        });
      };
      const keydown = (event: KeyboardEvent) => {
        if (event.target === create && !event.isComposing && ['Enter', ' '].includes(event.key)) {
          event.preventDefault(); event.stopImmediatePropagation(); create.click();
        }
      };
      root.addEventListener('click', click, true);
      root.addEventListener('keydown', keydown, true);
      this.explorers.set(root, () => {
        root.removeEventListener('click', click, true); root.removeEventListener('keydown', keydown, true); browse.remove();
        for (const [name, value] of original) { if (value === null) create.removeAttribute(name); else create.setAttribute(name, value); }
      });
    }
  }
  private relocateFolders(file?: import('obsidian').TAbstractFile, oldPath?: string) {
    if (this.selectedFolder) {
      if (file instanceof TFolder && oldPath && (this.selectedFolder === oldPath || this.selectedFolder.startsWith(oldPath + '/'))) this.selectedFolder = file.path + this.selectedFolder.slice(oldPath.length);
      if (!(this.app.vault.getAbstractFileByPath(this.selectedFolder) instanceof TFolder)) this.selectedFolder = '/';
    }
    for (const leaf of this.app.workspace.getLeavesOfType(LIBRARY_VIEW)) {
      const view = leaf.view as LibraryView;
      let folder = view.folder;
      if (file instanceof TFolder && oldPath && (folder === oldPath || folder.startsWith(oldPath + '/'))) folder = file.path + folder.slice(oldPath.length);
      if (!(this.app.vault.getAbstractFileByPath(folder || '/') instanceof TFolder)) folder = '/';
      if (folder !== view.folder) this.run(() => view.navigate(folder));
    }
  }
  async openLibrary(folder?: string, search = false) {
    const navigation = ++this.navigation;
    const current = this.app.workspace.getActiveFile();
    folder ??= this.selectedFolder ?? current?.parent?.path ?? '/';
    this.selectedFolder = folder;
    const existing = this.app.workspace.getLeavesOfType(LIBRARY_VIEW)[0];
    const leaf = existing ?? this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: LIBRARY_VIEW, active: true, state: { folder, search } });
    if (this.disposed || navigation !== this.navigation) return;
    await this.app.workspace.revealLeaf(leaf);
    if (this.disposed || navigation !== this.navigation) return;
    this.contentLeaf = leaf;
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    if (search) window.requestAnimationFrame(() => {
      if (!this.disposed && navigation === this.navigation && this.app.workspace.getMostRecentLeaf() === leaf)
        leaf.view.containerEl.querySelector<HTMLInputElement>('.ink-library-search input')?.focus();
    });
  }
  open = async (path: string, target?: NoteTarget, destination?: "tab" | "split") => {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw Error('文件已移动、删除，或尚未同步到这台设备。请刷新笔记库。');
    const navigation = ++this.navigation;
    let existing: WorkspaceLeaf | undefined;
    this.app.workspace.iterateAllLeaves(leaf => { if (!destination && leaf.view instanceof FileView && leaf.view.file === file) existing ??= leaf; });
    const leaf = existing ?? this.app.workspace.getLeaf(destination ?? false);
    if (!existing) await leaf.openFile(file, { active: true, eState: target?.pdfPage ? { subpath: `#page=${target.pdfPage}` } : undefined });
    if (this.disposed || navigation !== this.navigation) return;
    await this.app.workspace.revealLeaf(leaf);
    if (this.disposed || navigation !== this.navigation) return;
    this.contentLeaf = leaf;
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    if (target?.page) await this.actions.reveal(path, target);
    else if (target?.pdfPage && existing) leaf.setEphemeralState({ subpath: `#page=${target.pdfPage}` });
    else if (target?.line !== undefined && leaf.view instanceof MarkdownView) {
      if (leaf.view.getMode() !== 'source') {
        const state = leaf.getViewState(); await leaf.setViewState({ ...state, state: { ...state.state, mode: 'source' } });
      }
      if (this.disposed || navigation !== this.navigation || this.app.workspace.getMostRecentLeaf() !== leaf) return;
      const editor = (leaf.view).editor, line = Math.min(target.line, editor.lastLine());
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
    if (!files.length) { new Notice('先在手写笔记或无边画布中为一处内容加书签，再来插入这块区域。'); return; }
    new Picker(this.app, '选择手写笔记、无边画布或 PDF 批注', files, file => file.path, async file => {
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

import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Plugin, FileView, WorkspaceLeaf, TFile, TFolder, Notice, Modal, normalizePath, FuzzySuggestModal, MarkdownRenderChild, Menu, setIcon } from 'obsidian';
import { DocumentStore, FileIO, ensureDir, forkDocument } from './storage';
import { newManifest, newPage, digest, parseManifest, safePath, Manifest, PageTemplate, Rect } from './model';
import { Session } from './session';
import { PdfService } from './pdf';
import { Workspace } from './Workspace';
import { unpack } from './export';
import { renderArea } from './preview';
import { clearInkFontFaces } from './kernel-assets';
import { assetUrl, clearAssetUrls } from './assets';
import { normalizePreferences, PreferenceStore } from './preferences';
import { ErrorBoundary } from './ui';
import { TEMPLATES, paperStyle } from './templates';
import type { ViewMemory, WorkspaceActions, WorkspaceHost } from './host';
import { NotesHost } from './notes-host';
import { drawingRegionCode, NOTE_TYPES } from './notes';
import { MixedNotes } from './mixed-host';
import { BoardSources } from './cards-host';
import { LibrarySources } from './library-search-host';
import { dailyNotePath } from './library-search';
import { NoteProperties } from './properties-host';

const VIEW = 'drawing-local-view';
const EXPORT_FOLDER = 'Drawing Exports';

class VaultIO implements FileIO {
  constructor(private plugin: DrawingPlugin) {}
  private get adapter() { return this.plugin.app.vault.adapter; }
  read(path: string) { return this.adapter.read(normalizePath(path)); }
  write(path: string, data: string) { return this.adapter.write(normalizePath(path), data); }
  readBinary(path: string) { return this.adapter.readBinary(normalizePath(path)); }
  writeBinary(path: string, data: ArrayBuffer) { return this.adapter.writeBinary(normalizePath(path), data); }
  exists(path: string) { return this.adapter.exists(normalizePath(path)); }
  mkdir(path: string) { return this.adapter.mkdir(normalizePath(path)); }
  remove(path: string) { return this.adapter.remove(normalizePath(path)); }
  async list(path: string) { return (await this.adapter.list(normalizePath(path))).files; }
}

class PdfPicker extends FuzzySuggestModal<TFile> {
  constructor(plugin: DrawingPlugin, placeholder: string, private selected: (file: TFile) => Promise<void>) { super(plugin.app); this.setPlaceholder(placeholder); }
  getItems() { return this.app.vault.getFiles().filter(f => f.extension === 'pdf').sort((a, b) => b.stat.mtime - a.stat.mtime); }
  getItemText(file: TFile) { return file.path; }
  onChooseItem(file: TFile) { void this.selected(file).catch(e => new Notice((e as Error).message)); }
}

/** One-click creation: pick a paper or the infinite canvas; the name is optional. */
class CreateModal extends Modal {
  constructor(private plugin: DrawingPlugin, private folder?: string, private initial: 'text' | 'pages' = 'text') { super(plugin.app); }
  onOpen() {
    this.modalEl.addClass('ink-host-modal', 'ink-create-modal');
    this.titleEl.setText('新建笔记');
    const content = this.contentEl;
    content.createEl('p', { cls: 'ink-create-intro', text: `保存到 ${this.plugin.newFolder(this.folder) || this.app.vault.getName()}` });
    const options = content.createEl('details', { cls: 'ink-create-options' });
    options.createEl('summary', { text: '名称与纸张（可选）' });
    const nameLabel = options.createEl('label', { cls: 'ink-create-name-label', text: '笔记名称' });
    const name = nameLabel.createEl('input', { type: 'text', cls: 'ink-create-name', attr: { placeholder: '为这份笔记取个名字', autocomplete: 'off' } });
    let template = this.plugin.prefs.get().newTemplate, busy = false;
    const error = content.createDiv({ cls: 'ink-create-error', attr: { role: 'alert' } });
    const go = async (task: () => Promise<void>) => {
      if (busy) return; busy = true; error.empty(); content.setAttribute('aria-busy', 'true');
      const buttons = [...content.querySelectorAll('button')]; buttons.forEach(button => button.disabled = true);
      try { await task(); this.close(); }
      catch (e) { error.setText((e as Error).message); }
      finally { busy = false; content.removeAttribute('aria-busy'); buttons.forEach(button => button.disabled = false); }
    };
    const modes = content.createDiv({ cls: 'ink-create-modes' });
    const text = modes.createEl('button', { cls: 'ink-create-mode', attr: { type: 'button', 'aria-label': `新建${NOTE_TYPES.text.label}`, 'aria-description': NOTE_TYPES.text.description } });
    setIcon(text.createSpan({ cls: 'ink-create-glyph', attr: { 'aria-hidden': 'true' } }), NOTE_TYPES.text.hostIcon);
    text.createEl('strong', { text: NOTE_TYPES.text.label });
    text.createSpan({ text: NOTE_TYPES.text.description, cls: 'ink-create-description' });
    const textAction = text.createDiv({ cls: 'ink-create-mode-action', text: NOTE_TYPES.text.action }); setIcon(textAction.createSpan(), 'arrow-right');
    text.onclick = () => void go(() => this.plugin.createText(name.value, this.folder));
    const notebook = modes.createEl('button', { cls: 'ink-create-mode', attr: { type: 'button', 'aria-label': `新建${NOTE_TYPES.pages.label}`, 'aria-description': NOTE_TYPES.pages.description } });
    setIcon(notebook.createSpan({ cls: 'ink-create-glyph', attr: { 'aria-hidden': 'true' } }), NOTE_TYPES.pages.hostIcon);
    notebook.createEl('strong', { text: NOTE_TYPES.pages.label });
    notebook.createSpan({ text: NOTE_TYPES.pages.description, cls: 'ink-create-description' });
    const notebookAction = notebook.createDiv({ cls: 'ink-create-mode-action', text: NOTE_TYPES.pages.action }); setIcon(notebookAction.createSpan(), 'arrow-right');
    notebook.onclick = () => void go(() => this.plugin.create('pages', { template, title: name.value, folder: this.folder }));

    const canvas = modes.createEl('button', { cls: 'ink-create-mode', attr: { type: 'button', 'aria-label': `新建${NOTE_TYPES.canvas.label}`, 'aria-description': NOTE_TYPES.canvas.description } });
    setIcon(canvas.createSpan({ cls: 'ink-create-glyph', attr: { 'aria-hidden': 'true' } }), NOTE_TYPES.canvas.hostIcon);
    canvas.createEl('strong', { text: NOTE_TYPES.canvas.label });
    canvas.createSpan({ text: NOTE_TYPES.canvas.description, cls: 'ink-create-description' });
    const canvasAction = canvas.createDiv({ cls: 'ink-create-mode-action', text: NOTE_TYPES.canvas.action }); setIcon(canvasAction.createSpan(), 'arrow-right');
    canvas.onclick = () => void go(() => this.plugin.create('canvas', { title: name.value, folder: this.folder }));

    content.appendChild(options);
    const paperSection = options.createDiv({ cls: 'ink-create-paper-section' });
    paperSection.createSpan({ text: `${NOTE_TYPES.pages.label}纸张` });
    const papers = paperSection.createDiv({ cls: 'ink-create-grid', attr: { role: 'radiogroup', 'aria-label': '新笔记纸张' } });
    for (const option of TEMPLATES) {
      const card = papers.createEl('button', { cls: 'ink-create-card', attr: { type: 'button', role: 'radio', tabindex: option.id === template ? '0' : '-1', 'aria-checked': String(option.id === template), 'aria-label': option.label } });
      Object.assign(card.createSpan({ cls: 'ink-create-paper-chip', attr: { 'aria-hidden': 'true' } }).style, paperStyle(option.id));
      card.createSpan({ text: option.label });
      card.onclick = () => {
        template = option.id;
        for (const button of papers.querySelectorAll('button')) { button.setAttribute('aria-checked', String(button === card)); button.tabIndex = button === card ? 0 : -1; }
      };
    }
    papers.addEventListener('keydown', event => {
      if (event.isComposing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...papers.querySelectorAll('button')], index = buttons.indexOf(event.target as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus(); buttons[next]?.click();
    });
    name.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); (this.initial === 'text' ? text : notebook).click(); } });
    const files = content.createDiv({ cls: 'ink-create-links' });
    const link = (icon: string, text: string, hint: string, run: () => void) => {
      const button = files.createEl('button', { attr: { type: 'button' } }); setIcon(button.createSpan({ cls: 'ink-create-file-icon' }), icon);
      const label = button.createSpan(); label.createEl('strong', { text }); label.createEl('small', { text: hint }); button.onclick = run;
    };
    link('file-text', '批注 PDF', '从当前笔记库选择', () => { this.close(); this.plugin.pickVaultPdf(); });
    link('file-up', '导入 PDF', '从设备选择文件', () => this.plugin.chooseFile('.pdf', file => go(async () => { await this.plugin.importPdf(file.name, await file.arrayBuffer()); })));
    link('archive-restore', '恢复备份', '打开 .inkpack 文件', () => this.plugin.chooseFile('.inkpack,.zip', file => go(() => this.plugin.restorePackage(file))));
    (this.initial === 'text' ? text : notebook).focus();
  }
  onClose() { this.contentEl.empty(); }
}

class DrawingView extends FileView implements WorkspaceHost {
  root?: Root; session?: Session; pdf?: PdfService; generation = 0;
  actions: WorkspaceActions | null = null;
  private unloading?: Promise<void>;
  private viewTimer?: ReturnType<typeof setTimeout>;
  text = new MixedNotes(this.app, () => this.leaf);
  cards: BoardSources;
  constructor(leaf: WorkspaceLeaf, private plugin: DrawingPlugin) {
    super(leaf);
    this.cards = new BoardSources(this.app, { io: plugin.io, live: path => plugin.views().find(v => v.file?.path === path)?.session,
      resolve: (path, id) => plugin.resolveDocument(path, id), reveal: (path, page, region) => plugin.reveal(path, page, region),
      unique: title => plugin.uniquePath(title, 'inknote') });
  }
  get prefs() { return this.plugin.prefs; }
  getViewType() { return VIEW; }
  getIcon() { return 'pencil'; }
  getDisplayText() { return this.file?.basename ?? '绘写笔记'; }
  onPaneMenu(menu: Menu, source: string) {
    super.onPaneMenu(menu, source);
    if (!this.session) return;
    menu.addItem(item => item.setSection('action').setTitle('导出 PDF').setIcon('file-output').onClick(() => this.actions?.exportPdf()));
    menu.addItem(item => item.setSection('action').setTitle('可编辑备份（.inkpack）').setIcon('package').onClick(() => this.actions?.exportPackage()));
    menu.addItem(item => item.setSection('action').setTitle('历史版本…').setIcon('history').onClick(() => this.showVersions()));
    if (this.session.manifest.pdf) menu.addItem(item => item.setSection('action').setTitle('重新关联原 PDF…').setIcon('link').onClick(() => this.relinkSource()));
  }
  async onLoadFile(file: TFile) {
    const generation = ++this.generation;
    await this.unloading;
    // A detached leaf unloads asynchronously. A new leaf must wait for that file's
    // final save and React cleanup before reading it or recovering its failed session.
    await this.plugin.closingViews.get(file.path);
    if (generation !== this.generation) return;
    this.contentEl.empty(); this.contentEl.addClass('ink-view');
    this.contentEl.createDiv({ cls: 'ink-view-loading' }).createSpan({ cls: 'ink-spinner' });
    try {
      const session = this.plugin.unsavedSessions.get(file.path) ?? new Session(await DocumentStore.open(this.plugin.io, file.path));
      let pdf: PdfService | undefined;
      if (session.manifest.pdf) {
        try { pdf = await PdfService.open(this.plugin.io, session.manifest.pdf); session.sourceIssue = ''; }
        catch (error) { session.sourceIssue = (error as Error).message; }
      }
      if (generation !== this.generation) { await pdf?.destroy(); return; }
      this.plugin.unsavedSessions.delete(file.path);
      // Obsidian may empty contentEl before the asynchronous unload flush finishes.
      // A dedicated mount retains React's own child tree even after host detachment.
      this.session = session; this.pdf = pdf; this.contentEl.empty();
      this.root = createRoot(this.contentEl.createDiv({ cls: 'ink-react-root' }));
      this.root.render(<ErrorBoundary onReload={() => void this.reload()}><Workspace session={session} pdf={pdf} host={this}/></ErrorBoundary>);
    } catch (e) {
      if (generation !== this.generation) return;
      this.contentEl.empty();
      const box = this.contentEl.createDiv({ cls: 'ink-view-error' });
      box.createEl('strong', { text: '无法打开这个笔记' }); box.createEl('p', { text: (e as Error).message });
      const backup = `${file.path}.last-good.json`;
      if (await this.plugin.io.exists(backup) && generation === this.generation) {
        box.createEl('p', { text: '上一次完整保存的记录仍在，可以从中恢复一份副本。' });
        box.createEl('button', { text: '查看可恢复的版本', cls: 'mod-cta' }).onclick = () => void (async () => {
          await this.plugin.showRecovery(parseManifest(await this.plugin.io.read(backup)));
        })().catch(error => new Notice((error as Error).message));
      }
    }
  }
  async onUnloadFile() {
    ++this.generation;
    const session = this.session, root = this.root, pdf = this.pdf;
    if (session) this.saveViewNow();
    this.root = undefined; this.session = undefined; this.pdf = undefined; this.actions = null;
    const operation = (async () => {
      try { await session?.flush(); }
      catch (error) {
        if (session) this.plugin.unsavedSessions.set(session.store.path, session);
        new Notice(`关闭时保存失败，未保存的内容暂存在本次 Obsidian 会话中。请重新打开该笔记重试保存，不要退出 Obsidian。${(error as Error).message}`, 15000);
      } finally { root?.unmount(); await pdf?.destroy(); }
    })();
    const path = session?.store.path;
    const previous = path ? this.plugin.closingViews.get(path) : undefined;
    const closing = previous ? Promise.all([previous, operation]).then(() => {}) : operation;
    if (path) this.plugin.closingViews.set(path, closing);
    this.unloading = closing;
    try { await closing; } finally {
      if (this.unloading === closing) this.unloading = undefined;
      if (path && this.plugin.closingViews.get(path) === closing) this.plugin.closingViews.delete(path);
    }
  }
  async reload() { const file = this.file; if (!file) return; await this.onUnloadFile(); await this.onLoadFile(file); }

  // ---------- WorkspaceHost ----------
  openLibrary() { return this.plugin.notes.openLibrary(); }
  properties() { return this.file ? this.plugin.properties.open(this.file.path) : Promise.resolve(); }
  fileName() { return this.file?.basename ?? this.session?.manifest.title ?? '绘写笔记'; }
  async saveExport(name: string, extension: string, bytes: ArrayBuffer) {
    await ensureDir(this.plugin.io, EXPORT_FOLDER);
    const path = await this.plugin.uniquePath(name, extension, EXPORT_FOLDER);
    await this.plugin.io.writeBinary(path, bytes);
    return path;
  }
  async openFile(path: string) {
    const file = await this.plugin.waitForFile(path);
    await this.app.workspace.getLeaf('tab').openFile(file);
  }
  async copyLink({ page, region, embed }: { page?: string; region?: string; embed?: boolean }) {
    const session = this.session!, file = this.file!;
    if (embed) {
      if (!region) throw Error('请先选择需要嵌入的区域书签。');
      await navigator.clipboard.writeText(drawingRegionCode({ document: session.manifest.id, file: file.path, region }));
      return;
    }
    const uri = `obsidian://drawing-local?vault=${encodeURIComponent(this.app.vault.getName())}&document=${session.manifest.id}&file=${encodeURIComponent(file.path)}${page ? `&page=${page}` : ''}${region ? `&region=${region}` : ''}`;
    const index = session.manifest.pages.findIndex(p => p.id === page);
    const title = region ? session.manifest.regions.find(r => r.id === region)?.title ?? file.basename
      : session.manifest.mode === 'pages' && index >= 0 ? `${file.basename} · 第 ${index + 1} 页` : file.basename;
    await navigator.clipboard.writeText(`[${title.replace(/[[\]]/g, '')}](${uri})`);
  }
  async openSource(document: string, page: string, rect: Rect) { await this.plugin.reveal(await this.plugin.resolveDocument(undefined, document), page, undefined, rect); }
  async resolveConflict(openCopy: boolean) {
    const session = this.session!;
    const path = await session.preserveConflict(); session.conflictResolved = true;
    try { if (openCopy) await this.plugin.openPath(path); else await this.reload(); }
    catch (error) { session.conflictResolved = false; throw error; }
  }
  relinkSource() {
    const session = this.session; if (!session?.manifest.pdf) return;
    new PdfPicker(this.plugin, '选择同一份原 PDF（会核对文件内容）', async file => {
      const bytes = await this.app.vault.readBinary(file);
      if (await digest(bytes) !== session.manifest.pdf!.sha256) throw Error('这不是同一份 PDF（内容不同），旧批注没有迁移。改版教材请另建笔记。');
      session.manifest.pdf!.path = file.path; session.metadataChanged(); await session.flush();
      await this.reload(); new Notice('已重新关联原 PDF');
    }).open();
  }
  showVersions() { if (this.session) void this.plugin.showRecovery(this.session.manifest).catch(e => new Notice((e as Error).message)); }
  private viewKey() { return `pageink-view-${this.session?.manifest.id}`; }
  private pendingView?: ViewMemory;
  loadView() { const value = this.session && this.app.loadLocalStorage(this.viewKey()); return value && typeof value.zoom === 'number' ? value as ViewMemory : undefined; }
  saveView(view: ViewMemory) { this.pendingView = view; clearTimeout(this.viewTimer); this.viewTimer = setTimeout(() => this.saveViewNow(), 800); }
  private saveViewNow() { clearTimeout(this.viewTimer); if (this.pendingView && this.session) this.app.saveLocalStorage(this.viewKey(), this.pendingView); this.pendingView = undefined; }
  theme() { return document.body.classList.contains('theme-dark') ? 'dark' as const : 'light' as const; }
  onThemeChange(listener: () => void) { const ref = this.app.workspace.on('css-change', listener); return () => this.app.workspace.offref(ref); }
  connect(actions: WorkspaceActions) { this.actions = actions; return () => { if (this.actions === actions) this.actions = null; }; }
}

export default class DrawingPlugin extends Plugin {
  notes!: NotesHost;
  properties!: NoteProperties;
  private dailyTask?: Promise<void>;
  io = new VaultIO(this);
  unsavedSessions = new Map<string, Session>();
  closingViews = new Map<string, Promise<void>>();
  previewCache = new Map<string, HTMLCanvasElement>();
  prefs!: PreferenceStore;
  async onload() {
    this.prefs = new PreferenceStore(normalizePreferences(await this.loadData()), value => this.saveData(value));
    this.register(() => { this.prefs.flush(); clearInkFontFaces(); clearAssetUrls(); });
    const face = new FontFace('Ink Notebook Sans', `url("${assetUrl('fonts/NotoSansCJKsc-Regular.otf')}")`);
    await face.load(); document.fonts.add(face); this.register(() => document.fonts.delete(face));
    this.registerView(VIEW, leaf => new DrawingView(leaf, this));
    this.registerExtensions(['inknote'], VIEW);
    const live = (path: string) => this.views().find(view => view.file?.path === path)?.session ?? this.unsavedSessions.get(path);
    const sources = new LibrarySources(this.app, this.io, live);
    this.properties = new NoteProperties(this.app, this.io, live);
    this.register(() => this.properties.dispose());
    this.notes = this.addChild(new NotesHost(this, {
      create: async (kind, folder) => {
        if (kind === 'text') await this.createText('', folder);
        else if (kind) await this.create(kind, { folder });
        else new CreateModal(this, folder).open();
      },
      createText: () => void this.createText('').catch(e => new Notice((e as Error).message)),
      daily: () => this.openDaily(),
      properties: path => this.properties.open(path),
      preview: (entry, signal) => sources.preview(entry, signal),
      segments: (entry, signal) => sources.segments(entry, signal),
      reveal: (path, target) => this.reveal(path, target.page, target.region, target.rect),
      flushDrawing: async path => {
        const session = this.views().find(view => view.file?.path === path)?.session ?? this.unsavedSessions.get(path);
        await session?.flush();
      },
    }));
    const active = () => this.app.workspace.getActiveViewOfType(DrawingView);
    const withView = (run: (view: DrawingView) => void) => (checking: boolean) => { const view = active(); if (!view?.session) return false; if (!checking) run(view); return true; };
    this.addCommand({ id: 'new-drawing', name: '新建笔记…', callback: () => new CreateModal(this).open() });
    this.addCommand({ id: 'new-notebook', name: `新建${NOTE_TYPES.pages.label}`, callback: () => void this.create('pages').catch(e => new Notice(e.message)) });
    this.addCommand({ id: 'new-canvas', name: `新建${NOTE_TYPES.canvas.label}`, callback: () => void this.create('canvas').catch(e => new Notice(e.message)) });
    this.addCommand({ id: 'annotate-pdf', name: '批注库中的 PDF…', callback: () => this.pickVaultPdf() });
    this.addCommand({ id: 'import-pdf', name: '导入 PDF 并批注…', callback: () => this.chooseFile('.pdf', async file => this.importPdf(file.name, await file.arrayBuffer())) });
    this.addCommand({ id: 'restore-package', name: '从备份恢复（.inkpack）…', callback: () => this.chooseFile('.inkpack,.zip', file => this.restorePackage(file)) });
    this.addCommand({ id: 'export-pdf', name: '导出当前笔记为 PDF', checkCallback: withView(view => view.actions?.exportPdf()) });
    this.addCommand({ id: 'toggle-scratch', name: '打开/收起草稿纸', checkCallback: withView(view => view.actions?.toggleScratch()) });
    this.addCommand({ id: 'toggle-focus', name: '专注模式', checkCallback: withView(view => view.actions?.toggleFocus()) });
    this.addCommand({ id: 'search', name: '在当前笔记中搜索', checkCallback: withView(view => view.actions?.search()) });
    this.addCommand({ id: 'relink-source', name: '重新关联原 PDF…', checkCallback: (checking: boolean) => { const view = active(); if (!view?.session?.manifest.pdf) return false; if (!checking) view.relinkSource(); return true; } });
    this.addCommand({ id: 'restore-copy', name: '历史版本…', checkCallback: withView(view => view.showVersions()) });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'pdf') menu.addItem(item => item.setTitle('创建批注笔记').setIcon('pencil').onClick(() => { void this.importPdf(file.basename, undefined, file).catch(e => new Notice(e.message)); }));
      if (file instanceof TFolder) {
        menu.addItem(item => item.setTitle(`新建${NOTE_TYPES.text.label}`).setIcon(NOTE_TYPES.text.hostIcon).onClick(() => void this.createText('', file.path).catch(e => new Notice(e.message))));
        menu.addItem(item => item.setTitle(`新建${NOTE_TYPES.pages.label}`).setIcon(NOTE_TYPES.pages.hostIcon).onClick(() => void this.create('pages', { folder: file.path }).catch(e => new Notice(e.message))));
        menu.addItem(item => item.setTitle(`新建${NOTE_TYPES.canvas.label}`).setIcon(NOTE_TYPES.canvas.hostIcon).onClick(() => void this.create('canvas', { folder: file.path }).catch(e => new Notice(e.message))));
      }
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { void this.maintainPdfPath(oldPath, file.path).catch(e => new Notice(e.message)); }));
    this.registerEvent(this.app.vault.on('modify', file => {
      for (const view of this.views()) {
        const session = view.session;
        if (session?.manifest.pdf?.path === file.path) void (async () => {
          const identity = await digest(await this.io.readBinary(file.path));
          if (identity !== session.manifest.pdf!.sha256) { session.sourceIssue = '原 PDF 的内容变了。改版教材请另建笔记，或重新关联原来那份文件。'; session.notify(); }
        })().catch(e => { session.sourceIssue = e.message; session.notify(); });
      }
    }));
    this.registerEvent(this.app.vault.on('delete', file => {
      for (const view of this.views()) {
        const session = view.session, path = session?.manifest.pdf?.path;
        if (session && path && (path === file.path || path.startsWith(file.path + '/'))) { session.sourceIssue = '原 PDF 已删除，或还没有同步到这台设备。'; session.notify(); }
      }
    }));
    this.registerObsidianProtocolHandler('drawing-local', async params => {
      try {
        const path = await this.resolveDocument(params.file, params.document);
        await this.reveal(path, params.page, params.region);
      } catch (e) { new Notice((e as Error).message); }
    });
    this.registerMarkdownCodeBlockProcessor('drawing-region', async (source, el, context) => {
      const child = new MarkdownRenderChild(el); context.addChild(child);
      el.addClass('ink-embed');
      let controller = new AbortController(), timer: ReturnType<typeof setTimeout> | undefined, disposed = false, currentPath = '', sourcePath = '';
      child.register(() => { disposed = true; controller.abort(); clearTimeout(timer); });
      const render = async () => {
        controller.abort(); const task = new AbortController(); controller = task;
        try {
          const ref = JSON.parse(source), path = await this.resolveDocument(ref.file, ref.document); currentPath = path;
          const store = await DocumentStore.open(this.io, path), session = new Session(store);
          sourcePath = store.manifest.pdf?.path ?? '';
          const region = store.manifest.regions.find(r => r.id === ref.region);
          if (!region) throw Error('这个书签已删除，或还没有同步到这台设备。');
          const page = store.manifest.pages.find(p => p.id === region.pageId); if (!page) throw Error('书签所在的页面已删除。');
          const key = store.manifest.id + '/' + store.manifest.revision + '/' + region.id;
          let cached = this.previewCache.get(key);
          if (!cached) {
            const pdf = store.manifest.pdf ? await PdfService.open(this.io, store.manifest.pdf) : undefined;
            try { cached = await renderArea(session, page, region, Math.min(2, 1200 / Math.max(region.width, region.height)), pdf, task.signal); }
            finally { await pdf?.destroy(); }
            task.signal.throwIfAborted(); this.previewCache.set(key, cached);
            while (this.previewCache.size > 12) this.previewCache.delete(this.previewCache.keys().next().value!);
          }
          task.signal.throwIfAborted();
          const canvas = document.createElement('canvas'); canvas.width = cached.width; canvas.height = cached.height; canvas.getContext('2d')!.drawImage(cached, 0, 0);
          canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', region.title);
          const open = createEl('button', { cls: 'ink-embed-title', text: `${region.title} · ${store.manifest.title}` });
          open.onclick = () => void this.reveal(currentPath, region.pageId, region.id).catch(e => new Notice(e.message));
          el.replaceChildren(canvas, open);
        } catch (e) { if (!task.signal.aborted && !disposed) { el.empty(); el.createDiv({ cls: 'ink-embed-error', text: (e as Error).message }); } }
      };
      const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { if (!disposed) void render(); }, 500); };
      child.registerEvent(this.app.vault.on('modify', file => { if (file.path === currentPath) schedule(); else if (file.path === sourcePath) { this.previewCache.clear(); schedule(); } }));
      child.registerEvent(this.app.vault.on('rename', (file, oldPath) => { if (oldPath === currentPath) { currentPath = file.path; schedule(); } }));
      await render();
    });
  }

  views() { return this.app.workspace.getLeavesOfType(VIEW).map(leaf => leaf.view).filter((view): view is DrawingView => view instanceof DrawingView); }
  async resolveDocument(path?: string, id?: string) {
    if (path && await this.io.exists(path)) {
      const manifest = parseManifest(await this.io.read(path)); if (!id || manifest.id === id) return path;
    }
    if (id) for (const file of this.app.vault.getFiles().filter(f => f.extension === 'inknote')) {
      try { if (parseManifest(await this.io.read(file.path)).id === id) return file.path; } catch { /* An unrelated damaged note must not break all references. */ }
    }
    throw Error('找不到引用的笔记（可能已删除，或还没有同步到这台设备）。');
  }
  /** Opens a note and scrolls to a page, bookmark or rectangle once its editor is ready. */
  async reveal(path: string, page?: string, region?: string, rect?: Rect) {
    await this.openPath(path);
    if (!page) return;
    const view = this.views().find(v => v.file?.path === path);
    for (let i = 0; i < 100 && !view?.session; i++) await new Promise(resolve => setTimeout(resolve, 50));
    view?.session?.navigate(page, region, rect);
  }
  async showRecovery(manifest: Manifest) {
    const records = await new DocumentStore(this.io, '', manifest).recoveryRecords();
    if (!records.some(record => record.manifest.revision === manifest.revision)) records.unshift({ path: '', manifest });
    const modal = new Modal(this.app); modal.titleEl.setText('历史版本');
    modal.modalEl.addClass('ink-host-modal', 'ink-recovery-modal');
    modal.contentEl.createEl('p', { cls: 'ink-recovery-intro', text: '最近 20 次保存。恢复会另存为一份新笔记，当前笔记保持不变。' });
    const list = modal.contentEl.createDiv({ cls: 'ink-recovery-list' });
    for (const [index, record] of records.entries()) {
      const row = list.createDiv({ cls: 'ink-recovery-row' });
      const info = row.createDiv({ cls: 'ink-recovery-info' });
      info.createEl('strong', { text: new Date(record.manifest.modified).toLocaleString() });
      info.createSpan({ text: `${record.manifest.mode === 'pages' ? `${record.manifest.pages.length} 页` : '画布'}${index === 0 ? ' · 最新' : ''}` });
      row.createEl('button', { text: '恢复为副本' }).onclick = () => void (async () => {
        const path = await this.uniquePath(`${record.manifest.title} 恢复`, 'inknote', this.folderOf(manifest));
        await forkDocument(this.io, record.manifest, path); modal.close(); await this.openPath(path);
        new Notice(`已恢复为「${path}」`);
      })().catch(error => new Notice((error as Error).message));
    }
    modal.open();
  }
  private folderOf(manifest: Manifest) { return this.views().find(v => v.session?.manifest.id === manifest.id)?.file?.parent?.path ?? ''; }
  /** A free path such as `Folder/Title 2.ext`; never overwrites. */
  async uniquePath(title: string, extension: string, folder = '') {
    title = title.replace(/[\\/<>:"|?*#^[\]]/g, '-').replace(/\s+/g, ' ').trim() || '未命名';
    const prefix = folder && folder !== '/' ? `${normalizePath(folder)}/` : '';
    let path = `${prefix}${title}.${extension}`, n = 2;
    while (await this.io.exists(path)) path = `${prefix}${title} ${n++}.${extension}`;
    return safePath(path);
  }
  /** Where new notes go: the given folder, else Obsidian's "new file location" for the active file. */
  newFolder(folder?: string) {
    if (folder !== undefined) return folder === '/' ? '' : folder;
    const parent = this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? '');
    return parent.isRoot() ? '' : parent.path;
  }
  async waitForFile(path: string) {
    for (let i = 0; i < 40; i++) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) return file;
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    throw Error(`文件尚未出现在库中：${path}`);
  }
  async openPath(path: string) {
    const file = await this.waitForFile(path);
    const existing = this.app.workspace.getLeavesOfType(VIEW).find(leaf => (leaf.view as DrawingView).file?.path === path);
    const leaf = existing ?? this.app.workspace.getLeaf(false);
    if (!existing) await leaf.openFile(file);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
  async create(mode: 'pages' | 'canvas', options: { template?: PageTemplate; title?: string; folder?: string } = {}) {
    const folder = this.newFolder(options.folder);
    const path = await this.uniquePath(options.title?.trim() || `未命名${NOTE_TYPES[mode].label}`, 'inknote', folder);
    const manifest = newManifest(path.slice(path.lastIndexOf('/') + 1, -'.inknote'.length), mode, options.template ?? (mode === 'canvas' ? 'dotted' : this.prefs.get().newTemplate));
    if (mode === 'pages' && options.template) this.prefs.update({ newTemplate: options.template });
    await new DocumentStore(this.io, path, manifest).commit(new Map()); await this.openPath(path);
  }
  async createText(title: string, folder?: string) {
    const path = await this.uniquePath(title.trim() || `未命名${NOTE_TYPES.text.label}`, 'md', this.newFolder(folder));
    const file = await this.app.vault.create(path, '');
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true, state: { mode: 'source' } });
    await this.app.workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
  openDaily(): Promise<void> {
    if ((this.app as any).commands.executeCommandById('daily-notes')) return Promise.resolve();
    if (this.dailyTask) return this.dailyTask;
    this.dailyTask = (async () => {
      const legacy = dailyNotePath(new Date()), name = legacy.slice(legacy.lastIndexOf('/') + 1);
      const folder = this.newFolder();
      const path = this.app.vault.getAbstractFileByPath(legacy) ? legacy : (folder ? `${folder}/` : '') + name;
      if (!this.app.vault.getAbstractFileByPath(path)) {
        try { await this.app.vault.create(path, `# ${path.slice(path.lastIndexOf('/') + 1, -3)}\n\n`); }
        catch (error) { if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) throw error; }
      }
      await this.notes.open(path);
    })().finally(() => { this.dailyTask = undefined; });
    return this.dailyTask;
  }
  pickVaultPdf() {
    if (!this.app.vault.getFiles().some(f => f.extension === 'pdf')) { new Notice('库中还没有 PDF。可以用「导入 PDF」从设备中选择。'); return; }
    new PdfPicker(this, '选择要批注的 PDF', file => this.importPdf(file.basename, undefined, file)).open();
  }
  chooseFile(accept: string, callback: (file: File) => Promise<void>) {
    const input = document.createElement('input'); input.type = 'file'; input.accept = accept;
    input.onchange = () => { if (input.files?.[0]) void callback(input.files[0]).catch(e => new Notice(e.message)); }; input.click();
  }
  async restorePackage(file: File) {
    const notice = new Notice('正在恢复备份…', 0);
    try {
      const path = await this.uniquePath(file.name.replace(/\.(inkpack|zip)$/i, ''), 'inknote', this.newFolder());
      await unpack(this.io, new Uint8Array(await file.arrayBuffer()), path, (done, total) => notice.setMessage(`正在恢复备份 ${done}/${total}…`));
      await this.openPath(path);
    } finally { notice.hide(); }
  }
  /** A vault PDF is referenced in place (note goes beside it); an outside PDF is copied into the note's resources. */
  async importPdf(name: string, bytes?: ArrayBuffer, file?: TFile) {
    const notice = new Notice('正在准备 PDF…', 0);
    try {
      const folder = file ? (file.parent && !file.parent.isRoot() ? file.parent.path : '') : this.newFolder();
      const entry = await this.uniquePath(name.replace(/\.pdf$/i, ''), 'inknote', folder);
      const manifest = newManifest(entry.slice(entry.lastIndexOf('/') + 1, -'.inknote'.length), 'pages');
      bytes ??= await this.app.vault.readBinary(file!);
      const pdf = await PdfService.fromBytes(bytes.slice(0));
      try {
        manifest.pages = [];
        for (let i = 1; i <= pdf.document.numPages; i++) { const p = await pdf.document.getPage(i), viewport = p.getViewport({ scale: 1 }); manifest.pages.push({ ...newPage({ width: viewport.width, height: viewport.height }), pdfPage: i }); }
      } finally { await pdf.destroy(); }
      let path = file?.path;
      if (!path) { await ensureDir(this.io, `${manifest.resourceDir}/assets`); path = `${manifest.resourceDir}/assets/source.pdf`; await this.io.writeBinary(path, bytes); }
      manifest.pdf = { path, sha256: await digest(bytes), size: bytes.byteLength };
      await new DocumentStore(this.io, entry, manifest).commit(new Map()); await this.openPath(entry);
    } finally { notice.hide(); }
  }
  async maintainPdfPath(oldPath: string, newPath: string) {
    const moved = (path: string) => path === oldPath ? newPath : path.startsWith(oldPath + '/') ? newPath + path.slice(oldPath.length) : path;
    for (const [path, session] of [...this.unsavedSessions]) if (moved(path) !== path) { this.unsavedSessions.delete(path); session.store.path = moved(path); this.unsavedSessions.set(moved(path), session); }
    if (oldPath.endsWith('.inknote') && await this.io.exists(`${oldPath}.last-good.json`)) {
      await this.io.write(`${newPath}.last-good.json`, await this.io.read(`${oldPath}.last-good.json`));
      await this.io.remove(`${oldPath}.last-good.json`);
    }
    for (const view of this.views()) if (view.session) view.session.store.path = moved(view.session.store.path);
    for (const file of this.app.vault.getFiles().filter(file => file.extension === 'inknote')) {
      const view = this.views().find(view => view.file?.path === file.path);
      if (view?.session) {
        const session = view.session;
        if (session.manifest.pdf && moved(session.manifest.pdf.path) !== session.manifest.pdf.path) { session.manifest.pdf.path = moved(session.manifest.pdf.path); session.metadataChanged(); await session.flush(); }
        continue;
      }
      let store: DocumentStore;
      try { store = await DocumentStore.open(this.io, file.path); }
      catch (error) { new Notice(`未更新 ${file.path} 的 PDF 关联：${(error as Error).message}`); continue; }
      if (!store.manifest.pdf || moved(store.manifest.pdf.path) === store.manifest.pdf.path) continue;
      store.manifest.pdf.path = moved(store.manifest.pdf.path); await store.commit(new Map());
    }
  }
}

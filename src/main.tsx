import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { type App, Plugin, FileView, WorkspaceLeaf, TFile, TFolder, Notice, Modal, normalizePath, parseLinktext, FuzzySuggestModal, MarkdownView, type ViewStateResult, Menu, setIcon } from 'obsidian';
import { DocumentStore, FileIO, SurfaceBlocks, ensureDir, forkDocument } from './storage';
import { newManifest, newPage, digest, parseManifest, safePath, Manifest, PageTemplate, Rect, type Element } from './model';
import { Session } from './session';
import { PdfService } from './pdf';
import { Workspace } from './Workspace';
import { unpack } from './export';
import { registerInkEmbeds } from './embed-host';
import { BacklinkTracker, InkSubpathSuggest } from './ink-suggest';
import { clearInkFontFaces } from './kernel-assets';
import { assetUrl, clearAssetUrls } from './assets';
import { normalizePreferences, PreferenceStore } from './preferences';
import { ElementsLibraryStore, normalizeLibraryItems } from './elements-library';
import { ErrorBoundary, isImeComposing } from './ui';
import { TEMPLATES, paperStyle } from './templates';
import type { BacklinkEntry, DroppedItem, ViewMemory, ViewSurface, WorkspaceActions, WorkspaceChromeState, WorkspaceHost } from './host';
import { NotesHost } from './notes-host';
import { blockInsertion, formatInkSubpath, parseInkSubpath, NOTE_TYPES } from './notes';
import { MixedNotes } from './mixed-host';
import { BoardSources } from './cards-host';
import { LibrarySources } from './library-search-host';
import { dailyNotePath } from './library-search';
import { NoteProperties } from './properties-host';
import { PageInkSettingTab } from './settings-tab';

const VIEW = 'drawing-local-view';

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
  onChooseItem(file: TFile) { void this.selected(file).catch((e: Error) => new Notice((e).message)); }
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
      Object.assign(card.createSpan({ cls: 'ink-create-paper-chip', attr: { 'aria-hidden': 'true' } }).style, paperStyle(option.id, true));
      card.createSpan({ text: option.label });
      card.onclick = () => {
        template = option.id;
        for (const button of papers.querySelectorAll('button')) { button.setAttribute('aria-checked', String(button === card)); button.tabIndex = button === card ? 0 : -1; }
      };
    }
    papers.addEventListener('keydown', event => {
      if (isImeComposing(event) || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...papers.querySelectorAll('button')], index = buttons.indexOf(event.target as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus(); buttons[next]?.click();
    });
    name.addEventListener('keydown', event => { if (event.key === 'Enter' && !isImeComposing(event)) { event.preventDefault(); (this.initial === 'text' ? text : notebook).click(); } });
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
  private navigationRequest = 0;
  private currentBodyPage?: string;
  private currentPage() { return this.currentBodyPage ?? this.pendingViews.get('body')?.page ?? this.session?.navigation?.page ?? this.loadView()?.page; }
  private pendingNavigation?: { generation: number; target: unknown };
  private backlinkEntries: BacklinkEntry[] = [];
  private backlinkListeners = new Set<() => void>();
  private backlinkGeneration = 0;
  root?: Root; session?: Session; pdf?: PdfService; generation = 0;
  actions: WorkspaceActions | null = null;
  private chrome: WorkspaceChromeState | null = null;
  private lastReadingIcon?: boolean;
  private sidebarAction: HTMLElement;
  private readingAction: HTMLElement;
  private scratchAction: HTMLElement;
  private unloading?: Promise<void>;
  private viewTimer?: number;
  text = new MixedNotes(this.app, () => this.leaf);
  cards: BoardSources;
  constructor(leaf: WorkspaceLeaf, private plugin: DrawingPlugin) {
    super(leaf);
    this.register(plugin.backlinkTracker.subscribe(() => { void this.refreshBacklinks(); }));
    this.cards = new BoardSources(this.app, { io: plugin.io, live: path => plugin.views().find(v => v.file?.path === path)?.session,
      resolve: (path, id) => plugin.resolveDocument(path, id), reveal: (path, page, region) => plugin.reveal(path, page, region),
      unique: title => plugin.uniquePath(title, 'inknote') });
    // Obsidian prepends view-header actions beside its single native more-options button.
    this.scratchAction = this.addAction('notebook-pen', '打开草稿纸', () => this.actions?.toggleScratch());
    this.readingAction = this.addAction('book-open', '阅读模式', () => this.actions?.toggleReading());
    this.sidebarAction = this.addAction('panel-left', '显示侧栏', () => this.actions?.toggleSidebar());
    for (const el of [this.scratchAction, this.readingAction, this.sidebarAction]) {
      el.addClass('ink-host-action', 'ink-host-action-hidden');
    }
  }
  get isPreview() { return Boolean(this.containerEl.closest('.hover-popover')); }
  getState() { const page = this.currentPage(); return { ...super.getState(), page, region: page === this.session?.navigation?.page ? this.session?.navigation?.region : undefined }; }
  async setState(state: Record<string, unknown>, result: ViewStateResult) { const request = ++this.navigationRequest; await super.setState(state, result); if (request === this.navigationRequest) this.applyNavigation(state); }
  setEphemeralState(state: unknown) { ++this.navigationRequest; this.applyNavigation(state); }
  applyNavigation(state: unknown) {
    if (!state || typeof state !== 'object') return;
    const target = state as { subpath?: string; page?: string; pageNumber?: number; pageId?: string; region?: string; rect?: Rect };
    if (!this.session) { this.pendingNavigation = { generation: this.generation, target }; return; }
    const sub = typeof target.subpath === 'string' ? parseInkSubpath(target.subpath) : { pageId: target.pageId ?? target.page, pageNumber: target.pageNumber, region: target.region };
    const manifest = this.session.manifest;
    const region = manifest.regions.find(r => r.id === sub.region) ?? manifest.regions.find(r => r.title === sub.region);
    const number = sub.pageNumber ?? (sub.pageId && /^\d+$/.test(sub.pageId) ? Number(sub.pageId) : undefined);
    const page = region?.pageId ?? (number ? manifest.pages[number - 1]?.id : manifest.pages.find(p => p.id === sub.pageId)?.id);
    const rect = target.rect && [target.rect.x, target.rect.y, target.rect.width, target.rect.height].every(Number.isFinite) && target.rect.width > 0 && target.rect.height > 0 ? target.rect : undefined;
    if (page) { this.currentBodyPage = page; this.pendingViews.delete('body'); this.session.navigate(page, region?.id, rect); }
    this.pendingNavigation = undefined;
  }
  private async refreshBacklinks() {
    const generation = ++this.backlinkGeneration, file = this.file, manifest = this.session?.manifest;
    if (!file || !manifest) return;
    try {
      const entries = await this.plugin.backlinkTracker.entries(file.path, manifest);
      if (generation !== this.backlinkGeneration || this.file !== file) return;
      this.backlinkEntries = entries; for (const listener of this.backlinkListeners) listener();
    } catch (error) { new Notice(`无法读取反向链接：${(error as Error).message}`); }
  }
  backlinks() { return this.backlinkEntries; }
  onBacklinksChange(listener: () => void) { this.backlinkListeners.add(listener); return () => { this.backlinkListeners.delete(listener); }; }
  async openBacklink(entry: BacklinkEntry, newTab = false) {
    await this.app.workspace.openLinkText(entry.sourcePath, this.file?.path ?? '', newTab ? 'tab' : false, { eState: { line: entry.line } });
  }
  async openInPane(destination: 'tab' | 'split' = 'tab') {
    if (!this.file) return;
    const leaf = this.app.workspace.getLeaf(destination);
    await leaf.openFile(this.file);
    if (leaf.view instanceof DrawingView) leaf.view.applyNavigation(this.getState());
  }
  hoverLink(event: MouseEvent, targetEl: HTMLElement, linktext: string) {
    this.app.workspace.trigger('hover-link', { event, source: VIEW, hoverParent: this, targetEl, linktext, sourcePath: this.file?.path ?? '' });
  }
  get prefs() { return this.plugin.prefs; }
  get elements() { return this.plugin.elements; }
  getViewType() { return VIEW; }
  getIcon() { return 'pencil'; }
  getDisplayText() { return this.file?.basename ?? '绘写笔记'; }
  private resetChrome() {
    this.chrome = null;
    this.lastReadingIcon = undefined;
    for (const el of [this.scratchAction, this.readingAction, this.sidebarAction]) {
      el.addClass('ink-host-action-hidden');
      el.removeClass('is-active');
      el.removeAttribute('aria-pressed');
    }
  }
  syncChrome(state: WorkspaceChromeState) {
    this.chrome = state;
    if (this.isPreview) { this.resetChrome(); return; }
    const sidebarActive = state.sidebar && !state.focus;
    this.sidebarAction.toggleClass('ink-host-action-hidden', state.focus);
    this.sidebarAction.toggleClass('is-active', sidebarActive);
    this.sidebarAction.setAttribute('aria-pressed', String(sidebarActive));
    this.sidebarAction.setAttribute('aria-label', sidebarActive ? '隐藏侧栏' : '显示侧栏');

    this.readingAction.toggleClass('ink-host-action-hidden', !state.paged);
    this.readingAction.toggleClass('is-active', state.reading);
    this.readingAction.setAttribute('aria-pressed', String(state.reading));
    this.readingAction.setAttribute('aria-label', state.reading ? '继续书写' : '阅读模式');
    if (this.lastReadingIcon !== state.reading) {
      this.lastReadingIcon = state.reading;
      setIcon(this.readingAction, state.reading ? 'pencil' : 'book-open');
    }

    this.scratchAction.toggleClass('ink-host-action-hidden', false);
    this.scratchAction.toggleClass('is-active', state.scratchOpen);
    this.scratchAction.setAttribute('aria-pressed', String(state.scratchOpen));
    this.scratchAction.setAttribute('aria-label', state.scratchOpen ? '收起草稿纸' : '打开草稿纸');
  }
  focusSidebarAction() {
    if (!this.sidebarAction.hasClass('ink-host-action-hidden')) this.sidebarAction.focus({ preventScroll: true });
  }
  onPaneMenu(menu: Menu, source: string) {
    super.onPaneMenu(menu, source);
    if (!this.session) return;
    const paged = this.session.manifest.mode === 'pages';
    const chrome = this.chrome;
    const prefs = this.prefs.get();
    const headerHidden = source === 'tab-header' || !this.containerEl.querySelector('.view-header')?.getClientRects().length;
    const dockHidden = !!chrome?.reading && !chrome?.scratchOpen;
    if (headerHidden) {
      const sidebarActive = !!(chrome?.sidebar && !chrome?.focus);
      menu.addItem(item => item.setSection('pageink-view').setTitle(sidebarActive ? '隐藏侧栏' : '显示侧栏').setIcon('panel-left').onClick(() => this.actions?.toggleSidebar()));
      if (paged) menu.addItem(item => item.setSection('pageink-view').setTitle('阅读模式').setIcon('book-open').setChecked(!!chrome?.reading).onClick(() => this.actions?.toggleReading()));
      menu.addItem(item => item.setSection('pageink-view').setTitle(chrome?.scratchOpen ? '收起草稿纸' : '打开草稿纸').setIcon('notebook-pen').setChecked(!!chrome?.scratchOpen).onClick(() => this.actions?.toggleScratch()));
    }
    menu.addItem(item => item.setSection('pageink-view').setTitle('搜索笔记内容').setIcon('search').onClick(() => this.actions?.search()));
    menu.addItem(item => item.setSection('pageink-view').setTitle('导出…').setIcon('share').onClick(() => this.actions?.openExport()));
    menu.addItem(item => item.setSection('pageink-view').setTitle(paged ? '纸张与页边距…' : '画布样式…').setIcon('sliders-horizontal').onClick(() => this.actions?.openPageSettings()));
    menu.addItem(item => item.setSection('pageink-view').setTitle('专注模式').setIcon('expand').setChecked(!!chrome?.focus).onClick(() => this.actions?.toggleFocus()));
    if (!paged) menu.addItem(item => item.setSection('pageink-view').setTitle('将当前视野存为书签').setIcon('bookmark').onClick(() => this.actions?.bookmarkCurrentView()));

    if (dockHidden) menu.addItem(item => item.setSection('pageink-doc').setTitle('文字段落…').setIcon('file-text').onClick(() => this.actions?.openMixed()));
    menu.addItem(item => item.setSection('pageink-doc').setTitle(paged ? '复制本页链接' : '复制画布链接').setIcon('link').onClick(() => this.actions?.copyCurrentLink()));
    if (chrome?.hasPdfPage) {
      menu.addItem(item => item.setSection('pageink-doc').setTitle('复制本页文字').setIcon('file-text').onClick(() => this.actions?.copyCurrentPageText()));
      menu.addItem(item => item.setSection('pageink-doc').setTitle('选择本页文字…').setIcon('type').onClick(() => this.actions?.selectCurrentPageText()));
    }
    if (this.session.manifest.pdf) menu.addItem(item => item.setSection('pageink-doc').setTitle('重新关联原 PDF…').setIcon('refresh-cw').onClick(() => this.relinkSource()));
    menu.addItem(item => item.setSection('pageink-doc').setTitle('历史版本…').setIcon('history').onClick(() => this.showVersions()));

    if (dockHidden && paged) {
      menu.addItem(item => item.setSection('pageink-prefs').setTitle('夜间护眼纸面').setIcon(prefs.nightPaper ? 'sun' : 'moon').setChecked(prefs.nightPaper).onClick(() => this.prefs.update({ nightPaper: !prefs.nightPaper })));
    }
    menu.addItem(item => item.setSection('pageink-prefs').setTitle('用手指书写').setIcon('pointer').setChecked(prefs.fingerDraws).onClick(() => this.prefs.update({ fingerDraws: !prefs.fingerDraws })));
    menu.addItem(item => item.setSection('pageink-prefs').setTitle('空闲时自动收起笔盒').setIcon('panel-right').setChecked(prefs.autoCollapseDock).onClick(() => this.prefs.update({ autoCollapseDock: !prefs.autoCollapseDock })));
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
      if (this.pendingNavigation?.generation === generation) this.applyNavigation(this.pendingNavigation.target);
      if (this.isPreview) this.containerEl.querySelector('.view-actions')?.addClass('ink-host-action-hidden');
      void this.refreshBacklinks();
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
    ++this.generation; this.pendingNavigation = undefined; ++this.backlinkGeneration;
    const session = this.session, root = this.root, pdf = this.pdf;
    if (session) this.saveViewNow();
    this.currentBodyPage = undefined;
    this.root = undefined; this.session = undefined; this.pdf = undefined; this.actions = null; this.resetChrome();
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
    const folder = this.prefs.get().exportFolder;
    await ensureDir(this.plugin.io, folder);
    const path = await this.plugin.uniquePath(name, extension, folder);
    await this.plugin.io.writeBinary(path, bytes);
    return path;
  }
  async openFile(path: string) {
    const file = await this.plugin.waitForFile(path);
    await this.app.workspace.getLeaf('tab').openFile(file);
  }
  private adjacentMarkdown() {
    const candidates = this.app.workspace.getLeavesOfType('markdown')
      .filter(leaf => leaf.getRoot() === this.leaf.getRoot())
      .map(leaf => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView && view.getMode() === 'source' && !!view.file && view.containerEl.getClientRects().length > 0);
    const companionPath = this.file ? this.file.path.slice(0, -'.inknote'.length) + '.md' : '';
    const companion = candidates.find(view => view.file?.path === companionPath);
    if (companion) return companion;
    const myRect = this.containerEl.getBoundingClientRect();
    const right = candidates.filter(view => view.containerEl.getBoundingClientRect().left >= myRect.right - 8);
    return right.length === 1 ? right[0] : right.length === 0 && candidates.length === 1 ? candidates[0] : undefined;
  }
  hasAdjacentMarkdown() { return !!this.adjacentMarkdown(); }
  buildDragLink({ page, pageNumber, region, title, embed }: { page?: string; pageNumber?: number; region?: string; title?: string; embed?: boolean }) {
    const file = this.file, session = this.session; if (!file || !session) return '';
    const currentPage = page ?? this.currentPage() ?? session.manifest.pages[0].id;
    const index = session.manifest.pages.findIndex(p => p.id === currentPage);
    const subpath = formatInkSubpath({ pageNumber: session.manifest.mode === 'pages' ? pageNumber ?? index + 1 : undefined, region });
    const alias = embed ? String(this.prefs.get().embedMaxWidth) : title ?? (region ? session.manifest.regions.find(r => r.id === region)?.title : undefined) ?? file.basename;
    const generated = this.app.fileManager.generateMarkdownLink(file, this.adjacentMarkdown()?.file?.path ?? '', subpath, alias);
    const link = embed ? '!' + generated : generated;
    this.plugin.dragContext = { file, subpath, alias, embed: !!embed, link };
    return link;
  }
  async sendToMarkdown({ page, region, embed = true, createSplitIfMissing = false }: { page?: string; region?: string; embed?: boolean; createSplitIfMissing?: boolean }) {
    await this.session?.flush();
    const file = this.file, session = this.session;
    if (!file || !session) return;
    let mdView = createSplitIfMissing ? undefined : this.adjacentMarkdown();
    if (!mdView && createSplitIfMissing) {
      const companionPath = file.path.slice(0, -'.inknote'.length) + '.md';
      const existing = this.app.vault.getAbstractFileByPath(companionPath);
      if (existing && !(existing instanceof TFile)) throw Error('伴随文字笔记路径已被文件夹占用。');
      const companion = existing ?? await this.app.vault.create(companionPath, '');
      const opened = this.app.workspace.getLeavesOfType('markdown').find(leaf => leaf.view instanceof MarkdownView && leaf.view.file?.path === companionPath);
      const leaf = opened ?? this.app.workspace.createLeafBySplit(this.leaf, 'vertical');
      if (opened) {
        const state = leaf.getViewState();
        await leaf.setViewState({ ...state, state: { ...state.state, mode: 'source' } });
      } else await leaf.openFile(companion, { active: true, state: { mode: 'source' } });
      if (leaf.view instanceof MarkdownView) mdView = leaf.view;
    }
    if (!mdView?.file || mdView.getMode() !== 'source') {
      await navigator.clipboard.writeText(this.buildDragLink({ page, region, embed })); return;
    }
    const index = session.manifest.pages.findIndex(p => p.id === (page ?? this.currentPage() ?? session.manifest.pages[0].id));
    const subpath = formatInkSubpath({ pageNumber: session.manifest.mode === 'pages' ? index + 1 : undefined, region });
    const link = (embed ? '!' : '') + this.app.fileManager.generateMarkdownLink(file, mdView.file.path, subpath, embed ? String(this.prefs.get().embedMaxWidth) : undefined);
    const editor = mdView.editor, text = editor.getValue();
    const offset = editor.posToOffset(editor.getCursor('to')), pos = editor.offsetToPos(offset);
    const addition = embed ? blockInsertion(text.slice(0, offset), text.slice(offset), link) : link;
    editor.replaceRange(addition, pos, pos);
    await mdView.save();
    return mdView.file.path;
  }
  async resolveDrop(dataTransfer: DataTransfer): Promise<DroppedItem[]> {
    const images = Array.from(dataTransfer.files).filter(file => file.type.startsWith('image/'));
    if (images.length) return images.map(file => ({ kind: 'image', file, name: file.name }));
    const plain = dataTransfer.getData('text/plain').trim();
    let linkpath: string | undefined;
    if (plain.startsWith('obsidian://open?')) linkpath = new URL(plain).searchParams.get('file') ?? undefined;
    else {
      const match = /^!?\[\[([^\]]+)\]\]$/.exec(plain);
      if (match) linkpath = parseLinktext(match[1].split('|')[0]).path;
    }
    if (linkpath) {
      const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, this.file?.path ?? '') ?? this.app.vault.getAbstractFileByPath(linkpath);
      if (file instanceof TFile) {
        const extension = file.extension.toLowerCase();
        if (extension === 'md') return [{ kind: 'markdown', path: file.path }];
        if (extension === 'inknote' || extension === 'pdf') return [{ kind: extension, path: file.path }];
        const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
        if (mime[extension]) return [{ kind: 'image', file: new Blob([await this.app.vault.readBinary(file)], { type: mime[extension] }), name: file.name }];
      }
      return [];
    }
    return plain && !dataTransfer.getData('application/x-pageink-link') && !plain.startsWith('pageink-clipboard:')
      ? [{ kind: 'markdown', path: this.adjacentMarkdown()?.file?.path ?? '', text: plain }] : [];
  }
  pickFromMarkdown(path: string) { return this.text.pickFromPath(path); }
  pickFromInk(path: string) { return this.cards.pickFromPath(path); }
  async annotateVaultPdf(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'pdf') throw Error('找不到库中的 PDF，请重新选择。');
    await this.plugin.importPdf(file.basename, undefined, file);
  }
  async copyLink(target: { page?: string; region?: string; embed?: boolean }) { await navigator.clipboard.writeText(this.buildDragLink(target)); }
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
  showVersions() { if (this.session) void this.plugin.showRecovery(this.session.manifest).catch((e: Error) => new Notice((e).message)); }
  private viewKey(surface: ViewSurface = 'body') { return `pageink-view-${this.session?.manifest.id}${surface === 'scratch' ? '-scratch' : ''}`; }
  private pendingViews = new Map<ViewSurface, ViewMemory>();
  loadView(surface: ViewSurface = 'body') { const value = this.session && this.app.loadLocalStorage(this.viewKey(surface)) as ViewMemory | null; return value && typeof value.zoom === 'number' ? value : undefined; }
  saveView(view: ViewMemory, surface: ViewSurface = 'body') { if (surface === 'body') this.currentBodyPage = view.page; this.pendingViews.set(surface, view); window.clearTimeout(this.viewTimer); this.viewTimer = window.setTimeout(() => this.saveViewNow(), 800); }
  private saveViewNow() {
    window.clearTimeout(this.viewTimer);
    if (this.session) for (const [surface, view] of this.pendingViews) this.app.saveLocalStorage(this.viewKey(surface), view);
    this.pendingViews.clear();
  }
  theme() { return activeDocument.body.classList.contains('theme-dark') ? 'dark' as const : 'light' as const; }
  onThemeChange(listener: () => void) { const ref = this.app.workspace.on('css-change', listener); return () => this.app.workspace.offref(ref); }
  connect(actions: WorkspaceActions) {
    this.actions = actions;
    return () => {
      if (this.actions === actions) {
        this.actions = null;
        this.resetChrome();
      }
    };
  }
}

export default class DrawingPlugin extends Plugin {
  notes!: NotesHost;
  properties!: NoteProperties;
  private dailyTask?: Promise<void>;
  private ribbonIcon?: HTMLElement;
  private importingPdf = false;
  private restoringPackage = false;
  dragContext?: { file: TFile; subpath: string; alias: string; embed: boolean; link: string };
  io = new VaultIO(this);
  unsavedSessions = new Map<string, Session>();
  closingViews = new Map<string, Promise<void>>();
  backlinkTracker!: BacklinkTracker;
  prefs!: PreferenceStore;
  elements!: ElementsLibraryStore;
  async onload() {
    this.prefs = new PreferenceStore(normalizePreferences(await this.loadData()), value => this.saveData(value));
    this.addSettingTab(new PageInkSettingTab(this.app, this));
    this.syncRibbonIcon();
    this.register(this.prefs.subscribe(() => this.syncRibbonIcon()));
    this.register(() => { this.ribbonIcon?.remove(); this.ribbonIcon = undefined; this.dragContext = undefined; });
    const libPath = `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/elements-library.json`;
    let savedItems: ReturnType<typeof normalizeLibraryItems> = [];
    let libraryLoadFailed = false;
    try {
      if (await this.io.exists(libPath)) savedItems = normalizeLibraryItems(JSON.parse(await this.io.read(libPath)));
    } catch { libraryLoadFailed = true; }
    this.elements = new ElementsLibraryStore(savedItems, async items => {
      if (libraryLoadFailed) {
        throw new Error('常用元素库启动读取失败，为防止覆盖已有收藏已暂停写入，请检查元素库文件后重载。');
      }
      await this.io.write(libPath, JSON.stringify(items));
    });
    this.register(() => { this.prefs.flush(); clearInkFontFaces(); clearAssetUrls(); });
    const face = new FontFace('Ink Notebook Sans', `url("${assetUrl('fonts/NotoSansCJKsc-Regular.otf')}")`);
    await face.load(); const fontDocument = activeDocument; fontDocument.fonts.add(face); this.register(() => fontDocument.fonts.delete(face));
    this.backlinkTracker = this.addChild(new BacklinkTracker(this.app));
    this.registerHoverLinkSource(VIEW, { display: 'PageInk', defaultMod: true });
    this.registerHoverLinkSource('pageink-library', { display: 'PageInk', defaultMod: true });
    this.registerView(VIEW, leaf => new DrawingView(leaf, this));
    this.registerExtensions(['inknote'], VIEW);
    const live = (path: string) => this.views().find(view => view.file?.path === path)?.session ?? this.unsavedSessions.get(path);
    this.registerEditorSuggest(new InkSubpathSuggest(this.app, path => live(path)?.manifest, () => this.prefs.get().embedMaxWidth));
    const sources = new LibrarySources(this.app, this.io, live);
    this.properties = new NoteProperties(this.app, this.io, live);
    this.register(() => this.properties.dispose());
    this.notes = this.addChild(new NotesHost(this, {
      create: async (kind, folder) => {
        if (kind === 'text') await this.createText('', folder);
        else if (kind) await this.create(kind, { folder });
        else new CreateModal(this, folder).open();
      },
      createText: () => void this.createText('').catch((e: Error) => new Notice((e).message)),
      daily: () => this.openDaily(),
      embedMaxWidth: () => this.prefs.get().embedMaxWidth,
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
    this.addCommand({ id: 'new-notebook', name: `新建${NOTE_TYPES.pages.label}`, callback: () => void this.create('pages').catch((e: Error) => new Notice(e.message)) });
    this.addCommand({ id: 'new-canvas', name: `新建${NOTE_TYPES.canvas.label}`, callback: () => void this.create('canvas').catch((e: Error) => new Notice(e.message)) });
    this.addCommand({ id: 'annotate-pdf', name: '批注库中的 PDF…', callback: () => this.pickVaultPdf() });
    this.addCommand({ id: 'import-pdf', name: '导入 PDF 并批注…', callback: () => this.chooseFile('.pdf', async file => this.importPdf(file.name, await file.arrayBuffer())) });
    this.addCommand({ id: 'restore-package', name: '从备份恢复（.inkpack）…', callback: () => this.chooseFile('.inkpack,.zip', file => this.restorePackage(file)) });
    this.addCommand({ id: 'open-companion-ink', name: '在右侧打开伴随手写笔记', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile(); if (file?.extension !== 'md') return false;
      if (!checking) void this.openCompanionInkNote(file).catch((e: Error) => new Notice(e.message)); return true;
    } });
    this.addCommand({ id: 'export-pdf', name: '导出当前笔记为 PDF', checkCallback: withView(view => view.actions?.exportPdf()) });
    this.addCommand({ id: 'toggle-sidebar', name: '显示/隐藏侧栏', checkCallback: withView(view => view.actions?.toggleSidebar()) });
    this.addCommand({ id: 'toggle-reading', name: '阅读模式 / 继续书写', checkCallback: (checking: boolean) => { const view = active(); if (!view?.session || view.session.manifest.mode !== 'pages') return false; if (!checking) view.actions?.toggleReading(); return true; } });
    this.addCommand({ id: 'toggle-scratch', name: '打开/收起草稿纸', checkCallback: withView(view => view.actions?.toggleScratch()) });
    this.addCommand({ id: 'toggle-focus', name: '专注模式', checkCallback: withView(view => view.actions?.toggleFocus()) });
    this.addCommand({ id: 'search', name: '在当前笔记中搜索', checkCallback: withView(view => view.actions?.search()) });
    this.addCommand({ id: 'relink-source', name: '重新关联原 PDF…', checkCallback: (checking: boolean) => { const view = active(); if (!view?.session?.manifest.pdf) return false; if (!checking) view.relinkSource(); return true; } });
    this.addCommand({ id: 'restore-copy', name: '历史版本…', checkCallback: withView(view => view.showVersions()) });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') menu.addItem(item => item.setTitle('在右侧打开伴随手写笔记').setIcon('notebook-pen').onClick(() => { void this.openCompanionInkNote(file).catch((e: Error) => new Notice(e.message)); }));
      if (file instanceof TFile && file.extension === 'pdf') menu.addItem(item => item.setTitle('创建批注笔记').setIcon('pencil').onClick(() => { void this.importPdf(file.basename, undefined, file).catch((e: Error) => new Notice(e.message)); }));
      if (file instanceof TFolder) {
        menu.addItem(item => item.setTitle(`新建${NOTE_TYPES.text.label}`).setIcon(NOTE_TYPES.text.hostIcon).onClick(() => void this.createText('', file.path).catch((e: Error) => new Notice(e.message))));
        menu.addItem(item => item.setTitle(`新建${NOTE_TYPES.pages.label}`).setIcon(NOTE_TYPES.pages.hostIcon).onClick(() => void this.create('pages', { folder: file.path }).catch((e: Error) => new Notice(e.message))));
        menu.addItem(item => item.setTitle(`新建${NOTE_TYPES.canvas.label}`).setIcon(NOTE_TYPES.canvas.hostIcon).onClick(() => void this.create('canvas', { folder: file.path }).catch((e: Error) => new Notice(e.message))));
      }
    }));
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, _editor, info) => {
      if (info instanceof MarkdownView && info.file) menu.addItem(item => item.setTitle('在右侧打开伴随手写笔记').setIcon('notebook-pen').onClick(() => { if (info.file) void this.openCompanionInkNote(info.file).catch((e: Error) => new Notice(e.message)); }));
    }));
    this.registerDomEvent(activeWindow, 'dragend', () => { this.dragContext = undefined; });
    this.registerEvent(this.app.workspace.on('window-open', win => this.registerDomEvent(win.win, 'dragend', () => { this.dragContext = undefined; })));
    this.registerEvent(this.app.workspace.on('editor-drop', (evt, editor, info) => {
      if (evt.defaultPrevented) return;
      const marker = evt.dataTransfer?.getData('application/x-pageink-link');
      const context = this.dragContext;
      if (marker && context?.link === marker && info.file) {
        evt.preventDefault();
        const link = (context.embed ? '!' : '') + this.app.fileManager.generateMarkdownLink(context.file, info.file.path, context.subpath, context.alias);
        const cm = (editor as typeof editor & { cm?: { posAtCoords?: (coords: { x: number; y: number }, precise?: boolean) => number | null } }).cm;
        const offset = cm?.posAtCoords?.({ x: evt.clientX, y: evt.clientY }, false) ?? editor.posToOffset(editor.getCursor('to'));
        const pos = editor.offsetToPos(offset), text = editor.getValue();
        const addition = context.embed ? blockInsertion(text.slice(0, offset), text.slice(offset), link) : link;
        editor.replaceRange(addition, pos, pos);
        this.dragContext = undefined;
      }
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { void this.maintainPdfPath(oldPath, file.path).catch((e: Error) => new Notice(e.message)); }));
    this.registerEvent(this.app.vault.on('modify', file => {
      for (const view of this.views()) {
        const session = view.session;
        if (session?.manifest.pdf?.path === file.path) void (async () => {
          const identity = await digest(await this.io.readBinary(file.path));
          if (identity !== session.manifest.pdf!.sha256) { session.sourceIssue = '原 PDF 的内容变了。改版教材请另建笔记，或重新关联原来那份文件。'; session.notify(); }
        })().catch((e: Error) => { session.sourceIssue = e.message; session.notify(); });
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
    registerInkEmbeds(this, { io: this.io, prefs: this.prefs, live, resolve: (path, id) => this.resolveDocument(path, id), open: async (path, target, destination) => {
      if (!destination) { const view = await this.openPath(path); view?.applyNavigation(target); return; }
      const leaf = this.app.workspace.getLeaf(destination); await leaf.openFile(await this.waitForFile(path));
      if (leaf.view instanceof DrawingView) leaf.view.applyNavigation(target);
    } });
  }

  views() { return this.app.workspace.getLeavesOfType(VIEW).map(leaf => leaf.view).filter((view): view is DrawingView => view instanceof DrawingView); }
  syncRibbonIcon() {
    if (this.prefs.get().showRibbonIcon) this.ribbonIcon ??= this.addRibbonIcon('notebook-pen', '新建绘写笔记', () => new CreateModal(this, undefined, 'pages').open());
    else { this.ribbonIcon?.remove(); this.ribbonIcon = undefined; }
  }
  async openCompanionInkNote(mdFile: TFile) {
    const path = mdFile.path.slice(0, -'.md'.length) + '.inknote';
    const current = this.app.workspace.getLeavesOfType('markdown').find(leaf => leaf.view instanceof MarkdownView && leaf.view.file === mdFile) ?? this.app.workspace.getMostRecentLeaf();
    let file = this.app.vault.getAbstractFileByPath(path);
    if (file && !(file instanceof TFile)) throw Error('伴随手写笔记路径已被文件夹占用。');
    if (!file) {
      await new DocumentStore(this.io, path, newManifest(mdFile.basename, 'pages', this.prefs.get().newTemplate)).commit(new Map());
      file = await this.waitForFile(path);
    }
    const existing = this.views().find(view => view.file?.path === path)?.leaf;
    const leaf = existing ?? (current ? this.app.workspace.createLeafBySplit(current, 'vertical') : this.app.workspace.getLeaf('split'));
    if (!(file instanceof TFile)) throw Error('无法打开伴随手写笔记。');
    if (!existing) await leaf.openFile(file);
    await this.app.workspace.revealLeaf(leaf); this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
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
    const view = await this.openPath(path);
    view?.applyNavigation({ page, region, rect });
  }

  async showRecovery(manifest: Manifest) {
    const records = await new DocumentStore(this.io, '', manifest).recoveryRecords();
    if (!records.some(record => record.manifest.revision === manifest.revision)) records.unshift({ path: '', manifest });
    const modal = new Modal(this.app); modal.titleEl.setText('历史版本');
    modal.modalEl.addClass('ink-host-modal', 'ink-recovery-modal');
    modal.contentEl.createEl('p', { cls: 'ink-recovery-intro', text: '最近 20 次保存。恢复会另存为一份新笔记，当前笔记保持不变。' });
    let busy = false;
    const list = modal.contentEl.createDiv({ cls: 'ink-recovery-list' });
    for (const [index, record] of records.entries()) {
      const row = list.createDiv({ cls: 'ink-recovery-row' });
      const info = row.createDiv({ cls: 'ink-recovery-info' });
      info.createEl('strong', { text: new Date(record.manifest.modified).toLocaleString() });
      info.createSpan({ text: `${record.manifest.mode === 'pages' ? `${record.manifest.pages.length} 页` : '画布'}${index === 0 ? ' · 最新' : ''}` });
      row.createEl('button', { text: '恢复为副本' }).onclick = () => void (async () => {
        if (busy) return; busy = true;
        const buttons = [...list.querySelectorAll('button')]; buttons.forEach(button => button.disabled = true);
        try {
          const path = await this.uniquePath(`${record.manifest.title} 恢复`, 'inknote', this.folderOf(manifest));
          await forkDocument(this.io, record.manifest, path); modal.close(); await this.openPath(path);
          new Notice(`已恢复为「${path}」`);
        } finally { busy = false; buttons.forEach(button => button.disabled = false); }
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
    if (this.prefs.get().newNoteFolder) return this.prefs.get().newNoteFolder;
    const parent = this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? '');
    return parent.isRoot() ? '' : parent.path;
  }
  async waitForFile(path: string) {
    for (let i = 0; i < 40; i++) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) return file;
      await new Promise(resolve => window.setTimeout(resolve, 75));
    }
    throw Error(`文件尚未出现在库中：${path}`);
  }
  async openPath(path: string) {
    const file = await this.waitForFile(path);
    const existing = this.app.workspace.getLeavesOfType(VIEW).find(leaf => (leaf.view as DrawingView).file?.path === path);
    const leaf = existing ?? this.app.workspace.getLeaf(false);
    if (!existing) await leaf.openFile(file);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    return leaf.view instanceof DrawingView ? leaf.view : undefined;
  }
  async create(mode: 'pages' | 'canvas', options: { template?: PageTemplate; title?: string; folder?: string } = {}) {
    const folder = this.newFolder(options.folder);
    if (folder) await ensureDir(this.io, folder);
    const path = await this.uniquePath(options.title?.trim() || `未命名${NOTE_TYPES[mode].label}`, 'inknote', folder);
    const manifest = newManifest(path.slice(path.lastIndexOf('/') + 1, -'.inknote'.length), mode, options.template ?? (mode === 'canvas' ? 'dotted' : this.prefs.get().newTemplate));
    if (mode === 'pages' && options.template) this.prefs.update({ newTemplate: options.template });
    await new DocumentStore(this.io, path, manifest).commit(new Map()); await this.openPath(path);
  }
  async createText(title: string, folder?: string) {
    const path = await this.uniquePath(title.trim() || `未命名${NOTE_TYPES.text.label}`, 'md', this.newFolder(folder));
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (path.includes('/')) await ensureDir(this.io, parent);
    const file = await this.app.vault.create(path, '');
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true, state: { mode: 'source' } });
    await this.app.workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
  openDaily(): Promise<void> {
    if ((this.app as App & { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById('daily-notes')) return Promise.resolve();
    if (this.dailyTask) return this.dailyTask;
    this.dailyTask = (async () => {
      const legacy = dailyNotePath(new Date()), name = legacy.slice(legacy.lastIndexOf('/') + 1);
      const folder = this.newFolder();
      const path = this.app.vault.getAbstractFileByPath(legacy) ? legacy : (folder ? `${folder}/` : '') + name;
      if (!this.app.vault.getAbstractFileByPath(path)) {
        if (path.includes('/')) await ensureDir(this.io, path.slice(0, path.lastIndexOf('/')));
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
    const input = createEl('input'); input.type = 'file'; input.accept = accept;
    input.onchange = () => { if (input.files?.[0]) void callback(input.files[0]).catch((e: Error) => new Notice(e.message)); }; input.click();
  }
  async restorePackage(file: File) {
    if (this.restoringPackage) { new Notice('正在恢复中，请稍候'); return; }
    this.restoringPackage = true;
    const notice = new Notice('正在恢复备份…', 0);
    try {
      const folder = this.newFolder();
      if (folder) await ensureDir(this.io, folder);
      const path = await this.uniquePath(file.name.replace(/\.(inkpack|zip)$/i, ''), 'inknote', folder);
      await unpack(this.io, new Uint8Array(await file.arrayBuffer()), path, (done, total) => notice.setMessage(`正在恢复备份 ${done}/${total}…`));
      await this.openPath(path);
    } finally { notice.hide(); this.restoringPackage = false; }
  }
  /** A vault PDF is referenced in place (note goes beside it); an outside PDF is copied into the note's resources. */
  async importPdf(name: string, bytes?: ArrayBuffer, file?: TFile) {
    if (this.importingPdf) { new Notice('正在导入中，请稍候'); return; }
    this.importingPdf = true;
    const notice = new Notice('正在准备 PDF…', 0);
    try {
      if (file) {
        const notes = this.app.vault.getFiles().filter(f => f.extension === 'inknote').sort((a, b) => Number(b.parent === file.parent) - Number(a.parent === file.parent));
        for (const note of notes) {
          let manifest: Manifest;
          try { manifest = this.views().find(view => view.file === note)?.session?.manifest ?? parseManifest(await this.io.read(note.path)); }
          catch (error) { new Notice(`未检查 ${note.path} 的 PDF 关联：${(error as Error).message}`); continue; }
          if (manifest.pdf?.path === file.path) { await this.openPath(note.path); new Notice('已打开关联的 PDF 批注笔记'); return; }
        }
      }
      const folder = file ? (file.parent && !file.parent.isRoot() ? file.parent.path : '') : this.newFolder();
      if (folder) await ensureDir(this.io, folder);
      const entry = await this.uniquePath(name.replace(/\.pdf$/i, ''), 'inknote', folder);
      const manifest = newManifest(entry.slice(entry.lastIndexOf('/') + 1, -'.inknote'.length), 'pages');
      bytes ??= await this.app.vault.readBinary(file!);
      const pdf = await PdfService.fromBytes(bytes.slice(0));
      try {
        manifest.pages = [];
        for (let i = 1; i <= pdf.document.numPages; i++) {
          notice.setMessage(`正在准备 PDF（第 ${i}/${pdf.document.numPages} 页）…`);
          const p = await pdf.document.getPage(i);
          try { const viewport = p.getViewport({ scale: 1 }); manifest.pages.push({ ...newPage({ width: viewport.width, height: viewport.height }), pdfPage: i }); }
          finally { p.cleanup(); }
        }
      } finally { await pdf.destroy(); }
      let path = file?.path;
      if (!path) { await ensureDir(this.io, `${manifest.resourceDir}/assets`); path = `${manifest.resourceDir}/assets/source.pdf`; await this.io.writeBinary(path, bytes); }
      manifest.pdf = { path, sha256: await digest(bytes), size: bytes.byteLength };
      await new DocumentStore(this.io, entry, manifest).commit(new Map()); await this.openPath(entry);
    } finally { notice.hide(); this.importingPdf = false; }
  }
  async maintainPdfPath(oldPath: string, newPath: string) {
    const folder = this.app.vault.getAbstractFileByPath(newPath) instanceof TFolder;
    if (!folder && !/\.(pdf|md|inknote)$/i.test(oldPath)) return;
    const moved = (path: string) => path === oldPath ? newPath : path.startsWith(oldPath + '/') ? newPath + path.slice(oldPath.length) : path;
    const retargetElement = (element: Element): Element => {
      const data = element.customData, text = data?.pageinkText, card = data?.pageinkCard;
      if ((!text || moved(text.path) === text.path) && (!card || card.kind !== 'ink' || moved(card.path) === card.path)) return element;
      return { ...element, version: element.version + 1, customData: { ...data,
        ...(text ? { pageinkText: { ...text, path: moved(text.path) } } : {}),
        ...(card?.kind === 'ink' ? { pageinkCard: { ...card, path: moved(card.path) } } : {}),
      } };
    };
    for (const [path, session] of [...this.unsavedSessions]) if (moved(path) !== path) { this.unsavedSessions.delete(path); session.store.path = moved(path); this.unsavedSessions.set(moved(path), session); }
    if (oldPath.endsWith('.inknote') && await this.io.exists(`${oldPath}.last-good.json`)) {
      await this.io.write(`${newPath}.last-good.json`, await this.io.read(`${oldPath}.last-good.json`));
      await this.io.remove(`${oldPath}.last-good.json`);
    }
    for (const view of this.views()) if (view.session) view.session.store.path = moved(view.session.store.path);
    for (const file of this.app.vault.getFiles().filter(file => file.extension === 'inknote')) {
      try {
        const drain = async (s?: Session) => { if (s) await Promise.all([...s.flushers.values()].map(flush => flush())); };
        const liveViews = this.views().filter(view => view.file?.path === file.path);
        for (const view of liveViews) await drain(view.session);
        liveViews.sort((a, b) =>
          Number(!!b.session && (b.session.dirty.size > 0 || b.session.metadataDirty)) - Number(!!a.session && (a.session.dirty.size > 0 || a.session.metadataDirty))
          || Number(!!a.isPreview) - Number(!!b.isPreview));
        const primary = liveViews[0]?.session ?? this.unsavedSessions.get(file.path) ?? new Session(await DocumentStore.open(this.io, file.path));
        const dirtyExtras = new Set(liveViews.slice(1)
          .map(view => view.session)
          .filter((session): session is Session => !!session && session !== primary && (session.dirty.size > 0 || session.metadataDirty)));
        let changed = false, elementsChanged = false;
        if (primary.manifest.pdf && moved(primary.manifest.pdf.path) !== primary.manifest.pdf.path) {
          primary.manifest.pdf.path = moved(primary.manifest.pdf.path); primary.metadataChanged(); changed = true;
        }
        if (folder || !/\.pdf$/i.test(oldPath)) {
          const surfaces = new Set([...primary.manifest.pages.map(page => page.id), ...Object.keys(primary.manifest.chunks).map(key => key.slice(0, key.lastIndexOf('/'))), ...primary.surfaces.keys()]);
          for (const id of surfaces) {
            const elements = await primary.load(id), updated = elements.map(retargetElement);
            if (updated.some((element, index) => element !== elements[index])) { primary.change(id, updated, false); changed = true; elementsChanged = true; }
          }
        }
        primary.bodyHistory.remapElements(retargetElement); primary.scratchHistory.remapElements(retargetElement);
        const diskBefore = liveViews.length > 1 ? await DocumentStore.open(this.io, file.path) : undefined;
        if (changed) await primary.flush();
        if (elementsChanged) await liveViews[0]?.actions?.rebuildScenes?.();
        for (const extra of liveViews.slice(1)) {
          const session = extra.session;
          if (!session || session === primary) continue;
          const extraPreRev = session.store.manifest.revision;
          await drain(session);
          const canAdoptDisk = (changed || extraPreRev !== primary.store.manifest.revision) && !dirtyExtras.has(session) && session.dirty.size === 0 && !session.metadataDirty && session.store.manifest.revision === extraPreRev;
          if (canAdoptDisk) {
            const freshStore = await DocumentStore.open(this.io, file.path);
            const surfaceIds = new Set([...freshStore.manifest.pages.map(page => page.id), ...Object.keys(freshStore.manifest.chunks).map(key => key.slice(0, key.lastIndexOf('/')))]);
            const freshSurfaces = new Map<string, Element[]>();
            for (const id of surfaceIds) freshSurfaces.set(id, await freshStore.readSurface(id));
            let onlyRetargeted = diskBefore?.manifest.revision === extraPreRev
              && JSON.stringify({ pages: freshStore.manifest.pages, regions: freshStore.manifest.regions }) === JSON.stringify({ pages: diskBefore.manifest.pages, regions: diskBefore.manifest.regions });
            if (onlyRetargeted && diskBefore) {
              const beforeSurfaceIds = new Set([...surfaceIds, ...diskBefore.manifest.pages.map(page => page.id), ...Object.keys(diskBefore.manifest.chunks).map(key => key.slice(0, key.lastIndexOf('/')))]);
              for (const id of beforeSurfaceIds) {
                const before = (await diskBefore.readSurface(id)).map(retargetElement), fresh = freshSurfaces.get(id) ?? [];
                if (before.length !== fresh.length || JSON.stringify(before) !== JSON.stringify(fresh)) { onlyRetargeted = false; break; }
              }
            }
            await drain(session);
            if (!dirtyExtras.has(session) && session.dirty.size === 0 && !session.metadataDirty && session.store.manifest.revision === extraPreRev) {
              session.store = freshStore; session.manifest = structuredClone(freshStore.manifest);
              for (const id of session.surfaces.keys()) if (!freshSurfaces.has(id)) session.revisions.set(id, session.revision(id) + 1);
              session.surfaces.clear(); session.trackers.clear();
              for (const [id, elements] of freshSurfaces) {
                session.surfaces.set(id, elements);
                const tracker = new SurfaceBlocks(id);
                tracker.reset(elements); session.trackers.set(id, tracker);
                session.revisions.set(id, session.revision(id) + 1);
              }
              if (onlyRetargeted) {
                session.bodyHistory.remapElements(retargetElement); session.scratchHistory.remapElements(retargetElement);
              } else {
                session.bodyHistory.clear(); session.scratchHistory.clear();
              }
              await session.loadFiles([...freshSurfaces.values()].flat());
              session.notify(); await extra.actions?.rebuildScenes?.();
              continue;
            }
          }
          let extraElementsChanged = false;
          if (session.manifest.pdf && moved(session.manifest.pdf.path) !== session.manifest.pdf.path) {
            session.manifest.pdf.path = moved(session.manifest.pdf.path); session.metadataChanged();
          }
          if (folder || !/\.pdf$/i.test(oldPath)) {
            const surfaces = new Set([...session.manifest.pages.map(page => page.id), ...Object.keys(session.manifest.chunks).map(key => key.slice(0, key.lastIndexOf('/'))), ...session.surfaces.keys()]);
            for (const id of surfaces) {
              const elements = await session.load(id), updated = elements.map(retargetElement);
              if (updated.some((element, index) => element !== elements[index])) { session.change(id, updated, false); extraElementsChanged = true; }
            }
          }
          session.bodyHistory.remapElements(retargetElement); session.scratchHistory.remapElements(retargetElement);
          session.notify();
          if (extraElementsChanged) await extra.actions?.rebuildScenes?.();
        }
      } catch (error) { new Notice(`未更新 ${file.path} 的关联：${(error as Error).message}`); }
    }
  }
}

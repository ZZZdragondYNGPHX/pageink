import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Plugin, FileView, WorkspaceLeaf, TFile, Notice, Modal, Setting, normalizePath, FuzzySuggestModal, MarkdownRenderChild } from 'obsidian';
import { DocumentStore, FileIO, ensureDir, forkDocument } from './storage';
import { newManifest, newPage, digest, uid, parseManifest, safePath, toArrayBuffer, Manifest } from './model';
import { Session } from './session';
import { PdfService } from './pdf';
import { Workspace } from './Workspace';
import { pack, unpack, readingPdf, png } from './export';
import type { PdfExportOptions } from './export';
import { type EditorHandle, selectedContent } from './Editor';
import { renderArea } from './preview';
import { setInkAssetBase, clearInkFontFaces } from './kernel-assets';
const VIEW = 'drawing-local-view';
async function progressTask<T>(app: Plugin['app'], title: string, task: (signal: AbortSignal, progress: (current: number, total: number) => void) => Promise<T>) {
  const controller = new AbortController(), modal = new Modal(app); modal.titleEl.setText(title);
  modal.modalEl.addClass('ink-host-modal', 'ink-progress-modal');
  const progress = modal.contentEl.createDiv({ text: '正在准备…' }); progress.setAttribute('role', 'status');
  new Setting(modal.contentEl).addButton(button => button.setButtonText('取消').onClick(() => controller.abort()));
  modal.onClose = () => controller.abort(); modal.open();
  try { return await task(controller.signal, (i, n) => progress.setText(`${title} ${i}/${n}…`)); }
  finally { modal.close(); }
}
class PdfPicker extends FuzzySuggestModal<TFile> {
  constructor(private plugin: DrawingPlugin, private selected: (file: TFile) => Promise<void>) { super(plugin.app); this.setPlaceholder('选择同一份原 PDF（核对内容身份）'); }
  getItems() { return this.app.vault.getFiles().filter(f => f.extension === 'pdf'); }
  getItemText(file: TFile) { return file.path; }
  onChooseItem(file: TFile) { void this.selected(file).catch(e => new Notice(e.message)); }
}

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
class CreateModal extends Modal {
  constructor(private plugin: DrawingPlugin) { super(plugin.app); }
  onOpen() {
    this.modalEl.addClass('ink-host-modal', 'ink-create-modal');
    this.titleEl.setText('新建绘图笔记'); let title = '新笔记';
    new Setting(this.contentEl).setName('文档标题').addText(input => { input.inputEl.setAttribute('aria-label', '文档标题'); input.inputEl.autocomplete = 'off'; input.setValue(title).onChange(value => title = value); });
    for (const [mode, name] of [['pages', '有边记'], ['canvas', '无边记']] as const) {
      new Setting(this.contentEl).setName(name).setDesc(mode === 'pages' ? '按页书写，支持纸张模板与四边留白' : '自由延展，适合演算、草图与思维整理').addButton(button => button.setButtonText('创建').onClick(async () => {
        try { await this.plugin.create(title, mode); this.close(); } catch (e) { new Notice((e as Error).message); }
      }));
    }
    new Setting(this.contentEl).setName('导入库外 PDF').addButton(button => button.setButtonText('选择文件').onClick(() => this.plugin.chooseFile('.pdf', async file => { await this.plugin.importPdf(file.name, await file.arrayBuffer()); this.close(); })));
    new Setting(this.contentEl).setName('恢复完整打包').addButton(button => button.setButtonText('选择打包').onClick(() => this.plugin.chooseFile('.inkpack,.zip', async file => {
      const path = await this.plugin.uniquePath(file.name.replace(/\.(inkpack|zip)$/, '') + ' restored', 'inknote');
      await progressTask(this.app, '恢复完整打包', async (signal, progress) => unpack(this.plugin.io, new Uint8Array(await file.arrayBuffer()), path, progress, signal)); await this.plugin.openPath(path); this.close();
    })));
  }
}
class DrawingView extends FileView {
  root?: Root; session?: Session; pdf?: PdfService; generation = 0;
  private unloading?: Promise<void>;
  constructor(leaf: WorkspaceLeaf, private plugin: DrawingPlugin) { super(leaf); }
  getViewType() { return VIEW; }
  getDisplayText() { return this.file?.basename ?? '绘图'; }
  async onLoadFile(file: TFile) {
    const generation = ++this.generation;
    await this.unloading;
    if (generation !== this.generation) return;
    this.contentEl.empty(); this.contentEl.addClass('ink-view');
    this.contentEl.createDiv({ text: '正在读取文档…', cls: 'ink-loading' });
    try {
      const session = this.plugin.unsavedSessions.get(file.path) ?? new Session(await DocumentStore.open(this.plugin.io, file.path));
      let pdf: PdfService | undefined;
      if (session.manifest.pdf) {
        try { pdf = await PdfService.open(this.plugin.io, session.manifest.pdf, this.plugin.assetBase); session.sourceIssue = ''; }
        catch (error) { session.sourceIssue = (error as Error).message; }
      }
      if (generation !== this.generation) { await pdf?.destroy(); return; }
      this.plugin.unsavedSessions.delete(file.path);
      // Obsidian may empty contentEl before the asynchronous unload flush finishes.
      // A dedicated mount retains React's own child tree even after host detachment.
      this.session = session; this.pdf = pdf; this.contentEl.empty(); this.root = createRoot(this.contentEl.createDiv({ cls: 'ink-react-root' }));
      this.root.render(<Workspace session={session} pdf={pdf} onExport={(kind, page, editor, options) => this.export(kind, page, editor, options)} onReference={async (page, region, embed) => {
        const uri = `obsidian://drawing-local?vault=${encodeURIComponent(this.app.vault.getName())}&document=${session.manifest.id}&file=${encodeURIComponent(file.path)}&page=${page}${region ? `&region=${region}` : ''}`;
        await session.flush();
        await navigator.clipboard.writeText(embed ? '```drawing-region\n' + JSON.stringify({ document: session.manifest.id, file: this.file?.path, region }) + '\n```' : `[${region ? session.manifest.regions.find(r => r.id === region)?.title : file.basename}](${uri})`);
        new Notice('引用已复制');
      }} onOpenSource={async (document, page, rect) => {
        const path = await this.plugin.resolveDocument(undefined, document); await this.plugin.openPath(path);
        const target = this.app.workspace.getLeavesOfType(VIEW).find(leaf => (leaf.view as DrawingView).file?.path === path)?.view as DrawingView;
        target.session?.navigate(page, undefined, rect);
      }} onResolveConflict={async openCopy => {
        const path = await session.preserveConflict(); session.conflictResolved = true;
        try { if (openCopy) await this.plugin.openPath(path); else { const current = this.file!; await this.onUnloadFile(); await this.onLoadFile(current); } }
        catch (error) { session.conflictResolved = false; throw error; }
      }} />);
    } catch (e) {
      if (generation !== this.generation) return;
      this.contentEl.empty(); this.contentEl.createDiv({ cls: 'ink-error', text: (e as Error).message });
      const backup = `${file.path}.last-good.json`;
      const recoverable = await this.plugin.io.exists(backup);
      if (generation !== this.generation) return;
      if (recoverable) this.contentEl.createEl('button', { text: '查看恢复记录并另存副本' }).onclick = () => void (async () => {
        await this.plugin.showRecovery(parseManifest(await this.plugin.io.read(backup)));
      })().catch(error => new Notice(error.message));
    }
  }
  async export(kind: 'pdf' | 'png' | 'package', page: string, editor?: EditorHandle, options: PdfExportOptions = {}) {
    const session = this.session!;
    await session.flush();
    let bytes: ArrayBuffer, ext: string;
    if (kind === 'package') { bytes = toArrayBuffer(await this.exportTask('完整打包', (signal, progress) => pack(session, progress, signal))); ext = 'inkpack'; }
    else if (kind === 'png') {
      const api = editor!.api, selected = selectedContent(api);
      bytes = await (await png(session, selected)).arrayBuffer(); ext = 'png';
    } else {
      const api = editor?.api, selection = api ? selectedContent(api) : undefined;
      const data = await this.exportTask('导出 PDF', (signal, progress) => readingPdf(session, progress, signal, this.plugin.assetBase, { ...options, selection }));
      bytes = toArrayBuffer(data); ext = 'pdf';
    }
    await ensureDir(this.plugin.io, 'Drawing Exports');
    const path = await this.plugin.uniquePath(`Drawing Exports/${session.manifest.title}`, ext);
    await this.plugin.io.writeBinary(path, bytes); new Notice(`已导出：${path}`);
    return path;
  }
  async exportTask<T>(title: string, task: (signal: AbortSignal, progress: (current: number, total: number) => void) => Promise<T>) {
    return progressTask(this.app, title, task);
  }
  async onUnloadFile() {
    ++this.generation;
    const session = this.session, root = this.root, pdf = this.pdf;
    this.root = undefined; this.session = undefined; this.pdf = undefined;
    const operation = (async () => {
      try { await session?.flush(); }
      catch (error) {
        if (session) this.plugin.unsavedSessions.set(session.store.path, session);
        new Notice(`关闭时保存失败，未保存内容暂留当前 Obsidian 会话；请重开笔记后重试保存。${(error as Error).message}`, 15000);
      } finally { root?.unmount(); await pdf?.destroy(); }
    })();
    this.unloading = operation;
    try { await operation; } finally { if (this.unloading === operation) this.unloading = undefined; }
  }
}
export default class DrawingPlugin extends Plugin {
  io = new VaultIO(this);
  unsavedSessions = new Map<string, Session>();
  previewCache = new Map<string, HTMLCanvasElement>();
  get assetBase() { return this.app.vault.adapter.getResourcePath(`${this.manifest.dir}/assets`).split('?')[0].replace(/\/$/, '') + '/'; }
  async onload() {
    setInkAssetBase(this.assetBase);
    this.register(clearInkFontFaces);
    const face = new FontFace('Ink Notebook Sans', `url("${this.assetBase}fonts/NotoSansCJKsc-Regular.otf")`);
    await face.load(); document.fonts.add(face); this.register(() => document.fonts.delete(face));
    this.registerView(VIEW, leaf => new DrawingView(leaf, this));
    this.registerExtensions(['inknote'], VIEW);
    this.addRibbonIcon('pencil', '新建绘图笔记', () => new CreateModal(this).open());
    this.addCommand({ id: 'new-drawing', name: '新建绘图笔记', callback: () => new CreateModal(this).open() });
    this.addCommand({ id: 'relink-source', name: '重新关联原 PDF', callback: () => {
      const view = this.app.workspace.getActiveViewOfType(DrawingView), session = view?.session;
      if (!session?.manifest.pdf) { new Notice('请先打开 PDF 批注笔记。'); return; }
      new PdfPicker(this, async file => {
        const bytes = await this.app.vault.readBinary(file);
        if (await digest(bytes) !== session.manifest.pdf!.sha256) throw Error('内容不是同一原件，未迁移旧批注；请为新版另建文档。');
        session.manifest.pdf!.path = file.path; session.metadataChanged(); await session.flush();
        await view!.onUnloadFile(); await view!.onLoadFile(view!.file!);
      }).open();
    }});
    this.addCommand({ id: 'restore-copy', name: '恢复记录（另存副本）', callback: () => { void (async () => {
      const view = this.app.workspace.getActiveViewOfType(DrawingView); if (!view?.session) { new Notice('请先打开绘图笔记。'); return; }
      await this.showRecovery(view.session.manifest);
    })().catch(e => new Notice(e.message)); }});
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'pdf') menu.addItem(item => item.setTitle('创建独立批注笔记').setIcon('pencil').onClick(() => { void this.importPdf(file.basename, undefined, file).catch(e => new Notice(e.message)); }));
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { void this.maintainPdfPath(oldPath, file.path).catch(e => new Notice(e.message)); }));
    this.registerEvent(this.app.vault.on('modify', file => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) {
        const view = leaf.view as DrawingView, session = view.session;
        if (session?.manifest.pdf?.path === file.path) void (async () => {
          const identity = await digest(await this.io.readBinary(file.path));
          if (identity !== session.manifest.pdf!.sha256) {
            session.sourceIssue = '原 PDF 内容已变化。请为新版另建文档，或重新关联同一原件。'; session.notify();
          }
        })().catch(e => { session.sourceIssue = e.message; session.notify(); });
      }
    }));
    this.registerEvent(this.app.vault.on('delete', file => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) {
        const session = (leaf.view as DrawingView).session, path = session?.manifest.pdf?.path;
        if (session && path && (path === file.path || path.startsWith(file.path + '/'))) { session.sourceIssue = '原 PDF 已删除或暂未同步到此设备。请重新关联同一原件。'; session.notify(); }
      }
    }));
    this.registerObsidianProtocolHandler('drawing-local', async params => {
      try {
        const path = await this.resolveDocument(params.file, params.document);
        if (!path) throw Error('找不到引用文档。');
        await this.openPath(path);
        const view = this.app.workspace.getLeavesOfType(VIEW).find(leaf => (leaf.view as DrawingView).file?.path === path)?.view as DrawingView | undefined;
        if (params.page) view?.session?.navigate(params.page, params.region);
      } catch (e) { new Notice((e as Error).message); }
    });
    this.registerMarkdownCodeBlockProcessor('drawing-region', async (source, el, context) => {
      const child = new MarkdownRenderChild(el); context.addChild(child);
      let controller = new AbortController(), timer: ReturnType<typeof setTimeout> | undefined, disposed = false, currentPath = '', sourcePath = '';
      child.register(() => { disposed = true; controller.abort(); clearTimeout(timer); });
      const render = async () => {
        controller.abort(); const task = new AbortController(); controller = task;
        try {
          const ref = JSON.parse(source), path = await this.resolveDocument(ref.file, ref.document); currentPath = path;
          const store = await DocumentStore.open(this.io, path), session = new Session(store);
          sourcePath = store.manifest.pdf?.path ?? '';
          const region = store.manifest.regions.find(r => r.id === ref.region);
          if (!region) throw Error('区域不存在或尚未同步。');
          const page = store.manifest.pages.find(p => p.id === region.pageId); if (!page) throw Error('引用页已删除。');
          const key = store.manifest.id + '/' + store.manifest.revision + '/' + region.id;
          let cached = this.previewCache.get(key);
          if (!cached) {
            const pdf = store.manifest.pdf ? await PdfService.open(this.io, store.manifest.pdf, this.assetBase) : undefined;
            try { cached = await renderArea(session, page, region, Math.min(2, 1200 / Math.max(region.width, region.height)), pdf, task.signal); }
            finally { await pdf?.destroy(); }
            task.signal.throwIfAborted(); this.previewCache.set(key, cached);
            while (this.previewCache.size > 12) this.previewCache.delete(this.previewCache.keys().next().value!);
          }
          task.signal.throwIfAborted();
          const canvas = document.createElement('canvas'); canvas.width = cached.width; canvas.height = cached.height; canvas.getContext('2d')!.drawImage(cached, 0, 0);
          canvas.style.maxWidth = '100%'; canvas.style.height = 'auto'; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', region.title);
          el.replaceChildren(canvas);
          el.createEl('button', { text: region.title }).onclick = () => void (async () => {
            const target = await this.resolveDocument(ref.file, ref.document); await this.openPath(target);
            const view = this.app.workspace.getLeavesOfType(VIEW).find(leaf => (leaf.view as DrawingView).file?.path === target)?.view as DrawingView;
            view.session?.navigate(region.pageId, region.id);
          })().catch(e => new Notice(e.message));
        } catch (e) { if (!task.signal.aborted && !disposed) el.setText((e as Error).message); }
      };
      const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { if (!disposed) void render(); }, 500); };
      child.registerEvent(this.app.vault.on('modify', file => { if (file.path === currentPath) schedule(); else if (file.path === sourcePath) { this.previewCache.clear(); schedule(); } }));
      child.registerEvent(this.app.vault.on('rename', (file, oldPath) => { if (oldPath === currentPath) { currentPath = file.path; schedule(); } }));
      await render();
    });
  }

  async resolveDocument(path?: string, id?: string) {
    if (path && await this.io.exists(path)) {
      const manifest = parseManifest(await this.io.read(path)); if (!id || manifest.id === id) return path;
    }
    if (id) for (const file of this.app.vault.getFiles().filter(f => f.extension === 'inknote')) {
      try { if (parseManifest(await this.io.read(file.path)).id === id) return file.path; } catch { /* An unrelated damaged note must not break all references. */ }
    }
    throw Error('引用文档不存在或尚未同步。');
  }
  async showRecovery(manifest: Manifest) {
    const records = await new DocumentStore(this.io, '', manifest).recoveryRecords();
    if (!records.some(record => record.manifest.revision === manifest.revision)) records.push({ path: '', manifest });
    const modal = new Modal(this.app); modal.titleEl.setText('恢复记录 · 另存副本');
    modal.modalEl.addClass('ink-host-modal', 'ink-recovery-modal');
    for (const record of records) new Setting(modal.contentEl).setName(new Date(record.manifest.modified).toLocaleString()).addButton(button => button.setButtonText('另存恢复').onClick(async () => {
      try { const path = await this.uniquePath(`${record.manifest.title} recovered`, 'inknote'); await forkDocument(this.io, record.manifest, path); modal.close(); await this.openPath(path); } catch (error) { new Notice((error as Error).message); }
    }));
    modal.open();
  }
  async uniquePath(title: string, ext: string) {
    title = title.replace(/[<>:"\\|?*]/g, '-').trim() || 'Untitled';
    safePath(`${title}.${ext}`);
    let path = `${title}.${ext}`, n = 1; while (await this.io.exists(path)) path = `${title} ${n++}.${ext}`; return path;
  }
  async openPath(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) { await new Promise(resolve => setTimeout(resolve, 150)); }
    const target = this.app.vault.getAbstractFileByPath(path);
    if (!(target instanceof TFile)) throw Error(`文件尚未同步：${path}`);
    const existing = this.app.workspace.getLeavesOfType(VIEW).find(leaf => (leaf.view as DrawingView).file?.path === path);
    const leaf = existing ?? this.app.workspace.getLeaf(false);
    await leaf.openFile(target); this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
  async create(title: string, mode: 'pages' | 'canvas') {
    const manifest = newManifest(title, mode), path = await this.uniquePath(title, 'inknote');
    await new DocumentStore(this.io, path, manifest).commit(new Map()); await this.openPath(path);
  }
  chooseFile(accept: string, callback: (file: File) => Promise<void>) {
    const input = document.createElement('input'); input.type = 'file'; input.accept = accept;
    input.onchange = () => { if (input.files?.[0]) void callback(input.files[0]).catch(e => new Notice(e.message)); }; input.click();
  }
  async importPdf(name: string, bytes?: ArrayBuffer, file?: TFile) {
    const manifest = newManifest(name.replace(/\.pdf$/i, ''), 'pages');
    bytes ??= await this.app.vault.readBinary(file!);
    let path = file?.path;
    if (!path) { await ensureDir(this.io, `${manifest.resourceDir}/assets`); path = `${manifest.resourceDir}/assets/source.pdf`; await this.io.writeBinary(path, bytes); }
    manifest.pdf = { path, sha256: await digest(bytes), size: bytes.byteLength };
    const pdf = await PdfService.fromBytes(bytes.slice(0), this.assetBase);
    try {
      manifest.pages = [];
      for (let i = 1; i <= pdf.document.numPages; i++) { const p = await pdf.document.getPage(i), viewport = p.getViewport({ scale: 1 }); manifest.pages.push({ ...newPage(), pdfPage: i, width: viewport.width, height: viewport.height }); }
    } finally { await pdf.destroy(); }
    const entry = await this.uniquePath(manifest.title, 'inknote');
    await new DocumentStore(this.io, entry, manifest).commit(new Map()); await this.openPath(entry);
  }
  async maintainPdfPath(oldPath: string, newPath: string) {
    const moved = (path: string) => path === oldPath ? newPath : path.startsWith(oldPath + '/') ? newPath + path.slice(oldPath.length) : path;
    for (const [path, session] of [...this.unsavedSessions]) if (moved(path) !== path) { this.unsavedSessions.delete(path); session.store.path = moved(path); this.unsavedSessions.set(moved(path), session); }
    if (oldPath.endsWith('.inknote') && await this.io.exists(`${oldPath}.last-good.json`)) {
      await this.io.write(`${newPath}.last-good.json`, await this.io.read(`${oldPath}.last-good.json`));
      await this.io.remove(`${oldPath}.last-good.json`);
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) {
      const view = leaf.view as DrawingView;
      if (view.session) view.session.store.path = moved(view.session.store.path);
    }
    for (const file of this.app.vault.getFiles().filter(file => file.extension === 'inknote')) {
      const view = this.app.workspace.getLeavesOfType(VIEW).map(leaf => leaf.view as DrawingView).find(view => view.file?.path === file.path);
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

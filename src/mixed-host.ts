import { App, FileView, FuzzySuggestModal, MarkdownView, Scope, TFile, WorkspaceLeaf } from 'obsidian';
import { findParagraph, Paragraph, paragraphEdit, paragraphs, TextReference } from './mixed';
import { uid } from './model';

export interface SourceParagraph { path: string; blockId: string; text: string; source: string }
export interface MixedHost {
  pick(): Promise<SourceParagraph | undefined>;
  read(reference: TextReference): Promise<SourceParagraph>;
  edit(reference: TextReference): Promise<void>;
  commit(reference: TextReference, expected: SourceParagraph, text: string): Promise<SourceParagraph>;
  bindDraftKeys(element: HTMLElement, submit: () => void): () => void;
}

export class Choice<T> extends FuzzySuggestModal<T> {
  private chosen = false;
  constructor(app: App, label: string, private items: T[], private display: (item: T) => string, private resolve: (item?: T) => void) { super(app); this.setPlaceholder(label); }
  getItems() { return this.items; }
  getItemText(item: T) { return this.display(item); }
  onChooseItem(item: T) { this.chosen = true; this.resolve(item); }
  // Obsidian closes the modal before dispatching onChooseItem.
  onClose() { window.setTimeout(() => { if (!this.chosen) this.resolve(); }, 0); }
}

/** Native Markdown owns editing/history. Block IDs are added only when the user inserts a paragraph. */
export class MixedNotes implements MixedHost {
  constructor(private app: App, private origin: () => WorkspaceLeaf) {}
  bindDraftKeys(element: HTMLElement, submit: () => void) {
    const scope = new Scope(this.app.scope);
    for (const key of ['Enter', 'S']) scope.register(['Mod'], key, event => {
      if (event.isComposing || !element.contains(element.ownerDocument.activeElement)) return;
      event.stopPropagation(); submit(); return false;
    });
    let active = false;
    const enter = () => { if (!active) { this.app.keymap.pushScope(scope); active = true; } };
    const leave = (event?: FocusEvent) => {
      if (event?.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
      if (active) { this.app.keymap.popScope(scope); active = false; }
    };
    element.addEventListener('focusin', enter); element.addEventListener('focusout', leave);
    if (element.contains(element.ownerDocument.activeElement)) enter();
    return () => { element.removeEventListener('focusin', enter); element.removeEventListener('focusout', leave); leave(); };
  }
  private choose<T>(label: string, items: T[], display: (item: T) => string) {
    return new Promise<T | undefined>(resolve => new Choice(this.app, label, items, display, resolve).open());
  }
  private views(file: TFile) { return this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView && view.file === file); }
  private async source(file: TFile) {
    const views = this.views(file).filter(view => view.getMode() === 'source');
    const original = views[0]?.editor.getValue();
    if (views.some(view => view.editor.getValue() !== original)) throw Error('原笔记在多个编辑器中内容不一致，请先保存并解决差异。');
    if (views[0]) await views[0].save();
    const text = await this.app.vault.read(file);
    if (views.some(view => view.file !== file || view.editor.getValue() !== original) || original !== undefined && text !== original) throw Error('原笔记正在变化，请保存后重试。');
    return text;
  }
  private async native(file: TFile, activate = true): Promise<MarkdownView> {
    const existing = this.views(file)[0];
    const leaf = existing?.leaf ?? (activate ? this.app.workspace.createLeafBySplit(this.origin(), 'vertical') : this.app.workspace.getLeaf('tab'));
    // Creating a tab can activate it before openFile({active:false}); retain the draft's view.
    if (!activate) this.app.workspace.setActiveLeaf(this.origin(), { focus: false });
    if (!existing) await leaf.openFile(file, { active: activate });
    const state = leaf.getViewState();
    if (!(leaf.view instanceof MarkdownView) || leaf.view.getMode() !== 'source') await leaf.setViewState({ ...state, state: { ...state.state, mode: 'source' } });
    if (activate) { await this.app.workspace.revealLeaf(leaf); this.app.workspace.setActiveLeaf(leaf, { focus: true }); }
    if (!(leaf.view instanceof MarkdownView) || leaf.view.file !== file) throw Error('无法打开原生文字编辑器，请重试。');
    return leaf.view;
  }
  async pick(): Promise<SourceParagraph | undefined> {
    const origin = this.origin(), view = origin.view, target = view instanceof FileView ? view.file : null;
    const assertTarget = () => { if (origin.view !== view || !view.containerEl.isConnected || view instanceof FileView && view.file !== target) throw Error('目标笔记已关闭或切换，请重新插入段落。'); };
    const file = await this.choose('选择文字笔记（Markdown 文件）', this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime), file => file.path);
    if (!file) return;
    assertTarget();
    const original = await this.source(file), choices = paragraphs(original);
    if (!choices.length) throw Error('这份笔记没有可插入的普通段落或标题。列表、表格、代码和嵌入请在原笔记中编辑。');
    const paragraph = await this.choose('选择要摘入的段落', choices, p => p.text.replace(/\s+/g, ' ').slice(0, 160));
    if (!paragraph) return;
    assertTarget();
    if (await this.source(file) !== original) throw Error('选择期间原笔记已变化，请重新选择段落。');
    let source = original, blockId = paragraph.blockId;
    if (!blockId) {
      const view = await this.native(file);
      assertTarget();
      if (view.editor.getValue() !== original) throw Error('原笔记已变化，请重新选择段落。');
      blockId = `pi-${uid()}`;
      view.editor.replaceRange(` ^${blockId}`, view.editor.offsetToPos(paragraph.to));
      await view.save(); source = await this.source(file);
    }
    const current = findParagraph(source, blockId);
    // Return to the notebook after the picker; the real editor stays open beside it.
    const leaf = this.origin();
    await this.app.workspace.revealLeaf(leaf); this.app.workspace.setActiveLeaf(leaf, { focus: true });
    return { path: file.path, blockId, text: current.text, source };
  }
  private async resolve(reference: TextReference): Promise<TFile> {
    const direct = this.app.vault.getAbstractFileByPath(reference.path);
    if (direct instanceof TFile && direct.extension === 'md') return direct;
    const resource = reference.path.startsWith('Drawing Resources/');
    const candidates = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith('Drawing Resources/') === resource && this.app.metadataCache.getFileCache(file)?.blocks?.[reference.blockId]);
    if (candidates.length !== 1) throw Error(candidates.length ? '找到多个具有相同段落标识的原件，无法确定改名后的来源；当前内容已保留。' : '找不到文字原件。页面上的文字、批注和备份快照仍保留。');
    return candidates[0];
  }
  async read(reference: TextReference): Promise<SourceParagraph> {
    const file = await this.resolve(reference), source = await this.source(file), paragraph = findParagraph(source, reference.blockId);
    return { path: file.path, blockId: reference.blockId, text: paragraph.text, source };
  }
  async commit(reference: TextReference, expected: SourceParagraph, text: string): Promise<SourceParagraph> {
    const origin = this.origin(), target = origin.view, file = await this.resolve(reference);
    const source = await this.source(file);
    if (source !== expected.source) throw Error('原文已在别处修改。你的草稿仍保留，请复制草稿后重新打开卡片编辑。');
    const patch = paragraphEdit(source, reference.blockId, text);
    if (patch.next === source) return { ...expected, path: file.path };
    const view = await this.native(file, false);
    if (origin.view !== target || !target.containerEl.isConnected || view.editor.getValue() !== source || await this.source(file) !== source) throw Error('笔记或原文已变化，草稿已保留，请重新打开卡片编辑。');
    // No await between the final comparison and this single native transaction.
    if (view.editor.getValue() !== source) throw Error('原文正在变化，请重试。');
    view.editor.replaceRange(patch.text, view.editor.offsetToPos(patch.from), view.editor.offsetToPos(patch.to));
    await view.save();
    const saved = await this.source(file);
    if (saved !== patch.next) throw Error('原文已提交，但随后又发生变化；请检查原笔记并更新卡片。');
    this.app.workspace.setActiveLeaf(origin, { focus: false });
    return { path: file.path, blockId: reference.blockId, text: patch.text, source: saved };
  }
  async edit(reference: TextReference) {
    const file = await this.resolve(reference), source = await this.source(file), paragraph: Paragraph = findParagraph(source, reference.blockId);
    const view = await this.native(file);
    if (view.editor.getValue() !== source) throw Error('原笔记已变化，请重试。');
    const raw = source.slice(paragraph.from, paragraph.to), marker = raw.match(/\s+\^[A-Za-z0-9-]+\s*$/);
    const end = marker ? paragraph.from + marker.index! : paragraph.to;
    view.editor.setSelection(view.editor.offsetToPos(paragraph.from), view.editor.offsetToPos(end));
    view.editor.scrollIntoView({ from: view.editor.offsetToPos(paragraph.from), to: view.editor.offsetToPos(paragraph.to) }, true); view.editor.focus();
  }
}

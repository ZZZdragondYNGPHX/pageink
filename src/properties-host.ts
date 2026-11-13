import { App, MarkdownView, Modal, TFile, getFrontMatterInfo, parseYaml } from 'obsidian';
import { parseManifest } from './model';
import type { Session } from './session';
import { DocumentStore, type FileIO } from './storage';
import {
  applyPropertyChanges, copyProperties, editableKey, parsePropertyNumber,
  propertiesSnapshot, propertyChanges, propertyPreview, propertyType, PROPERTY_TYPES, sameProperty, validateProperties,
  type JsonProperties, type PropertiesSnapshot, type PropertyChange, type PropertyType, type PropertyValue,
} from './properties';

/** Host integration only: call open(path) and import properties.css from the plugin entry. */
export class NoteProperties {
  private writes = new Map<string, Promise<void>>();
  private files = new WeakMap<PropertiesSnapshot, TFile>();
  private modals = new Set<NotePropertiesModal>();
  private disposed = false;
  constructor(private app: App, private io: FileIO, private session: (path: string) => Session | undefined) {}

  async open(path: string): Promise<void> {
    const snapshot = await this.read(path);
    this.checkActive();
    const modal = new NotePropertiesModal(this.app, this, snapshot, () => this.modals.delete(modal));
    this.modals.add(modal);
    modal.open();
  }

  /** Plugin unload closes only this service's dialogs and prevents new/stale operations. */
  dispose(): void {
    this.disposed = true;
    for (const modal of this.modals) modal.dispose();
    this.modals.clear();
  }
  private checkActive() {
    if (this.disposed) throw Error('属性服务已卸载，不能继续读写。请重新打开 PageInk。');
  }

  private file(path: string): TFile {
    this.checkActive();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw Error('笔记已移动、删除或尚未到达本机，请重新打开。');
    return file;
  }
  private checkFile(path: string, file: TFile) {
    if (file.path !== path || this.file(path) !== file) throw Error('笔记已移动或替换，请保留草稿并重新打开属性。');
  }
  private async saveMarkdown(file: TFile, path: string) {
    // TextFileView.save owns editor persistence. Never read/write editor content ourselves.
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file === file) {
        this.checkFile(path, file); await leaf.view.save();
      }
    }
    this.checkFile(path, file);
  }

  async read(path: string): Promise<PropertiesSnapshot> {
    const file = this.file(path);
    let snapshot: PropertiesSnapshot;
    if (file.extension.toLowerCase() === 'md') {
      await this.saveMarkdown(file, path);
      const info = getFrontMatterInfo(await this.app.vault.read(file));
      this.checkFile(path, file);
      const value: unknown = info.exists && !info.frontmatter.split('\n').every(line => /^\s*(?:#.*)?$/.test(line)) ? parseYaml(info.frontmatter) : {};
      snapshot = propertiesSnapshot(path, 'markdown', value);
    } else if (file.extension.toLowerCase() === 'inknote') {
      const live = this.session(path);
      const manifest = live?.manifest ?? parseManifest(await this.io.read(path));
      this.checkFile(path, file);
      if (live && live.store.path !== path) throw Error('笔记位置已变化，请重新打开属性。');
      if (manifest.properties !== undefined) validateProperties(manifest.properties);
      snapshot = propertiesSnapshot(path, 'drawing', manifest.properties ?? {}, manifest.id);
    } else if (file.extension.toLowerCase() === 'pdf') snapshot = propertiesSnapshot(path, 'pdf', {});
    else throw Error('这类文件不支持笔记属性。');
    this.checkActive();
    this.files.set(snapshot, file);
    return snapshot;
  }

  /** Resolves only after persistence. The opening snapshot remains unchanged on failure. */
  save(snapshot: PropertiesSnapshot, changes: readonly PropertyChange[]): Promise<void> {
    // Copy before queuing: edits supplied by an input handler may be mutated later.
    let edits: PropertyChange[];
    try {
      this.checkActive();
      if (snapshot.kind === 'pdf') throw Error('PDF 只读，不支持编辑属性。');
      edits = propertyChanges(snapshot.properties, changes);
    } catch (error) { return Promise.reject(error instanceof Error ? error : Error(String(error))); }
    const operation = (this.writes.get(snapshot.path) ?? Promise.resolve()).catch(() => {}).then(() => this.persist(snapshot, edits));
    this.writes.set(snapshot.path, operation);
    void operation.finally(() => { if (this.writes.get(snapshot.path) === operation) this.writes.delete(snapshot.path); }).catch(() => {});
    return operation;
  }

  private async persist(snapshot: PropertiesSnapshot, edits: PropertyChange[]) {
    const file = this.files.get(snapshot);
    if (!file) throw Error('请使用 read() 返回的原始属性快照保存。');
    this.checkFile(snapshot.path, file);
    if (!edits.length) return;
    if (snapshot.kind === 'markdown') {
      await this.saveMarkdown(file, snapshot.path);
      await this.app.fileManager.processFrontMatter(file, current => {
        this.checkFile(snapshot.path, file);
        applyPropertyChanges(current as Record<string, unknown>, snapshot.properties, edits);
      });
      this.checkActive();
      return;
    }
    let live = this.session(snapshot.path);
    if (!live) {
      const store = await DocumentStore.open(this.io, snapshot.path);
      this.checkFile(snapshot.path, file);
      live = this.session(snapshot.path);
      if (!live) {
        if (store.manifest.id !== snapshot.documentId) throw Error('笔记已替换，请重新打开属性。');
        const metadata = structuredClone(store.manifest), current = copyProperties(metadata.properties ?? {});
        applyPropertyChanges(current, snapshot.properties, edits);
        metadata.properties = current as JsonProperties;
        await store.commit(new Map(), metadata);
        this.checkActive();
        return;
      }
    }
    await this.saveLive(live, snapshot, edits, file);
  }

  private async saveLive(live: Session, snapshot: PropertiesSnapshot, edits: PropertyChange[], file: TFile) {
    const check = () => {
      this.checkFile(snapshot.path, file);
      if (this.session(snapshot.path) !== live || live.store.path !== snapshot.path || live.manifest.id !== snapshot.documentId) {
        throw Error('当前笔记已变化，请保留草稿并重新打开属性。');
      }
      if (live.conflictPath) throw Error('笔记存在保存冲突，请先选择要继续编辑的版本，再保存属性。');
    };
    check();
    // Flush kernel/native state before staging properties; failure cannot leak a draft.
    await live.flush();
    check();
    const disk = parseManifest(await this.io.read(snapshot.path));
    check();
    if (disk.id !== live.manifest.id || disk.revision !== live.store.manifest.revision || JSON.stringify(disk) !== JSON.stringify(live.store.manifest)) {
      throw Error('笔记在别处被修改过，请重新载入笔记后再保存属性。草稿已保留。');
    }
    const previous = live.manifest.properties, current = copyProperties(previous ?? {});
    validateProperties(current);
    applyPropertyChanges(current, snapshot.properties, edits);
    // Check the disk too, including writers that changed properties without a new revision.
    applyPropertyChanges(copyProperties(disk.properties ?? {}), snapshot.properties, edits);
    live.manifest.properties = current;
    try {
      live.metadataChanged();
      this.checkActive();
      // flush() above already drained editors. save() publishes this metadata immediately,
      // without running fallible editor flushers a second time after staging the draft.
      await live.save();
    } catch (error) {
      // Do not leave failed property edits queued for an unrelated future autosave.
      // Restore only our own still-matching keys, preserving edits made during the await.
      const restored = copyProperties(live.manifest.properties ?? {});
      for (const edit of edits) {
        const ours = edit.op === 'delete' ? !Object.hasOwn(restored, edit.key) :
          Object.hasOwn(restored, edit.key) && sameProperty(restored[edit.key], edit.value);
        if (!ours) continue;
        if (previous && Object.hasOwn(previous, edit.key)) restored[edit.key] = structuredClone(previous[edit.key]);
        else delete restored[edit.key];
      }
      if (previous === undefined && !Object.keys(restored).length) delete live.manifest.properties;
      else live.manifest.properties = restored as JsonProperties;
      window.clearTimeout(live.timer);
      live.metadataDirty = true;
      live.notify();
      throw error;
    }
    this.checkActive();
  }
}

interface DraftRow {
  key: string;
  existing: boolean;
  type?: PropertyType;
  text: string;
  checked: boolean;
  items: string[];
  original?: unknown;
  removed: boolean;
}

/** Native Modal retains focus management and host close controls; every close is guarded. */
export class NotePropertiesModal extends Modal {
  private rows: DraftRow[];
  private initial: string;
  private busy = false;
  private acceptingClose = false;
  private confirming = false;
  private list!: HTMLElement;
  private error!: HTMLElement;
  private confirmation!: HTMLElement;
  private saveButton?: HTMLButtonElement;
  private addButton?: HTMLButtonElement;

  constructor(app: App, private host: NoteProperties, private snapshot: PropertiesSnapshot, private onClosed: () => void = () => {}) {
    super(app);
    this.rows = Object.entries(snapshot.properties).map(([key, value]) => ({
      key, existing: true, type: editableKey(key) ? propertyType(value) : undefined,
      text: typeof value === 'string' || typeof value === 'number' ? String(value) : '',
      checked: value === true, items: propertyType(value) === 'list' ? [...value as string[]] : [], original: value, removed: false,
    }));
    this.initial = this.fingerprint();
  }
  private fingerprint() {
    return JSON.stringify(this.rows.filter(row => row.type).map(row => [row.key, row.existing, row.removed, row.type,
      row.type === 'boolean' ? row.checked : row.type === 'list' ? row.items : row.text]));
  }
  private get dirty() { return this.fingerprint() !== this.initial; }
  private changed() {
    this.confirming = false; this.confirmation.replaceChildren();
    this.error.textContent = '';
    if (this.saveButton) this.saveButton.disabled = this.busy || !this.dirty;
  }
  private button(parent: HTMLElement, label: string, action: () => void, cls = '') {
    const button = parent.createEl('button', { text: label, cls, attr: { type: 'button' } });
    button.onclick = action;
    return button;
  }

  onOpen() {
    this.modalEl.addClass('pageink-properties-modal');
    this.titleEl.setText('笔记属性');
    this.contentEl.addClass('pageink-properties');
    this.contentEl.createEl('p', { text: this.snapshot.path, cls: 'pageink-properties-path' });
    if (this.snapshot.kind === 'pdf') {
      this.contentEl.createEl('p', { text: 'PDF 只读，不支持编辑属性。' });
      this.button(this.contentEl, '关闭', () => this.close());
      return;
    }
    this.contentEl.createEl('p', { text: '添上标签、主题或进度，让笔记更容易整理。', cls: 'pageink-properties-help' });
    this.list = this.contentEl.createDiv({ cls: 'pageink-properties-list' });
    this.addButton = this.button(this.contentEl, '添加属性', () => {
      this.rows.push({ key: '', existing: false, type: 'text', text: '', checked: false, items: [], removed: false });
      this.renderRows(); this.changed();
      this.list.lastElementChild?.querySelector('input')?.focus();
    });
    this.error = this.contentEl.createDiv({ cls: 'pageink-properties-error', attr: { role: 'alert', tabindex: '-1' } });
    this.confirmation = this.contentEl.createDiv({ cls: 'pageink-properties-confirm' });
    const actions = this.contentEl.createDiv({ cls: 'pageink-properties-actions' });
    this.button(actions, '关闭', () => this.close());
    this.saveButton = this.button(actions, '保存属性', () => void this.submit(), 'mod-cta');
    this.saveButton.disabled = true;
    this.renderRows();
  }

  private renderRows() {
    this.list.replaceChildren();
    if (!this.rows.length) this.list.createEl('p', { text: '暂无属性。可添加一项开始整理。', cls: 'pageink-properties-help' });
    for (const row of this.rows) {
      const section = this.list.createEl('fieldset', { cls: 'pageink-property-row' });
      section.createEl('legend', { text: row.existing ? row.key : '新属性' });
      if (!row.type) {
        section.createEl('p', { text: editableKey(row.key) ? '复杂属性 · 只读保留' : '保留属性名 · 只读保留', cls: 'pageink-properties-help' });
        section.createEl('pre', { text: propertyPreview(row.original), cls: 'pageink-property-preview' });
        continue;
      }
      if (row.removed) {
        section.createEl('p', { text: '保存后删除此属性。' });
        this.button(section, '撤销删除', () => { row.removed = false; this.renderRows(); this.changed(); this.addButton?.focus(); });
        continue;
      }
      const header = section.createDiv({ cls: 'pageink-property-header' });
      const keyLabel = header.createEl('label', { text: '属性名', cls: 'pageink-property-field' });
      const key = keyLabel.createEl('input', { type: 'text', attr: { autocomplete: 'off', spellcheck: 'false' } });
      key.value = row.key; key.readOnly = row.existing;
      key.oninput = () => { row.key = key.value; this.changed(); };
      const typeLabel = header.createEl('label', { text: '属性类型', cls: 'pageink-property-field' });
      const type = typeLabel.createEl('select');
      for (const [value, text] of Object.entries(PROPERTY_TYPES)) type.createEl('option', { value, text });
      type.value = row.type;
      const valueEl = section.createDiv({ cls: 'pageink-property-value' });
      type.onchange = () => { row.type = type.value as PropertyType; this.renderValue(row, valueEl); this.changed(); };
      this.renderValue(row, valueEl);
      this.button(section, '删除属性', () => {
        if (row.existing) row.removed = true;
        else this.rows.splice(this.rows.indexOf(row), 1);
        this.renderRows(); this.changed(); this.addButton?.focus();
      }, 'pageink-property-remove');
    }
  }

  private renderValue(row: DraftRow, parent: HTMLElement) {
    parent.replaceChildren();
    if (row.type === 'boolean') {
      const label = parent.createEl('label', { cls: 'pageink-property-boolean' });
      const input = label.createEl('input', { type: 'checkbox' }); input.checked = row.checked;
      const text = label.createSpan({ text: row.checked ? '属性值：是' : '属性值：否' });
      input.onchange = () => { row.checked = input.checked; text.setText(row.checked ? '属性值：是' : '属性值：否'); this.changed(); };
    } else if (row.type === 'list') {
      parent.createEl('p', { text: '每项单独填写，可用于标签或关键词。', cls: 'pageink-properties-help' });
      row.items.forEach((value, index) => {
        const item = parent.createDiv({ cls: 'pageink-property-list-item' });
        const label = item.createEl('label', { text: `第 ${index + 1} 项`, cls: 'pageink-property-field' });
        const input = label.createEl('textarea', { attr: { rows: '2' } }); input.value = value;
        input.oninput = () => { row.items[index] = input.value; this.changed(); };
        this.button(item, `删除第 ${index + 1} 项`, () => {
          row.items.splice(index, 1); this.renderValue(row, parent); this.changed();
          parent.querySelector('button')?.focus();
        });
      });
      this.button(parent, '添加列表项', () => {
        row.items.push(''); this.renderValue(row, parent); this.changed();
        const inputs = parent.querySelectorAll('textarea'); inputs[inputs.length - 1]?.focus();
      });
    } else {
      const label = parent.createEl('label', { text: row.type === 'number' ? '数字值' : '文本值', cls: 'pageink-property-field' });
      const input = row.type === 'number' ? label.createEl('input', { type: 'text', attr: { inputmode: 'decimal' } }) : label.createEl('textarea', { attr: { rows: '2' } });
      input.value = row.text;
      input.oninput = () => { row.text = input.value; input.removeAttribute('aria-invalid'); this.changed(); };
    }
  }

  private edits(): PropertyChange[] {
    const desired = new Map<string, PropertyValue>();
    const reserved = new Set(this.rows.filter(row => !row.type).map(row => row.key));
    for (const row of this.rows) {
      if (row.removed || !row.type) continue;
      if (!editableKey(row.key)) throw Error('这个属性名无法使用，请换一个名称。');
      if (desired.has(row.key) || reserved.has(row.key)) throw Error(`属性名重复：${row.key}`);
      let value: PropertyValue;
      try { value = row.type === 'number' ? parsePropertyNumber(row.text) : row.type === 'boolean' ? row.checked : row.type === 'list' ? [...row.items] : row.text; }
      catch (error) { throw Error(`属性「${row.key}」：${(error as Error).message}`); }
      desired.set(row.key, value);
    }
    const changes: PropertyChange[] = [...desired].map(([key, value]) => ({ key, op: 'set', value }));
    for (const row of this.rows) if (row.existing && row.type && !desired.has(row.key)) changes.push({ key: row.key, op: 'delete' });
    return propertyChanges(this.snapshot.properties, changes);
  }

  private async submit() {
    if (this.busy || this.acceptingClose) return;
    let edits: PropertyChange[];
    try { edits = this.edits(); }
    catch (error) { this.error.textContent = (error as Error).message; this.error.focus(); return; }
    this.busy = true;
    this.confirmation.replaceChildren(); this.confirming = false;
    this.contentEl.setAttribute('aria-busy', 'true');
    const controls = [...this.contentEl.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input, button, select, textarea')];
    const disabled = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    this.saveButton!.textContent = '正在保存…'; this.error.textContent = '';
    try {
      await this.host.save(this.snapshot, edits);
      this.acceptingClose = true; super.close();
    } catch (error) {
      this.error.textContent = `保存失败，草稿仍保留。${(error as Error).message}`;
      this.error.focus();
    } finally {
      this.busy = false;
      this.contentEl.removeAttribute('aria-busy');
      controls.forEach((control, index) => { control.disabled = disabled[index]; });
      this.saveButton!.textContent = '保存属性';
    }
  }

  close() {
    if (this.acceptingClose || this.snapshot.kind === 'pdf' || !this.dirty) { super.close(); return; }
    if (this.busy) { this.error.textContent = '正在保存，请等待保存完成。'; return; }
    // Escape, backdrop and the native close button all reach this override. Repeated Escape
    // never discards a draft: only the explicitly labelled button authorizes that action.
    if (!this.confirming) {
      this.confirming = true;
      this.confirmation.setAttribute('role', 'group');
      this.confirmation.setAttribute('aria-label', '放弃草稿确认');
      this.confirmation.createEl('p', { text: '有未保存的属性草稿。关闭将放弃这些修改。' });
      const keep = this.button(this.confirmation, '继续编辑', () => { this.confirming = false; this.confirmation.replaceChildren(); this.saveButton?.focus(); });
      this.button(this.confirmation, '放弃草稿并关闭', () => { this.acceptingClose = true; super.close(); }, 'mod-warning');
      keep.focus();
    }
  }
  /** Unload cannot leave an orphaned modal capable of submitting its old draft. */
  dispose() { this.acceptingClose = true; super.close(); }
  onClose() { this.acceptingClose = true; this.contentEl.replaceChildren(); this.onClosed(); }
}

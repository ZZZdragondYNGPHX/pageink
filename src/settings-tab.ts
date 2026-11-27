import { AbstractInputSuggest, App, PluginSettingTab, Setting, TFolder } from 'obsidian';
import type DrawingPlugin from './main';
import { normalizePreferences, type PenStabilize } from './preferences';
import type { PageTemplate } from './model';

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(app: App, private input: HTMLInputElement) { super(app, input); }
  getSuggestions(query: string): TFolder[] {
    return this.app.vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder && file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  }
  renderSuggestion(folder: TFolder, el: HTMLElement) { el.setText(folder.path); }
  selectSuggestion(folder: TFolder) {
    this.input.value = folder.path;
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
    this.close();
  }
}

// Structural definitions also let Obsidian 1.13+ index settings with the pinned 1.8 typings.
interface SettingRow { name: string; desc?: string; render(setting: Setting): void | (() => void) }
interface SettingSection { type: 'group'; heading: string; items: SettingRow[] }

export class PageInkSettingTab extends PluginSettingTab {
  private suggests = new Set<FolderSuggest>();
  constructor(app: App, private drawing: DrawingPlugin) { super(app, drawing); }
  hide(): void { for (const suggest of this.suggests) suggest.close(); this.suggests.clear(); }
  private folder(setting: Setting, placeholder: string, value: string, update: (value: string) => void) {
    let suggest: FolderSuggest;
    setting.addText(text => {
      text.setPlaceholder(placeholder).setValue(value).onChange(update);
      suggest = new FolderSuggest(this.app, text.inputEl); this.suggests.add(suggest);
    });
    return () => { suggest.close(); this.suggests.delete(suggest); };
  }
  getSettingDefinitions(): (SettingRow | SettingSection)[] {
    const { drawing } = this, prefs = drawing.prefs;
    return [
      { name: '新笔记默认纸张', render: setting => { setting.addDropdown(dropdown => dropdown
        .addOptions({ ruled: '横线', grid: '方格', dotted: '点阵', blank: '空白' }).setValue(prefs.get().newTemplate)
        .onChange(value => prefs.update({ newTemplate: value as PageTemplate }))); } },
      { name: '新建笔记保存位置', render: setting => this.folder(setting, '留空则跟随当前所在文件夹', prefs.get().newNoteFolder,
        value => prefs.update({ newNoteFolder: normalizePreferences({ newNoteFolder: value }).newNoteFolder })) },
      { name: '在左侧功能区显示新建按钮', render: setting => { setting.addToggle(toggle => toggle.setValue(prefs.get().showRibbonIcon)
        .onChange(showRibbonIcon => { prefs.update({ showRibbonIcon }); drawing.syncRibbonIcon(); })); } },
      { type: 'group', heading: '书写与触控', items: [
        { name: '允许手指直接书写', desc: '关闭时手指仅用于平移和缩放，触控笔负责书写。', render: setting => {
          setting.addToggle(toggle => toggle.setValue(prefs.get().fingerDraws).onChange(fingerDraws => prefs.update({ fingerDraws })));
        } },
        { name: '启用压感笔迹', desc: '根据触控笔力度变化线条粗细。', render: setting => {
          setting.addToggle(toggle => toggle.setValue(prefs.get().pen.pressure).onChange(pressure => prefs.update({ pen: { pressure } })));
        } },
        { name: '笔迹平滑程度', render: setting => { setting.addDropdown(dropdown => dropdown
          .addOptions({ '0': '关闭', '1': '适中', '2': '强平滑' }).setValue(String(prefs.get().pen.stabilize))
          .onChange(value => prefs.update({ pen: { stabilize: Number(value) as PenStabilize } }))); } },
        { name: '空闲时自动收起笔盒', render: setting => { setting.addToggle(toggle => toggle.setValue(prefs.get().autoCollapseDock)
          .onChange(autoCollapseDock => prefs.update({ autoCollapseDock }))); } },
        { name: '分页笔记夜间护眼纸面', render: setting => { setting.addToggle(toggle => toggle.setValue(prefs.get().nightPaper)
          .onChange(nightPaper => prefs.update({ nightPaper }))); } },
      ] },
      { type: 'group', heading: '嵌入与导出', items: [
        { name: '嵌入预览默认最大宽度', render: setting => { setting.addSlider(slider => slider.setLimits(240, 1200, 20)
          .setValue(prefs.get().embedMaxWidth).setDynamicTooltip().onChange(embedMaxWidth => prefs.update({ embedMaxWidth }))); } },
        { name: '导出文件保存文件夹', render: setting => this.folder(setting, 'Drawing Exports', prefs.get().exportFolder,
          value => prefs.update({ exportFolder: normalizePreferences({ exportFolder: value }).exportFolder })) },
      ] },
    ];
  }
  display(): void {
    this.hide(); this.containerEl.empty();
    const render = (row: SettingRow) => {
      const setting = new Setting(this.containerEl).setName(row.name);
      if (row.desc) setting.setDesc(row.desc);
      row.render(setting);
    };
    for (const item of this.getSettingDefinitions()) {
      if ('type' in item) {
        new Setting(this.containerEl).setName(item.heading).setHeading();
        item.items.forEach(render);
      } else render(item);
    }
  }
}

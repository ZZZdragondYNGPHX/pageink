import { App, TFile } from 'obsidian';
import { InkCardReference } from './cards';
import { Choice } from './mixed-host';
import { DocumentStore, FileIO } from './storage';
import { Session } from './session';
import { pageRect } from './model';
import { bounds } from './geometry';
import { pack, unpack } from './archive';
import { renderArea } from './preview';
import { PdfService } from './pdf';

export interface InkCardSource { reference: Omit<InkCardReference, 'archiveAsset'>; archive: Uint8Array; preview: string; width: number; height: number }
export const WHOLE_PAGE_REGION = '__page__';
export interface CardsHost {
  pickInk(): Promise<InkCardSource | undefined>;
  pickFromPath(path: string): Promise<InkCardSource | undefined>;
  readInk(ref: InkCardReference): Promise<InkCardSource>;
  openInk(ref: InkCardReference): Promise<void>;
  recoverInk(bytes: Uint8Array, ref: InkCardReference): Promise<InkCardReference>;
}
interface Services {
  io: FileIO;
  live(path: string): Session | undefined;
  resolve(path: string, id: string): Promise<string>;
  reveal(path: string, page: string, region?: string): Promise<void>;
  unique(title: string): Promise<string>;
}

export class BoardSources implements CardsHost {
  constructor(private app: App, private services: Services) {}
  private choose<T>(label: string, items: T[], display: (item: T) => string) {
    return new Promise<T | undefined>(resolve => new Choice(this.app, label, items, display, resolve).open());
  }
  private async snapshot(path: string) {
    await this.services.live(path)?.flush();
    return new Session(await DocumentStore.open(this.services.io, path));
  }
  async pickInk() {
    const file = await this.choose('选择手写笔记、无边画布或 PDF 批注', this.app.vault.getFiles().filter(f => f.extension === 'inknote'), file => file.path);
    return file ? this.pickFromPath(file.path) : undefined;
  }
  async pickFromPath(path: string): Promise<InkCardSource | undefined> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== 'inknote') throw Error('找不到手写笔记，请重新选择。');
    const session = await this.snapshot(path), manifest = session.manifest;
    const choices = [
      ...manifest.regions.map(r => ({ label: `书签：${r.title}`, page: r.pageId, region: r.id, title: r.title })),
      ...manifest.pages.map((page, i) => ({ label: manifest.mode === 'pages' ? `整页：第 ${i + 1} 页` : '整张无边画布', page: page.id, region: WHOLE_PAGE_REGION,
        title: manifest.mode === 'pages' ? `${manifest.title} · 第 ${i + 1} 页` : manifest.title })),
    ];
    const choice = await this.choose('选择手写区域或页面', choices, item => item.label); if (!choice) return;
    return this.readInk({ version: 1, kind: 'ink', path, document: manifest.id, page: choice.page, region: choice.region, title: choice.title, archiveAsset: '' });
  }
  async readInk(ref: InkCardReference): Promise<InkCardSource> {
    const path = await this.services.resolve(ref.path, ref.document), session = await this.snapshot(path);
    const whole = ref.region === WHOLE_PAGE_REGION;
    const region = session.manifest.regions.find(r => r.id === ref.region), page = session.manifest.pages.find(p => p.id === (whole ? ref.page : region?.pageId));
    if (!page || !whole && !region) throw Error(`${whole ? '原页面' : '原区域'}已删除。卡片预览与完整备份仍保留，可另存当时的原件副本。`);
    const area = whole ? session.manifest.mode === 'pages' ? pageRect(page) : bounds((await session.read(page.id)).filter(e => !e.isDeleted)) ?? { x: 0, y: 0, width: 600, height: 400 } : region!;
    const archive = await pack(session);
    const pdf = session.manifest.pdf ? await PdfService.open(this.services.io, session.manifest.pdf) : undefined;
    let canvas: HTMLCanvasElement | undefined;
    try {
      canvas = await renderArea(session, page, area, Math.min(2, 1600 / Math.max(area.width, area.height)), pdf);
      return { reference: { version: 1, kind: 'ink', path, document: session.manifest.id, page: page.id, region: whole ? WHOLE_PAGE_REGION : region!.id, title: whole ? ref.title : region!.title }, archive,
        preview: canvas.toDataURL('image/png'), width: whole ? Math.max(120, area.width) : area.width, height: whole ? Math.max(80, area.height) : area.height };
    } finally { if (canvas) canvas.width = canvas.height = 0; await pdf?.destroy(); }
  }
  async openInk(ref: InkCardReference) { await this.services.reveal(await this.services.resolve(ref.path, ref.document), ref.page, ref.region === WHOLE_PAGE_REGION ? undefined : ref.region); }
  async recoverInk(bytes: Uint8Array, ref: InkCardReference) {
    const path = await this.services.unique(`${ref.title} 恢复原件`), manifest = await unpack(this.services.io, bytes, path);
    return { ...ref, path, document: manifest.id };
  }
}

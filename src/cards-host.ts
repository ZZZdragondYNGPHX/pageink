import { App, TFile } from 'obsidian';
import { InkCardReference } from './cards';
import { Choice } from './mixed-host';
import { DocumentStore, FileIO } from './storage';
import { Session } from './session';
import { parseManifest } from './model';
import { pack, unpack } from './archive';
import { renderArea } from './preview';
import { PdfService } from './pdf';

export interface InkCardSource { reference: Omit<InkCardReference, 'archiveAsset'>; archive: Uint8Array; preview: string; width: number; height: number }
export interface CardsHost {
  pickInk(): Promise<InkCardSource | undefined>;
  readInk(ref: InkCardReference): Promise<InkCardSource>;
  openInk(ref: InkCardReference): Promise<void>;
  recoverInk(bytes: Uint8Array, ref: InkCardReference): Promise<InkCardReference>;
}
interface Services {
  io: FileIO;
  live(path: string): Session | undefined;
  resolve(path: string, id: string): Promise<string>;
  reveal(path: string, page: string, region: string): Promise<void>;
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
    const files: TFile[] = [];
    for (const file of this.app.vault.getFiles().filter(f => f.extension === 'inknote')) {
      try { if (parseManifest(await this.services.io.read(file.path)).mode === 'pages') files.push(file); } catch { /* unrelated damaged document */ }
    }
    const file = await this.choose('选择手写笔记本', files, file => file.path); if (!file) return;
    const session = await this.snapshot(file.path);
    if (!session.manifest.regions.length) throw Error('这份笔记本还没有区域书签。请先圈选内容并加书签，再插入手写卡片。');
    const region = await this.choose('选择手写区域', session.manifest.regions, r => r.title); if (!region) return;
    return this.readInk({ version: 1, kind: 'ink', path: file.path, document: session.manifest.id, page: region.pageId, region: region.id, title: region.title, archiveAsset: '' });
  }
  async readInk(ref: InkCardReference): Promise<InkCardSource> {
    const path = await this.services.resolve(ref.path, ref.document), session = await this.snapshot(path);
    const region = session.manifest.regions.find(r => r.id === ref.region), page = region && session.manifest.pages.find(p => p.id === region.pageId);
    if (!region || !page) throw Error('原区域已删除。卡片预览与完整备份仍保留，可恢复引用时的原件。');
    const archive = await pack(session);
    const pdf = session.manifest.pdf ? await PdfService.open(this.services.io, session.manifest.pdf) : undefined;
    let canvas: HTMLCanvasElement | undefined;
    try {
      canvas = await renderArea(session, page, region, Math.min(2, 1600 / Math.max(region.width, region.height)), pdf);
      return { reference: { version: 1, kind: 'ink', path, document: session.manifest.id, page: page.id, region: region.id, title: region.title }, archive,
        preview: canvas.toDataURL('image/png'), width: region.width, height: region.height };
    } finally { if (canvas) canvas.width = canvas.height = 0; await pdf?.destroy(); }
  }
  async openInk(ref: InkCardReference) { await this.services.reveal(await this.services.resolve(ref.path, ref.document), ref.page, ref.region); }
  async recoverInk(bytes: Uint8Array, ref: InkCardReference) {
    const path = await this.services.unique(`${ref.title} 恢复原件`), manifest = await unpack(this.services.io, bytes, path);
    return { ...ref, path, document: manifest.id };
  }
}

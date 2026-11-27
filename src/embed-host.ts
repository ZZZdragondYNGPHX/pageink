import { MarkdownRenderChild, Notice, parseLinktext, type Plugin, type MarkdownPostProcessorContext } from 'obsidian';
import { DocumentStore, type FileIO } from './storage';
import { Session } from './session';
import { PdfService } from './pdf';
import { pageRect } from './model';
import { bounds } from './geometry';
import { parseEmbedSize, parseInkSubpath } from './notes';
import { renderArea } from './preview';
import type { PreferenceStore } from './preferences';

interface Services {
  io: FileIO; prefs: PreferenceStore;
  live(path: string): Session | undefined;
  resolve(path?: string, id?: string): Promise<string>;
  open(path: string, target: { page?: string; region?: string }, destination?: 'tab' | 'split'): Promise<void>;
}
interface EmbedContext { containerEl: HTMLElement; sourcePath: string }
declare module 'obsidian' {
  interface App {
    embedRegistry?: {
      registerExtension?(extension: string, factory: (context: EmbedContext, file: import('obsidian').TFile, subpath: string) => MarkdownRenderChild): void;
      unregisterExtension?(extension: string): void;
    };
  }
}
/** Two render slots; aborted waiters leave the queue immediately. */
class RenderQueue {
  private active = 0;
  private waiting: (() => void)[] = [];
  async run<T>(signal: AbortSignal, render: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => { const index = this.waiting.indexOf(start); if (index >= 0) this.waiting.splice(index, 1); reject(new DOMException('预览已取消', 'AbortError')); };
      const start = () => { signal.removeEventListener('abort', abort); this.active++; resolve(); };
      if (this.active < 2) start();
      else { this.waiting.push(start); signal.addEventListener('abort', abort, { once: true }); }
    });
    try { signal.throwIfAborted(); return await render(); }
    finally { this.active--; this.waiting.shift()?.(); }
  }
}
class InkEmbedChild extends MarkdownRenderChild {
  renderContent?: () => Promise<void>;
  private initialRender?: Promise<void>;
  loadFile() { return this.initialRender ??= this.renderContent?.() ?? Promise.resolve(); }
  onload() { void this.loadFile(); }
}
export function registerInkEmbeds(plugin: Plugin, services: Services) {
  const mounted = new WeakMap<HTMLElement, MarkdownRenderChild>(), cache = new Map<string, HTMLCanvasElement>(), heights = new Map<string, number>(), queue = new RenderQueue();
  plugin.register(() => { for (const canvas of cache.values()) canvas.width = canvas.height = 0; cache.clear(); heights.clear(); });
  const mount = (el: HTMLElement, reference: { file?: string; document?: string; region?: string; subpath?: string; alt?: string }, sourcePath: string) => {
    const existing = mounted.get(el); if (existing) return existing;
    const child = new InkEmbedChild(el); mounted.set(el, child);
    el.addClass('ink-embed'); el.tabIndex = -1;
    let controller = new AbortController(), timer: number | undefined, disposed = false, currentPath = '', pdfPath = '', manualPageId: string | undefined;
    child.register(() => { disposed = true; controller.abort(); window.clearTimeout(timer); mounted.delete(el); });
    const render = async () => {
      el.setAttribute('aria-busy', 'true');
      controller.abort(); const task = new AbortController(); controller = task;
      try {
        const destination = reference.file ? plugin.app.metadataCache.getFirstLinkpathDest(reference.file, sourcePath) : null;
        const path = await services.resolve(currentPath || destination?.path || reference.file, reference.document); currentPath = path;
        const heightKey = `${path}#${reference.region ?? reference.subpath ?? ''}|${reference.alt ?? ''}`;
        if (heights.has(heightKey)) el.setCssStyles({ minHeight: `${heights.get(heightKey)}px` });
        const live = services.live(path);
        await live?.flush(); task.signal.throwIfAborted();
        const session = live ?? new Session(await DocumentStore.open(services.io, path));
        const manifest = session.manifest, sub = parseInkSubpath(reference.subpath ?? '');
        const regionName = reference.region ?? sub.region;
        const region = manifest.regions.find(r => r.id === regionName) ?? manifest.regions.find(r => r.title === regionName);
        if (regionName && !region) throw Error('这个书签已删除，或还没有同步到这台设备。');
        const manualIndex = manifest.pages.findIndex(p => p.id === manualPageId);
        const pageIndex = region ? manifest.pages.findIndex(p => p.id === region.pageId) : manualIndex >= 0 ? manualIndex : sub.pageNumber ? sub.pageNumber - 1 : sub.pageId ? manifest.pages.findIndex(p => p.id === sub.pageId) : 0;
        const page = manifest.pages[pageIndex]; if (!page) throw Error('引用的页面已删除。');
        pdfPath = manifest.pdf?.path ?? '';
        const area = region ?? (manifest.mode === 'canvas' ? bounds((await session.read(page.id)).filter(e => !e.isDeleted)) ?? { x: 0, y: 0, width: 600, height: 400 } : pageRect(page)), key = `${path}/${manifest.revision}/${page.id}/${region?.id ?? ''}`;
        let cached = cache.get(key);
        if (cached) { cache.delete(key); cache.set(key, cached); }
        else {
          cached = await queue.run(task.signal, async () => {
            const pdf = manifest.pdf ? await PdfService.open(services.io, manifest.pdf) : undefined;
            try { return await renderArea(session, page, area, Math.min(2, 1200 / Math.max(area.width, area.height)), pdf, task.signal); }
            finally { await pdf?.destroy(); }
          });
          task.signal.throwIfAborted(); cache.set(key, cached);
          while (cache.size > 12) { const oldest = cache.keys().next().value!; const canvas = cache.get(oldest)!; cache.delete(oldest); canvas.width = canvas.height = 0; }
        }
        task.signal.throwIfAborted(); if (disposed) return;
        const canvas = createEl('canvas'); canvas.width = cached.width; canvas.height = cached.height; canvas.getContext('2d')!.drawImage(cached, 0, 0);
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', region?.title ?? manifest.title);
        const size = parseEmbedSize(reference.alt, services.prefs.get().embedMaxWidth);
        el.setCssStyles({ maxWidth: `${size.width}px` });
        if (size.height) canvas.setCssStyles({ maxHeight: `${size.height}px` });
        const focused = el.ownerDocument.activeElement;
        const focusAction = focused && el.contains(focused) ? focused.getAttribute('data-ink-action') : null;
        el.replaceChildren(canvas);
        const toolbar = el.createDiv({ cls: 'ink-embed-toolbar', attr: { role: 'group', 'aria-label': '笔记预览' } });
        for (const type of ['pointerdown', 'mousedown', 'touchstart']) toolbar.addEventListener(type, event => event.stopPropagation());
        if (manifest.pages.length > 1 && !region) {
          const previous = toolbar.createEl('button', { text: '上一页', attr: { type: 'button', 'data-ink-action': 'previous' } }); previous.disabled = pageIndex === 0;
          previous.onclick = () => { manualPageId = manifest.pages[Math.max(0, pageIndex - 1)]?.id; void render(); };
          toolbar.createSpan({ text: `${pageIndex + 1}/${manifest.pages.length}`, attr: { 'aria-live': 'polite' } });
          const next = toolbar.createEl('button', { text: '下一页', attr: { type: 'button', 'data-ink-action': 'next' } }); next.disabled = pageIndex === manifest.pages.length - 1;
          next.onclick = () => { manualPageId = manifest.pages[Math.min(manifest.pages.length - 1, pageIndex + 1)]?.id; void render(); };
        }
        toolbar.createEl('button', { text: '打开笔记', attr: { type: 'button', 'data-ink-action': 'open' } }).onclick = event => {
          const mod = event.ctrlKey || event.metaKey;
          void services.open(path, { page: page.id, region: region?.id }, mod ? event.altKey ? 'split' : 'tab' : undefined).catch((error: Error) => new Notice(error.message));
        };
        el.removeAttribute('aria-busy'); el.setCssStyles({ minHeight: '' });
        const height = el.getBoundingClientRect().height; if (height > 0) heights.set(heightKey, height);
        if (focusAction) (toolbar.querySelector<HTMLButtonElement>(`[data-ink-action="${focusAction}"]:enabled`) ?? toolbar.querySelector<HTMLButtonElement>('button:enabled'))?.focus({ preventScroll: true });
      } catch (error) {
        if (!task.signal.aborted && !disposed) { el.empty(); el.removeAttribute('aria-busy'); el.setCssStyles({ minHeight: '' }); el.createDiv({ cls: 'ink-embed-error', text: (error as Error).message, attr: { role: 'alert' } }); }
      }
    };
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { if (!disposed) void render(); }, 300); };
    child.registerEvent(plugin.app.vault.on('modify', file => { if (file.path === currentPath || file.path === pdfPath) { cache.clear(); schedule(); } }));
    child.registerEvent(plugin.app.vault.on('rename', (file, oldPath) => { if (oldPath === currentPath) { currentPath = file.path; schedule(); } }));
    child.registerEvent(plugin.app.vault.on('delete', file => { if (file.path === currentPath || file.path === pdfPath) schedule(); }));
    child.renderContent = render; return child;
  };
  plugin.registerMarkdownCodeBlockProcessor('drawing-region', (source, el, context) => {
    try {
      const reference = JSON.parse(source) as { file?: string; document?: string; region?: string };
      if (!reference || typeof reference !== 'object' || (typeof reference.file !== 'string' && typeof reference.document !== 'string') || typeof reference.region !== 'string') throw Error('区域引用格式无效。');
      context.addChild(mount(el, reference, context.sourcePath));
    }
    catch (error) { el.createDiv({ cls: 'ink-embed-error', text: (error as Error).message }); }
  });
  plugin.app.embedRegistry?.registerExtension?.('inknote', (context, file, subpath) => mount(context.containerEl, { file: file.path, subpath, alt: context.containerEl.getAttribute('alt') ?? undefined }, context.sourcePath));
  plugin.register(() => plugin.app.embedRegistry?.unregisterExtension?.('inknote'));
  plugin.registerMarkdownPostProcessor((el: HTMLElement, context: MarkdownPostProcessorContext) => {
    const embeds = [...el.querySelectorAll<HTMLElement>('.internal-embed[src*=".inknote"]')];
    if (el.matches('.internal-embed[src*=".inknote"]')) embeds.unshift(el);
    for (const embed of embeds) {
      if (mounted.has(embed)) continue;
      const parsed = parseLinktext(embed.getAttribute('src') ?? '');
      context.addChild(mount(embed, { file: parsed.path, subpath: parsed.subpath, alt: embed.getAttribute('alt') ?? undefined }, context.sourcePath));
    }
  });
}

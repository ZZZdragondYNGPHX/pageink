import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Page, Rect } from './model';
import type { PdfService } from './pdf';
import type { PageLayout, PagePlacement } from './layout';
import { paperStyle, templateSpec } from './templates';
import { View, ViewStore, sceneViewport, useView } from './view';

const RASTER_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2];
const rasterScale = (zoom: number) => { const wanted = Math.min(2, zoom * devicePixelRatio); return RASTER_STEPS.find(step => step >= wanted - 0.01) ?? 2; };
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Paper, templates and PDF pages behind the transparent kernel canvas, sharing its transform. */
export function PaperLayer({ layout, views, pdf, sourceIssue }: { layout: PageLayout; views: ViewStore; pdf?: PdfService; sourceIssue?: string }) {
  const container = useRef<HTMLDivElement>(null);
  // Position follows every scroll frame without React; the visible set and raster scale change rarely.
  useEffect(() => {
    const apply = () => { const v = views.get(); if (container.current) container.current.style.transform = `scale(${v.zoom}) translate(${v.scrollX}px, ${v.scrollY}px)`; };
    apply(); return views.subscribe(apply);
  }, [views]);
  const visible = useView(views, v => {
    const area = sceneViewport(v), margin = area.height * 0.75;
    const wide = { x: area.x - margin, y: area.y - margin, width: area.width + margin * 2, height: area.height + margin * 2 };
    return layout.placements.filter(p => intersects(p.paper, wide)).map(p => p.index).join(',');
  });
  const scale = useSettled(views, v => rasterScale(v.zoom), 180);
  const shown = useMemo(() => visible ? visible.split(',').map(i => layout.placements[Number(i)]) : [], [visible, layout]);
  return <div className="ink-paper-layer" ref={container}>{shown.map(placement =>
    <Paper key={placement.page.id} placement={placement} pdf={pdf} scale={scale} views={views} sourceIssue={sourceIssue}/>)}</div>;
}

function Paper({ placement, pdf, scale, views, sourceIssue }: { placement: PagePlacement; pdf?: PdfService; scale: number; views: ViewStore; sourceIssue?: string }) {
  const { page, paper } = placement;
  return <div className={`ink-paper${page.pdfPage ? ' is-pdf' : ''}`} style={{ left: paper.x, top: paper.y, width: paper.width, height: paper.height, ...(page.pdfPage ? {} : paperStyle(page.template)) }}>
    {page.pdfPage && (pdf ? <PdfRaster page={page} placement={placement} pdf={pdf} scale={scale} views={views}/>
      : <div className="ink-pdf-missing" style={{ left: page.margins.left, top: page.margins.top, width: page.width, height: page.height }}>{sourceIssue ? '原 PDF 暂不可用' : '正在载入 PDF…'}</div>)}
  </div>;
}

function PdfRaster({ page, placement, pdf, scale, views }: { page: Page; placement: PagePlacement; pdf: PdfService; scale: number; views: ViewStore }) {
  const base = useRef<HTMLCanvasElement>(null), detail = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController(), target = base.current!;
    const scratch = createEl('canvas');
    pdf.render(page, scratch, scale, undefined, abort.signal).then(() => {
      if (abort.signal.aborted) return;
      target.width = scratch.width; target.height = scratch.height; target.getContext('2d')!.drawImage(scratch, 0, 0); setError('');
    }).catch(e => { if (!abort.signal.aborted) setError((e as Error).message); }).finally(() => { scratch.width = scratch.height = 0; });
    return () => abort.abort();
  }, [pdf, page.pdfPage, scale]);
  useEffect(() => () => { for (const canvas of [base.current, detail.current]) if (canvas) canvas.width = canvas.height = 0; }, []);
  // Sharp detail for the visible part once the zoom exceeds the base raster.
  const settled = useSettled(views, v => v, 140, (a, b) => a.scrollX === b.scrollX && a.scrollY === b.scrollY && a.zoom === b.zoom && a.width === b.width);
  useEffect(() => {
    const target = detail.current; if (!target) return;
    const v: View = settled, wanted = v.zoom * devicePixelRatio;
    const area = sceneViewport(v);
    const x = Math.max(0, area.x - placement.x), y = Math.max(0, area.y - placement.y);
    const width = Math.min(page.width, area.x + area.width - placement.x) - x, height = Math.min(page.height, area.y + area.height - placement.y) - y;
    if (wanted <= scale + 0.05 || width <= 0 || height <= 0) { target.classList.remove('is-visible'); return; }
    const abort = new AbortController(), rect = { x, y, width, height }, rendered = createEl('canvas');
    pdf.render(page, rendered, Math.min(wanted, Math.sqrt(8_000_000 / (width * height))), rect, abort.signal).then(() => {
      if (abort.signal.aborted) return;
      target.width = rendered.width; target.height = rendered.height; target.getContext('2d')!.drawImage(rendered, 0, 0);
      target.classList.add('is-visible'); target.setCssStyles({ left: `${page.margins.left + x}px`, top: `${page.margins.top + y}px`, width: `${width}px`, height: `${height}px` });
    }).catch(() => {}).finally(() => { rendered.width = rendered.height = 0; });
    return () => abort.abort();
  }, [settled, scale, pdf, page.pdfPage]);
  return <>
    <canvas ref={base} className="ink-pdf-base" style={{ left: page.margins.left, top: page.margins.top, width: page.width, height: page.height }}/>
    <canvas ref={detail} className="ink-pdf-detail" />
    {error && <div className="ink-pdf-missing" style={{ left: page.margins.left, top: page.margins.top, width: page.width, height: page.height }}>{error}</div>}
  </>;
}

/** A value derived from the view that only updates after it stops changing for `delay` ms. */
function useSettled<T>(views: ViewStore, select: (v: View) => T, delay: number, equal: (a: T, b: T) => boolean = Object.is): T {
  const [value, setValue] = useState(() => select(views.get()));
  const latest = useRef(value); latest.current = value;
  useEffect(() => {
    let timer: number | undefined;
    const update = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { const next = select(views.get()); if (!equal(latest.current, next)) setValue(next); }, delay); };
    update(); const unsubscribe = views.subscribe(update);
    return () => { window.clearTimeout(timer); unsubscribe(); };
  }, [views]);
  return value;
}

/** Infinite-canvas background (Freeform-style dots or grid) that pans and zooms with the scene. */
export function GridLayer({ views, template, dark }: { views: ViewStore; template: Page['template']; dark: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const apply = () => {
      const el = ref.current; if (!el) return;
      if (template !== 'dotted' && template !== 'grid' && template !== 'ruled') { el.style.removeProperty('background-image'); return; }
      const v = views.get(), base = templateSpec(template === 'ruled' ? 'grid' : template).step;
      let step = base * v.zoom; while (step < 14) step *= 4;
      const color = dark ? 'rgba(255,255,255,.16)' : template === 'dotted' ? 'rgba(80,96,115,.32)' : 'rgba(80,96,115,.12)';
      const ox = ((v.scrollX * v.zoom) % step + step) % step, oy = ((v.scrollY * v.zoom) % step + step) % step;
      if (template === 'dotted') {
        const r = Math.max(0.8, Math.min(1.6, 1.2 * Math.sqrt(v.zoom)));
        el.style.backgroundImage = `radial-gradient(circle, ${color} ${r}px, transparent ${r + 0.6}px)`;
        el.style.backgroundPosition = `${ox - step / 2}px ${oy - step / 2}px`;
      } else {
        el.style.backgroundImage = `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`;
        el.style.backgroundPosition = `${ox}px ${oy}px`;
      }
      el.style.backgroundSize = `${step}px ${step}px`;
    };
    apply(); return views.subscribe(apply);
  }, [views, template, dark]);
  return <div className="ink-grid-layer" ref={ref} aria-hidden="true"/>;
}

/** Interactive affordances above the kernel canvas, positioned in screen space. */
export function PageOverlay({ layout, views, onAddPage, flash }: { layout: PageLayout; views: ViewStore; onAddPage?: () => void; flash?: { rect: Rect; token: string } | null }) {
  const last = layout.placements[layout.placements.length - 1].paper;
  const anchor = useView(views, v => {
    const x = (last.x + last.width / 2 + v.scrollX) * v.zoom, y = (last.y + last.height + v.scrollY) * v.zoom;
    return y < v.height + 80 ? `${Math.round(x)},${Math.round(y)}` : '';
  });
  const flashBox = useView(views, v => flash ? [(flash.rect.x + v.scrollX) * v.zoom, (flash.rect.y + v.scrollY) * v.zoom, flash.rect.width * v.zoom, flash.rect.height * v.zoom].map(Math.round).join(',') : '');
  const [x, y] = anchor ? anchor.split(',').map(Number) : [0, 0];
  const [fx, fy, fw, fh] = flashBox ? flashBox.split(',').map(Number) : [0, 0, 0, 0];
  return <div className="ink-page-overlay">
    {anchor && onAddPage && <button type="button" className="ink-add-page" style={{ left: x, top: y + 20 }} onClick={onAddPage}><span>＋</span>添加页面</button>}
    {flashBox && <div key={flash!.token} className="ink-flash" style={{ left: fx, top: fy, width: fw, height: fh }}/>}
  </div>;
}

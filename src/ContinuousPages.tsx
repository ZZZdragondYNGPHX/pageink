import React, { useEffect, useRef, useState } from 'react';
import { exportToCanvas } from '@excalidraw/excalidraw';
import { Page, pageRect } from './model';
import { Session } from './session';
import { PdfService } from './pdf';
import { bounds } from './geometry';
import { renderArea } from './preview';
function Preview({ session, page, pdf }: { session: Session; page: Page; pdf?: PdfService }) {
  const canvas = useRef<HTMLCanvasElement>(null), [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      const rect = pageRect(page), target = canvas.current!, scale = .7;
      const rendered = await renderArea(session, page, rect, scale, pdf, abort.signal);
      abort.signal.throwIfAborted(); target.width = rendered.width; target.height = rendered.height;
      target.getContext('2d')!.drawImage(rendered, 0, 0); rendered.width = rendered.height = 0;
    })().catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => { abort.abort(); };
  }, [page.id, session.manifest.revision, pdf]);
  return <>{error ? <div role="alert">{error}</div> : <canvas ref={canvas} style={{ width: '100%', height: '100%' }} />}</>;
}
export function ContinuousPages({ session, current, pdf, onSelect, children }: { session: Session; current: string; pdf?: PdfService; onSelect: (id: string) => void; children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null), [width, setWidth] = useState(600), [height, setHeight] = useState(800), [scroll, setScroll] = useState(0);
  useEffect(() => { const observer = new ResizeObserver(entries => { setWidth(entries[0].contentRect.width); setHeight(entries[0].contentRect.height); }); observer.observe(root.current!); return () => observer.disconnect(); }, []);
  const sizes = session.manifest.pages.map(p => { const rect = pageRect(p); return Math.min(1, Math.max(160, width - 48) / rect.width) * rect.height + 64; });
  let y = 0;
  return <div className="ink-continuous" ref={root} onScroll={e => setScroll(e.currentTarget.scrollTop)}>{session.manifest.pages.map((p, i) => {
    const top = y; y += sizes[i] + 16;
    const visible = top + sizes[i] > scroll - 400 && top < scroll + height + 400;
    return <section key={p.id} data-page-id={p.id} style={{ height: sizes[i], position: 'relative', marginBottom: 16 }}>
      {p.id === current ? children : visible ? <button className="ink-page-preview" aria-label={`编辑第 ${i + 1} 页`} onClick={() => onSelect(p.id)}><Preview session={session} page={p} pdf={pdf} /><span>第 {i + 1} 页 · 点击编辑</span></button> : <div className="ink-page-placeholder">第 {i + 1} 页</div>}
    </section>;
  })}</div>;
}

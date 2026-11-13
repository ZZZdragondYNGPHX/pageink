import { exportToSvg, getCommonBounds } from '@excalidraw/excalidraw';
import { Session } from './session';
import { Page, Rect, pageRect } from './model';
import { PdfService } from './pdf';
import { templateSpec, templateLines, templateDots } from './templates';
export async function renderArea(session: Session, page: Page, area: Rect, scale: number, pdf?: PdfService, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const canvas = createEl('canvas'); canvas.width = Math.ceil(area.width * scale); canvas.height = Math.ceil(area.height * scale);
  const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (page.pdfPage && !pdf) throw Error('PDF 原件不可用，不能生成缺少底稿的预览。');
  if (pdf && page.pdfPage) await pdf.render(page, canvas, scale, area, signal);
  if (!page.pdfPage) {
    ctx.strokeStyle = templateSpec(page.template).color; ctx.lineWidth = scale;
    for (const [x1,y1,x2,y2] of templateLines(page.template,pageRect(page),area)) { ctx.beginPath();ctx.moveTo((x1-area.x)*scale,(y1-area.y)*scale);ctx.lineTo((x2-area.x)*scale,(y2-area.y)*scale);ctx.stroke(); }
    ctx.fillStyle = templateSpec(page.template).color;
    for (const [x, y] of templateDots(page.template, pageRect(page), area)) { ctx.beginPath(); ctx.arc((x - area.x) * scale, (y - area.y) * scale, Math.max(.6, 1.15 * scale), 0, Math.PI * 2); ctx.fill(); }
  }
  const elements = (await session.read(page.id)).filter(e => {
    if (e.isDeleted) return false;
    const [x, y, right, bottom] = getCommonBounds([e]);
    return right > area.x && bottom > area.y && x < area.x + area.width && y < area.y + area.height;
  });
  await session.loadFiles(elements); signal?.throwIfAborted();
  if (elements.length) {
    const [x, y] = getCommonBounds(elements);
    const svg = await exportToSvg({ elements, files: { ...session.files }, appState: { exportBackground: false }, exportPadding: 0 });
    svg.setAttribute('viewBox', `${area.x - x} ${area.y - y} ${area.width} ${area.height}`);
    svg.setAttribute('width', String(canvas.width)); svg.setAttribute('height', String(canvas.height));
    const url = URL.createObjectURL(new Blob([svg.outerHTML], { type: 'image/svg+xml' }));
    try { const image = new Image(); image.src = url; await image.decode(); signal?.throwIfAborted(); ctx.drawImage(image, 0, 0, canvas.width, canvas.height); }
    finally { URL.revokeObjectURL(url); }
  }
  return canvas;
}

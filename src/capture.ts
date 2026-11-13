import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import { Session } from './session';
import { Page, uid } from './model';
import { imageFile } from './binary';
import { PdfService } from './pdf';
import { ScenePoint as Point, polygonBounds } from './geometry';
import { renderArea } from './preview';
/** Clips part of a page into a static image (source text only by default; blank pages always include ink). */
export async function capturePdf(session: Session, pdf: PdfService | undefined, page: Page, polygon: Point[], annotations: boolean, signal: AbortSignal) {
  const box = polygonBounds(polygon);
  if (box.width < 4 || box.height < 4) throw Error('选区太小，请重新框选。');
  // 2× sampling; very large areas use the largest scale that stays within 16 MP.
  const scale = Math.min(2, Math.sqrt(16_000_000 / (box.width * box.height)));
  const source = !annotations && page.pdfPage && pdf ? pdf : undefined;
  const canvas = source ? createEl('canvas') : await renderArea(session, page, box, scale, pdf, signal);
  if (source) await source.render(page, canvas, scale, box, signal);
  signal.throwIfAborted();
  const ctx = canvas.getContext('2d')!;
  ctx.globalCompositeOperation = 'destination-in'; ctx.beginPath();
  polygon.forEach((p, i) => { const x = (p[0] - box.x) * scale, y = (p[1] - box.y) * scale; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); ctx.fill();
  signal.throwIfAborted();
  const dataURL = canvas.toDataURL('image/png'), fileId = uid(); canvas.width = canvas.height = 0;
  const files = { [fileId]: imageFile(fileId, dataURL, 'image/png') };
  await session.acceptFiles(files); signal.throwIfAborted();
  const element = convertToExcalidrawElements([{ type: 'image', x: 0, y: 0, width: box.width, height: box.height, fileId: files[fileId].id, customData: { source: { document: session.manifest.id, page: page.id, polygon, annotations } } }])[0];
  return { element, files };
}

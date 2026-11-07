import { exportToCanvas, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import { Session } from './session';
import { Page, Element, uid } from './model';
import { PdfService } from './pdf';
import { Point, polygonBounds } from './SelectionOverlay';
import { bounds } from './geometry';
import { renderArea } from './preview';
export async function capturePdf(session: Session, pdf: PdfService, page: Page, polygon: Point[], annotations: boolean, signal: AbortSignal) {
  const box = polygonBounds(polygon), scale = 2;
  if (box.width < 1 || box.height < 1) throw Error('选区太小，请重新圈选。');
  if (box.width * box.height * scale * scale > 16_000_000) throw Error('选区超过 1600 万像素预算；请缩小选区，未自动降低清晰度。');
  const canvas = annotations ? await renderArea(session, page, box, scale, pdf, signal) : document.createElement('canvas');
  if (!annotations) await pdf.render(page, canvas, scale, box, signal);
  signal.throwIfAborted();
  const ctx = canvas.getContext('2d')!;
  ctx.globalCompositeOperation = 'destination-in'; ctx.beginPath();
  polygon.forEach((p, i) => { const x = (p[0] - box.x) * scale, y = (p[1] - box.y) * scale; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); ctx.fill();
  signal.throwIfAborted();
  const dataURL = canvas.toDataURL('image/png'), fileId = uid(); canvas.width = canvas.height = 0;
  const files = { [fileId]: { id: fileId as any, dataURL: dataURL as any, mimeType: 'image/png' as const, created: Date.now() } };
  await session.acceptFiles(files); signal.throwIfAborted();
  const element = convertToExcalidrawElements([{ type: 'image', x: 0, y: 0, width: box.width, height: box.height, fileId, customData: { source: { document: session.manifest.id, page: page.id, polygon, annotations } } } as any])[0];
  return { element, files };
}

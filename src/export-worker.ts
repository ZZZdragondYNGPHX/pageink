import { PDFDocument, degrees, rgb } from 'pdf-lib';
import PDFKit from 'pdfkit/js/pdfkit.standalone.js';
import svgToPdf from 'svg-to-pdfkit';
import { Buffer } from 'buffer';
import { templateLines, templateSpec } from './templates';
import type { Page, Rect } from './model';
import type { VectorLayer } from './vector-export';

let result: PDFDocument, source: PDFDocument | undefined, assetBase = '', font: Promise<Buffer> | undefined;
async function layerPdf(layer: VectorLayer) {
  const doc = new PDFKit({ size: [Math.max(1, layer.width), Math.max(1, layer.height)], margin: 0, compress: true });
  const chunks: Uint8Array[] = [];
  const finished = new Promise<Uint8Array>((resolve, reject) => {
    doc.on('data', (chunk: Uint8Array) => chunks.push(chunk)); doc.on('error', reject);
    doc.on('end', () => { const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; } resolve(bytes); });
  });
  if (layer.text) {
    font ??= fetch(`${assetBase}fonts/NotoSansCJKsc-Regular.otf`).then(async response => { if (!response.ok) throw Error('离线导出字体加载失败。'); return Buffer.from(await response.arrayBuffer()); });
    doc.registerFont('Ink CJK', await font);
  }
  const warnings: string[] = [];
  svgToPdf(doc, layer.svg, 0, 0, { width: layer.width, height: layer.height, assumePt: true, fontCallback: () => 'Ink CJK', imageCallback: (url: string) => url.startsWith('data:') ? Buffer.from(url.split(',')[1], 'base64') : url, warningCallback: (message: string) => warnings.push(message) });
  doc.end(); const bytes = await finished;
  if (warnings.some(message => !message.includes('Unsupported font-family'))) throw Error(`矢量导出未完成：${warnings.join('; ')}`);
  return bytes;
}
async function addPage(p: Page, box: Rect, paperKind: string, paginated: boolean, layer?: VectorLayer) {
  const paper = paperKind === 'a4' ? [595.28, 841.89] : paperKind === 'letter' ? [612, 792] : [box.width, box.height];
  const scale = Math.min(paper[0] / box.width, paper[1] / box.height), ox = (paper[0] - box.width * scale) / 2, oy = (paper[1] - box.height * scale) / 2;
  const page = result.addPage(paper as [number, number]);
  if (!p.pdfPage && paginated && p.template !== 'blank') {
    const hex = templateSpec(p.template).color, color = rgb(parseInt(hex.slice(1,3),16)/255,parseInt(hex.slice(3,5),16)/255,parseInt(hex.slice(5,7),16)/255);
    for (const [x1,y1,x2,y2] of templateLines(p.template,box,box)) page.drawLine({start:{x:ox+(x1-box.x)*scale,y:oy+(box.height-y1+box.y)*scale},end:{x:ox+(x2-box.x)*scale,y:oy+(box.height-y2+box.y)*scale},color,thickness:scale});
  }
  if (source && p.pdfPage) {
    const original = source.getPage(p.pdfPage - 1), crop = original.getCropBox();
    const embedded = await result.embedPage(original, {left:crop.x,bottom:crop.y,right:crop.x+crop.width,top:crop.y+crop.height});
    const rotation = ((original.getRotation().angle % 360) + 360) % 360, left = -box.x, bottom = box.height + box.y - p.height;
    const width = rotation % 180 ? p.height : p.width, height = rotation % 180 ? p.width : p.height;
    page.drawPage(embedded,{x:ox+scale*(left+(rotation===180?width:rotation===270?height:0)),y:oy+scale*(bottom+(rotation===90?width:rotation===180?height:0)),width:width*scale,height:height*scale,rotate:degrees(-rotation)});
  }
  if (layer) {
    const [embedded] = await result.embedPdf(await layerPdf(layer), [0]);
    page.drawPage(embedded,{x:ox+(layer.x-box.x)*scale,y:oy+(box.height-(layer.y-box.y)-layer.height)*scale,width:layer.width*scale,height:layer.height*scale});
  }
}
self.onmessage = async event => {
  const { id, kind, data } = event.data;
  try {
    if (kind === 'init') { assetBase = data.assetBase; result = await PDFDocument.create(); if (data.source) source = await PDFDocument.load(data.source); }
    else if (kind === 'page') await addPage(data.page, data.box, data.paper, data.paginated, data.layer);
    else if (kind === 'finish') { const bytes = await result.save(); (self as any).postMessage({id,result:bytes.buffer},[bytes.buffer]); return; }
    (self as any).postMessage({id});
  } catch (error) { (self as any).postMessage({id,error:(error as Error).message}); }
};

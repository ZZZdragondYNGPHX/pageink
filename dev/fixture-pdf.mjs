// Generates a small textbook-like PDF (Chinese text layer, figures, exercises) for host testing.
import PDFDocument from 'pdfkit';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export function writeFixturePdf(path, pages = 6) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 64, info: { Title: 'PageInk 测试教材' } });
    const out = createWriteStream(path);
    out.on('finish', resolve); out.on('error', reject);
    doc.pipe(out);
    doc.registerFont('cjk', `${root}vendor/fonts/NotoSansCJKsc-Regular.otf`);
    doc.font('cjk');
    for (let i = 1; i <= pages; i++) {
      if (i > 1) doc.addPage();
      doc.fontSize(20).fillColor('#1d2733').text(`第 ${i} 章  函数与极限`, { align: 'left' });
      doc.moveDown(0.6).fontSize(11).fillColor('#333');
      doc.text('设函数 f(x) 在点 x0 的某一去心邻域内有定义。如果存在常数 A，对于任意给定的正数 ε，总存在正数 δ，使得当 x 满足 0 < |x − x0| < δ 时，对应的函数值都满足 |f(x) − A| < ε，那么常数 A 就叫做函数 f(x) 当 x → x0 时的极限。', { lineGap: 6 });
      doc.moveDown(0.8);
      doc.rect(64, doc.y, 467, 120).strokeColor('#8aa0b8').lineWidth(1).stroke();
      const top = doc.y;
      doc.moveTo(84, top + 100).lineTo(300, top + 100).moveTo(84, top + 100).lineTo(84, top + 16).strokeColor('#445').stroke();
      doc.moveTo(84, top + 92).bezierCurveTo(140, top + 20, 200, top + 90, 290, top + 30).strokeColor('#2867b2').lineWidth(1.5).stroke();
      doc.fontSize(10).fillColor('#556').text(`图 ${i}-1  函数图像示意`, 320, top + 50);
      doc.x = 64; doc.y = top + 140;
      doc.fontSize(14).fillColor('#1d2733').text(`例题 ${i}.1`);
      doc.moveDown(0.3).fontSize(11).fillColor('#333').text(`求极限 lim (x→${i}) (x² − ${i * i}) / (x − ${i})。`, { lineGap: 6 });
      doc.moveDown(0.6).fontSize(14).fillColor('#1d2733').text(`习题 ${i}.2`);
      doc.moveDown(0.3).fontSize(11).fillColor('#333').text('证明：若 lim f(x) = A 且 A > 0，则存在 x0 的某一去心邻域，使得在该邻域内 f(x) > 0。', { lineGap: 6 });
      doc.moveDown(0.6).text('提示：取 ε = A / 2，由极限定义即可得到结论。注意区分函数极限与数列极限的定义方式，以及左极限、右极限与极限存在之间的关系。', { lineGap: 6 });
      doc.fontSize(9).fillColor('#889').text(`— ${i} —`, 64, 780, { width: 467, align: 'center' });
    }
    doc.end();
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await writeFixturePdf(process.argv[2] ?? 'fixture.pdf');

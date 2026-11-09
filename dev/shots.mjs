// Drives the redesigned UI in an isolated Obsidian and captures screenshots of key states.
import { launch, shot, resize, readVaultFile } from './obsidian.mjs';
import assert from 'node:assert/strict';

const prefix = process.env.PREFIX ?? 'new';
const { page, close } = await launch({ theme: process.env.THEME ?? 'moonstone', width: 1400, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`); });
const wait = ms => page.waitForTimeout(ms);
const plugin = (fn, arg) => page.evaluate(([source, a]) => new Function('plugin', 'app', 'arg', `return (${source})(plugin, app, arg)`)(window.app.plugins.plugins.pageink, window.app, a), [fn.toString(), arg]);
async function stroke(points, steps = 6) {
  await page.mouse.move(...points[0]); await page.mouse.down();
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    for (let s = 1; s <= steps; s++) await page.mouse.move(x0 + (x1 - x0) * s / steps, y0 + (y1 - y0) * s / steps);
  }
  await page.mouse.up(); await wait(120);
}
async function scribble(x, y, w = 160) { await stroke([[x, y], [x + w * .25, y - 18], [x + w * .5, y + 12], [x + w * .75, y - 10], [x + w, y + 6]]); }
const area = async () => page.locator('.workspace-leaf.mod-active .ink-canvas-area').boundingBox();
const leaf = '.workspace-leaf.mod-active';
try {
  await wait(1200);
  console.log('command', await page.evaluate(() => { const ok = window.app.commands.executeCommandById('pageink:new-drawing'); return { ok, exists: !!window.app.commands.commands['pageink:new-drawing'] }; }));
  await page.waitForSelector('.ink-create-modal', { timeout: 5000 }).catch(() => console.log('no create modal'));
  await wait(300); await shot(page, `${prefix}-01-create`);
  await page.keyboard.press('Escape');

  await plugin(p => p.create('pages', { template: 'ruled', title: '笔记本示例' }));
  await page.waitForSelector(`${leaf} .ink-paper`, { timeout: 20000 }); await wait(1200);
  let box = await area();
  await scribble(box.x + 200, box.y + 160); await scribble(box.x + 200, box.y + 220, 220); await wait(900);
  await shot(page, `${prefix}-02-pages`);
  await page.click(`${leaf} .ink-thumb-add`);
  await wait(1500); await shot(page, `${prefix}-03-added-page`);
  box = await area();
  await scribble(box.x + 260, box.y + box.height / 2, 200); await wait(2500);
  let doc = JSON.parse(await readVaultFile('笔记本示例.inknote'));
  console.log('pages', doc.pages.length, 'chunks', Object.keys(doc.chunks));
  assert.equal(doc.pages.length, 2);
  await page.keyboard.press('Control+z'); await wait(400); await page.keyboard.press('Control+z'); await wait(2500);
  doc = JSON.parse(await readVaultFile('笔记本示例.inknote'));
  console.log('after 2× undo: pages', doc.pages.length);
  assert.equal(doc.pages.length, 1);
  await shot(page, `${prefix}-03b-undo`);
  await page.keyboard.press('Control+Shift+z'); await wait(400); await page.keyboard.press('Control+Shift+z'); await wait(2500);
  doc = JSON.parse(await readVaultFile('笔记本示例.inknote'));
  console.log('after 2× redo: pages', doc.pages.length);
  assert.equal(doc.pages.length, 2);

  await plugin((p, app) => p.importPdf('教材', undefined, app.vault.getAbstractFileByPath('教材.pdf')));
  await page.waitForSelector(`${leaf} .ink-pdf-base`, { timeout: 20000 }); await wait(2500);
  await shot(page, `${prefix}-04-pdf`);
  await page.click(`${leaf} button[aria-label="荧光笔"]`); box = await area();
  await stroke([[box.x + 330, box.y + 230], [box.x + 620, box.y + 230]]);
  await page.click(`${leaf} button[aria-label="圈选"]`);
  await stroke([[box.x + 300, box.y + 200], [box.x + 680, box.y + 200], [box.x + 680, box.y + 260], [box.x + 300, box.y + 260], [box.x + 300, box.y + 200]], 3);
  await wait(500); await shot(page, `${prefix}-05-lasso`);
  await page.keyboard.press('Escape');
  await page.click(`${leaf} button[aria-label="草稿纸"]`); await wait(1200);
  await page.click(`${leaf} button[aria-label="笔"]`);
  const scratch = await page.locator(`${leaf} .ink-scratch-body`).boundingBox();
  await scribble(scratch.x + 40, scratch.y + 80, 200); await wait(600);
  await shot(page, `${prefix}-06-scratch`);
  await page.click(`${leaf} button[aria-label="导出"]`); await wait(400); await shot(page, `${prefix}-07-export`);
  await page.keyboard.press('Escape');
  await page.click(`${leaf} button[aria-label="更多"]`); await wait(400); await shot(page, `${prefix}-08-more`);
  await page.keyboard.press('Escape');

  await plugin(p => p.create('canvas', { title: '自由画布示例' }));
  await page.waitForSelector(`${leaf} .ink-grid-layer`, { timeout: 20000 }); await wait(1500);
  box = await area();
  await scribble(box.x + box.width / 2 - 120, box.y + box.height / 2 - 40, 240);
  await page.click(`${leaf} button[aria-label="形状"]`);
  await stroke([[box.x + box.width / 2 - 100, box.y + box.height / 2 + 20], [box.x + box.width / 2 + 100, box.y + box.height / 2 + 120]], 4);
  await wait(800); await shot(page, `${prefix}-09-canvas`);

  await resize(page, 820, 1000); await wait(1200); await shot(page, `${prefix}-10-narrow`);
  console.log(JSON.stringify(errors.slice(0, 20), null, 1));
  assert.deepEqual(errors, []);
} catch (error) {
  console.log('FAILED', error.message, JSON.stringify(errors.slice(0, 20), null, 1));
  await shot(page, `${prefix}-failure`).catch(() => {});
  process.exitCode = 1;
} finally { await close(); }

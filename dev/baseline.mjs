// Screenshots of the main states for before/after comparison.
import { launch, shot, resize } from './obsidian.mjs';

const { page, close } = await launch({ theme: process.env.THEME ?? 'moonstone' });
const prefix = process.env.PREFIX ?? 'base';
const wait = (ms) => page.waitForTimeout(ms);
try {
  await wait(1500);
  await page.evaluate(() => (window).app.commands.executeCommandById('pageink:new-drawing'));
  await wait(800); await shot(page, `${prefix}-01-create`);
  await page.keyboard.press('Escape');
  await page.evaluate(async () => { const p = (window).app.plugins.plugins.pageink; await p.create('笔记本示例', 'pages'); });
  await wait(2500); await shot(page, `${prefix}-02-pages`);
  await page.evaluate(async () => { const p = (window).app.plugins.plugins.pageink; await p.importPdf('教材', undefined, (window).app.vault.getAbstractFileByPath('教材.pdf')); });
  await wait(3500); await shot(page, `${prefix}-03-pdf`);
  await page.evaluate(async () => { const p = (window).app.plugins.plugins.pageink; await p.create('自由画布示例', 'canvas'); });
  await wait(2500); await shot(page, `${prefix}-04-canvas`);
  const scratch = page.locator('button[aria-label="草稿纸"], button:has-text("草稿纸")').first();
  if (await scratch.isVisible().catch(() => false)) { await scratch.click(); await wait(1200); await shot(page, `${prefix}-05-scratch`); }
  await resize(page, 820, 1000);
  await wait(1200); await shot(page, `${prefix}-06-narrow`);
} finally { await close(); }

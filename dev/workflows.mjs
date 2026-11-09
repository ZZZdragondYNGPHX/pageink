// End-to-end workflows in the generated Obsidian vault; no personal notes are used.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { launch, resize, shot, vault } from './obsidian.mjs';

const { page, close } = await launch();
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 500)); });
const workspace = page.locator('.workspace-leaf.mod-active .ink-workspace');
const button = name => workspace.getByRole('button', { name, exact: true });
const command = id => page.evaluate(id => window.app.commands.executeCommandById(`pageink:${id}`), id);
const active = (fn, arg) => page.evaluate(([source, arg]) => {
  const app = window.app, plugin = app.plugins.plugins.pageink;
  const view = app.workspace.activeLeaf.view;
  return new Function('view', 'plugin', 'app', 'arg', `return (${source})(view, plugin, app, arg)`)(view, plugin, app, arg);
}, [fn.toString(), arg]);
const snapshot = () => active(async view => {
  const s = view.session; await s.flush();
  return { path: view.file.path, manifest: structuredClone(s.manifest), body: await Promise.all(s.manifest.pages.map(p => s.read(p.id))), scratch: await s.read('scratch') };
});
const waitFor = async (predicate, message, timeout = 20000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await page.waitForTimeout(150); }
  throw Error(message);
};
const visibleScratchInk = () => workspace.locator('.ink-editor-scratch').evaluate(root => {
  let pixels = 0;
  for (const canvas of root.querySelectorAll('canvas')) {
    if (!canvas.width || !canvas.height) continue;
    const context = canvas.getContext('2d'); if (!context) continue;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 100 && data[i] < 160 && data[i + 1] < 160 && data[i + 2] < 160) pixels++;
  }
  return pixels > 500;
});
async function drag(points) {
  await page.mouse.move(...points[0]); await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(...point, { steps: 10 });
  await page.mouse.up(); await page.waitForTimeout(200);
}
async function create(mode, name) {
  await command('new-drawing');
  await page.locator('.ink-create-name').fill(name);
  if (mode === '笔记本') await page.getByRole('radio', { name: '横线', exact: true }).click();
  await page.getByRole('button', { name: `新建${mode}`, exact: true }).click();
  await workspace.waitFor(); await page.waitForTimeout(700);
}
async function exportItem(label, extension) {
  await button('导出').click();
  await workspace.getByRole('menuitem', { name: label }).click();
  let path;
  await waitFor(async () => {
    path = await active((view, plugin, app, extension) => app.vault.getFiles().filter(f => f.path.startsWith('Drawing Exports/') && f.extension === extension).at(-1)?.path, extension);
    return !!path;
  }, `Export ${extension} did not finish`, 60000);
  return path;
}
try {
  const environment = await page.evaluate(() => ({ obsidian: navigator.userAgent.match(/obsidian\/([\d.]+)/i)?.[1] ?? null, userAgent: navigator.userAgent }));
  await create('笔记本', '流程笔记');
  const box = await workspace.locator('.ink-canvas-area').boundingBox();
  await drag([[box.x + 200, box.y + 140], [box.x + 250, box.y + 120], [box.x + 300, box.y + 160], [box.x + 340, box.y + 140]]);
  const written = await snapshot();
  assert.equal(written.body[0].filter(e => e.type === 'freedraw').length, 1);
  assert.ok(written.body[0][0].points.length > 10);
  assert.equal(written.manifest.pages[0].template, 'ruled');
  await button('阅读模式').click();
  assert.equal(await workspace.locator('.ink-writing-bar').count(), 0);
  await drag([[box.x + 200, box.y + 260], [box.x + 300, box.y + 260]]);
  assert.deepEqual((await snapshot()).body, written.body);
  await button('继续书写').click();
  assert.equal(await workspace.locator('.ink-writing-bar').count(), 1);
  checks.push('Create notebook through modal, raw stroke samples, reading prevents editing');

  await active(async (view, plugin, app) => { const path = view.file.path; await view.session.flush(); await view.leaf.openFile(app.vault.getAbstractFileByPath('欢迎.md')); await plugin.openPath(path); });
  await workspace.waitFor(); await page.waitForTimeout(600);
  assert.deepEqual((await snapshot()).body, written.body);
  checks.push('Save, close note, reopen: exact raw drawing data preserved');

  await active((view, plugin, app) => plugin.importPdf('教材', undefined, app.vault.getAbstractFileByPath('教材.pdf')));
  await workspace.locator('.ink-pdf-base').first().waitFor(); await page.waitForTimeout(1000);
  await button('更多').click();
  await workspace.getByRole('menuitem', { name: '选择本页文字…', exact: true }).click();
  assert.match(await workspace.getByRole('textbox', { name: 'PDF 原文文字' }).inputValue(), /函数与极限/);
  await page.keyboard.press('Escape');
  await button('搜索').click();
  await workspace.getByRole('searchbox', { name: '搜索', exact: true }).fill('函数');
  await waitFor(async () => await workspace.locator('.ink-search-hit').count() > 0, 'PDF search missing');
  await button('收起侧栏').click();
  await button('摘录').click();
  const paper = await workspace.locator('.ink-paper').first().boundingBox();
  await drag([[paper.x + 80, paper.y + 80], [paper.x + 410, paper.y + 230]]);
  await waitFor(async () => (await snapshot()).scratch.some(e => e.type === 'image'), 'Capture missing');
  await waitFor(visibleScratchInk, 'Captured text is not visible in the opened scratchpad');
  let captured = await snapshot();
  assert.ok(captured.scratch[0].customData.source);
  await workspace.getByRole('button', { name: '复制到正文', exact: true }).click();
  await waitFor(async () => (await snapshot()).body[0].some(e => e.type === 'image'), 'Copy to body missing');
  const copied = await snapshot();
  assert.notEqual(copied.body[0][0].id, copied.scratch[0].id);
  assert.equal(copied.body[0][0].fileId, copied.scratch[0].fileId);
  const scratchBox = await workspace.locator('.ink-scratch').boundingBox();
  await workspace.getByRole('button', { name: '调整草稿纸大小，用方向键调整' }).focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(Math.round((await workspace.locator('.ink-scratch').boundingBox()).width), Math.round(scratchBox.width + 16));
  await button('清空草稿纸（可撤销）').click();
  await waitFor(async () => (await snapshot()).scratch.length === 0, 'Scratch clear failed');
  await button('撤销草稿纸').click();
  await waitFor(async () => (await snapshot()).scratch.length === copied.scratch.length, 'Scratch undo failed');
  await waitFor(visibleScratchInk, 'Restored capture is not visible after scratch undo');
  assert.deepEqual((await snapshot()).body, copied.body);
  await shot(page, 'workflow-pdf-scratch');
  checks.push('PDF selectable Chinese text and search, capture to scratch, editable independent copy to body, keyboard resize, independent scratch undo');

  const pdfPath = await exportItem('批注版 PDF', 'pdf');
  const exported = await PDFDocument.load(await readFile(join(vault, pdfPath)));
  assert.equal(exported.getPageCount(), copied.manifest.pages.length);
  assert.ok(exported.getPage(0).getWidth() >= copied.manifest.pages[0].width);
  const packagePath = await exportItem('可编辑备份', 'inkpack');
  const backedUp = await snapshot();
  await command('new-drawing');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /恢复备份/ }).click();
  await (await chooserPromise).setFiles(join(vault, packagePath));
  await waitFor(async () => await active(view => !!view.session && view.file.path !== '教材.inknote'), 'Backup restore did not open', 60000);
  await workspace.waitFor();
  const restored = await snapshot();
  assert.notEqual(restored.manifest.id, backedUp.manifest.id);
  assert.equal(restored.manifest.pdf.sha256, backedUp.manifest.pdf.sha256);
  assert.equal(restored.body[0][0].id, backedUp.body[0][0].id);
  assert.equal(restored.scratch[0].id, backedUp.scratch[0].id);
  assert.equal(restored.scratch[0].customData.source.document, restored.manifest.id);
  assert.equal(restored.manifest.pages.length, backedUp.manifest.pages.length);
  assert.equal(Object.keys(restored.manifest.assets).length, Object.keys(backedUp.manifest.assets).length);
  checks.push('Six-page PDF export, full backup export and restore with scratch, images, source PDF and remapped source link');

  await create('自由画布', '想法画布');
  const board = await workspace.locator('.ink-canvas-area').boundingBox();
  await button('笔').click();
  await drag([[board.x + 250, board.y + 220], [board.x + 320, board.y + 260], [board.x + 420, board.y + 200]]);
  await button('保存当前视野').click();
  const bookmark = workspace.getByRole('textbox', { name: '书签名称' });
  await bookmark.fill('项目思路'); await bookmark.press('Enter');
  assert.equal((await snapshot()).manifest.regions[0].title, '项目思路');
  await button('收起侧栏').click();
  await resize(page, 820, 1000);
  await button('更多工具').click();
  await workspace.getByRole('menuitemcheckbox', { name: '形状', exact: true }).click();
  assert.equal(await button('形状').getAttribute('aria-pressed'), 'true');
  assert.ok(await button('重做').isVisible());
  await shot(page, 'workflow-narrow-tools');
  await button('形状设置').click();
  const pop = await workspace.getByRole('dialog', { name: '形状设置' }).boundingBox();
  const bounds = await workspace.boundingBox();
  assert.ok(pop.x >= bounds.x && pop.x + pop.width <= bounds.x + bounds.width + 1);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.app.commands.executeCommandById('theme:toggle-light-dark'));
  await page.waitForTimeout(600);
  assert.ok(await page.locator('body.theme-dark').count());
  await shot(page, 'workflow-dark');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await button('形状设置').click();
  const duration = await workspace.getByRole('dialog', { name: '形状设置' }).evaluate(el => getComputedStyle(el).animationDuration);
  assert.ok(parseFloat(duration) <= 0.001);
  checks.push('Canvas bookmark, narrow toolbar all tools and redo, bounded popover, dark theme and reduced motion');
  assert.deepEqual(errors, []);
  const sha256 = createHash('sha256').update(await readFile(new URL('../dist/main.js', import.meta.url))).digest('hex');
  const report = { date: new Date().toISOString(), environment, sha256, checks, errors };
  await writeFile(new URL('../artifacts/workflow-validation.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error); console.error({ checks, errors });
  await shot(page, 'workflow-failure').catch(() => {});
  process.exitCode = 1;
} finally { await close(); }

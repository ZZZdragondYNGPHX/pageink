// Real Obsidian card workflows, isolated vault. Run host suites sequentially.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { unzipSync } from 'fflate';
import { launch, resize, shot, vault, readVaultFile } from './obsidian.mjs';
const first = '观察：磁场改变了运动方向。', second = '推论：需要补充对照实验。';
const { page, close } = await launch({ files: { '卡片来源.md': `${first} ^first\n\n${second} ^second\n` } });
const errors = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 500)); });
const app = (fn, arg) => page.evaluate(([source, arg]) => new Function('app', 'plugin', 'arg', `return (${source})(app, plugin, arg)`)(window.app, window.app.plugins.plugins.pageink, arg), [fn.toString(), arg]);
const drawing = () => page.locator('.workspace-leaf.mod-active .ink-workspace');
const button = name => (['撤销', '重做'].includes(name) ? drawing().locator('.ink-history-tools') : drawing()).getByRole('button', { name, exact: true });
const panel = () => drawing().getByRole('dialog', { name: '画板卡片', exact: true });
const editor = () => drawing().getByRole('dialog', { name: '编辑卡片段落', exact: true });
const waitFor = async (test, label, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return; await page.waitForTimeout(100); } throw Error(label); };
const snapshot = () => app(async app => {
  const view = app.workspace.getLeavesOfType('drawing-local-view').find(l => l.view.file?.path === window.boardPath).view;
  await view.session.flush(); return { path: view.file.path, manifest: structuredClone(view.session.manifest), elements: await view.session.read(view.session.manifest.pages[0].id), memory: view.pendingView ?? view.loadView() };
});
const activate = () => app(async (app, plugin) => { const leaf = app.workspace.getLeavesOfType('drawing-local-view').find(l => l.view.file?.path === window.boardPath); if (!leaf) { await plugin.openPath(window.boardPath); return; } await app.workspace.revealLeaf(leaf); app.workspace.setActiveLeaf(leaf, { focus: true }); });
async function pick(text) { await page.locator('.prompt-input').fill(text); await page.locator('.suggestion-item').filter({ hasText: text }).first().click(); }
async function openPanel() { if (!(await panel().count())) await button('画板卡片').click(); }
async function insert(text) {
  await openPanel(); await panel().getByRole('button', { name: '插入文字卡片', exact: true }).click(); await pick('卡片来源.md'); await pick(text);
  await waitFor(async () => (await snapshot()).elements.some(e => e.originalText === text), 'Card not inserted'); await activate();
}
async function point(e, dx = 20, dy = 10) {
  await page.waitForTimeout(450); const { memory } = await snapshot(); const box = await drawing().locator('.ink-editor-canvas').boundingBox();
  return { x: box.x + (e.x + dx - memory.dx) * memory.zoom, y: box.y + (e.y + dy - memory.dy) * memory.zoom };
}
async function selectCard(e, shift = false) {
  await button('选择').click(); const p = await point(e); if (shift) await page.keyboard.down('Shift'); await page.mouse.click(p.x, p.y); if (shift) await page.keyboard.up('Shift');
}
async function exportItem(label, extension) {
  await page.keyboard.press('Escape'); await button('导出').click(); await drawing().getByRole('menuitem', { name: label === 'PDF' ? /^PDF(?:\s|$)/ : label }).click(); let path;
  await waitFor(async () => { path = await app((app, _, ext) => app.vault.getFiles().filter(f => f.path.startsWith('Drawing Exports/') && f.extension === ext).at(-1)?.path, extension); return !!path; }, 'Export timed out', 60000); return path;
}
try {
  const environment = await app(() => ({ userAgent: navigator.userAgent }));
  await app(async (_, plugin) => { await plugin.create('canvas', { title: '卡片画板' }); window.boardPath = '卡片画板.inknote'; });
  await drawing().waitFor(); await page.waitForTimeout(600);
  await insert(first); let state = await snapshot(), root = state.elements.find(e => e.customData?.pageinkCard);
  assert.equal(root.type, 'rectangle'); let text = state.elements.find(e => e.containerId === root.id); assert.equal(text.originalText, first);
  // Drag a card using the actual kernel; its shared text moves with it.
  await page.keyboard.press('Escape'); await button('显示全部内容').click(); const drag = await point(root);
  await page.mouse.move(drag.x, drag.y); await page.mouse.down(); await page.mouse.move(drag.x - 230, drag.y - 160, { steps: 16 }); await page.mouse.up();
  await waitFor(async () => (await snapshot()).elements.find(e => e.id === root.id).x < root.x - 100, 'Card drag failed');
  state = await snapshot(); const moved = state.elements.find(e => e.id === root.id), movedText = state.elements.find(e => e.id === text.id);
  assert.ok(Math.abs((movedText.x - text.x) - (moved.x - root.x)) < 1); root = moved;
  checks.push('Real card drag keeps bound source text and stable IDs together');
  // Double click opens the inline editor without another foreground leaf.
  const p = await point(root, 45, 35); await page.mouse.dblclick(p.x, p.y); await editor().waitFor();
  const expanded = '观察更新：' + '经过重复测量，记录变量与误差范围。'.repeat(8);
  await editor().getByRole('textbox', { name: '段落正文' }).fill(expanded); await page.keyboard.press('Control+Enter');
  await waitFor(async () => !(await editor().count()), 'Inline submit did not close');
  await waitFor(async () => (await snapshot()).elements.find(e => e.id === text.id).originalText === expanded, 'Projection not updated');
  assert.ok((await readVaultFile('卡片来源.md')).includes(expanded + ' ^first'));
  const committed = await snapshot(); assert.ok(committed.elements.find(e => e.id === root.id).height > root.height);
  await button('撤销').click(); await waitFor(async () => (await snapshot()).elements.find(e => e.id === text.id).originalText === first, 'Card undo failed');
  assert.ok((await readVaultFile('卡片来源.md')).includes(expanded)); await button('重做').click();
  await waitFor(async () => (await snapshot()).elements.find(e => e.id === text.id).originalText === expanded, 'Card redo failed');
  await app(async app => { const view = app.workspace.getLeavesOfType('markdown').find(l => l.view.file?.path === '卡片来源.md').view; view.editor.undo(); await view.save(); });
  assert.ok((await readVaultFile('卡片来源.md')).includes(first));
  assert.equal((await snapshot()).elements.find(e => e.id === text.id).originalText, expanded);
  await app(async app => { const view = app.workspace.getLeavesOfType('markdown').find(l => l.view.file?.path === '卡片来源.md').view; view.editor.redo(); await view.save(); });
  assert.ok((await readVaultFile('卡片来源.md')).includes(expanded));
  checks.push('Inline native transaction retains block ID; projection undo/redo is independent of original Markdown');
  // Concurrent source change must preserve the draft and refuse the commit.
  await openPanel(); await panel().locator('li').first().getByRole('button', { name: '在卡片内编辑' }).click(); await editor().waitFor();
  await editor().getByRole('textbox', { name: '段落正文' }).fill('未提交草稿');
  await app(async app => { const view = app.workspace.getLeavesOfType('markdown').find(l => l.view.file?.path === '卡片来源.md').view; view.editor.replaceRange('别处追加\n\n', { line: 0, ch: 0 }); await view.save(); });
  await editor().getByRole('button', { name: '保存到原文' }).click(); await editor().getByRole('alert').waitFor();
  assert.equal(await editor().getByRole('textbox').inputValue(), '未提交草稿'); assert.ok(!(await readVaultFile('卡片来源.md')).includes('未提交草稿'));
  await editor().getByRole('button', { name: '放弃草稿' }).click(); checks.push('Concurrent source edits reject stale inline draft without overwriting either side');
  // A second card, connect, group, duplicate, remove and undo.
  await insert(second); state = await snapshot(); const roots = state.elements.filter(e => e.customData?.pageinkCard); const other = roots.find(e => e.id !== root.id);
  await page.keyboard.press('Escape'); await button('显示全部内容').click();
  root = state.elements.find(e => e.id === root.id); await selectCard(root); await selectCard(other, true);
  await openPanel(); await panel().getByRole('button', { name: '连接所选卡片' }).click();
  await waitFor(async () => (await snapshot()).elements.some(e => e.type === 'arrow' && e.startBinding && e.endBinding), 'Cards not connected');
  const arrowBefore = (await snapshot()).elements.find(e => e.type === 'arrow');
  await panel().locator('li').filter({ hasText: expanded }).getByRole('button', { name: '在卡片内编辑' }).click();
  await editor().getByRole('textbox').fill('观察更新：缩短段落。'); await page.keyboard.press('Control+Enter');
  await waitFor(async () => !(await editor().count()), 'Connected card submit failed');
  const arrowAfter = (await snapshot()).elements.find(e => e.id === arrowBefore.id);
  assert.notDeepEqual([arrowAfter.x, arrowAfter.y, arrowAfter.points], [arrowBefore.x, arrowBefore.y, arrowBefore.points]);
  await button('撤销').click();
  await waitFor(async () => (await snapshot()).elements.find(e => e.id === text.id).originalText === expanded, 'Connected resize undo failed');
  const arrowUndone = (await snapshot()).elements.find(e => e.id === arrowBefore.id);
  assert.deepEqual([arrowUndone.x, arrowUndone.y, arrowUndone.points], [arrowBefore.x, arrowBefore.y, arrowBefore.points]);
  checks.push('Native source undo/redo and card-height refresh update bound arrow endpoints in the same drawing undo step');
  await selectCard(root); await selectCard(other, true); await openPanel();
  await panel().getByRole('button', { name: '组合所选' }).click();
  await waitFor(async () => (await snapshot()).elements.filter(e => e.customData?.pageinkCard).every(e => e.groupIds.length), 'Cards not grouped');
  await page.keyboard.press('Escape'); await button('复制一份').click();
  await waitFor(async () => (await snapshot()).elements.filter(e => e.customData?.pageinkCard).length === 4, 'Group duplicate failed');
  state = await snapshot(); const copies = state.elements.filter(e => e.customData?.pageinkCard && !roots.some(r => r.id === e.id));
  assert.equal(copies.length, 2); for (const copy of copies) assert.ok(state.elements.some(e => e.containerId === copy.id && e.customData?.pageinkText));
  await button('删除').click(); await waitFor(async () => (await snapshot()).elements.filter(e => e.customData?.pageinkCard).length === 2, 'Delete failed');
  await button('撤销').click(); await waitFor(async () => (await snapshot()).elements.filter(e => e.customData?.pageinkCard).length === 4, 'Delete undo failed');
  checks.push('Native bound arrows, grouping, duplicate identity remapping and removal undo');
  // Create a notebook with real mouse ink and a source region.
  await app(async (_, plugin) => { await plugin.create('pages', { title: '卡片手写原件' }); }); await drawing().waitFor(); await page.waitForTimeout(600);
  await button('笔').click(); const paper = await drawing().locator('.ink-paper').first().boundingBox();
  await page.mouse.move(paper.x + 120, paper.y + 150); await page.mouse.down(); await page.mouse.move(paper.x + 190, paper.y + 110, { steps: 16 }); await page.mouse.move(paper.x + 250, paper.y + 180, { steps: 16 }); await page.mouse.up();
  const rawInk = await app(async app => { const session = app.workspace.activeLeaf.view.session; await session.flush(); const p = session.manifest.pages[0]; const ink = (await session.read(p.id)).filter(e => e.type === 'freedraw'); session.editLayout(() => session.manifest.regions.push({ id: 'test-region', pageId: p.id, title: '实验草图', x: 0, y: 0, width: p.width, height: 420 })); await session.save(); return ink; });
  assert.equal(rawInk.length, 1); await activate(); await page.keyboard.press('Escape');
  await openPanel(); await panel().getByRole('button', { name: '插入手写卡片' }).click(); await pick('卡片手写原件.inknote'); await pick('实验草图');
  await waitFor(async () => (await snapshot()).elements.some(e => e.customData?.pageinkCard?.kind === 'ink'), 'Ink card not inserted', 60000);
  state = await snapshot(); let inkRoot = state.elements.find(e => e.customData?.pageinkCard?.kind === 'ink'), ref = inkRoot.customData.pageinkCard;
  const packBytes = await readFile(join(vault, state.manifest.assets[ref.archiveAsset].path)), files = unzipSync(packBytes), inner = JSON.parse(new TextDecoder().decode(files['document.json']));
  const storedInk = Object.values(inner.chunks).flatMap(path => JSON.parse(new TextDecoder().decode(files[path]))).filter(e => e.type === 'freedraw');
  assert.deepEqual(storedInk, rawInk);
  await app(app => app.vault.delete(app.vault.getAbstractFileByPath('卡片手写原件.inknote')));
  await openPanel(); await panel().locator('li').filter({ hasText: '实验草图' }).getByRole('button', { name: '恢复引用时的原件' }).click();
  await waitFor(async () => (await snapshot()).elements.find(e => e.id === inkRoot.id).customData.pageinkCard.document !== ref.document, 'Ink source not restored', 60000);
  state = await snapshot(); ref = state.elements.find(e => e.id === inkRoot.id).customData.pageinkCard;
  const restoredInk = await app(async (_, plugin, path) => { const manifest = JSON.parse(await plugin.io.read(path)); return (await Promise.all(Object.values(manifest.chunks).map(p => plugin.io.read(p)))).flatMap(data => JSON.parse(data)).filter(e => e.type === 'freedraw'); }, ref.path);
  assert.deepEqual(restoredInk, rawInk); checks.push('Ink region preview embeds complete notebook archive; missing original restores exact raw mouse ink into independent editable notebook');
  await page.keyboard.press('Escape'); await button('显示全部内容').click(); await shot(page, 'cards-board');
  await resize(page, 820, 1000); await app(app => app.commands.executeCommandById('theme:toggle-light-dark')); await openPanel(); await panel().evaluate(el => Promise.all(el.getAnimations().map(a => a.finished))); await shot(page, 'cards-narrow-dark');
  const panelBox = await panel().boundingBox(), workspaceBox = await drawing().boundingBox(); assert.ok(panelBox.x >= workspaceBox.x && panelBox.x + panelBox.width <= workspaceBox.x + workspaceBox.width + 1);
  await page.keyboard.press('Escape'); await resize(page, 1400, 900);
  const pdfPath = await exportItem('PDF', 'pdf'); const pdf = await PDFDocument.load(await readFile(join(vault, pdfPath))); assert.equal(pdf.getPageCount(), 1);
  const packagePath = await exportItem('可编辑备份', 'inkpack'); const saved = await snapshot();
  await app(app => app.commands.executeCommandById('pageink:new-drawing'));
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: /恢复备份/ }).click(); await (await chooser).setFiles(join(vault, packagePath));
  await waitFor(() => app(app => app.workspace.activeLeaf.view.file?.extension === 'inknote' && app.workspace.activeLeaf.view.file.path !== window.boardPath), 'Board restore failed', 60000);
  await app(app => { window.boardPath = app.workspace.activeLeaf.view.file.path; }); await drawing().waitFor(); await page.waitForTimeout(600);
  state = await snapshot(); assert.equal(state.elements.filter(e => e.customData?.pageinkCard).length, 5);
  for (const e of state.elements.filter(e => e.customData?.pageinkText)) assert.ok(e.customData.pageinkText.path.startsWith('Drawing Resources/'));
  const restoredArchive = state.manifest.assets[ref.archiveAsset]; assert.deepEqual(await readFile(join(vault, restoredArchive.path)), packBytes);
  await openPanel(); await panel().locator('li').first().getByRole('button', { name: '在卡片内编辑' }).click();
  await editor().getByRole('textbox').fill('恢复后共享编辑。'); await page.keyboard.press('Control+s');
  await waitFor(async () => { const texts = (await snapshot()).elements.filter(e => e.customData?.pageinkText?.blockId === 'first'); return texts.length === 2 && texts.every(e => e.originalText === '恢复后共享编辑。'); }, 'Restored shared card projections did not update');
  await activate();
  await waitFor(async () => !(await editor().count()), 'Restored card edit failed');
  const shared = (await snapshot()).elements.filter(e => e.customData?.pageinkText?.blockId === 'first');
  assert.equal(shared.length, 2); assert.ok(shared.every(e => e.originalText === '恢复后共享编辑。'));
  checks.push('Restored native Markdown remains editable in place; both cards sharing the same block update together');
  const beforeClose = await snapshot(); await app(async (app, plugin) => { const v = app.workspace.activeLeaf.view, p = v.file.path; await v.session.flush(); v.leaf.detach(); await plugin.openPath(p); });
  await drawing().waitFor(); await page.waitForTimeout(600); assert.deepEqual((await snapshot()).elements, beforeClose.elements);
  checks.push('Narrow dark panel, complete-board PDF and archive restore preserve cards, native bindings, editable Markdown and nested raw notebook archives; close/reopen round trip');
  assert.deepEqual(errors, []);
  const sha256 = createHash('sha256').update(await readFile(new URL('../dist/main.js', import.meta.url))).digest('hex');
  const report = { date: new Date().toISOString(), environment, sha256, checks, errors }; await writeFile(new URL('../artifacts/cards-validation.json', import.meta.url), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error); console.error({ checks, errors }); await shot(page, 'cards-failure').catch(() => {}); process.exitCode = 1; }
finally { await close(); }

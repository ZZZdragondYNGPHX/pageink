// Paragraph integration in the generated vault. Host suites must run sequentially.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { launch, resize, shot, vault, readVaultFile } from './obsidian.mjs';

const first = '第一段：观察与假设。', second = '第二段：保留这段旁边的推导笔迹。';
const { page, close } = await launch({ files: { '混合来源.md': `# 实验记录\n\n${first}\n\n${second}\n` } });
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 500)); });
const app = (fn, arg) => page.evaluate(([source, argument]) => new Function('app', 'plugin', 'arg', `return (${source})(app, plugin, arg)`)(window.app, window.app.plugins.plugins.pageink, argument), [fn.toString(), arg]);
const drawing = () => page.locator('.workspace-leaf.mod-active .ink-workspace');
const button = name => (['撤销', '重做'].includes(name) ? drawing().locator('.ink-history-tools') : drawing()).getByRole('button', { name, exact: true });
const panel = () => drawing().getByRole('dialog', { name: '文字段落', exact: true });
const waitFor = async (predicate, label, timeout = 20000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await page.waitForTimeout(100); }
  throw Error(label);
};
const snapshot = () => app(async app => {
  const view = app.workspace.getLeavesOfType('drawing-local-view').find(l => l.view.file?.path === window.mixedPath).view, s = view.session;
  await s.flush(); return { path: view.file.path, manifest: structuredClone(s.manifest), body: await Promise.all(s.manifest.pages.map(p => s.read(p.id))) };
});
const activate = () => app(async app => { const leaf = app.workspace.getLeavesOfType('drawing-local-view').find(l => l.view.file?.path === window.mixedPath); await app.workspace.revealLeaf(leaf); app.workspace.setActiveLeaf(leaf, { focus: true }); });
async function pick(text) { await page.locator('.prompt-input').fill(text); await page.locator('.suggestion-item').filter({ hasText: text }).first().click(); }
async function openPanel() { if (!(await panel().count())) await button('文字段落').click(); }
async function insert(text) {
  await openPanel(); await panel().getByRole('button', { name: '插入文字段落', exact: true }).click();
  await pick('混合来源.md'); await pick(text);
  await waitFor(async () => (await snapshot()).body[0].some(e => e.originalText === text), 'Paragraph not inserted');
  await activate();
}
const raw = e => ({ points: e.points, pressures: e.pressures, lastCommittedPoint: e.lastCommittedPoint, angle: e.angle });
async function exportItem(label, extension) {
  await page.keyboard.press('Escape'); await button('导出').click(); await drawing().getByRole('menuitem', { name: label === 'PDF' ? /^PDF(?:\s|$)/ : label }).click();
  let path;
  await waitFor(async () => { path = await app((app, _, extension) => app.vault.getFiles().filter(f => f.path.startsWith('Drawing Exports/') && f.extension === extension).at(-1)?.path, extension); return !!path; }, 'Export did not finish', 60000);
  return path;
}

try {
  const environment = await app(() => ({ userAgent: navigator.userAgent }));
  await app(async (_, plugin) => { await plugin.create('pages', { title: '混合笔记' }); window.mixedPath = '混合笔记.inknote'; });
  await drawing().waitFor(); await page.waitForTimeout(600);
  await insert(first); await insert(second);
  let current = await snapshot(), texts = current.body[0].filter(e => e.customData?.pageinkText);
  assert.equal(texts.length, 2); assert.ok(texts.every(e => e.locked && e.width <= 565));
  const originalSource = await readVaultFile('混合来源.md');
  for (const text of texts) assert.ok(originalSource.includes('^' + text.customData.pageinkText.blockId));
  assert.equal(await app(app => app.workspace.getLeavesOfType('markdown').filter(l => l.view.file?.path === '混合来源.md').length), 1);
  checks.push('Insert two native paragraphs, stable native block IDs, one reused adjacent Markdown editor, wrapped locked text projection');

  await button('在当前页后添加').click();
  await waitFor(async () => (await snapshot()).manifest.pages.length === 2, 'Second page not added');
  await button('上一页').click();

  // Keep the source editor available but give the notebook enough space for real mouse ink.
  await app(app => { app.workspace.getLeavesOfType('markdown').filter(l => l.view.file?.path === '混合来源.md').forEach(l => l.detach()); });
  await button('适合宽度').click(); await button('笔').click();
  const paper = await drawing().locator('.ink-paper').first().boundingBox();
  const scale = paper.width / current.manifest.pages[0].width;
  const y = paper.y + (texts[1].y + 14) * scale, x = paper.x + 640 * scale;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 40, y - 18, { steps: 12 }); await page.mouse.move(x + 65, y + 12, { steps: 12 }); await page.mouse.up();
  await waitFor(async () => (await snapshot()).body[0].some(e => e.type === 'freedraw'), 'No real stroke');
  const stroke = (await snapshot()).body[0].find(e => e.type === 'freedraw');
  await button('选择').click();
  await page.mouse.move(x - 20, y - 35); await page.mouse.down(); await page.mouse.move(x + 95, y + 45, { steps: 10 }); await page.mouse.up();
  await openPanel(); await panel().getByText('已选中 1 条笔迹', { exact: false }).waitFor();
  await panel().locator('li').filter({ hasText: second }).getByRole('button', { name: '绑定所选笔迹' }).click();
  await waitFor(async () => (await snapshot()).body[0].find(e => e.id === stroke.id)?.customData?.pageinkAnchor?.elementId === texts[1].id, 'Anchor not attached');
  current = await snapshot();
  assert.deepEqual(raw(current.body[0].find(e => e.id === stroke.id)), raw(stroke));
  checks.push('Real mouse stroke, selection and explicit paragraph binding preserve exact raw points, pressure and terminal point');

  await panel().locator('li').filter({ hasText: first }).getByRole('button', { name: '编辑原文' }).click();
  await page.locator('.workspace-leaf.mod-active .ink-native-tools').waitFor();
  // Source selection excludes the stable ID, so replacing the paragraph leaves the anchor intact.
  const expanded = '第一段：' + '在这里补充观察、推理和验证条件。'.repeat(65);
  await page.keyboard.insertText(expanded);
  await app(async app => { await app.workspace.activeLeaf.view.save(); });
  assert.ok((await readVaultFile('混合来源.md')).includes('^' + texts[0].customData.pageinkText.blockId));
  await page.keyboard.press('Control+z');
  assert.ok(await app(app => app.workspace.activeLeaf.view.editor.getValue().includes('第一段：观察与假设。')));
  await page.keyboard.press('Control+y'); await app(app => app.workspace.activeLeaf.view.save());
  assert.equal((await snapshot()).body[0].find(e => e.id === texts[0].id).originalText, first);
  await activate(); await openPanel(); await panel().getByRole('button', { name: '更新本页文字' }).click();
  await waitFor(async () => (await snapshot()).body[0].find(e => e.id === texts[0].id).originalText === expanded, 'Refresh failed');
  const refreshed = await snapshot(), secondNow = refreshed.body[0].find(e => e.id === texts[1].id), strokeNow = refreshed.body[0].find(e => e.id === stroke.id);
  const expandedElement = refreshed.body[0].find(e => e.id === texts[0].id);
  assert.ok(expandedElement.width <= 565 && expandedElement.text.includes('\n'));
  assert.ok(secondNow.y > texts[1].y + 100);
  assert.equal(strokeNow.y - stroke.y, secondNow.y - texts[1].y); assert.deepEqual(raw(strokeNow), raw(stroke));
  assert.ok(refreshed.manifest.pages[0].margins.bottom > 0);
  await page.keyboard.press('Escape'); await button('撤销').click();
  await waitFor(async () => (await snapshot()).body[0].find(e => e.id === texts[0].id).originalText === first, 'Refresh undo failed');
  assert.equal((await snapshot()).manifest.pages[0].margins.bottom, current.manifest.pages[0].margins.bottom);
  assert.ok((await readVaultFile('混合来源.md')).includes(expanded));
  await button('重做').click(); await waitFor(async () => (await snapshot()).body[0].find(e => e.id === texts[0].id).originalText === expanded, 'Refresh redo failed');
  checks.push('Native undo/redo; explicit one-step reflow moves paragraph and ink, grows page, drawing undo leaves Markdown source unchanged');

  await app(app => app.fileManager.renameFile(app.vault.getAbstractFileByPath('混合来源.md'), '混合来源改名.md'));
  await page.waitForTimeout(500); await openPanel(); await panel().getByRole('button', { name: '更新本页文字' }).click();
  await waitFor(async () => (await snapshot()).body[0].filter(e => e.customData?.pageinkText).every(e => e.customData.pageinkText.path === '混合来源改名.md'), 'Renamed source not resolved');
  await panel().locator('li').filter({ hasText: second }).getByRole('button', { name: '上移段落 2' }).click();
  await waitFor(async () => (await snapshot()).body[0].find(e => e.id === texts[1].id).y < 100, 'Reorder failed');
  assert.deepEqual(raw((await snapshot()).body[0].find(e => e.id === stroke.id)), raw(stroke));
  await page.keyboard.press('Escape'); await button('撤销').click();
  await openPanel(); await panel().locator('li').filter({ hasText: second }).getByRole('button', { name: '移除', exact: true }).click();
  await waitFor(async () => !(await snapshot()).body[0].some(e => e.id === texts[1].id), 'Remove failed');
  assert.ok(!(await snapshot()).body[0].find(e => e.id === stroke.id).customData.pageinkAnchor);
  await page.keyboard.press('Escape'); await button('撤销').click();
  await waitFor(async () => (await snapshot()).body[0].some(e => e.id === texts[1].id), 'Remove undo failed');
  checks.push('Rename resolves by unique block ID; reorder carries anchors; removal preserves/detaches ink and undo restores both');

  // Missing source: refresh must retain the complete page, while export uses preserved snapshots.
  await app(app => app.vault.delete(app.vault.getAbstractFileByPath('混合来源改名.md')));
  const beforeMissing = await snapshot();
  await openPanel(); await panel().getByRole('button', { name: '更新本页文字' }).click();
  await drawing().getByText('找不到文字原件。页面上的文字、批注和备份快照仍保留。', { exact: true }).waitFor();
  assert.deepEqual((await snapshot()).body, beforeMissing.body);
  await page.keyboard.press('Escape');
  await app(app => { for (const leaf of app.workspace.getLeavesOfType('empty')) leaf.detach(); });
  await resize(page, 820, 1000); await app(app => app.commands.executeCommandById('theme:toggle-light-dark'));
  await openPanel(); await panel().evaluate(el => Promise.all(el.getAnimations().map(a => a.finished))); await shot(page, 'mixed-narrow-dark');
  const dialogBox = await panel().boundingBox(), rootBox = await drawing().boundingBox();
  assert.ok(dialogBox.x >= rootBox.x && dialogBox.x + dialogBox.width <= rootBox.x + rootBox.width + 1);
  await page.keyboard.press('Escape'); await resize(page, 1400, 900); await app(app => app.commands.executeCommandById('theme:toggle-light-dark'));
  await button('适合宽度').click(); await shot(page, 'mixed-notebook');
  const pdfPath = await exportItem('PDF', 'pdf'), pdf = await PDFDocument.load(await readFile(join(vault, pdfPath)));
  assert.equal(pdf.getPageCount(), beforeMissing.manifest.pages.length);
  assert.ok(pdf.getPage(0).getHeight() > 1123 * .75);
  const packagePath = await exportItem('可编辑备份', 'inkpack');
  const backup = await snapshot();
  await app(app => app.commands.executeCommandById('pageink:new-drawing'));
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: /恢复备份/ }).click(); await (await chooser).setFiles(join(vault, packagePath));
  await waitFor(() => app(app => app.workspace.activeLeaf.view.file?.extension === 'inknote' && app.workspace.activeLeaf.view.file.path !== window.mixedPath), 'Restore failed', 60000);
  await app(app => { window.mixedPath = app.workspace.activeLeaf.view.file.path; });
  await drawing().waitFor(); await page.waitForTimeout(600);
  const restored = await snapshot(), restoredText = restored.body[0].find(e => e.id === texts[1].id), restoredRef = restoredText.customData.pageinkText;
  assert.deepEqual(raw(restored.body[0].find(e => e.id === stroke.id)), raw(stroke));
  assert.ok(restoredRef.path.endsWith('.md')); assert.notEqual(restoredRef.path, '混合来源改名.md');
  assert.notEqual(restoredRef.path, restored.manifest.assets[restoredRef.snapshotAsset].path);
  await openPanel(); await panel().locator('li').filter({ hasText: second }).getByRole('button', { name: '编辑原文' }).click();
  await page.locator('.workspace-leaf.mod-active .ink-native-tools').waitFor();
  await page.keyboard.insertText('恢复后继续编辑。'); await app(app => app.workspace.activeLeaf.view.save());
  const immutable = await readFile(join(vault, restored.manifest.assets[restoredRef.snapshotAsset].path), 'utf8');
  assert.ok(immutable.includes(second)); assert.ok(!immutable.includes('恢复后继续编辑。'));
  await activate(); await openPanel(); await panel().getByRole('button', { name: '更新本页文字' }).click();
  await waitFor(async () => (await snapshot()).body[0].find(e => e.id === texts[1].id).originalText === '恢复后继续编辑。', 'Restored source could not refresh');
  checks.push('Missing source fails atomically; narrow/dark controls; expanded-page PDF and complete backup restore editable Markdown separately from immutable snapshots');

  await page.keyboard.press('Escape');
  const saved = await snapshot();
  await app(async (app, plugin) => { const view = app.workspace.activeLeaf.view, path = view.file.path; await view.session.flush(); view.leaf.detach(); await plugin.openPath(path); });
  await drawing().waitFor(); await page.waitForTimeout(700);
  assert.deepEqual((await snapshot()).body, saved.body);
  checks.push('Save/close/reopen preserves restored paragraphs, references and exact raw handwriting');

  await app(async (app, plugin) => { await app.vault.create('画布文字.md', '文字与画布共享同一个来源。\n'); await plugin.create('canvas', { title: '混合画布' }); window.mixedPath = '混合画布.inknote'; });
  await drawing().waitFor(); await page.waitForTimeout(500);
  await openPanel(); await panel().getByRole('button', { name: '插入文字段落', exact: true }).click();
  await pick('画布文字.md'); await pick('文字与画布共享同一个来源。');
  await waitFor(async () => (await snapshot()).body[0].some(e => e.customData?.pageinkText), 'Canvas text not inserted');
  await activate(); await page.keyboard.press('Escape'); await shot(page, 'mixed-canvas');
  const canvasState = await snapshot(); assert.equal(canvasState.manifest.mode, 'canvas'); assert.equal(canvasState.body[0][0].originalText, '文字与画布共享同一个来源。');
  await button('撤销').click(); await waitFor(async () => (await snapshot()).body[0].length === 0, 'Canvas insert undo failed');
  await button('重做').click(); await waitFor(async () => (await snapshot()).body[0].length === 1, 'Canvas insert redo failed');
  checks.push('The same paragraph insertion, native source editor and drawing undo/redo work on the infinite canvas');
  assert.deepEqual(errors, []);
  const sha256 = createHash('sha256').update(await readFile(new URL('../dist/main.js', import.meta.url))).digest('hex');
  const report = { date: new Date().toISOString(), environment, sha256, checks, errors };
  await writeFile(new URL('../artifacts/mixed-validation.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error); console.error({ checks, errors }); await shot(page, 'mixed-failure').catch(() => {}); process.exitCode = 1;
} finally { await close(); }

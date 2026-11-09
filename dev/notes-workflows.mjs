// Native text + PageInk integration. Uses only the generated vault and throwaway profile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { launch, resize, shot, readVaultFile } from './obsidian.mjs';

const { page, close } = await launch({ files: { '基础.md': '# 基础\n\n用于验证原生双向链接。\n' } });
const errors = [], checks = [];
const unchangedHistorySteps = { undo: 0, redo: 0 };
page.on('pageerror', e => errors.push(e.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 600)); });
const activeRoot = () => page.locator('.workspace-leaf.mod-active');
const nativeTools = () => activeRoot().locator('.ink-native-tools');
const app = (fn, arg) => page.evaluate(([source, argument]) => new Function('app', 'plugin', 'arg', `return (${source})(app, plugin, arg)`)(window.app, window.app.plugins.plugins.pageink, argument), [fn.toString(), arg]);
const command = id => app((app, _plugin, id) => app.commands.executeCommandById(`pageink:${id}`), id);
const text = () => app(app => app.workspace.activeLeaf.view.editor.getValue());
const waitFor = async (predicate, label, timeout = 20000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await predicate()) return; await page.waitForTimeout(100); }
  throw Error(label);
};
// Native history may include entries that leave the document unchanged. Assert that
// the first document change is the complete insertion/removal, never a partial edit.
async function documentHistory(key, before, expected, kind) {
  for (let step = 0; step < 4; step++) {
    await page.keyboard.press(key);
    const current = await text();
    if (current !== before) { assert.equal(current, expected); unchangedHistorySteps[kind] = step; return; }
  }
  throw Error('Native history did not change the document');
}
async function pick(name) {
  await page.locator('.prompt-input').fill(name);
  await page.locator('.suggestion-item').filter({ hasText: name }).first().click();
}
async function endOfText() {
  await app(app => { const editor = app.workspace.activeLeaf.view.editor; editor.setCursor(editor.offsetToPos(editor.getValue().length)); editor.focus(); });
}
async function library() { await command('open-library'); await activeRoot().locator('.ink-library').waitFor(); }
async function openFromLibrary(name) {
  await library();
  await activeRoot().getByRole('searchbox', { name: '搜索笔记', exact: true }).fill(name);
  await activeRoot().locator('.ink-library-note').filter({ hasText: name }).first().click();
}

try {
  const environment = await app(() => ({ userAgent: navigator.userAgent }));
  await app(app => app.vault.setConfig('alwaysUpdateLinks', true));
  await library();
  await waitFor(() => activeRoot().locator('.ink-library-note').count().then(n => n >= 3), 'Library did not load files');
  await activeRoot().getByRole('button', { name: '新建与导入', exact: true }).click();
  await page.locator('.ink-create-options summary').click();
  await page.locator('.ink-create-name').fill('课堂记录');
  await shot(page, 'notes-create');
  await page.locator('.ink-create-modal').getByRole('button', { name: '新建文笺', exact: true }).click();
  await nativeTools().waitFor();
  assert.equal(await app(app => app.workspace.activeLeaf.getViewState().type), 'markdown');
  const editor = activeRoot().locator('.cm-content[contenteditable=true]');
  await editor.click();
  const initial = '# 课堂记录\n\n中文内容与 English 都保存在原生 Markdown 中。\n\n';
  await page.keyboard.insertText(initial);
  assert.equal(await text(), initial);
  await page.waitForTimeout(800);
  await page.keyboard.type('history-check', { delay: 45 });
  assert.ok((await text()).endsWith('history-check'));
  await page.keyboard.press('Control+z'); assert.equal(await text(), initial);
  await page.keyboard.press('Control+y'); assert.ok((await text()).endsWith('history-check'));
  await page.keyboard.press('Control+z');
  await app(app => app.workspace.activeLeaf.view.save());
  assert.equal(await readVaultFile('课堂记录.md'), initial);
  checks.push('Create Markdown from PageInk, real native view, Chinese/English input, native undo/redo and exact disk save');

  await endOfText();
  await nativeTools().getByRole('button', { name: '插入笔记链接' }).click(); await pick('基础.md');
  await waitFor(async () => (await text()).includes('[[基础]]'), 'Native link not inserted');
  await waitFor(() => app(app => !!app.metadataCache.resolvedLinks['课堂记录.md']?.['基础.md']), 'Native metadata did not index link');
  await app(app => app.fileManager.renameFile(app.vault.getAbstractFileByPath('基础.md'), '概念基础.md'));
  await waitFor(async () => (await text()).includes('[[概念基础]]'), 'Native rename did not update text');
  checks.push('Native Markdown link insertion, metadata/backlink index, rename updates open editor');

  await app((_app, plugin) => plugin.create('canvas', { title: '推导画布' }));
  const drawing = activeRoot().locator('.ink-workspace'); await drawing.waitFor();
  const box = await drawing.locator('.ink-canvas-area').boundingBox();
  await page.mouse.move(box.x + 240, box.y + 220); await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 180, { steps: 12 });
  await page.mouse.move(box.x + 400, box.y + 230, { steps: 12 }); await page.mouse.up();
  await drawing.getByRole('button', { name: '保存当前视野', exact: true }).click();
  await drawing.getByRole('textbox', { name: '书签名称' }).fill('推导过程');
  await drawing.getByRole('textbox', { name: '书签名称' }).press('Enter');
  const originalInk = await app(async app => { const s = app.workspace.activeLeaf.view.session; await s.flush(); return { manifest: structuredClone(s.manifest), ink: await s.read(s.manifest.pages[0].id) }; });
  assert.ok(originalInk.ink.some(e => e.type === 'freedraw' && e.points.length > 10));
  await drawing.getByRole('button', { name: '笔记库', exact: true }).click();
  await activeRoot().getByRole('button', { name: '长卷', exact: true }).click();
  await waitFor(() => activeRoot().locator('.ink-library-note').count().then(n => n === 1), 'Canvas catalogue filter failed');
  await activeRoot().getByRole('button', { name: '全部', exact: true }).click();
  await openFromLibrary('课堂记录'); await nativeTools().waitFor(); await endOfText();
  const beforeReference = await text();
  await nativeTools().getByRole('button', { name: '插入手写区域' }).click(); await pick('推导画布.inknote'); await pick('推导过程');
  await waitFor(async () => (await text()).includes('```drawing-region'), 'Region reference not inserted');
  const withReference = await text();
  const reference = JSON.parse(withReference.match(/```drawing-region\n([^\n]+)\n```/)[1]);
  assert.equal(reference.document, originalInk.manifest.id);
  assert.equal(reference.region, originalInk.manifest.regions[0].id);
  assert.ok(withReference.includes('[[推导画布.inknote]]'));
  // The picker saves asynchronously; wait for that publication before exercising native history.
  await waitFor(() => readVaultFile('课堂记录.md').then(value => value === withReference), 'Inserted reference was not saved');
  await page.locator('.modal-container').waitFor({ state: 'detached' });
  await documentHistory('Control+z', withReference, beforeReference, 'undo');
  await documentHistory('Control+y', beforeReference, withReference, 'redo');
  await nativeTools().getByRole('button', { name: '阅读模式', exact: true }).click();
  await activeRoot().locator('.ink-embed canvas:visible').waitFor();
  await shot(page, 'notes-reading-reference');
  await activeRoot().getByRole('button', { name: '推导过程 · 推导画布', exact: true }).click();
  await drawing.waitFor();
  assert.deepEqual(await app(app => { const s = app.workspace.activeLeaf.view.session; return s.read(s.manifest.pages[0].id); }), originalInk.ink);
  checks.push('Create real strokes, shared library filters, region embed is one native document change (unchanged native history entries are counted separately), live preview and jump preserve exact source data');

  await app(app => app.fileManager.renameFile(app.vault.getAbstractFileByPath('推导画布.inknote'), '推导画布改名.inknote'));
  await openFromLibrary('课堂记录'); await nativeTools().waitFor();
  await activeRoot().locator('.ink-embed canvas:visible').waitFor();
  await waitFor(() => readVaultFile('课堂记录.md').then(t => t.includes('[[推导画布改名.inknote]]')), 'Drawing rename did not update native link');
  assert.ok((await readVaultFile('课堂记录.md')).includes('"file":"推导画布.inknote"'));
  // Old code-block path deliberately stays unchanged; stable document ID resolves the new location.
  await app(async app => { await app.workspace.activeLeaf.view.save(); app.workspace.activeLeaf.detach(); });
  await openFromLibrary('课堂记录'); await nativeTools().waitFor();
  if (await nativeTools().getByRole('button', { name: '阅读模式', exact: true }).count()) await nativeTools().getByRole('button', { name: '阅读模式', exact: true }).click();
  await activeRoot().locator('.ink-embed canvas:visible').waitFor();
  checks.push('Renamed drawing native link updates; stable region ID resolves old path after closing and reopening Markdown');

  await nativeTools().getByRole('button', { name: '继续编辑', exact: true }).click();
  await endOfText();
  await nativeTools().getByRole('button', { name: '插入笔记链接' }).click();
  const changed = await app(app => { const e = app.workspace.activeLeaf.view.editor; e.replaceRange('插入窗口打开后的新内容', e.offsetToPos(e.getValue().length)); return e.getValue(); });
  await pick('概念基础.md');
  await page.getByText('笔记或正文已变化，请回到需要插入的位置再试一次。', { exact: true }).waitFor();
  assert.equal(await text(), changed);
  checks.push('Async insertion refuses stale text and preserves intervening edits');

  await library();
  await activeRoot().getByRole('searchbox', { name: '搜索笔记', exact: true }).fill('');
  await shot(page, 'notes-library');
  await resize(page, 820, 1000);
  await page.evaluate(() => window.app.commands.executeCommandById('theme:toggle-light-dark'));
  await shot(page, 'notes-library-narrow-dark');
  await openFromLibrary('课堂记录'); await nativeTools().waitFor();
  for (const el of await nativeTools().getByRole('button').all()) {
    const bounds = await el.boundingBox(), container = await nativeTools().boundingBox();
    assert.ok(bounds.x >= container.x && bounds.x + bounds.width <= container.x + container.width + 1, 'Native controls overflow narrow view');
  }
  // Exercise keyboard access; actual Chinese IME and Pencil remain device checks.
  await nativeTools().getByRole('button', { name: '笔记库', exact: true }).focus();
  await page.keyboard.press('Enter'); await activeRoot().locator('.ink-library').waitFor();
  await openFromLibrary('课堂记录'); await nativeTools().waitFor();
  await shot(page, 'notes-native-narrow-dark');
  checks.push('Narrow/dark library and native controls, keyboard activation and return to same file');

  await app(app => app.workspace.activeLeaf.view.save());
  const beforeDisable = await readVaultFile('课堂记录.md');
  await app(app => app.plugins.disablePlugin('pageink'));
  await waitFor(() => page.locator('.ink-native-tools').count().then(n => n === 0), 'Native toolbar not removed on unload');
  assert.equal(await text(), beforeDisable);
  await endOfText(); await page.keyboard.insertText('\n插件关闭后继续编辑。');
  await app(app => app.workspace.activeLeaf.view.save());
  assert.equal(await readVaultFile('课堂记录.md'), beforeDisable + '\n插件关闭后继续编辑。');
  await app(app => app.plugins.enablePlugin('pageink'));
  await nativeTools().waitFor(); assert.equal(await nativeTools().count(), 1);
  checks.push('Disable removes all added native controls; Markdown continues editing/saving; re-enable attaches once');

  assert.deepEqual(errors, []);
  const sha256 = createHash('sha256').update(await readFile(new URL('../dist/main.js', import.meta.url))).digest('hex');
  const report = { date: new Date().toISOString(), environment, sha256, checks, unchangedHistorySteps, errors };
  await writeFile(new URL('../artifacts/notes-validation.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error); console.error({ checks, errors });
  await shot(page, 'notes-failure').catch(() => {}); process.exitCode = 1;
} finally { await close(); }

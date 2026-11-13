// Stage 4: real Obsidian library search, navigation, daily entry and properties.
// Uses only the generated vault and isolated host; run host suites serially.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { launch, resize, shot, readVaultFile } from './obsidian.mjs';

const initial = '---\nstatus: draft\ntags:\n  - physics\nuntouched:\n  nested: keep\n---\n\n# 课程资料\n\n正文唯一词：洛伦兹力。\n';
const { page, close } = await launch({ files: { '课程.md': initial, '不完整.inknote': '{"broken":true}' } });
const errors = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 500)); });
const app = (fn, arg) => page.evaluate(([source, arg]) => new Function('app', 'plugin', 'arg', `return (${source})(app, plugin, arg)`)(window.app, window.app.plugins.plugins.pageink, arg), [fn.toString(), arg]);
const root = () => page.locator('.workspace-leaf.mod-active');
const library = () => root().locator('.ink-library');
const command = id => app((app, _, id) => app.commands.executeCommandById(`pageink:${id}`), id);
const waitFor = async (test, label, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return; await page.waitForTimeout(100); } throw Error(label); };
async function home() { await command('search-library'); await library().waitFor(); }
async function search(query) {
  await home(); await library().getByRole('searchbox', { name: '搜索笔记', exact: true }).fill(query);
  await library().getByRole('button', { name: '重新搜索', exact: true }).waitFor();
}
async function result(name) { return library().locator('.ink-library-note').filter({ has: page.locator('strong', { hasText: name }) }).first(); }

try {
  const environment = await app(() => ({ userAgent: navigator.userAgent }));
  await search('洛伦兹力');
  assert.equal(await library().locator('.ink-library-note').count(), 1);
  assert.ok((await (await result('课程')).textContent()).includes('正文唯一词'));
  await (await result('课程')).click();
  await waitFor(() => app(app => app.workspace.activeLeaf.view.editor?.getSelection().includes('洛伦兹力')), 'Search did not navigate to native text line');
  assert.equal(await readVaultFile('课程.md'), initial);
  await app(app => { const e = app.workspace.activeLeaf.view.editor; e.replaceRange('\n编辑中唯一词：电磁感应。\n', e.offsetToPos(e.getValue().length)); });
  await search('电磁感应'); assert.equal(await library().locator('.ink-library-note').count(), 1);
  await search('physics'); assert.equal(await library().locator('.ink-library-note').count(), 1);
  checks.push('Native Markdown body, current editor content and frontmatter search with exact line selection and unchanged source');

  await app(async (app, plugin) => { await plugin.create('canvas', { title: '整理画板' }); });
  await root().locator('.ink-canvas-area').waitFor(); await page.waitForTimeout(500);
  const area = await root().locator('.ink-canvas-area').boundingBox();
  await page.mouse.move(area.x + 160, area.y + 170); await page.mouse.down(); await page.mouse.move(area.x + 290, area.y + 260, { steps: 15 }); await page.mouse.up();
  const originalInk = await app(async app => {
    const s = app.workspace.activeLeaf.view.session; await s.flush(); const p = s.manifest.pages[0];
    s.editLayout(() => s.manifest.regions.push({ id: 'library-region', title: '手写书签唯一词', pageId: p.id, x: 0, y: 0, width: 500, height: 500 }));
    await s.flush(); return await s.read(p.id);
  });
  assert.ok(originalInk.some(e => e.type === 'freedraw'));
  await search('手写书签唯一词'); assert.equal(await library().locator('.ink-library-note').count(), 1);
  await (await result('整理画板')).click();
  await waitFor(() => app(app => app.workspace.activeLeaf.view.session?.navigation?.region === 'library-region'), 'Drawing bookmark destination missing');
  assert.deepEqual(await app(app => { const s = app.workspace.activeLeaf.view.session; return s.read(s.manifest.pages[0].id); }), originalInk);
  checks.push('Drawing bookmark search navigates to exact region without changing raw ink');

  // Project a source paragraph, then find it from the shared library.
  await root().getByRole('button', { name: '画布卡片', exact: true }).click();
  await root().getByRole('button', { name: '插入文字卡片', exact: true }).click();
  await page.locator('.prompt-input').fill('课程.md'); await page.locator('.suggestion-item').filter({ hasText: '课程.md' }).first().click();
  await page.locator('.prompt-input').fill('洛伦兹力'); await page.locator('.suggestion-item').filter({ hasText: '洛伦兹力' }).first().click();
  await waitFor(() => app(async app => { const s = app.workspace.getLeavesOfType('drawing-local-view')[0].view.session; return (await s.read(s.manifest.pages[0].id)).some(e => e.originalText?.includes('洛伦兹力')); }), 'Text card not ready');
  await search('洛伦兹力'); assert.equal(await library().locator('.ink-library-note').count(), 2);
  assert.ok((await (await result('整理画板')).textContent()).includes('画布文字'));
  await (await result('整理画板')).click();
  await waitFor(() => app(app => !!app.workspace.activeLeaf.view.session?.navigation?.rect), 'Text card navigation missing');
  checks.push('Global query finds both canonical Markdown and displayed board text with canvas coordinates');

  await search('例题 4.1');
  assert.equal(await library().locator('.ink-library-note').count(), 1);
  // The PDFKit fixture puts a footer overflow page after each chapter: chapter 4 is physical page 7.
  assert.ok((await (await result('教材')).textContent()).includes('第 7 页'));
  await (await result('教材')).click();
  await waitFor(() => root().locator('.pdfViewer .page[data-page-number="7"]').count().then(n => n > 0), 'PDF page not present');
  await waitFor(() => root().locator('.pdf-page-input').inputValue().then(n => n === '7').catch(() => false), 'PDF did not navigate to page 7');
  checks.push('Local PDF text layer search reaches the matching physical page in the native PDF viewer');

  await search('肯定不存在的词'); assert.equal(await library().locator('.ink-library-note').count(), 0);
  await library().locator('.ink-library-issues summary').click();
  assert.ok((await library().locator('.ink-library-issues').textContent()).includes('不完整.inknote'));
  await library().getByRole('searchbox', { name: '搜索笔记', exact: true }).fill('课程');
  await library().getByRole('searchbox', { name: '搜索笔记', exact: true }).fill('手写书签唯一词');
  await library().getByRole('button', { name: '重新搜索', exact: true }).waitFor();
  assert.equal(await library().locator('.ink-library-note').count(), 1);
  assert.ok((await library().locator('.ink-library-note').textContent()).includes('整理画板'));
  await library().getByRole('searchbox', { name: '搜索笔记', exact: true }).fill('暂停搜索示例');
  await library().getByRole('button', { name: '停止搜索', exact: true }).click();
  await library().getByText(/已停止，结果不完整/).waitFor();
  checks.push('Broken files are disclosed; superseded queries cannot publish stale results; explicit cancellation marks incomplete results');

  await app(async (_, plugin) => { await Promise.all([plugin.openDaily(), plugin.openDaily(), plugin.openDaily()]); });
  await root().locator('.markdown-source-view').waitFor();
  const dailyPath = await app(app => app.workspace.activeLeaf.view.file.path);
  assert.match(dailyPath, /^\d{4}-\d{2}-\d{2}\.md$/);
  await app(async app => { const view = app.workspace.activeLeaf.view; view.editor.replaceRange('今天继续研究。', view.editor.offsetToPos(view.editor.getValue().length)); await view.save(); });
  const dailyText = await readVaultFile(dailyPath);
  await home(); await command('daily-note');
  await root().locator('.markdown-source-view').waitFor();
  assert.equal(await readVaultFile(dailyPath), dailyText);
  assert.equal(await app((app, _, path) => app.vault.getFiles().filter(f => f.path === path).length, dailyPath), 1);
  await command('quick-open'); await page.locator('.prompt-input').fill('课程.md'); await page.locator('.suggestion-item').filter({ hasText: '课程.md' }).first().click();
  await root().locator('.markdown-source-view').waitFor(); assert.equal(await app(app => app.workspace.activeLeaf.view.file.path), '课程.md');
  checks.push('Concurrent daily entry creates exactly one local-date Markdown, reopens without overwriting, quick open reuses native file');

  const properties = () => page.locator('.pageink-properties-modal');
  const field = key => properties().getByRole('group', { name: key, exact: true });
  await command('note-properties'); await properties().waitFor();
  await field('status').getByLabel('文本值', { exact: true }).fill('reviewed');
  await app(async app => {
    const view = app.workspace.getLeavesOfType('markdown').find(l => l.view.file?.path === '课程.md').view;
    view.editor.replaceRange('\n属性窗口打开后追加的正文。\n', view.editor.offsetToPos(view.editor.getValue().length)); await view.save();
    await app.fileManager.processFrontMatter(view.file, fm => { fm.other = 'external-value'; });
  });
  const beforeProperties = (await readVaultFile('课程.md')).split('---').slice(2).join('---');
  await properties().getByRole('button', { name: '保存属性', exact: true }).click(); await properties().waitFor({ state: 'detached' });
  const afterProperties = await readVaultFile('课程.md');
  assert.ok(afterProperties.includes('status: reviewed')); assert.ok(afterProperties.includes('other: external-value'));
  assert.ok(afterProperties.includes('nested: keep')); assert.equal(afterProperties.split('---').slice(2).join('---'), beforeProperties);
  await waitFor(() => app(app => app.workspace.activeLeaf.view.editor.getValue().includes('status: reviewed')), 'Native view did not receive property update');
  checks.push('Property form saves through native frontmatter API, preserves complex fields, unrelated concurrent properties and exact latest body');

  await command('note-properties'); await properties().waitFor();
  await field('status').getByLabel('文本值', { exact: true }).fill('stale-draft');
  await app(async app => { await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath('课程.md'), fm => { fm.status = 'concurrent-status'; }); });
  await properties().getByRole('button', { name: '保存属性', exact: true }).click();
  await waitFor(() => properties().getByRole('alert').textContent().then(t => t.includes('保存失败')), 'Stale property write not rejected');
  assert.equal(await field('status').getByLabel('文本值', { exact: true }).inputValue(), 'stale-draft');
  await page.keyboard.press('Escape'); await properties().getByRole('button', { name: '继续编辑', exact: true }).waitFor();
  await properties().getByRole('button', { name: '放弃草稿并关闭', exact: true }).click(); await properties().waitFor({ state: 'detached' });
  assert.ok((await readVaultFile('课程.md')).includes('status: concurrent-status'));
  await app(async (_, plugin) => { const snapshot = await plugin.properties.read('课程.md'); await plugin.properties.save(snapshot, [
    { key: 'count', op: 'set', value: 7 }, { key: 'finished', op: 'set', value: true }, { key: 'tags', op: 'set', value: ['physics', 'magnetism'] },
  ]); });
  const values = await app(async (_, plugin) => (await plugin.properties.read('课程.md')).properties);
  assert.equal(values.count, 7); assert.equal(values.finished, true); assert.deepEqual(values.tags, ['physics', 'magnetism']);
  checks.push('Concurrent same-key changes reject stale property drafts; Escape retains draft until explicit discard; numeric/boolean/list values persist with types');

  await home(); await library().getByRole('searchbox', { name: '搜索笔记', exact: true }).fill('');
  await app((_, plugin) => plugin.properties.open('整理画板.inknote')); await properties().waitFor();
  await properties().getByRole('button', { name: '添加属性', exact: true }).click();
  const newField = field('新属性'); await newField.getByLabel('属性名', { exact: true }).fill('topic'); await newField.getByLabel('文本值', { exact: true }).fill('电磁学');
  await properties().getByRole('button', { name: '保存属性', exact: true }).click(); await properties().waitFor({ state: 'detached' });
  const drawingProperties = JSON.parse(await readVaultFile('整理画板.inknote')).properties;
  assert.equal(drawingProperties.topic, '电磁学');
  await search('电磁学'); assert.equal(await library().locator('.ink-library-note').count(), 1); await (await result('整理画板')).click();
  assert.deepEqual(await app(app => { const s = app.workspace.activeLeaf.view.session; return s.read(s.manifest.pages[0].id).then(elements => elements.filter(e => e.type === 'freedraw')); }), originalInk.filter(e => e.type === 'freedraw'));
  checks.push('Library property entry saves drawing metadata, makes it searchable and preserves exact existing raw strokes');

  await home(); await library().getByRole('searchbox', { name: '搜索笔记', exact: true }).fill('');
  await shot(page, 'library-home');
  await resize(page, 820, 1000); await app(app => app.commands.executeCommandById('theme:toggle-light-dark'));
  await search('洛伦兹力'); await shot(page, 'library-search-narrow-dark');
  assert.ok(await library().evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  for (const button of await library().locator('.ink-library-actions button').all()) { const b = await button.boundingBox(), l = await library().boundingBox(); assert.ok(b.x >= l.x && b.x + b.width <= l.x + l.width + 1); }
  await app((_, plugin) => plugin.properties.open('课程.md')); await properties().waitFor();
  await shot(page, 'library-properties-narrow-dark');
  assert.ok(await properties().evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await properties().getByRole('button', { name: '关闭', exact: true }).click(); await properties().waitFor({ state: 'detached' });
  checks.push('Narrow dark library and property form show readable snippets and visible action buttons without horizontal overflow');
  assert.deepEqual(errors, []);
  const sha256 = createHash('sha256').update(await readFile(new URL('../dist/main.js', import.meta.url))).digest('hex');
  const report = { date: new Date().toISOString(), environment, sha256, checks, errors };
  await writeFile(new URL('../artifacts/library-validation.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error); console.error({ checks, errors }); await shot(page, 'library-failure').catch(() => {}); process.exitCode = 1; }
finally { await close(); }

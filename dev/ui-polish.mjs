// UI regression checks in the actual, isolated Obsidian host. No personal vault is used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { launch, shot, resize, readVaultFile } from './obsidian.mjs';

const original = '# 电磁学课堂笔记\n\n洛伦兹力与磁场。\n\n用右手判断运动电荷的受力方向。\n';
const { page, close } = await launch({ files: {
  '学习/电磁学课堂笔记.md': original,
  '阅读/设计心理学.md': '# 设计心理学\n\n让操作与结果建立清晰的联系。\n',
  '项目/把复杂的想法整理成容易理解的笔记与清晰的行动步骤.md': '# 整理思路\n\n从一个小问题开始。\n',
} });
const checks = [], errors = [];
page.on('pageerror', e => errors.push(e.message));
const app = (fn, arg) => page.evaluate(([source, arg]) => new Function('app', 'plugin', 'arg', `return (${source})(app, plugin, arg)`)(window.app, window.app.plugins.plugins.pageink, arg), [fn.toString(), arg]);
const root = () => page.locator('.workspace-leaf.mod-active');
const library = () => root().locator('.ink-library');
const command = id => app((app, _, id) => app.commands.executeCommandById(`pageink:${id}`), id);
const home = async () => { await app(async (_, plugin) => { await plugin.notes.openLibrary(); await new Promise(requestAnimationFrame); }); await library().waitFor(); };
const query = async text => { await library().getByRole('searchbox', { name: '搜索笔记', exact: true }).fill(text); if (text) await library().getByRole('button', { name: '重新搜索', exact: true }).waitFor(); };
const searchInput = () => library().getByRole('searchbox', { name: '搜索笔记', exact: true });
async function bounded(locator) {
  assert.ok(await locator.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Horizontal overflow');
}

try {
  const environment = await app(() => ({ userAgent: navigator.userAgent }));
  await home();
  const textCount = await app(app => app.vault.getMarkdownFiles().length);
  await library().getByRole('button', { name: '新建文笺', exact: true }).evaluate(el => { el.click(); el.click(); });
  await root().locator('.ink-native-tools').waitFor();
  assert.equal(await app(app => app.vault.getMarkdownFiles().length), textCount + 1);
  assert.equal(await page.locator('.ink-create-modal').count(), 0);
  checks.push('Direct text creation skips the modal; two immediate clicks create exactly one file');

  await home(); await library().getByRole('button', { name: '新建长卷', exact: true }).click();
  await root().locator('.ink-editor-canvas .ink-grid-layer').waitFor();
  assert.equal(await app(app => app.workspace.activeLeaf.view.session.manifest.mode), 'canvas');
  await shot(page, 'polish-canvas');
  await home(); await library().getByRole('button', { name: '新建手札', exact: true }).click();
  await root().locator('.ink-paper').waitFor();
  checks.push('Direct canvas and notebook creation reach their real editors with sensible defaults');

  const pen = root().getByRole('button', { name: '笔', exact: true });
  await pen.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '荧光笔');
  await page.keyboard.press('Enter');
  assert.equal(await root().getByRole('button', { name: '荧光笔', exact: true }).getAttribute('aria-pressed'), 'true');
  await pen.click(); await pen.focus(); await page.keyboard.press('Enter');
  const options = root().getByRole('dialog', { name: '笔设置' }); await options.waitFor();
  assert.equal(await options.evaluate(el => getComputedStyle(el).animationName), 'none');
  const colors = options.getByRole('radiogroup', { name: '笔颜色', exact: true });
  await colors.locator('button[aria-checked=true]').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await colors.locator('button[aria-checked=true]').count(), 1);
  assert.equal(await colors.locator('button[tabindex="0"]').count(), 1);
  await page.keyboard.press('Escape'); await options.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '笔');
  checks.push('Toolbar arrow navigation, radio selection, Escape focus return and instant keyboard popovers');

  const box = await root().locator('.ink-canvas-area').boundingBox();
  await page.mouse.move(box.x + 180, box.y + 160); await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 220, { steps: 14 }); await page.mouse.up();
  const saved = await app(async app => { const s = app.workspace.activeLeaf.view.session; await s.flush(); return { path: app.workspace.activeLeaf.view.file.path, elements: await s.read(s.manifest.pages[0].id) }; });
  assert.ok(saved.elements.some(e => e.type === 'freedraw'));
  await shot(page, 'polish-notebook');
  await app(async (app, plugin, path) => { await app.workspace.activeLeaf.detach(); await plugin.openPath(path); }, saved.path);
  await root().locator('.ink-paper').waitFor();
  assert.deepEqual(await app(app => { const s = app.workspace.activeLeaf.view.session; return s.read(s.manifest.pages[0].id); }), saved.elements);
  checks.push('Raw drawing elements survive saving, closing and reopening unchanged');

  await home(); await library().locator('.ink-library-note strong').filter({ hasText: '未命名手札' }).first().waitFor(); await shot(page, 'polish-library-desktop');
  await library().getByRole('button', { name: '新建与导入', exact: true }).click();
  const modal = page.locator('.ink-create-modal'); await modal.waitFor();
  assert.equal(await modal.locator('.ink-create-name').isVisible(), false);
  await shot(page, 'polish-create');
  await shot(modal, 'polish-create-detail');
  await modal.locator('.ink-create-options summary').click();
  await modal.locator('.ink-create-name').fill('点阵练习');
  await modal.getByRole('radio', { name: '点阵', exact: true }).click();
  await modal.getByRole('button', { name: '新建手札', exact: true }).click();
  await modal.waitFor({ state: 'detached' }); await root().locator('.ink-paper').waitFor();
  assert.equal(await app(app => app.workspace.activeLeaf.view.file.basename), '点阵练习');
  assert.equal(await app(app => app.workspace.activeLeaf.view.session.manifest.pages[0].template), 'dotted');
  checks.push('Optional naming and paper choices remain available and create the requested document');

  await home(); await library().getByRole('button', { name: '全部', exact: true }).focus(); await page.keyboard.press('Control+f');
  assert.ok(await searchInput().evaluate(el => el === document.activeElement));
  await query('洛伦兹力');
  assert.equal(await library().locator('.ink-library-note').count(), 1);
  await searchInput().focus(); await page.keyboard.press('ArrowDown');
  assert.ok(await page.evaluate(() => document.activeElement.matches('.ink-library-note')));
  await page.keyboard.press('ArrowUp'); assert.ok(await searchInput().evaluate(el => el === document.activeElement));
  await page.keyboard.press('Enter'); await root().locator('.ink-native-tools').waitFor();
  assert.equal(await readVaultFile('学习/电磁学课堂笔记.md'), original);
  checks.push('Content search, keyboard results and Enter open the native source without changing it');

  // Keep a real host navigation pending, return to the library, then release the
  // older navigation. Its delayed line focus must not pull us back to the editor.
  await app(async (app, plugin) => {
    const reveal = app.workspace.revealLeaf;
    let resume, reached;
    const paused = new Promise(resolve => { reached = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    app.workspace.revealLeaf = async function (leaf) {
      await reveal.call(this, leaf);
      if (leaf.view.file?.path === '学习/电磁学课堂笔记.md') { reached(); await gate; }
    };
    try {
      const opening = plugin.notes.open('学习/电磁学课堂笔记.md', { line: 2 });
      await paused;
      await plugin.notes.openLibrary();
      resume(); await opening;
      await new Promise(requestAnimationFrame);
    } finally { resume(); app.workspace.revealLeaf = reveal; }
  });
  await library().waitFor();
  assert.ok(await searchInput().evaluate(el => el === document.activeElement));
  checks.push('A late search-result navigation cannot steal focus after returning to the library');

  await home(); await query('');
  await library().getByRole('button', { name: '搜索选项', exact: true }).click();
  let searchOptions = library().getByRole('dialog', { name: '搜索选项', exact: true }); await searchOptions.waitFor();
  await searchOptions.getByRole('radio', { name: '名称与内容', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await searchOptions.getByRole('radio', { name: '仅名称', exact: true }).getAttribute('aria-checked'), 'true');
  await page.keyboard.press('Escape');
  await searchOptions.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '搜索选项');
  await searchInput().fill('洛伦兹力');
  assert.equal(await library().locator('.ink-library-note').count(), 0);
  await library().getByRole('button', { name: '查看全部笔记', exact: true }).click();
  assert.equal(await searchInput().inputValue(), '');
  await library().getByRole('button', { name: '搜索选项', exact: true }).click();
  await searchOptions.getByRole('radio', { name: '名称与内容', exact: true }).click(); await page.keyboard.press('Escape');
  checks.push('Search scope is progressively disclosed; keyboard switching and empty-state reset work');

  await app((app, plugin) => { const search = plugin.notes.search; window.polishSearchCalls = []; plugin.notes.search = (...args) => { window.polishSearchCalls.push(args[1]); return search(...args); }; });
  await searchInput().dispatchEvent('compositionstart'); await searchInput().fill('luo'); await page.waitForTimeout(350);
  assert.deepEqual(await page.evaluate(() => window.polishSearchCalls), []);
  await searchInput().fill('洛伦兹力'); await searchInput().dispatchEvent('compositionend');
  await library().getByRole('button', { name: '重新搜索', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.polishSearchCalls), ['洛伦兹力']);
  await query('不存在的关键词'); await query('设计心理学');
  assert.equal(await library().locator('.ink-library-note').count(), 1);
  assert.ok((await library().locator('.ink-library-note').textContent()).includes('设计心理学'));
  await searchInput().fill('停止搜索用例'); await library().getByRole('button', { name: '停止搜索', exact: true }).click();
  await library().getByText(/已停止，结果不完整/).waitFor();
  checks.push('Synthetic IME composition waits for committed text; latest query and explicit cancellation remain correct');

  await query('');
  await app((app, plugin) => { const daily = plugin.notes.daily; plugin.notes.daily = async () => { plugin.notes.daily = daily; throw Error('测试：暂时无法打开今日记录'); }; });
  await library().getByRole('button', { name: '今日记录', exact: true }).click();
  await library().getByRole('button', { name: '再试一次', exact: true }).click();
  await root().locator('.ink-native-tools').waitFor();
  assert.ok((await app(app => app.workspace.activeLeaf.view.file.path)).startsWith('PageInk Daily/'));
  checks.push('An action failure retries that action instead of rereading the library');

  await home(); await resize(page, 820, 1000); await app(app => { app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse(); app.commands.executeCommandById('theme:toggle-light-dark'); });
  await page.waitForFunction(() => document.body.classList.contains('theme-dark'));
  await page.locator('.workspace-split.mod-left-split').waitFor({ state: 'hidden' });
  await bounded(library()); await shot(page, 'polish-library-dark');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await bounded(library());
  await bounded(library().locator('.ink-library-filters'));
  for (const button of await library().locator('.ink-library-starter').all()) {
    assert.ok(await button.isVisible());
    assert.ok(await button.locator('.ink-library-starter-short').isVisible(), 'The concrete document type remains visible on narrow screens');
    await bounded(button);
  }
  assert.ok(await library().locator('.ink-library-note-kind').first().isVisible());
  assert.ok(await library().locator('time').first().isVisible());
  await shot(page, 'polish-library-mobile-dark');
  await library().getByRole('button', { name: '搜索选项', exact: true }).click(); await searchOptions.waitFor();
  const bounds = await searchOptions.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391);
  await page.keyboard.press('Escape');
  await app(app => app.commands.executeCommandById('theme:toggle-light-dark'));
  await page.waitForFunction(() => document.body.classList.contains('theme-light'));
  await shot(page, 'polish-library-mobile');
  await library().getByRole('button', { name: '新建与导入', exact: true }).click(); await modal.waitFor(); await bounded(modal); await shot(page, 'polish-create-mobile');
  await page.keyboard.press('Escape');
  checks.push('Actual narrow desktop window plus simulated 390px touch viewport: light/dark, reduced motion, metadata and bounded popovers');
  assert.deepEqual(errors, []);
  const sha256 = createHash('sha256').update(await readFile(new URL('../dist/main.js', import.meta.url))).digest('hex');
  const report = { date: new Date().toISOString(), environment, sha256, checks, errors };
  await writeFile(new URL('../artifacts/ui-polish-validation.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error); console.error({ checks, errors }); await shot(page, 'polish-failure').catch(() => {}); process.exitCode = 1; }
finally { await close(); }

// Floating navigation checks in a real Obsidian host with an isolated vault.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { launch, resize, shot } from './obsidian.mjs';

const { page, close } = await launch();
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const root = page.locator('.workspace-leaf.mod-active .ink-workspace');
const sidebar = root.locator('.ink-sidebar');
const canvas = root.locator('.ink-canvas-area');
const open = async () => {
  if (!await sidebar.count()) await root.getByRole('button', { name: '显示侧栏', exact: true }).click();
  await sidebar.waitFor();
};
const selectTab = name => sidebar.getByRole('tab', { name, exact: true }).click();
const ready = async () => {
  await root.waitFor();
  await page.waitForFunction(() => window.app.workspace.activeLeaf.view.session?.flushers.has('body'));
  await canvas.locator('.ink-canvas-status').waitFor({ state: 'hidden' });
};
const bounded = async () => {
  const result = await sidebar.evaluate(el => {
    const panel = el.getBoundingClientRect(), body = el.closest('.ink-body').getBoundingClientRect();
    const heading = el.querySelector('.ink-sidebar-heading').getBoundingClientRect();
    const footer = el.querySelector('.ink-sidebar-footer')?.getBoundingClientRect();
    return {
      top: panel.top - body.top, bottom: body.bottom - panel.bottom,
      horizontal: panel.left >= body.left && panel.right <= body.right && el.scrollWidth <= el.clientWidth,
      headingVisible: heading.top >= panel.top && heading.bottom < panel.bottom,
      footerVisible: !footer || footer.top >= heading.bottom && footer.bottom <= panel.bottom,
    };
  });
  assert.ok(result.top >= 7 && result.bottom >= 63, JSON.stringify(result));
  assert.ok(result.horizontal && result.headingVisible && result.footerVisible, JSON.stringify(result));
};
try {
  await page.evaluate(async () => {
    window.app.workspace.leftSplit.collapse(); window.app.workspace.rightSplit.collapse();
    await window.app.plugins.plugins.pageink.notes.create('pages');
  });
  await ready(); await open(); await selectTab('页面'); await bounded();
  const onePage = await sidebar.boundingBox(), before = await canvas.boundingBox();
  await sidebar.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await sidebar.waitFor({ state: 'detached' });
  assert.deepEqual(await canvas.boundingBox(), before, 'Closing the sidebar must not resize or move the canvas');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '显示侧栏');
  await open();
  assert.deepEqual(await canvas.boundingBox(), before);
  checks.push('Single page panel follows content height; opening/closing preserves the canvas bounds and returns focus');

  for (let i = 2; i <= 12; i++) {
    await sidebar.getByRole('button', { name: '添加页面', exact: true }).click();
    await page.waitForFunction(count => document.querySelectorAll('.workspace-leaf.mod-active .ink-thumb').length === count, i);
  }
  await bounded();
  assert.ok((await sidebar.boundingBox()).height > onePage.height);
  assert.ok(await sidebar.locator('.ink-page-list').evaluate(el => el.scrollHeight > el.clientHeight));
  const footer = await sidebar.locator('.ink-sidebar-footer').boundingBox();
  await sidebar.getByRole('button', { name: '第 1 页', exact: true }).click();
  await sidebar.getByRole('button', { name: '第 12 页', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.ink-thumb:last-child').getAttribute('aria-current') === 'page');
  assert.deepEqual(await sidebar.locator('.ink-sidebar-footer').boundingBox(), footer);
  await sidebar.getByRole('button', { name: '第 12 页操作', exact: true }).click();
  await root.getByRole('menuitem', { name: '在后面添加页面', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  checks.push('Twelve pages scroll independently; keyboard navigation reveals the selected page and the footer stays visible; page menu works');

  await selectTab('书签'); await bounded();
  assert.ok(await sidebar.locator('.ink-empty').isVisible());
  await sidebar.getByRole('tab', { name: '书签', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await sidebar.getByRole('searchbox', { name: '搜索', exact: true }).waitFor();
  await sidebar.getByRole('searchbox', { name: '搜索', exact: true }).fill('missing-term');
  await sidebar.getByRole('status').filter({ hasText: '没有找到' }).waitFor();
  await page.keyboard.press('Escape');
  await sidebar.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '显示侧栏');
  checks.push('Bookmarks empty state, keyboard tabs, search empty results and Escape focus return work');

  await page.evaluate(async () => {
    const app = window.app;
    await app.plugins.plugins.pageink.importPdf('侧栏预览', undefined, app.vault.getAbstractFileByPath('教材.pdf'));
  });
  await ready(); await open(); await selectTab('页面');
  await sidebar.locator('.ink-thumb-canvas').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.ink-thumb-canvas')?.height > 150);
  await root.getByRole('button', { name: '阅读模式', exact: true }).click();
  await bounded(); await shot(page, 'sidebar-floating-light');
  await selectTab('搜索');
  await sidebar.getByRole('searchbox', { name: '搜索', exact: true }).fill('函数');
  await sidebar.locator('.ink-search-hit').first().waitFor();
  await sidebar.locator('.ink-search-hit').first().click(); await bounded();
  await selectTab('页面');
  await page.evaluate(() => window.app.commands.executeCommandById('theme:toggle-light-dark'));
  await page.waitForFunction(() => document.body.classList.contains('theme-dark'));
  await shot(page, 'sidebar-floating-dark');
  checks.push('Real PDF thumbnails and search results render; reading mode and dark theme preserve floating panel bounds');

  await resize(page, 720, 640); await bounded();
  const narrow = await canvas.boundingBox();
  await sidebar.getByRole('button', { name: '第 2 页', exact: true }).click();
  await sidebar.waitFor({ state: 'detached' });
  assert.deepEqual(await canvas.boundingBox(), narrow);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '显示侧栏');
  await open();
  const backdrop = await root.getByRole('button', { name: '关闭侧栏', exact: true }).boundingBox();
  await page.mouse.click(backdrop.x + backdrop.width - 10, backdrop.y + 20);
  await sidebar.waitFor({ state: 'detached' });
  checks.push('Real narrow host window: page selection and backdrop close the panel without canvas shifts or lost focus');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(); await bounded();
  const targets = await sidebar.locator('.ink-tabs button, .ink-thumb-add, .ink-thumb-more, .ink-sidebar-heading > button').evaluateAll(items => items.map(el => ({ w: el.offsetWidth, h: el.offsetHeight })));
  assert.ok(targets.every(size => size.w >= 44 && size.h >= 44), JSON.stringify(targets));
  assert.ok(await sidebar.evaluate(el => getComputedStyle(el).animationName === 'none'));
  await shot(page, 'sidebar-floating-simulated-touch');
  await sidebar.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await sidebar.waitFor({ state: 'detached' });
  for (let i = 0; i < 3; i++) { await open(); await sidebar.getByRole('button', { name: '收起侧栏', exact: true }).click(); await sidebar.waitFor({ state: 'detached' }); }
  checks.push('390px simulated touch: 44px controls, bounded scroll panel, reduced motion and repeated open/close');
  assert.deepEqual(errors, []);
  const report = { date: new Date().toISOString(), host: await page.title(), checks, errors };
  await writeFile(new URL('../artifacts/sidebar-validation.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error); console.error({ checks, errors });
  await shot(page, 'sidebar-failure').catch(() => {}); process.exitCode = 1;
} finally { await close(); }

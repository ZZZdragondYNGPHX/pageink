// Real Obsidian host; Pencil pointer and Safari gesture events are simulated, not device evidence.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { launch, resize, shot } from './obsidian.mjs';

const { page, close } = await launch();
const checks = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
const root = () => page.locator('.workspace-leaf.mod-active .ink-workspace');
const button = name => root().getByRole('button', { name, exact: true });
const app = (fn, arg) => page.evaluate(([source, arg]) => new Function('app', 'plugin', 'arg', `return (${source})(app, plugin, arg)`)(window.app, window.app.plugins.plugins.pageink, arg), [fn.toString(), arg]);
const ready = async () => {
  await page.waitForFunction(() => window.app.workspace.activeLeaf.view.session?.flushers.has('body'));
  await root().locator('.ink-canvas-area .ink-canvas-status').waitFor({ state: 'hidden' });
};
const cdp = await page.context().newCDPSession(page);
const pen = async (locator, dx = 0, dy = 0) => {
  const box = await locator.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' });
  if (dx || dy) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx, y: y + dy, button: 'left', buttons: 1, pointerType: 'pen' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
};
const zoom = owner => root().locator(owner === 'body' ? '.ink-canvas-area .ink-zoom-value' : '.ink-scratch .ink-zoom-value');
const zoomValue = async owner => Number((await zoom(owner).innerText()).replace('%', ''));
const zoomTo = async (owner, action) => {
  await zoom(owner).click();
  await root().getByRole('dialog', { name: owner === 'body' ? '缩放' : '草稿纸缩放', exact: true }).getByRole('menuitem', { name: action, exact: true }).click();
};
const gesture = async (owner, scale) => {
  await root().locator(owner === 'body' ? '.ink-editor-pages canvas.interactive' : '.ink-editor-scratch canvas.interactive').evaluate((canvas, scale) => {
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'scale', { value: type === 'gesturechange' ? scale : 1 });
      canvas.dispatchEvent(event);
    }
  }, scale);
};
const content = () => app(async app => {
  const s = app.workspace.activeLeaf.view.session;
  for (const flush of s.flushers.values()) await flush();
  return structuredClone({ body: await s.read(s.manifest.pages[0].id), scratch: await s.read('scratch') });
});
const stroke = async owner => {
  const box = await root().locator(owner === 'body' ? '.ink-canvas-area' : '.ink-scratch-body').boundingBox();
  await page.mouse.move(box.x + 100, box.y + 140); await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 165, { steps: 12 }); await page.mouse.up();
};
const fullHeight = async () => {
  const workspace = await root().boundingBox(), body = await root().locator('.ink-body').boundingBox();
  assert.ok(Math.abs(body.y - workspace.y) < 1);
  assert.ok(Math.abs(body.height - workspace.height) < 1);
  const topbar = await root().locator('.ink-topbar').boundingBox(), dock = await root().locator('.ink-writing-bar').boundingBox();
  if (!(await root().locator('.ink-writing-bar').evaluate(el => el.classList.contains('is-floating-dock')))) assert.ok(dock.y >= topbar.y + topbar.height);
  assert.ok(await root().evaluate(el => el.scrollWidth <= el.clientWidth + 1));
};
try {
  await app(async (app, plugin) => { app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse(); await plugin.create('pages'); });
  await ready(); await fullHeight();
  await root().locator('.ink-dock-grip').evaluate(el => { window.gripClicks = 0; el.addEventListener('click', () => window.gripClicks++); });
  await pen(button('收起笔盒'));
  await button('展开笔盒').waitFor();
  assert.equal(await page.evaluate(() => window.gripClicks), 1, 'Pencil tap must not activate twice');
  await pen(button('展开笔盒')); await button('收起笔盒').waitFor();
  await button('收起笔盒').focus(); await page.keyboard.press('Enter'); await button('展开笔盒').waitFor();
  await page.keyboard.press('Space'); await button('收起笔盒').waitFor();
  await pen(button('收起笔盒'), 80, 140);
  await button('收起笔盒').waitFor();
  assert.equal(await page.evaluate(() => window.gripClicks), 4, 'Dragging must not toggle the toolbox');
  await button('收起笔盒').focus(); await page.keyboard.press('Home');
  checks.push('Overlay toolbars preserve the full content height; simulated pen taps activate once, keyboard still works, and pen dragging does not collapse');

  await stroke('body');
  await button('草稿纸').click();
  await page.waitForFunction(() => window.app.workspace.activeLeaf.view.session?.flushers.has('scratch'));
  await root().locator('.ink-editor-scratch .ink-canvas-status').waitFor({ state: 'hidden' });
  await stroke('scratch');
  const original = await content(); assert.equal(original.body.length, 1); assert.equal(original.scratch.length, 1);
  await pen(button('撤销草稿纸')); assert.equal((await content()).scratch.length, 0);
  await pen(button('重做草稿纸')); assert.deepEqual(await content(), original);
  await pen(button('清空草稿纸（可撤销）')); assert.equal((await content()).scratch.length, 0);
  await pen(button('撤销草稿纸')); assert.deepEqual(await content(), original);
  await pen(button('浮动草稿纸')); await button('停靠草稿纸').waitFor();
  // A pen press that moves or is cancelled must not turn into a destructive click.
  await pen(button('清空草稿纸（可撤销）'), 8, 0);
  assert.deepEqual(await content(), original);
  const clear = button('清空草稿纸（可撤销）'), clearBox = await clear.boundingBox();
  await clear.evaluate(el => el.addEventListener('pointerdown', event => { window.cancelledPen = event.pointerId; }, { once: true }));
  const cx = clearBox.x + clearBox.width / 2, cy = clearBox.y + clearBox.height / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' });
  await clear.dispatchEvent('pointercancel', { pointerId: await page.evaluate(() => window.cancelledPen), pointerType: 'pen' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
  assert.deepEqual(await content(), original);
  await pen(button('草稿纸显示全部内容'));
  await pen(button('停靠草稿纸')); await button('浮动草稿纸').waitFor();
  await pen(button('收起草稿纸')); await root().locator('.ink-scratch').waitFor({ state: 'hidden' });
  await button('草稿纸').click();
  checks.push('Simulated pen activates scratch undo, redo, clear, dock, float, fit and close; moved/cancelled presses preserve exact body and scratch data');

  await zoomTo('body', '100%'); await zoomTo('scratch', '100%');
  await pen(zoom('scratch'));
  await root().getByRole('dialog', { name: '草稿纸缩放', exact: true }).getByRole('menuitem', { name: '放大', exact: true }).click();
  assert.equal(await zoomValue('scratch'), 125); assert.equal(await zoomValue('body'), 100);
  await zoomTo('body', '缩小');
  assert.equal(await zoomValue('body'), 80); assert.equal(await zoomValue('scratch'), 125);
  await gesture('scratch', 1.6);
  await page.waitForFunction(() => document.querySelector('.workspace-leaf.mod-active .ink-scratch .ink-zoom-value').textContent.trim() === '200%');
  assert.equal(await zoomValue('body'), 80);
  await gesture('body', 1.5);
  await page.waitForFunction(() => document.querySelector('.workspace-leaf.mod-active .ink-canvas-area .ink-zoom-value').textContent.trim() === '120%');
  assert.equal(await zoomValue('scratch'), 200);
  assert.deepEqual(await content(), original);
  checks.push('Separate zoom menus and simulated Safari pinch events only change their own canvas, preserving raw drawing data');

  await page.waitForTimeout(1000);
  const stored = await app(app => { const view = app.workspace.activeLeaf.view; return { path: view.file.path, body: view.loadView(), scratch: view.loadView('scratch') }; });
  assert.equal(stored.body.zoom, 1.2); assert.equal(stored.scratch.zoom, 2);
  await app(async app => { await app.workspace.activeLeaf.detach(); });
  await app(async (app, _, path) => { await app.workspace.getLeaf('tab').openFile(app.vault.getAbstractFileByPath(path)); }, stored.path);
  await ready(); await button('草稿纸').click();
  await page.waitForFunction(() => document.querySelector('.workspace-leaf.mod-active .ink-scratch .ink-zoom-value')?.textContent.trim() === '200%');
  assert.equal(await zoomValue('body'), 120); assert.deepEqual(await content(), original);
  checks.push('Close/reopen restores body and scratch zoom separately, using the existing body key and a separate scratch key');

  await resize(page, 820, 1000); await fullHeight(); await shot(page, 'input-overlay-narrow');
  await app(app => app.commands.executeCommandById('theme:toggle-light-dark'));
  await page.waitForFunction(() => document.body.classList.contains('theme-dark'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await fullHeight();
  await pen(button('浮动草稿纸'));
  await app((_, plugin) => plugin.prefs.update({ scratch: { width: 260, height: 260 } }));
  assert.ok(await root().locator('.ink-scratch-bar').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  for (const action of ['停靠草稿纸', '清空草稿纸（可撤销）', '收起草稿纸', '草稿纸显示全部内容']) {
    assert.ok(await button(action).evaluate(el => { const rect = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); }), `${action} must be reachable at minimum scratch width`);
  }
  await pen(button('停靠草稿纸'));
  const target = await button('收起笔盒').boundingBox();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x + target.width / 2, y: target.y + target.height / 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await button('展开笔盒').waitFor();
  await pen(button('展开笔盒')); await button('收起笔盒').waitFor();
  await pen(button('收起草稿纸')); await root().locator('.ink-scratch').waitFor({ state: 'hidden' });
  await shot(page, 'input-overlay-simulated-mobile');
  checks.push('820px real host window and 390px simulated touch viewport preserve bounded overlays, touch/pen buttons, dark theme and reduced motion');

  assert.deepEqual(errors, []);
  const report = { date: new Date().toISOString(), host: await page.title(), checks, errors };
  await writeFile(new URL('../artifacts/input-validation.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error); console.error({ checks, errors }); await shot(page, 'input-failure').catch(() => {}); process.exitCode = 1; }
finally { await close(); }

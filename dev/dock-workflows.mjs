// Toolbox interaction checks in an isolated, real Obsidian host.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { launch, resize, shot } from './obsidian.mjs';

const { page, close } = await launch();
const checks = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
const workspace = () => page.locator('.workspace-leaf.mod-active .ink-workspace');
const bar = () => workspace().locator('.ink-writing-bar');
const grip = () => bar().locator('.ink-dock-grip');
const state = () => bar().evaluate(el => ({ edge: el.dataset.edge, collapsed: el.classList.contains('is-collapsed'), floating: el.classList.contains('is-floating-dock') }));
const collapsed = async value => page.waitForFunction(value => document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').classList.contains('is-collapsed') === value, value);
const bounded = async () => {
  assert.ok(await workspace().evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Workspace controls must not overflow horizontally');
  const result = await bar().evaluate(el => {
    const b = el.getBoundingClientRect(), w = el.closest('.ink-workspace').getBoundingClientRect();
    return { within: b.left >= w.left - 1 && b.top >= w.top - 1 && b.right <= w.right + 1 && b.bottom <= w.bottom + 1, overflow: el.scrollWidth > el.clientWidth + 1 };
  });
  assert.ok(result.within, 'Toolbox must remain inside the workspace');
  assert.equal(result.overflow, false, 'Toolbox must not overflow horizontally');
};
const reset = async () => {
  await grip().focus(); await page.keyboard.press('Home');
  await page.waitForFunction(() => !document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').classList.contains('is-floating-dock'));
};
const moveTo = async (edge, resetFirst = true) => {
  if (resetFirst) await reset();
  const g = await grip().boundingBox(), w = await workspace().boundingBox();
  const x = edge === 'left' ? w.x + 20 : edge === 'right' ? w.x + w.width - 20 : w.x + w.width / 2;
  const y = edge === 'bottom' ? w.y + w.height - 20 : edge === 'top' ? w.y + 20 : w.y + 120;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await page.mouse.down();
  await page.mouse.move(x, y, { steps: 16 }); await page.mouse.up();
  await page.waitForFunction(edge => document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').dataset.edge === edge, edge);
  await bounded();
};
const leave = async () => { await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(5, 5); };
const compactButton = async () => {
  await collapsed(true); await bounded();
  await page.waitForFunction(() => {
    const el = document.querySelector('.workspace-leaf.mod-active .ink-writing-bar');
    return el.offsetWidth <= 56 && Math.abs(el.offsetWidth - el.offsetHeight) <= 1;
  }, null, { timeout: 2000 });
  const size = await bar().evaluate(el => ({ width: el.offsetWidth, height: el.offsetHeight }));
  assert.ok(Math.abs(size.width - size.height) <= 1 && size.width <= 56, `Minimized toolbox must be one square button: ${JSON.stringify(size)}`);
  assert.equal(await workspace().getByRole('button', { name: '笔', exact: true }).isVisible(), false);
  assert.equal(await workspace().locator('.ink-dock-content').isVisible(), false);
};
try {
  await page.evaluate(async () => { window.app.workspace.leftSplit.collapse(); window.app.workspace.rightSplit.collapse(); await window.app.plugins.plugins.pageink.notes.create('pages'); });
  await page.waitForFunction(() => window.app.workspace.activeLeaf.view.session?.flushers.has('body'));
  await workspace().locator('.ink-canvas-area > .ink-editor .ink-canvas-status').waitFor({ state: 'hidden' });
  await reset(); await bounded();
  const initial = await bar().boundingBox(), canvas = await workspace().locator('.ink-canvas-area').boundingBox();
  await page.keyboard.press('Enter'); await compactButton();
  const compact = await bar().boundingBox();
  assert.ok(Math.abs(compact.x - initial.x) < 1 && Math.abs(compact.y - initial.y) < 1, 'Top click must collapse at its own position');
  assert.deepEqual(await workspace().locator('.ink-canvas-area').boundingBox(), canvas, 'Collapse must not move or resize the drawing viewport');
  await page.keyboard.press('Space'); await collapsed(false); await bounded();
  const reopened = await bar().boundingBox(); assert.ok(Math.abs(reopened.x - initial.x) < 1 && Math.abs(reopened.y - initial.y) < 1);
  checks.push('Top grip collapses to one button and expands in place; repeated keyboard toggles preserve the drawing viewport');

  for (const edge of ['left', 'right', 'top', 'bottom']) {
    await moveTo(edge); await collapsed(false);
    const b = await bar().boundingBox(); assert.ok(['left', 'right'].includes(edge) ? b.height > b.width * 2 : b.width > b.height * 2, `${edge} must use the corresponding full-palette orientation`);
    await shot(page, `dock-full-${edge}`);
    await grip().click(); await compactButton(); await grip().click(); await collapsed(false); await bounded();
    assert.equal((await state()).edge, edge);
  }
  checks.push('Full palettes are vertical on left/right and horizontal on top/bottom; each edge collapses to a single button');

  await moveTo('left'); await moveTo('bottom', false);
  const bottom = await bar().boundingBox(); assert.ok(bottom.width > bottom.height * 2);
  await moveTo('right', false); const right = await bar().boundingBox(); assert.ok(right.height > right.width * 2);
  checks.push('Dragging an expanded palette between edges changes its orientation without requiring minimization');

  await reset(); const idlePosition = await bar().boundingBox(); const idleCanvas = await workspace().locator('.ink-canvas-area').boundingBox();
  await leave(); await page.waitForTimeout(4000); await collapsed(false);
  await page.waitForFunction(() => document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').classList.contains('is-collapsed'), null, { timeout: 6500 });
  await compactButton(); assert.deepEqual(await workspace().locator('.ink-canvas-area').boundingBox(), idleCanvas);
  const idleButton = await bar().boundingBox(); assert.ok(Math.abs(idleButton.x - idlePosition.x) < 1 && Math.abs(idleButton.y - idlePosition.y) < 1);
  await grip().click(); await collapsed(false);
  await workspace().getByRole('button', { name: '笔设置', exact: true }).click();
  await workspace().getByRole('dialog', { name: '笔设置', exact: true }).waitFor();
  await leave(); await page.waitForTimeout(8500); await collapsed(false);
  await page.keyboard.press('Escape'); await leave();
  await page.waitForFunction(() => document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').classList.contains('is-collapsed'), null, { timeout: 10000 });
  checks.push('Eight seconds of toolbox inactivity minimizes it in place; an open settings popup pauses minimization, then closing it resumes the timer');

  await grip().click(); await collapsed(false);
  await workspace().getByRole('button', { name: '荧光笔', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').classList.contains('is-collapsed'), null, { timeout: 10000 });
  await compactButton();
  checks.push('A stationary pointer and mouse focus after selecting a tool do not block idle minimization');

  await grip().click(); await collapsed(false); await grip().focus(); await page.keyboard.press('ArrowDown');
  assert.ok(await grip().evaluate(el => el === el.ownerDocument.activeElement));
  await page.waitForTimeout(8500); assert.equal((await state()).collapsed, false);
  checks.push('Keyboard focus prevents automatic minimization while operating the toolbox');

  await moveTo('right'); await grip().click(); await compactButton(); const readingPosition = await bar().boundingBox();
  await workspace().getByRole('button', { name: '阅读模式', exact: true }).click(); await bar().waitFor({ state: 'hidden' });
  await workspace().getByRole('button', { name: '继续书写', exact: true }).click(); await bar().waitFor({ state: 'visible' });
  assert.equal((await state()).edge, 'right'); await compactButton(); assert.ok(Math.abs((await bar().boundingBox()).x - readingPosition.x) < 1);
  checks.push('Reading/writing switches preserve dock position and minimization');

  await reset(); const g = await grip().boundingBox(), original = await bar().boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await page.mouse.down();
  await page.mouse.move(g.x + 120, g.y + 150, { steps: 12 }); await page.keyboard.press('Escape'); await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').classList.contains('is-floating-dock'));
  assert.ok(Math.abs((await bar().boundingBox()).x - original.x) < 1);
  const g2 = await grip().boundingBox();
  await grip().evaluate(el => el.addEventListener('pointerdown', e => { window.dockTestPointer = e.pointerId; }, { once: true }));
  await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2); await page.mouse.down(); await page.mouse.move(g2.x + 120, g2.y + 150, { steps: 12 });
  await grip().dispatchEvent('pointercancel', { pointerId: await page.evaluate(() => window.dockTestPointer), pointerType: 'mouse' }); await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').classList.contains('is-floating-dock'));
  await workspace().getByRole('button', { name: '荧光笔', exact: true }).click(); assert.equal(await workspace().getByRole('button', { name: '荧光笔', exact: true }).getAttribute('aria-pressed'), 'true');
  checks.push('Escape/pointer cancellation restore the previous dock and do not swallow the next tool click');

  await moveTo('right'); await resize(page, 820, 650); await bounded();
  await workspace().getByRole('button', { name: '笔', exact: true }).focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '荧光笔');
  await page.keyboard.press('End'); assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '插入图片');
  assert.ok(await workspace().getByRole('button', { name: '文字段落', exact: true }).isVisible());
  await resize(page, 600, 700); await bounded();
  await page.evaluate(() => window.app.commands.executeCommandById('theme:toggle-light-dark'));
  await page.waitForFunction(() => document.body.classList.contains('theme-dark')); await shot(page, 'dock-vertical-narrow-dark');
  checks.push('Narrow vertical palettes scroll to all tools and actions; keyboard navigation and dark theme stay usable');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await reset(); await bounded();
  assert.ok(await grip().evaluate(el => el.offsetWidth >= 44 && el.offsetHeight >= 44));
  const tg = await grip().boundingBox(), tx = tg.x + tg.width / 2, ty = tg.y + tg.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: ty }] });
  for (let i = 1; i <= 12; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tx, y: ty + i * 10 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(() => document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').classList.contains('is-floating-dock'));
  await bounded(); await shot(page, 'dock-simulated-touch');
  const leakage = await grip().evaluate(el => {
    const seen = [], parent = el.parentElement, types = ['touchstart', 'touchmove', 'touchend', 'touchcancel'];
    const listener = event => seen.push(event.type);
    for (const type of types) parent.addEventListener(type, listener);
    for (const type of types) el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: [], changedTouches: [], targetTouches: [] }));
    for (const type of types) parent.removeEventListener(type, listener);
    return seen;
  });
  assert.deepEqual(leakage, []);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await grip().click(); await compactButton();
  assert.ok(await grip().evaluate(el => el.offsetWidth >= 44 && el.offsetHeight >= 44));
  await grip().click(); await collapsed(false); await bounded();
  checks.push('390px simulated touch and reduced motion: drag, button minimization/expansion and 44px targets work; touch events remain isolated from host drawers');

  assert.deepEqual(errors, []);
  const report = { date: new Date().toISOString(), host: await page.title(), checks, errors };
  await writeFile(new URL('../artifacts/dock-validation.json', import.meta.url), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error); console.error({ checks, errors }); await shot(page, 'dock-failure').catch(() => {}); process.exitCode = 1; }
finally { await close(); }

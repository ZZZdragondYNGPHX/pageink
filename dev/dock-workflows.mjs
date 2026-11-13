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
const bounded = async () => {
  assert.ok(await workspace().evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Workspace controls must not overflow horizontally');
  const result = await bar().evaluate(el => {
    const b = el.getBoundingClientRect(), w = el.closest('.ink-workspace').getBoundingClientRect();
    return { within: b.left >= w.left - 1 && b.top >= w.top - 1 && b.right <= w.right + 1 && b.bottom <= w.bottom + 1, overflow: el.scrollWidth > el.clientWidth + 1 };
  });
  assert.ok(result.within, 'Toolbox must remain inside the workspace');
  assert.equal(result.overflow, false, 'Collapsed and full toolbox must not overflow');
};
const reset = async () => {
  await grip().focus(); await page.keyboard.press('Home');
  await page.waitForFunction(() => !document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').classList.contains('is-floating-dock'));
};
const moveTo = async edge => {
  await reset();
  const b = await bar().boundingBox(), g = await grip().boundingBox(), w = await workspace().boundingBox();
  const x = edge === 'left' ? w.x + 8 : edge === 'right' ? w.x + w.width - b.width - 8 : w.x + (w.width - b.width) / 2;
  const y = edge === 'bottom' ? w.y + w.height - b.height - 8 : edge === 'top' ? w.y + 8 : w.y + 120;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + x - b.x, g.y + g.height / 2 + y - b.y, { steps: 16 }); await page.mouse.up();
  await page.waitForFunction(edge => {
    const el = document.querySelector('.workspace-leaf.mod-active .ink-writing-bar');
    return edge === 'top' ? !el.classList.contains('is-floating-dock') : el.dataset.edge === edge && el.classList.contains('is-collapsed');
  }, edge);
  await bounded();
};
try {
  await page.evaluate(async () => { window.app.workspace.leftSplit.collapse(); window.app.workspace.rightSplit.collapse(); await window.app.plugins.plugins.pageink.notes.create('pages'); });
  await page.waitForFunction(() => window.app.workspace.activeLeaf.view.session?.flushers.has('body'));
  await workspace().locator('.ink-canvas-area > .ink-editor .ink-canvas-status').waitFor({ state: 'hidden' });
  await bounded();
  await grip().focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').classList.contains('is-collapsed'));
  await bounded(); assert.equal((await state()).edge, 'left');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').classList.contains('is-collapsed'));
  await bounded();
  const before = await bar().boundingBox(); await page.keyboard.press('ArrowDown');
  await page.waitForFunction(y => document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').getBoundingClientRect().top > y + 1, before.y);
  checks.push('Keyboard Enter/Space toggles the toolbox, arrows move it, and Home restores the default position');

  for (const edge of ['left', 'right', 'bottom']) {
    await moveTo(edge); await shot(page, `dock-${edge}`);
    await grip().click();
    await page.waitForFunction(() => !document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').classList.contains('is-collapsed'));
    await bounded();
  }
  await moveTo('top');
  checks.push('Dragging to each edge snaps correctly; expanded left/right/bottom toolboxes remain fully reachable');

  await moveTo('right'); const readingPosition = await bar().boundingBox();
  await workspace().getByRole('button', { name: '阅读模式', exact: true }).click(); await bar().waitFor({ state: 'hidden' });
  await workspace().getByRole('button', { name: '继续书写', exact: true }).click(); await bar().waitFor({ state: 'visible' });
  assert.equal((await state()).edge, 'right'); assert.equal((await state()).collapsed, true);
  assert.ok(Math.abs((await bar().boundingBox()).x - readingPosition.x) < 1);
  checks.push('Reading hides the toolbox; returning to writing preserves its dock position and collapsed state');

  await reset();
  const g = await grip().boundingBox(), initial = await bar().boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await page.mouse.down();
  await page.mouse.move(g.x + 120, g.y + 150, { steps: 12 }); await page.keyboard.press('Escape'); await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').classList.contains('is-floating-dock'));
  assert.ok(Math.abs((await bar().boundingBox()).x - initial.x) < 1);
  const g2 = await grip().boundingBox();
  await grip().evaluate(el => el.addEventListener('pointerdown', e => { window.dockTestPointer = e.pointerId; }, { once: true }));
  await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2); await page.mouse.down();
  await page.mouse.move(g2.x + 120, g2.y + 150, { steps: 12 });
  await grip().dispatchEvent('pointercancel', { pointerId: await page.evaluate(() => window.dockTestPointer), pointerType: 'mouse' }); await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').classList.contains('is-floating-dock'));
  await workspace().getByRole('button', { name: '荧光笔', exact: true }).click();
  assert.equal(await workspace().getByRole('button', { name: '荧光笔', exact: true }).getAttribute('aria-pressed'), 'true');
  checks.push('Escape and pointer cancellation restore the original position; the next tool click is not swallowed');

  await workspace().getByRole('button', { name: '文字', exact: true }).click();
  await grip().click(); await page.waitForFunction(() => document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').classList.contains('is-collapsed'));
  assert.ok(await workspace().getByRole('button', { name: '文字', exact: true }).isVisible()); await bounded();
  await workspace().getByRole('button', { name: '笔', exact: true }).focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '荧光笔');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '文字');
  checks.push('Collapsed tools retain the active insertion tool; keyboard navigation skips hidden buttons');

  await moveTo('right'); await resize(page, 820, 650); await bounded();
  await grip().click(); await page.waitForFunction(() => !document.querySelector('.workspace-leaf.mod-active .ink-writing-bar').classList.contains('is-collapsed')); await bounded();
  await shot(page, 'dock-narrow-expanded');
  await resize(page, 600, 700); await bounded();
  await page.evaluate(() => window.app.commands.executeCommandById('theme:toggle-light-dark'));
  await page.waitForFunction(() => document.body.classList.contains('theme-dark')); await bounded(); await shot(page, 'dock-narrow-dark');
  checks.push('Real narrow host windows constrain dock positions and expanded layouts in light and dark themes');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await reset(); await bounded();
  assert.ok(await grip().evaluate(el => el.offsetWidth >= 44 && el.offsetHeight >= 44));
  const touchGrip = await grip().boundingBox(), tx = touchGrip.x + touchGrip.width / 2, ty = touchGrip.y + touchGrip.height / 2;
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
  checks.push('390px simulated touch: the grip has a 44px target, touch drag works, and native touch events stay isolated from host drawers');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await reset();
  assert.ok(await workspace().getByRole('button', { name: '笔', exact: true }).evaluate(el => getComputedStyle(el.querySelector('svg')).transitionDuration.split(',').every(value => parseFloat(value) < 0.001)));
  assert.deepEqual(errors, []);
  const report = { date: new Date().toISOString(), host: await page.title(), checks, errors };
  await writeFile(new URL('../artifacts/dock-validation.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error); console.error({ checks, errors }); await shot(page, 'dock-failure').catch(() => {}); process.exitCode = 1;
} finally { await close(); }

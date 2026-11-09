// Isolated Obsidian host for manual and scripted checks. Never touches the user's own profile or vaults:
// a generated vault (.test-vault/) and a throwaway profile (/tmp) are created on every launch.
import { spawn } from 'node:child_process';
import { cp, mkdir, rm, writeFile, readFile, readlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { writeFixturePdf } from './fixture-pdf.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const vault = join(root, '.test-vault');
const appImage = process.env.OBSIDIAN_APPIMAGE ?? join(homedir(), '.local/opt/obsidian/Obsidian.AppImage');

// AppImage may put Electron in a different process group from its launcher. A CDP
// disconnect alone is not an application exit; wait before reusing this test profile.
async function stopProfile(profile, child) {
  const lock = await readlink(join(profile, 'SingletonLock')).catch(() => '');
  const pid = Number(lock.match(/-(\d+)$/)?.[1]);
  const ownProcess = async id => {
    if (!id) return false;
    const cmd = await readFile(`/proc/${id}/cmdline`, 'utf8').catch(() => '');
    return cmd.split('\0').includes(`--user-data-dir=${profile}`);
  };
  for (const id of new Set([pid, child.pid])) {
    if (!(await ownProcess(id))) continue;
    try { process.kill(id, 'SIGTERM'); } catch {}
    for (let i = 0; i < 100 && await ownProcess(id); i++) await new Promise(resolve => setTimeout(resolve, 50));
    if (await ownProcess(id)) { try { process.kill(id, 'SIGKILL'); } catch {} }
  }
}

export async function prepareVault({ theme = 'moonstone', fresh = true, files = {} } = {}) {
  if (fresh) await rm(vault, { recursive: true, force: true });
  const plugin = join(vault, '.obsidian/plugins/pageink');
  await mkdir(plugin, { recursive: true });
  for (const name of ['main.js', 'manifest.json', 'styles.css']) await cp(join(root, 'dist', name), join(plugin, name));
  await writeFile(join(vault, '.obsidian/community-plugins.json'), JSON.stringify(['pageink']));
  await writeFile(join(vault, '.obsidian/appearance.json'), JSON.stringify({ theme, accentColor: '' }));
  await writeFile(join(vault, '.obsidian/app.json'), JSON.stringify({ promptDelete: false }));
  if (!existsSync(join(vault, '教材.pdf'))) await writeFixturePdf(join(vault, '教材.pdf'));
  if (!existsSync(join(vault, '欢迎.md'))) await writeFile(join(vault, '欢迎.md'), '# 测试库\n\n由 dev/obsidian.mjs 生成。\n');
  for (const [path, content] of Object.entries(files)) { await mkdir(join(vault, path, '..'), { recursive: true }); await writeFile(join(vault, path), content); }
}

export async function launch({ port = 9333, width = 1400, height = 900, theme, fresh = true, files } = {}) {
  await prepareVault({ theme, fresh, files });
  const profile = join(tmpdir(), 'pageink-obsidian-profile');
  await rm(profile, { recursive: true, force: true }); await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'obsidian.json'), JSON.stringify({ updateDisabled: true, vaults: { '0123456789abcdef': { path: vault, ts: Date.now(), open: true } } }));
  const child = spawn(appImage, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, `--window-size=${width},${height}`], { detached: true, stdio: 'ignore', env: { ...process.env, APPIMAGE_SILENT_INSTALL: '1' } });
  child.unref();
  let browser;
  for (let i = 0; i < 120 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  if (!browser) { await stopProfile(profile, child); throw Error('Obsidian did not expose CDP'); }
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    page = browser.contexts().flatMap(c => c.pages()).find(p => !p.url().startsWith('devtools'));
    if (!page) await new Promise(r => setTimeout(r, 250));
  }
  await page.waitForSelector('.workspace', { timeout: 60000 });
  const trust = page.locator('button', { hasText: /Trust author|信任/ });
  for (let i = 0; i < 120; i++) {
    if (await page.evaluate(() => !!window.app?.plugins?.plugins?.pageink)) break;
    if (await trust.first().isVisible().catch(() => false)) await trust.first().click({ timeout: 1500, force: true }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
  }
  if (!(await page.evaluate(() => !!window.app?.plugins?.plugins?.pageink))) throw Error('PageInk did not load in the test host');
  // Obsidian shows the trust prompt in a separate settings window; modals follow `activeWindow`,
  // so close it and hand focus back to the main window.
  for (const other of browser.contexts().flatMap(c => c.pages())) if (other !== page && !other.url().startsWith('devtools')) await other.close().catch(() => {});
  await page.bringToFront();
  await resize(page, width, height);
  await page.evaluate(() => { window.activeWindow = window; window.activeDocument = document; });
  const close = async () => {
    try { const cdp = await browser.newBrowserCDPSession(); await cdp.send('Browser.close'); } catch {}
    try { await browser.close(); } catch {}
    await stopProfile(profile, child);
  };
  return { browser, page, close };
}

/** Resizes the real host window (viewport emulation would not reflow Obsidian's own layout). */
export async function resize(page, width, height) {
  const resized = await page.evaluate(([w, h]) => {
    for (const name of ['@electron/remote', 'electron']) {
      try { const remote = name === 'electron' ? window.require(name).remote : window.require(name); const win = remote.getCurrentWindow(); if (win.isMaximized()) win.unmaximize(); win.setSize(w, h); return true; } catch {}
    }
    return false;
  }, [width, height]);
  if (!resized) {
    const session = await page.context().browser().newBrowserCDPSession();
    const { targetInfos } = await session.send('Target.getTargets');
    const target = targetInfos.find(t => t.type === 'page' && t.url.startsWith('app://'));
    const { windowId } = await session.send('Browser.getWindowForTarget', { targetId: target.targetId });
    await session.send('Browser.setWindowBounds', { windowId, bounds: { width, height } });
  }
  await page.waitForTimeout(500);
}

export async function shot(page, name) {
  await mkdir(join(root, 'artifacts/shots'), { recursive: true });
  const path = join(root, 'artifacts/shots', `${name}.png`);
  await page.screenshot({ path });
  return path;
}

export const readVaultFile = (path) => readFile(join(vault, path), 'utf8');

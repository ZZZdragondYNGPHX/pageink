import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kernelPatch } from './kernel-patch.mjs';
import { isolateKernelCss } from './kernel-css.mjs';
import { embeddedAssets, licenseBanner } from './embed-assets.mjs';
import { pdfBrowserOnly } from './pdf-browser.mjs';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
if (resolve(process.cwd()) !== resolve(projectRoot)) throw Error('Run the build from the project root.');
const outputDir = resolve(projectRoot, 'dist');
// Only the known generated output is replaced; never reuse stale dependency assets.
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
const common = { bundle: true, target: ['es2022'], logLevel: 'info', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } };
await esbuild.build({ ...common, plugins: [pdfBrowserOnly], entryPoints: ['src/export-worker.ts'], outfile: 'dist/assets/pdf-export.worker.mjs', format: 'esm', minify: true });
await cp('manifest.json', 'dist/manifest.json');
await cp('LICENSE', 'dist/LICENSE');
let engineCss = await readFile('node_modules/@excalidraw/excalidraw/dist/prod/index.css', 'utf8');
// Host inserts CSS into a style element, so relative font URLs resolve against app://obsidian.md.
for (const match of [...engineCss.matchAll(/url\("\.\/fonts\/([^\"]+)"\)/g)]) {
  const bytes = await readFile(`node_modules/@excalidraw/excalidraw/dist/prod/fonts/${match[1]}`);
  engineCss = engineCss.replace(match[0], `url("data:font/woff2;base64,${bytes.toString('base64')}")`);
}
await writeFile('dist/styles.css', isolateKernelCss(engineCss) + '\n' + await readFile('src/styles.css', 'utf8') + '\n' + await readFile('src/properties.css', 'utf8'));
await mkdir('dist/assets', { recursive: true });
await cp('node_modules/@excalidraw/excalidraw/dist/prod/fonts', 'dist/assets/fonts', { recursive: true });
await cp('vendor/fonts', 'dist/assets/fonts', { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) await cp(`node_modules/pdfjs-dist/${dir}`, `dist/assets/${dir}`, { recursive: true });
await cp('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/assets/pdf.worker.min.mjs');
await import('./licenses.mjs');
const embedded = await embeddedAssets();
await esbuild.build({ ...common, plugins: [embedded.plugin, kernelPatch], entryPoints: ['src/main.tsx'], outfile: 'dist/main.js', format: 'cjs', external: ['obsidian', 'electron'], minify: true, sourcemap: 'external' });
await writeFile('dist/main.js', await readFile('dist/main.js', 'utf8') + await licenseBanner());
await writeFile('dist/embedded-assets.json', JSON.stringify(embedded.hashes, null, 2));

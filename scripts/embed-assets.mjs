import { readFile, readdir } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'fflate';
import { createHash } from 'node:crypto';

export async function embeddedAssets() {
  const records = {}, hashes = {};
  async function collect(dir, prefix = '') {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = `${dir}/${entry.name}`, name = prefix + entry.name;
      if (entry.isDirectory()) await collect(path, name + '/');
      else {
        const bytes = await readFile(path), compressed = deflateSync(bytes, { level: 6 });
        if (!Buffer.from(inflateSync(compressed)).equals(bytes)) throw Error(`Asset compression mismatch: ${name}`);
        const mime = name.endsWith('.mjs') ? 'text/javascript' : name.endsWith('.wasm') ? 'application/wasm'
          : name.endsWith('.woff2') ? 'font/woff2' : name.endsWith('.woff') ? 'font/woff'
          : name.endsWith('.otf') ? 'font/otf' : name.endsWith('.ttf') ? 'font/ttf' : 'application/octet-stream';
        records[name] = [Buffer.from(compressed).toString('base64'), bytes.length, mime];
        hashes[name] = createHash('sha256').update(bytes).digest('hex');
      }
    }
  }
  await collect('dist/assets');
  return {
    hashes,
    plugin: {
      name: 'pageink-bundled-assets',
      setup(build) {
        build.onResolve({ filter: /^pageink:assets$/ }, () => ({ path: 'assets', namespace: 'pageink' }));
        build.onLoad({ filter: /.*/, namespace: 'pageink' }, () => ({ contents: `export default ${JSON.stringify(records)};`, loader: 'js' }));
      },
    },
  };
}

export async function licenseBanner() {
  const notices = {};
  async function collect(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await collect(path);
      else notices[path.slice(5)] = await readFile(path, 'utf8');
    }
  }
  notices.LICENSE = await readFile('LICENSE', 'utf8');
  notices['THIRD_PARTY_NOTICES.md'] = await readFile('dist/THIRD_PARTY_NOTICES.md', 'utf8');
  await collect('dist/licenses');
  // Asset-specific licenses are preserved too, including PDF.js CMaps and decoders.
  for (const dir of ['fonts', 'cmaps', 'standard_fonts', 'wasm']) {
    for (const name of await readdir('dist/assets/' + dir)) if (/^(license|notice|copying)/i.test(name)) {
      notices[`assets/${dir}/${name}`] = await readFile(`dist/assets/${dir}/${name}`, 'utf8');
    }
  }
  // A normal exported data property keeps the exact original texts in the three-file
  // community distribution, without changing license terms or executing extra code.
  return `\nmodule.exports.pageinkLicenses = ${JSON.stringify(notices, null, 2)};\n`;
}

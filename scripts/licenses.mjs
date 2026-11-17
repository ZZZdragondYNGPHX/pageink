import { readFile, writeFile, readdir, mkdir, cp } from 'node:fs/promises';
const lock = JSON.parse(await readFile('package-lock.json','utf8'));
await mkdir('dist/licenses', { recursive:true });
await cp('vendor/licenses','dist/licenses/vendor',{recursive:true});
const rows=[],missing=[];
for(const [path,entry] of Object.entries(lock.packages)){
  if(!path || entry.dev) continue;
  let pkg; try{pkg=JSON.parse(await readFile(`${path}/package.json`,'utf8'));}catch{continue;}
  const files=(await readdir(path)).filter(name=>/^(licen[sc]e|copying|notice)(\.|$|-)/i.test(name));
  const key=`${pkg.name.replaceAll('/','_').replaceAll('@','')}-${pkg.version}`;
  const copies=[];
  for(const file of files){try{const data=await readFile(`${path}/${file}`); const out=`${key}-${file}`;await writeFile(`dist/licenses/${out}`,data);copies.push(out);}catch{}}
  if(!copies.length && pkg.name==='@excalidraw/excalidraw')copies.push('vendor/excalidraw-MIT.txt');
  const fallback=pkg.name.startsWith('@radix-ui/')?'radix-ui':(['fontkit','fastdom','strictdom','react-remove-scroll-bar'].includes(pkg.name)?pkg.name:null);
  if(!copies.length && fallback)copies.push(`vendor/${fallback}.txt`);
  if(!copies.length && pkg.name.startsWith('@napi-rs/canvas-')) {const file=`${key}-LICENSE`;await cp('node_modules/@napi-rs/canvas/LICENSE',`dist/licenses/${file}`);copies.push(file);}
  if(!copies.length && ['brotli','dfa'].includes(pkg.name)) {
    const readme=(await readdir(path)).find(name=>/^readme\.md$/i.test(name)), body=await readFile(`${path}/${readme}`,'utf8');
    const mit=await readFile('vendor/licenses/fontkit.txt','utf8'),file=`${key}-NOTICE.txt`;
    await writeFile(`dist/licenses/${file}`,`Upstream package declares MIT in its README and package metadata; it ships no standalone license file.\nName: ${pkg.name}\nVersion: ${pkg.version}\nAuthor metadata: ${JSON.stringify(pkg.author)}\nRepository: ${JSON.stringify(pkg.repository)}\n\n${body.slice(body.lastIndexOf('## License'))}\n\nStandard MIT permission terms:\n${mit.slice(mit.indexOf('Permission is hereby granted'))}`);copies.push(file);
  }
  if(!copies.length)missing.push({name:pkg.name,version:pkg.version,license:pkg.license});
  rows.push(`| ${pkg.name} | ${pkg.version} | ${typeof pkg.license==='string'?pkg.license:JSON.stringify(pkg.license)} | ${copies.map(file=>`[${file}](licenses/${file})`).join(', ')} |`);
}
const text=`# Third-party notices

PageInk's original code is MIT-licensed. This inventory lists direct and transitive production dependencies from the lockfile. Bundled code, fonts and resources retain their upstream notices and license terms.

The editing kernel is Excalidraw 0.18.1 (MIT). Input, history and rendering patches are applied by scripts/kernel-patch.mjs.

## Fonts and PDF assets

- Noto Sans CJK SC: original OTF and OFL in assets/fonts.
- Excalidraw fonts: Assistant, Cascadia, Excalifont, Lilita, Nunito, Virgil and Xiaolai use OFL; Comic Shanns uses MIT. Notices are in licenses/vendor/font-*.txt.
- Liberation Sans: Excalidraw bundles 1.05 and PDF.js bundles 1.07.4. Both include GPL v2 and the Liberation font exception in licenses/vendor. The exception permits document embedding. Sources: https://github.com/liberationfonts/liberation-fonts ; license: https://fedoraproject.org/wiki/Licensing:LiberationFontLicense .
- PDF.js CMaps, Foxit fonts and WASM include their upstream LICENSE files in assets. PDFium JBIG2 uses BSD-3-Clause, OpenJPEG uses BSD-2-Clause, and qcms uses MIT; PDF.js wrappers use Apache-2.0. Versions and hashes: https://github.com/ZZZdragondYNGPHX/pageink/blob/main/docs/pdf-assets.md .

## Production dependency inventory

| Package | Version | Declared license | Included notice |
| --- | --- | --- | --- |
${rows.join('\n')}
`;

await writeFile('THIRD_PARTY_NOTICES.md',text.replaceAll('(licenses/','(dist/licenses/')); await writeFile('dist/THIRD_PARTY_NOTICES.md',text);
console.log(JSON.stringify({packages:rows.length,missing},null,2));
if(missing.length)throw Error('Third-party notices are incomplete; inspect the missing package list before packaging.');

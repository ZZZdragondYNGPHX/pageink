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
const text=`# Third-party notices\n\nPageInk uses the MIT license for its original code. Third-party code and fonts retain their own terms. Direct and transitive production dependencies are listed conservatively, including packages whose modules may be removed by bundling. Original notices are copied without modifying their terms.\n\nThe editing kernel is Excalidraw 0.18.1 (MIT). Our changes are centralized in scripts/kernel-patch.mjs: pressure/input adaptation, external undo ownership, spatial queries, incremental snapshots and eraser updates.\n\n## Fonts and PDF assets\n\n- Noto Sans CJK SC: original OTF in assets/fonts, OFL in assets/fonts/LICENSE.\n- Excalidraw font assets: Assistant, Cascadia, Excalifont, Lilita, Nunito, Virgil and Xiaolai use the accompanying OFL notices; Comic Shanns uses MIT. See licenses/vendor/font-*.txt. Font binaries are unchanged.\n- Liberation Sans bundled by Excalidraw identifies as 1.05; PDF.js standard fonts identify as 1.07.4. Preserve the GPL v2 text and Liberation font exception in licenses/vendor. The font exception covers embedding in documents. The OFL file shipped by this PDF.js npm version does not replace those actual-version terms. Source project: https://github.com/liberationfonts/liberation-fonts and original license: https://fedoraproject.org/wiki/Licensing:LiberationFontLicense .\n- PDF.js CMaps, Foxit fonts and decoder WASM keep their own LICENSE files inside assets.\n\n## Production dependency inventory\n\n| Package | Version | Declared license | Included notice |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`;
await writeFile('THIRD_PARTY_NOTICES.md',text.replaceAll('(licenses/','(dist/licenses/')); await writeFile('dist/THIRD_PARTY_NOTICES.md',text);
console.log(JSON.stringify({packages:rows.length,missing},null,2));
if(missing.length)throw Error('Third-party notices are incomplete; inspect the missing package list before packaging.');

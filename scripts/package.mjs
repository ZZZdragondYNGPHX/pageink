import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
const manifest=JSON.parse(await readFile('manifest.json','utf8'));
const files={},source={};
async function collect(root,prefix,target){for(const item of await readdir(root,{withFileTypes:true})){const path=`${root}/${item.name}`,key=prefix?`${prefix}/${item.name}`:item.name;if(item.isDirectory())await collect(path,key,target);else if(!item.name.endsWith('.map'))target[key]=new Uint8Array(await readFile(path));}}
await collect('dist',manifest.id,files);
for(const required of ['main.js','manifest.json','styles.css','assets/pdf.worker.min.mjs','assets/pdf-export.worker.mjs','assets/fonts/NotoSansCJKsc-Regular.otf','LICENSE','THIRD_PARTY_NOTICES.md'])if(!files[`${manifest.id}/${required}`])throw Error(`Missing package file ${required}`);
for(const folder of ['src','scripts','tests','docs','vendor'])await collect(folder,folder,source);
for(const file of ['README.md','AGENTS.md','LICENSE','THIRD_PARTY_NOTICES.md','.gitignore','manifest.json','package.json','package-lock.json','tsconfig.json'])source[file]=new Uint8Array(await readFile(file));
await mkdir('artifacts',{recursive:true});
const outputs=[];
for(const[name,contents]of [[`${manifest.id}-${manifest.version}.zip`,files],[`${manifest.id}-${manifest.version}-source.zip`,source]]){
  const bytes=zipSync(contents,{level:6});await writeFile(`artifacts/${name}`,bytes);outputs.push({file:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
await writeFile('artifacts/SHA256SUMS.txt',outputs.map(x=>`${x.sha256}  ${x.file}`).join('\n')+'\n');console.log(JSON.stringify(outputs,null,2));

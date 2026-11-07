import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
const manifest=JSON.parse(await readFile('manifest.json','utf8'));
const files={},source={};
async function collect(root,prefix,target){for(const item of await readdir(root,{withFileTypes:true})){const path=`${root}/${item.name}`,key=prefix?`${prefix}/${item.name}`:item.name;if(item.isDirectory())await collect(path,key,target);else if(!item.name.endsWith('.map'))target[key]=new Uint8Array(await readFile(path));}}
for(const name of ['main.js','manifest.json','styles.css','LICENSE','THIRD_PARTY_NOTICES.md'])files[`${manifest.id}/${name}`]=new Uint8Array(await readFile(`dist/${name}`));
await collect('dist/licenses',`${manifest.id}/licenses`,files);
for(const folder of ['src','scripts','tests','docs','vendor'])await collect(folder,folder,source);
for(const file of ['README.md','AGENTS.md','LICENSE','THIRD_PARTY_NOTICES.md','.gitignore','manifest.json','versions.json','package.json','package-lock.json','tsconfig.json'])source[file]=new Uint8Array(await readFile(file));
await mkdir('artifacts',{recursive:true});
const outputs=[];
for(const[name,contents]of [[`${manifest.id}-${manifest.version}.zip`,files],[`${manifest.id}-${manifest.version}-source.zip`,source]]){
  const bytes=zipSync(contents,{level:6});await writeFile(`artifacts/${name}`,bytes);outputs.push({file:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
let previous='';try{previous=await readFile('artifacts/SHA256SUMS.txt','utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
const retained=previous.split('\n').filter(line=>line&&!outputs.some(x=>line.endsWith('  '+x.file)));
await writeFile('artifacts/SHA256SUMS.txt',[...retained,...outputs.map(x=>`${x.sha256}  ${x.file}`)].join('\n')+'\n');console.log(JSON.stringify(outputs,null,2));

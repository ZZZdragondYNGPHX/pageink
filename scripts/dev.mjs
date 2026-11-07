import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
let running=false,again=false,timer;
const build=()=>{ if(running){again=true;return;}running=true;const child=spawn(process.execPath,['scripts/build.mjs'],{stdio:'inherit'});child.on('exit',()=>{running=false;if(again){again=false;build();}}); };
for(const path of ['src','scripts'])watch(path,{recursive:true},()=>{clearTimeout(timer);timer=setTimeout(build,150);});
watch('manifest.json',()=>build());build();console.log('Watching source; output: dist. No vault is modified.');

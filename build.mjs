import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const dir=path.dirname(fileURLToPath(import.meta.url));
const source=await fs.readFile(path.join(dir,'src/MobileStudio.tsx'),'utf8');
const chars=[...new Set([...source].filter(c=>c.codePointAt(0)>127))].sort().join('');
const fontPath=path.join(dir,'src/Font.css');
const characterPath=path.join(dir,'font-characters.txt');
let cached='';try{cached=await fs.readFile(characterPath,'utf8');}catch{}
if([...chars].some(c=>!cached.includes(c))){
 const res=await fetch('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;600;700&display=swap&text='+encodeURIComponent(chars));if(!res.ok)throw Error('Font CSS '+res.status);
 let font=await res.text();const urls=[...new Set([...font.matchAll(/url\(([^)]+)\)/g)].map(m=>m[1]))];
 for(const url of urls){const r=await fetch(url);if(!r.ok)throw Error('Font data '+r.status);font=font.replaceAll(url,'data:font/woff2;base64,'+Buffer.from(await r.arrayBuffer()).toString('base64'));}
 await fs.writeFile(fontPath,font.replaceAll('Noto Sans SC','Toolbox Sans').replaceAll('font-display: swap','font-display: block'));await fs.writeFile(characterPath,chars);
}
const result=await build({entryPoints:[path.join(dir,'src/main.tsx')],bundle:true,write:false,outdir:path.join(dir,'dist'),platform:'browser',format:'iife',jsx:'automatic',minify:true,loader:{'.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"'}});
const js=result.outputFiles.find(f=>f.path.endsWith('.js')).text;const css=result.outputFiles.find(f=>f.path.endsWith('.css')).text;
const iconData=(await fs.readFile(path.join(dir,'assets/yero-logo.png'))).toString('base64');
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content"><meta name="theme-color" content="#ffffff"><meta name="color-scheme" content="light dark"><link rel="icon" type="image/png" href="data:image/png;base64,${iconData}"><title>Yero · 移动端生图</title><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll('</script','<\\/script')}</script></body></html>`;
const legacyOutput=path.resolve(dir,'../../outputs');
try{if((await fs.stat(legacyOutput)).isDirectory())for(const name of ['客户工具箱_移动端生图.html','客户工具箱_生图工作区.html'])await fs.writeFile(path.join(legacyOutput,name),html);}catch(error){if(error.code!=='ENOENT')throw error;}
await fs.mkdir(path.join(dir,'dist/site'),{recursive:true});await fs.writeFile(path.join(dir,'dist/mobile.html'),html);await fs.writeFile(path.join(dir,'dist/site/index.html'),html);await fs.copyFile(path.join(dir,'cloud/worker.mjs'),path.join(dir,'dist/site/_worker.js'));
console.log(JSON.stringify({status:'PASS',fontCharacters:chars.length,htmlBytes:Buffer.byteLength(html),embeddedAssets:true,oldLayoutsIncluded:false}));

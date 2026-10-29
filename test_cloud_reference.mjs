import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';

const dir=path.dirname(fileURLToPath(import.meta.url));const qa=path.join(dir,'.test-cache');await fs.mkdir(qa,{recursive:true});
const codePath=process.env.YERO_TEST_ACCESS_CODE_FILE,jobs=process.env.YERO_BRIDGE_JOBS_DIR;
if(!codePath||!jobs){console.log('SKIP: set YERO_TEST_ACCESS_CODE_FILE and YERO_BRIDGE_JOBS_DIR to run the live reference test');process.exit(0);}
const code=(await fs.readFile(codePath,'utf8')).trim();const origin=process.env.YERO_TEST_BASE_URL||'https://yero-mobile-studio.pages.dev/';
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:origin});
const viewport=new dom.window.EventTarget();viewport.height=844;Object.defineProperty(dom.window,'visualViewport',{value:viewport});
for(const key of ['window','document','HTMLElement','HTMLInputElement','HTMLTextAreaElement','Event','MouseEvent','KeyboardEvent','File','FileReader'])globalThis[key]=dom.window[key];
window.matchMedia=()=>({matches:true});window.sessionStorage.setItem('yero-access-code',code);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const nativeFetch=globalThis.fetch;let requests=0;
globalThis.fetch=(url,options)=>{requests++;return nativeFetch(new URL(url,origin),options);};
await build({entryPoints:[path.join(dir,'src/MobileStudio.tsx')],outfile:path.join(qa,'mobile-cloud-test.mjs'),bundle:true,format:'esm',platform:'node',jsx:'automatic',loader:{'.css':'empty','.png':'file'},external:['react','react/jsx-runtime']});
const {createElement,act}=await import('react');const {createRoot}=await import('react-dom/client');const {MobileStudio}=await import('./.test-cache/mobile-cloud-test.mjs');
const root=createRoot(document.getElementById('root'));
const click=async el=>{assert(el);await act(()=>el.dispatchEvent(new MouseEvent('click',{bubbles:true})));};
const button=label=>[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent.trim())===label);
await act(()=>root.render(createElement(MobileStudio)));
await click(button('使用徽标模板'));
const file=new File([await fs.readFile(path.join(dir,'assets/template-atlas.png'))],'reference.png',{type:'image/png'});
const input=document.querySelector('input[type="file"]');Object.defineProperty(input,'files',{value:[file],configurable:true});
await act(async()=>{input.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,50));});
assert(document.querySelector('.reference-token'));
await click(button('画面比例 1:1'));await click(button('2K'));await click(button('完成'));
const marker='YERO-RATIO-TEST-'+Date.now();
const textarea=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,'基于参考图做简洁平面插画，保留构图，不添加文字。 '+marker);
await act(()=>textarea.dispatchEvent(new Event('input',{bubbles:true})));
await act(async()=>{document.querySelector('.mobile-composer').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await new Promise(resolve=>setTimeout(resolve,500));});
console.log('Submitted one reference-image task through the deployed page.');
let complete=false;
for(let i=0;i<190;i++){
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5000));});
 const image=document.querySelector('.generated-image');
 if(image){
  const bytes=Buffer.from(image.src.split(',')[1],'base64');assert(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  const target=path.join(dir,'test-output','cloud-ratio-resolution-'+Date.now()+'.png');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);
  let nativeSize=null;
  for(const name of await fs.readdir(jobs)){
   if(!/^[0-9a-f]{32}$/.test(name))continue;
   try{const record=JSON.parse(await fs.readFile(path.join(jobs,name,'request.json'),'utf8'));if(!record.fields?.prompt?.includes(marker))continue;const native=await fs.readFile(path.join(jobs,name,'native-output.png'));nativeSize=[native.readUInt32BE(16),native.readUInt32BE(20)];break;}catch{}
  }
  assert(nativeSize,'Native image for this exact test was found');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);assert.equal(Math.max(width,height),2048);assert(Math.abs(width/height-nativeSize[0]/nativeSize[1])<.002,'Output preserves the model image aspect ratio');
  await click(button('打开侧边栏'));assert.match(document.querySelector('.chat-list').textContent,/基于参考图做简洁平面插画/);
  console.log(JSON.stringify({status:'PASS',bytes:bytes.length,width,height,nativeWidth:nativeSize[0],nativeHeight:nativeSize[1],requests,output:target}));complete=true;break;
 }
 const error=document.querySelector('.mobile-result h1')?.textContent;
 if(error==='暂时没有生成图片')throw new Error(document.querySelector('.mobile-result p')?.textContent||'Generation failed');
}
await act(()=>root.unmount());
if(!complete)throw new Error('Cloud reference-image test timed out');

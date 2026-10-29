import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import 'fake-indexeddb/auto';

const dir=path.dirname(fileURLToPath(import.meta.url));const qa=path.join(dir,'.test-cache');await fs.mkdir(qa,{recursive:true});
const codePath=process.env.YERO_TEST_ACCESS_CODE_FILE;if(!codePath){console.log('SKIP: set YERO_TEST_ACCESS_CODE_FILE to run the live test');process.exit(0);}
const code=(await fs.readFile(codePath,'utf8')).trim();
const origin=process.env.YERO_TEST_BASE_URL||'https://yero-mobile-studio.pages.dev/';
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:origin});
const viewport=new dom.window.EventTarget();viewport.height=844;Object.defineProperty(dom.window,'visualViewport',{value:viewport});
for(const key of ['window','document','HTMLElement','HTMLInputElement','HTMLTextAreaElement','Event','MouseEvent','KeyboardEvent','File','FileReader'])globalThis[key]=dom.window[key];
window.matchMedia=()=>({matches:true});window.sessionStorage.setItem('yero-access-code',code);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const firstPrompt='YERO会话隔离测试 '+Date.now()+' 紫色纸鹤，纯色背景，无文字';
const secondPrompt='YERO失败输入保留 '+Date.now();
const nativeFetch=globalThis.fetch;let firstId='',firstResult=false,rejected=false;
globalThis.fetch=async(url,options={})=>{
 const response=await nativeFetch(new URL(url,origin),options);
 if(options.method==='POST'){
  const submitted=JSON.parse(options.body).prompt;const data=await response.clone().json();
  if(submitted===firstPrompt&&response.ok)firstId=data.id;
  if(submitted===secondPrompt&&response.status===401)rejected=true;
 }else if(firstId&&String(url).endsWith(firstId)){
  const data=await response.clone().json();if(data.status==='completed')firstResult=true;
 }
 return response;
};
await build({entryPoints:[path.join(dir,'src/MobileStudio.tsx')],outfile:path.join(qa,'mobile-cloud-session-test.mjs'),bundle:true,format:'esm',platform:'node',jsx:'automatic',loader:{'.css':'empty','.png':'file'},external:['react','react/jsx-runtime']});
const {createElement,act}=await import('react');const {createRoot}=await import('react-dom/client');const {MobileStudio}=await import('./.test-cache/mobile-cloud-session-test.mjs');
const root=createRoot(document.getElementById('root'));
const button=label=>[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent.trim())===label);
const click=async el=>{assert(el,'button exists');await act(async()=>{el.dispatchEvent(new MouseEvent('click',{bubbles:true}));await Promise.resolve();});};
const setValue=async(el,value)=>{const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);await act(()=>el.dispatchEvent(new Event('input',{bubbles:true})));};
const send=async form=>act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,100));});
const waitFor=async(predicate,attempts=80)=>{for(let i=0;i<attempts;i++){await act(async()=>{await new Promise(r=>setTimeout(r,500));});if(predicate())return;}throw new Error('Timed out waiting for the expected state');};
const openChat=async title=>{await click(button('打开侧边栏'));const target=[...document.querySelectorAll('.chat-open')].find(el=>el.textContent.includes(title));assert(target,'Conversation exists: '+title);await click(target);};

await act(()=>root.render(createElement(MobileStudio)));await click(button('创作'));
await setValue(document.querySelector('textarea'),firstPrompt);await send(document.querySelector('.mobile-composer'));
await waitFor(()=>!!firstId);
assert.equal(document.querySelector('textarea').value,'','Accepted cloud submission clears its own input');
assert.match(document.querySelector('.mobile-conversation').textContent,/正在生成图片/);
await click(button('打开侧边栏'));await click(button('新建聊天'));
assert.equal(document.querySelector('.mobile-conversation'),null);assert.equal(button('生成图片')?.disabled,false);
await setValue(document.querySelector('textarea'),secondPrompt);
await openChat('YERO会话隔离测试');assert.match(document.querySelector('.mobile-conversation').textContent,/正在生成图片/);
await openChat('YERO失败输入保留');assert.equal(document.querySelector('textarea').value,secondPrompt);
await click(button('管理访问码'));await setValue(document.querySelector('.access-sheet input'),'invalid-test-code');await send(document.querySelector('.access-sheet form'));
await send(document.querySelector('.mobile-composer'));await waitFor(()=>rejected);
assert.equal(document.querySelector('textarea').value,secondPrompt,'Real rejected submission retains its input');
assert.match(document.querySelector('.mobile-conversation').textContent,/访问码不正确/);
console.log('Cloud request accepted; another chat was opened and a real rejected submission retained its draft. Waiting for the original image.');
await waitFor(()=>firstResult,1200);
assert.equal(document.querySelector('.generated-image'),null,'Original result stays out of the second chat');
assert.equal(document.querySelector('textarea').value,secondPrompt);
await openChat('YERO会话隔离测试');await waitFor(()=>!!document.querySelector('.generated-image'),30);
assert.match(document.querySelector('.mobile-conversation').textContent,/YERO会话隔离测试/);
assert.doesNotMatch(document.querySelector('.mobile-conversation').textContent,/YERO失败输入保留/);
await openChat('YERO失败输入保留');assert.equal(document.querySelector('textarea').value,secondPrompt);
assert.equal(document.querySelector('.generated-image'),null);
await act(()=>root.unmount());
console.log(JSON.stringify({status:'PASS',cloudSubmission:true,newChatDuringGeneration:true,resultReturnedToOriginalChat:true,acceptedInputCleared:true,rejectedInputRetained:true}));

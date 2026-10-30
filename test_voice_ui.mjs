import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import 'fake-indexeddb/auto';

const dir=path.dirname(fileURLToPath(import.meta.url));const qa=path.join(dir,'.test-cache');await fs.mkdir(qa,{recursive:true});
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'https://yero.test'});
const viewport=new dom.window.EventTarget();viewport.height=844;Object.defineProperty(dom.window,'visualViewport',{value:viewport});
for(const key of ['window','document','HTMLElement','HTMLInputElement','HTMLTextAreaElement','Event','MouseEvent','KeyboardEvent','File','FileReader'])globalThis[key]=dom.window[key];
window.matchMedia=()=>({matches:true});window.sessionStorage.setItem('yero-access-code','test-code');globalThis.IS_REACT_ACT_ENVIRONMENT=true;
let stopped=0;const stream={getTracks:()=>[{stop(){stopped++;}}]};
Object.defineProperty(window.navigator,'mediaDevices',{value:{getUserMedia:async()=>stream},configurable:true});
class FakeRecorder{
 static isTypeSupported(type){return type.startsWith('audio/webm');}
 constructor(){this.state='inactive';this.mimeType='audio/webm;codecs=opus';}
 start(){this.state='recording';}
 stop(){this.state='inactive';window.setTimeout(()=>{this.ondataavailable?.({data:new window.Blob([Uint8Array.from([0x1a,0x45,0xdf,0xa3,1])],{type:'audio/webm'})});this.onstop?.();},0);}
}
window.MediaRecorder=FakeRecorder;
let resolveResult;const result=new Promise(resolve=>{resolveResult=resolve;});const calls=[];
globalThis.fetch=async(url,options={})=>{
 calls.push({url,options});
 if(options.method==='POST')return new Response(JSON.stringify({id:'c'.repeat(32),status:'running'}),{status:202});
 return result;
};
await build({entryPoints:[path.join(dir,'src/MobileStudio.tsx')],outfile:path.join(qa,'mobile-voice-test.mjs'),bundle:true,format:'esm',platform:'node',jsx:'automatic',loader:{'.css':'empty','.png':'file'},external:['react','react/jsx-runtime']});
const {createElement,act}=await import('react');const {createRoot}=await import('react-dom/client');const {MobileStudio}=await import('./.test-cache/mobile-voice-test.mjs');
const root=createRoot(document.getElementById('root'));
const button=label=>[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent.trim())===label);
const click=async el=>{assert(el,'button exists');await act(async()=>{el.dispatchEvent(new MouseEvent('click',{bubbles:true}));await new Promise(r=>setTimeout(r,30));});};
const setPrompt=async value=>{const el=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);await act(()=>el.dispatchEvent(new Event('input',{bubbles:true})));};
const waitFor=async predicate=>{for(let i=0;i<60;i++){await act(async()=>{await new Promise(r=>setTimeout(r,20));});if(predicate())return;}throw Error('Timed out waiting for voice state');};

await act(()=>root.render(createElement(MobileStudio)));await click(button('创作'));
await setPrompt('一张');
assert(button('语音输入'),'Voice control is available beside send');
await click(button('语音输入'));assert(button('停止录音'),'Recording can be stopped');
await click(button('停止录音'));await waitFor(()=>calls.some(call=>call.url==='/api/transcriptions'));
assert.equal(stopped,1,'Microphone tracks stop when recording ends');
const posted=calls.find(call=>call.url==='/api/transcriptions');assert.match(JSON.parse(posted.options.body).audio,/^data:audio\/webm;base64,/);
await click(button('新建聊天'));await setPrompt('另一个聊天的草稿');
await act(async()=>{resolveResult(new Response(JSON.stringify({status:'completed',text:'紫色海报'}),{status:200}));await new Promise(r=>setTimeout(r,80));});
assert.equal(document.querySelector('textarea').value,'另一个聊天的草稿','Voice result does not overwrite a different conversation');
await click(button('打开侧边栏'));const original=[...document.querySelectorAll('.chat-open')].find(el=>el.textContent.includes('一张'));assert(original);await click(original);
await waitFor(()=>document.querySelector('textarea').value.includes('紫色海报'));
assert.equal(document.querySelector('textarea').value,'一张 紫色海报','Transcript appends to the originating draft');
Object.defineProperty(window.navigator,'mediaDevices',{value:{getUserMedia:async()=>{const error=new Error('denied');error.name='NotAllowedError';throw error;}},configurable:true});
await click(button('语音输入'));assert.match(document.querySelector('[role="alert"]').textContent,/麦克风/);
assert.equal(document.querySelector('textarea').value,'一张 紫色海报','Permission failure preserves the draft');
await act(()=>root.unmount());
console.log('PASS: voice recording, microphone cleanup, protected request, session-safe transcript and permission failure');

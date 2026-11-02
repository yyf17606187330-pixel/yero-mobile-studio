import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './cloud/worker.mjs';

class MemoryKV {
 values=new Map();
 async put(key,value){this.values.set(key,typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value));}
 async get(key,options){const value=this.values.get(key);if(!value)return null;return options?.type==='arrayBuffer'?value.slice().buffer:new TextDecoder().decode(value);}
 async list({prefix}){return {keys:[...this.values.keys()].filter(key=>key.startsWith(prefix)).map(name=>({name})),list_complete:true};}
 async delete(key){this.values.delete(key);}
}
const request=(path,options={})=>new Request('https://yero.example'+path,options);
const key='01'.repeat(32);
const makeEnv=()=>({YERO_ACCESS_CODE:'human-secret',YERO_RUNNER_KEY:'runner-secret',YERO_STORAGE_KEY:key,YERO_QUEUE:new MemoryKV(),YERO_DISPATCH:{idFromName:()=>1,get:()=>({fetch:async()=>new Response(null,{status:200})})},ASSETS:{fetch:async()=>new Response('site content')}});
const human={Authorization:'Bearer human-secret','Content-Type':'application/json'};
const runner={'X-Yero-Runner':'runner-secret'};
async function encrypt(text){const iv=new Uint8Array(12).fill(7);const raw=Uint8Array.from(key.match(/../g),h=>parseInt(h,16));const cryptoKey=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']);const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},cryptoKey,new TextEncoder().encode(text)));const result=new Uint8Array(iv.length+cipher.length);result.set(iv);result.set(cipher,iv.length);return result;}
async function decrypt(bytes){const data=new Uint8Array(bytes);const raw=Uint8Array.from(key.match(/../g),h=>parseInt(h,16));const cryptoKey=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:data.slice(0,12)},cryptoKey,data.slice(12)));}

test('static content remains public',async()=>{const response=await worker.fetch(request('/'),makeEnv());assert.equal(await response.text(),'site content');});
test('unauthorized clients cannot create jobs or access the runner',async()=>{
 const env=makeEnv();assert.equal((await worker.fetch(request('/api/jobs',{method:'POST',body:'{}'}),env)).status,401);
 assert.equal((await worker.fetch(request('/api/runner/next'),env)).status,401);assert.equal(env.YERO_QUEUE.values.size,0);
});
test('image job travels through the encrypted queue and returns its result',async()=>{
 const env=makeEnv();const prompt='a private reference description';
 const submitted=await worker.fetch(request('/api/jobs',{method:'POST',headers:human,body:JSON.stringify({prompt,ratio:'1:1',style:'自动',reference:null})}),env);
 assert.equal(submitted.status,202);const {id}=await submitted.json();assert.match(id,/^[a-f0-9]{32}$/);
 const stored=env.YERO_QUEUE.values.get('q/'+id);assert(stored);assert(!new TextDecoder().decode(stored).includes(prompt),'Queue data is encrypted');
 const pending=await worker.fetch(request('/api/jobs/'+id,{headers:human}),env);assert.equal((await pending.json()).status,'running');
 const next=await worker.fetch(request('/api/runner/job/'+id+'?kind=image',{headers:runner}),env);assert.equal(next.status,200);
 assert.equal(JSON.parse(await decrypt(await next.arrayBuffer())).prompt,prompt);
 const encryptedResult=await encrypt(JSON.stringify({status:'completed',image:'data:image/png;base64,AAAA'}));
 const done=await worker.fetch(request('/api/runner/result/'+id,{method:'POST',headers:runner,body:encryptedResult}),env);assert.equal(done.status,200);
 const result=await worker.fetch(request('/api/jobs/'+id,{headers:human}),env);assert.deepEqual(await result.json(),{status:'completed',image:'data:image/png;base64,AAAA'});
});
test('accepts and preserves a large generated image with an edit mask',async()=>{
 const env=makeEnv();
 const reference='data:image/png;base64,'+'A'.repeat(15*1024*1024);
 const body=JSON.stringify({prompt:'remove selected clutter',reference,mask:'data:image/png;base64,AAAA'});
 const created=await worker.fetch(request('/api/jobs',{method:'POST',headers:human,body}),env);
 assert.equal(created.status,202);
 const {id}=await created.json();
 const next=await worker.fetch(request('/api/runner/job/'+id+'?kind=image',{headers:runner}),env);
 const stored=JSON.parse(await decrypt(await next.arrayBuffer()));
 assert.equal(stored.reference,reference);
 assert.equal(stored.mask,'data:image/png;base64,AAAA');
});
test('missing storage configuration fails closed and other APIs stay unavailable',async()=>{
 const env=makeEnv();delete env.YERO_STORAGE_KEY;
 assert.equal((await worker.fetch(request('/api/jobs',{method:'POST',headers:human,body:'{}'}),env)).status,503);
 assert.equal((await worker.fetch(request('/api/models',{headers:human}),env)).status,404);
});

test('voice jobs use a separate encrypted queue and return text through the protected job endpoint',async()=>{
 const env=makeEnv();const payload={audio:'data:audio/webm;base64,GkXfo0E='};
 assert.equal((await worker.fetch(request('/api/transcriptions',{method:'POST',body:JSON.stringify(payload)}),env)).status,401);
 const submitted=await worker.fetch(request('/api/transcriptions',{method:'POST',headers:human,body:JSON.stringify(payload)}),env);
 assert.equal(submitted.status,202);const {id}=await submitted.json();assert.match(id,/^[a-f0-9]{32}$/);
 const stored=env.YERO_QUEUE.values.get('s/'+id);assert(stored);assert(!new TextDecoder().decode(stored).includes(payload.audio));
 assert.equal((await worker.fetch(request('/api/runner/job/'+id+'?kind=image',{headers:runner}),env)).status,404,'Image runner never consumes voice jobs');
 assert.equal((await worker.fetch(request('/api/runner/voice-next?force=1'),env)).status,401);
 const next=await worker.fetch(request('/api/runner/job/'+id+'?kind=voice',{headers:runner}),env);
 assert.equal(next.status,200);assert.deepEqual(JSON.parse(await decrypt(await next.arrayBuffer())),payload);
 const encryptedResult=await encrypt(JSON.stringify({status:'completed',text:'紫色海报'}));
 const done=await worker.fetch(request('/api/runner/voice-result/'+id,{method:'POST',headers:runner,body:encryptedResult}),env);
 assert.equal(done.status,200);assert.equal(env.YERO_QUEUE.values.has('s/'+id),false,'Processed audio is removed from the queue');
 const result=await worker.fetch(request('/api/jobs/'+id,{headers:human}),env);assert.deepEqual(await result.json(),{status:'completed',text:'紫色海报'});
});

test('voice requests reject missing, invalid or oversized audio',async()=>{
 const env=makeEnv();
 for(const payload of [{},{audio:'data:text/plain;base64,AAAA'},{audio:'data:audio/webm;base64,not valid'}]){
  const response=await worker.fetch(request('/api/transcriptions',{method:'POST',headers:human,body:JSON.stringify(payload)}),env);assert.equal(response.status,400);
 }
 const oversized=await worker.fetch(request('/api/transcriptions',{method:'POST',headers:human,body:JSON.stringify({audio:'data:audio/webm;base64,'+'A'.repeat(3*1024*1024)})}),env);
 assert.equal(oversized.status,413);
});

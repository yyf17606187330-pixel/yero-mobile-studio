const MAX_BODY_BYTES = 14 * 1024 * 1024;
const MAX_RESULT_BYTES = 24 * 1024 * 1024;
const TTL = 3600;

function reply(status, data) {
 return new Response(JSON.stringify(data), {status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
function matchesSecret(actual, expected) {
 const a=new TextEncoder().encode(actual),b=new TextEncoder().encode(expected);
 if(a.length!==b.length)return false;
 let difference=0;for(let i=0;i<a.length;i++)difference|=a[i]^b[i];return difference===0;
}
async function storageKey(value,usage){
 if(!/^[a-f0-9]{64}$/.test(value||''))throw new Error('missing key');
 const raw=Uint8Array.from(value.match(/../g),item=>parseInt(item,16));
 return crypto.subtle.importKey('raw',raw,'AES-GCM',false,[usage]);
}
async function encrypt(data,secret){
 const iv=crypto.getRandomValues(new Uint8Array(12));const key=await storageKey(secret,'encrypt');
 const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,data));
 const result=new Uint8Array(iv.length+cipher.length);result.set(iv);result.set(cipher,iv.length);return result;
}
async function decrypt(data,secret){
 const bytes=new Uint8Array(data);if(bytes.length<29)throw new Error('invalid data');
 const key=await storageKey(secret,'decrypt');return crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},key,bytes.slice(12));
}
function ready(env){return !!(env.YERO_ACCESS_CODE&&env.YERO_RUNNER_KEY&&env.YERO_STORAGE_KEY&&env.YERO_QUEUE);}

export default {
 async fetch(request,env){
  const url=new URL(request.url),path=url.pathname;
  if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
  const create=path==='/api/jobs'&&request.method==='POST';
  const read=/^\/api\/jobs\/([0-9a-f]{32})$/.exec(path);
  const next=path==='/api/runner/next'&&request.method==='GET';
  const result=/^\/api\/runner\/result\/([0-9a-f]{32})$/.exec(path);
  if(!create&&!(read&&request.method==='GET')&&!next&&!(result&&request.method==='POST'))return reply(404,{error:'接口不存在。'});
  if(!ready(env))return reply(503,{error:'生图服务暂未连接。'});
  const runner=next||!!result;
  const provided=runner?(request.headers.get('X-Yero-Runner')||''):(request.headers.get('Authorization')||'');
  const expected=runner?env.YERO_RUNNER_KEY:'Bearer '+env.YERO_ACCESS_CODE;
  if(!matchesSecret(provided,expected))return reply(401,{error:'访问码不正确。'});
  try{
   if(create){
    if(Number(request.headers.get('Content-Length')||0)>MAX_BODY_BYTES)return reply(413,{error:'上传内容过大。'});
    const body=await request.arrayBuffer();if(!body.byteLength||body.byteLength>MAX_BODY_BYTES)return reply(413,{error:'上传内容过大。'});
    try{const value=JSON.parse(new TextDecoder().decode(body));if(!value||typeof value.prompt!=='string'||!value.prompt.trim())return reply(400,{error:'请先填写画面描述。'});}catch{return reply(400,{error:'请求格式不正确。'});}
    const id=crypto.randomUUID().replaceAll('-','');
    await env.YERO_QUEUE.put('q/'+id,await encrypt(body,env.YERO_STORAGE_KEY),{expirationTtl:TTL});
    try{await env.YERO_QUEUE.put('latest',id,{expirationTtl:TTL});}catch{/* Periodic queue discovery will still find it. */}
    return reply(202,{id,status:'running'});
   }
   if(read){
    const data=await env.YERO_QUEUE.get('r/'+read[1],{type:'arrayBuffer'});
    if(!data)return reply(200,{status:'running'});
    const plain=await decrypt(data,env.YERO_STORAGE_KEY);
    return new Response(plain,{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
   }
   if(next){
    const latest=await env.YERO_QUEUE.get('latest')||'';
    const headers={'Cache-Control':'no-store','X-Yero-Latest':latest};
    if(url.searchParams.get('force')!=='1'&&latest===url.searchParams.get('last'))return new Response(null,{status:204,headers});
    const seen=new Set((request.headers.get('X-Yero-Seen')||'').split(',').filter(id=>/^[0-9a-f]{32}$/.test(id)).slice(-100));
    const listing=await env.YERO_QUEUE.list({prefix:'q/',limit:100});
    for(const item of listing.keys){
     const id=item.name.slice(2);if(!/^[0-9a-f]{32}$/.test(id)||seen.has(id))continue;
     const payload=await env.YERO_QUEUE.get(item.name,{type:'arrayBuffer'});if(!payload)continue;
     return new Response(payload,{status:200,headers:{...headers,'X-Yero-Job':id,'Content-Type':'application/octet-stream'}});
    }
    return new Response(null,{status:204,headers});
   }
   const declared=Number(request.headers.get('Content-Length')||0);
   if(declared>MAX_RESULT_BYTES)return reply(413,{error:'图片结果过大。'});
   const body=await request.arrayBuffer();if(body.byteLength<29||body.byteLength>MAX_RESULT_BYTES)return reply(400,{error:'图片结果无效。'});
   await env.YERO_QUEUE.put('r/'+result[1],body,{expirationTtl:TTL});
   return reply(200,{status:'stored'});
  }catch{return reply(503,{error:'生图服务暂时不可用，请稍后再试。'});}
 }
};

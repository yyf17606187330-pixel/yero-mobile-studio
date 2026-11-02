import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import atlas from '../assets/template-atlas.png';
import yeroLogo from '../assets/yero-logo.png';
import './MobileStudio.css';
import './Font.css';
import './Motion.css';
import {loadChatIndex,loadMessageMedia,saveChatMessage,setMessageFavorite} from './chatStorage';
import {PixelWave} from './PixelWave';
import {PaymentDemo} from './PaymentDemo';
import type {Brief,Creation,Conversation} from './chatStorage';

type Template={id:string;name:string;group:string;style:string;ratio:string;prompt:string;crop:string};
export const templates:Template[]=[
 {id:'poster',name:'海报',group:'设计',style:'品牌海报',ratio:'3:4',prompt:'一张复古植物海报，以鲜艳的橙红色虞美人作为主角，搭配奶油色纸张和温暖的杏色背景，保留清晰留白。',crop:'0 0 512 508'},
 {id:'room',name:'室内设计',group:'空间',style:'立体场景',ratio:'1:1',prompt:'一个温暖的等距视角客厅，奶油色沙发、木地板、绿植和大窗户，自然光，精致的微缩模型质感。',crop:'512 0 512 508'},
 {id:'logo',name:'徽标',group:'设计',style:'平面设计',ratio:'1:1',prompt:'设计一个原创鱼形圆形徽标，以深钴蓝和浅蓝灰配色，线条简洁、构图平衡，适合品牌标识。',crop:'0 508 512 483'},
 {id:'illustration',name:'插画',group:'插画',style:'手绘插画',ratio:'3:4',prompt:'一幅温暖的手绘插画：穿黄色毛衣的成年女生抱着一只黑白猫，柔和的薰衣草色背景，细腻笔触，轻松愉快。',crop:'512 508 512 483'},
 {id:'portrait',name:'职业形象照',group:'人像',style:'自然摄影',ratio:'3:4',prompt:'一张自然专业的成年女性职业形象照，简洁的浅色上衣，温暖的浅灰背景，自然柔光，保留真实皮肤质感。',crop:'0 991 512 545'},
 {id:'icons',name:'图标',group:'设计',style:'平面设计',ratio:'1:1',prompt:'一组清爽的原创贴纸图标，包含星星、星球、爱心和叶子，薄荷白配深青色背景，形状简洁，统一风格。',crop:'512 991 512 545'},
];
const styles=['自动','品牌海报','立体场景','平面设计','手绘插画','自然摄影'];
const ratios=['1:1','3:4','4:3','16:9','9:16'];
const resolutions=['原图','1K','2K','4K'];
type Overlay='history'|'settings'|'upload'|'access'|'payment'|null;
const newId=()=>globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
type ChatDraft={prompt:string;ratio:string;style:string;resolution:string;selected:string|null;reference:{name:string;url:string}|null;mask:string|null;error:string};
const emptyDraft=():ChatDraft=>({prompt:'',ratio:'1:1',style:'自动',resolution:'1K',selected:null,reference:null,mask:null,error:''});
type VoiceStage='starting'|'recording'|'transcribing';
type VoiceRecording={chatId:string;code:string;recorder:MediaRecorder;stream:MediaStream;chunks:Blob[];timer:number;bytes:number;cancelled:boolean;released:boolean;tooLarge:boolean};

function Glyph({name,size=22}:{name:string;size?:number}){
 const paths:Record<string,React.ReactNode>={
  menu:<><path d="M5 7h14M5 12h9M5 17h14"/></>,
  plus:<path d="M12 5v14M5 12h14"/>,
  close:<path d="m6 6 12 12M18 6 6 18"/>,
  arrow:<path d="M12 20V4m-6 6 6-6 6 6"/>,
  mic:<><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21m-3 0h6"/></>,
  stop:<rect x="7" y="7" width="10" height="10" rx="2"/>,
  search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
  image:<><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-7 5 8"/></>,
  edit:<><path d="m14 5 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15Z"/></>,
  star:<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>,
  moon:<path d="M20.5 14.2A8.8 8.8 0 0 1 9.8 3.5 9 9 0 1 0 20.5 14.2Z"/>,
  sun:<><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5"/></>,
  chevron:<path d="m9 5 7 7-7 7"/>,
  down:<path d="m7 10 5 5 5-5"/>,
  check:<path d="m5 12 4 4L19 6"/>,
  spark:<><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z"/></>,
 };
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]||paths.image}</svg>;
}

function TemplateArt({template}:{template:Template}){
 return <svg className="template-art" viewBox={template.crop} preserveAspectRatio="xMidYMid slice" role="img" aria-label={`${template.name}，示例模板`}><image href={atlas} width="1024" height="1536"/></svg>;
}

export function MobileStudio(){
 const [theme,setTheme]=useState<'light'|'dark'>('light');
 const [view,setView]=useState<'create'|'templates'>('templates');
 const [overlay,setOverlay]=useState<Overlay>(null);
 const [closing,setClosing]=useState(false);
 const [category,setCategory]=useState('全部');
 const [historyFilter,setHistoryFilter]=useState('聊天');
 const [search,setSearch]=useState('');
 const [activeChatId,setActiveChatId]=useState(()=>newId());
 const [drafts,setDrafts]=useState<Record<string,ChatDraft>>({});
 const {prompt,ratio,style,resolution,selected,reference,mask,error}=drafts[activeChatId]||emptyDraft();
 const [preview,setPreview]=useState<string|null>(null);const [painting,setPainting]=useState(false);const [painted,setPainted]=useState(false);const maskCanvas=useRef<HTMLCanvasElement>(null);const drawing=useRef(false);
 const [showAbout,setShowAbout]=useState(false);
 const [accessCode,setAccessCode]=useState(()=>{try{return window.sessionStorage.getItem('yero-access-code')||'';}catch{return '';}});
 const [accessDraft,setAccessDraft]=useState('');
 const [accessError,setAccessError]=useState('');
 const [pending,setPending]=useState<{brief:Brief;chatId:string;rawPrompt:string}|null>(null);
 const [pendingVoice,setPendingVoice]=useState<string|null>(null);
 const [voiceStates,setVoiceStates]=useState<Record<string,VoiceStage>>({});
 const [creations,setCreations]=useState<Creation[]>([]);
 const [conversations,setConversations]=useState<Conversation[]>([]);
 const [cacheError,setCacheError]=useState('');
 const [cacheLoading,setCacheLoading]=useState(true);
 const root=useRef<HTMLDivElement>(null);
 const promptRef=useRef<HTMLTextAreaElement>(null);
 const scrollArea=useRef<HTMLElement>(null);
 const dock=useRef<HTMLDivElement>(null);
 const fileInput=useRef<HTMLInputElement>(null);
 const attachButton=useRef<HTMLButtonElement>(null);
 const sendButton=useRef<HTMLButtonElement>(null);
 const voiceButton=useRef<HTMLButtonElement>(null);
 const dialog=useRef<HTMLElement>(null);
 const restoreFocus=useRef<HTMLElement|null>(null);
 const uploadToken=useRef(0);
 const reader=useRef<FileReader|null>(null);
 const running=useRef(new Set<string>());
 const generation=useRef(0);
 const activeChatRef=useRef(activeChatId);
 const draftsRef=useRef<Record<string,ChatDraft>>({});
 const creationsRef=useRef<Creation[]>([]);
 const conversationsRef=useRef<Conversation[]>([]);
 const cacheQueue=useRef<Promise<void>>(Promise.resolve());
 const mediaLoading=useRef(new Set<string>());
 const mounted=useRef(true);
 const voiceStatesRef=useRef<Record<string,VoiceStage>>({});
 const voiceRecording=useRef<VoiceRecording|null>(null);
 const voiceStarting=useRef<{chatId:string;token:number}|null>(null);
 const voiceToken=useRef(0);
 const patchDraft=(chatId:string,change:Partial<ChatDraft>)=>{
  const next={...(draftsRef.current[chatId]||emptyDraft()),...change};
  draftsRef.current={...draftsRef.current,[chatId]:next};setDrafts(draftsRef.current);
 };
 const setPrompt=(value:string)=>patchDraft(activeChatRef.current,{prompt:value});
 const setRatio=(value:string)=>patchDraft(activeChatRef.current,{ratio:value});
 const setStyle=(value:string)=>patchDraft(activeChatRef.current,{style:value});
 const setResolution=(value:string)=>patchDraft(activeChatRef.current,{resolution:value});
 const setSelected=(value:string|null)=>patchDraft(activeChatRef.current,{selected:value});
 const setReference=(value:{name:string;url:string}|null)=>patchDraft(activeChatRef.current,{reference:value,mask:null});
 const setError=(value:string)=>patchDraft(activeChatRef.current,{error:value});
 const setVoiceStage=(chatId:string,stage:VoiceStage|null)=>{const next={...voiceStatesRef.current};if(stage)next[chatId]=stage;else delete next[chatId];voiceStatesRef.current=next;if(mounted.current)setVoiceStates(next);};
 const openOverlay=(name:Overlay,trigger:HTMLElement)=>{restoreFocus.current=trigger;setClosing(false);setOverlay(name);};
 const finishClose=()=>{setOverlay(null);setClosing(false);};
 const closeOverlay=()=>{
  if(!overlay)return;
  if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){finishClose();return;}
  setClosing(true);
 };
 const replaceCreations=(items:Creation[])=>{creationsRef.current=items;setCreations(items);};
 const replaceConversations=(items:Conversation[])=>{conversationsRef.current=items;setConversations(items);};
 const persist=(chat:Conversation,item:Creation)=>{
  cacheQueue.current=cacheQueue.current.then(()=>saveChatMessage(chat,item)).then(()=>{if(mounted.current)setCacheError('');}).catch(()=>{if(mounted.current)setCacheError('本地记录未能保存，请及时保存图片。');});
 };
 const updateCreation=(id:string,change:Partial<Creation>)=>{
  const current=creationsRef.current.find(item=>item.id===id);if(!current)return;
  const next={...current,...change};replaceCreations(creationsRef.current.map(item=>item.id===id?next:item));
  const chat=conversationsRef.current.find(item=>item.id===next.chatId);if(chat)persist(chat,next);
 };
 function releaseVoice(entry:VoiceRecording){if(!entry.released){entry.released=true;entry.stream.getTracks().forEach(track=>track.stop());}}
 function stopVoice(cancel=false){
  const entry=voiceRecording.current;if(!entry)return;
  entry.cancelled=entry.cancelled||cancel;window.clearTimeout(entry.timer);
  try{if(entry.recorder.state!=='inactive')entry.recorder.stop();}catch{entry.cancelled=true;voiceRecording.current=null;setVoiceStage(entry.chatId,null);}
  releaseVoice(entry);
 }
 function leaveVoiceChat(){
  const starting=voiceStarting.current;if(starting?.chatId===activeChatRef.current){voiceToken.current++;voiceStarting.current=null;setVoiceStage(starting.chatId,null);}
  if(voiceRecording.current?.chatId===activeChatRef.current)stopVoice();
 }
 async function transcribeVoice(entry:VoiceRecording){
  const {chatId,code}=entry;const run=generation.current;
  try{
   const mime=(entry.recorder.mimeType||entry.chunks[0]?.type||'').split(';')[0].toLowerCase();
   if(!['audio/webm','audio/mp4','audio/ogg','audio/mpeg','audio/wav','audio/x-wav'].includes(mime))throw new Error('此浏览器的录音格式暂不支持。');
   const blob=new window.Blob(entry.chunks,{type:mime});
   if(!blob.size)throw new Error('没有录到声音，请再试一次。');
   if(blob.size>2*1024*1024)throw new Error('录音过大，请缩短后重试。');
   const audio=await new Promise<string>((resolve,reject)=>{const fileReader=new window.FileReader();fileReader.onload=()=>typeof fileReader.result==='string'?resolve(fileReader.result):reject(new Error('无法读取录音。'));fileReader.onerror=()=>reject(new Error('无法读取录音。'));fileReader.readAsDataURL(blob);});
   if(run!==generation.current)return;
   const headers={'Content-Type':'application/json','Authorization':'Bearer '+code};
   const call=async(url:string,options:RequestInit)=>{
    const controller=new AbortController();const timeout=window.setTimeout(()=>controller.abort(),25000);
    try{const response=await fetch(url,{...options,signal:controller.signal});const data=await response.json().catch(()=>({}));
     if(!response.ok){if(response.status===401){setAccessCode(current=>current===code?'':current);try{if(window.sessionStorage.getItem('yero-access-code')===code)window.sessionStorage.removeItem('yero-access-code');}catch{}}throw new Error(typeof data.error==='string'?data.error:'语音转录暂时不可用，请重试。');}return data;
    }finally{window.clearTimeout(timeout);}
   };
   const submitted=await call('/api/transcriptions',{method:'POST',headers,body:JSON.stringify({audio})});
   if(!/^[0-9a-f]{32}$/.test(submitted.id||''))throw new Error('语音提交失败，请重试。');
   for(let attempt=0;attempt<45;attempt++){
    if(run!==generation.current)return;
    const job=await call('/api/jobs/'+submitted.id,{method:'GET',headers});
    if(job.status==='failed')throw new Error(typeof job.error==='string'?job.error:'语音转录失败，请重试。');
    if(job.status==='completed'){
     if(typeof job.text!=='string'||!job.text.trim())throw new Error('没有听清内容，请再说一次。');
     const current=draftsRef.current[chatId]||emptyDraft();const separator=current.prompt.trim()&&!/\s$/.test(current.prompt)?' ':'';
     const remaining=4000-current.prompt.length-separator.length;if(remaining<=0)throw new Error('输入框已满，请精简内容后重试。');
     patchDraft(chatId,{prompt:current.prompt+separator+job.text.trim().slice(0,remaining),error:''});return;
    }
    await new Promise(resolve=>window.setTimeout(resolve,2000));
   }
   throw new Error('语音转录等待超时，请重试。');
  }catch(cause){if(run===generation.current&&mounted.current){const message=cause instanceof Error&&cause.name==='AbortError'?'语音连接超时，请重试。':cause instanceof Error?cause.message:'语音转录暂时不可用，请重试。';patchDraft(chatId,{error:message});}}
  finally{if(run===generation.current)setVoiceStage(chatId,null);}
 }
 async function beginVoice(chatId:string,code:string){
  if(voiceRecording.current||voiceStatesRef.current[chatId])return;
  if(!window.MediaRecorder||!window.navigator.mediaDevices?.getUserMedia){patchDraft(chatId,{error:'当前浏览器不支持录音，请换用支持麦克风的浏览器。'});return;}
  const token=++voiceToken.current;voiceStarting.current={chatId,token};setVoiceStage(chatId,'starting');patchDraft(chatId,{error:''});
  let stream:MediaStream|undefined;
  try{
   stream=await window.navigator.mediaDevices.getUserMedia({audio:true});
   if(!mounted.current||token!==voiceToken.current||activeChatRef.current!==chatId){stream.getTracks().forEach(track=>track.stop());return;}
   voiceStarting.current=null;
   const supported=['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg;codecs=opus'].find(type=>window.MediaRecorder.isTypeSupported?.(type));
   let recorder:MediaRecorder;try{recorder=new window.MediaRecorder(stream,supported?{mimeType:supported,audioBitsPerSecond:32000}:{audioBitsPerSecond:32000});}catch{recorder=new window.MediaRecorder(stream);}
   const entry:VoiceRecording={chatId,code,recorder,stream,chunks:[],timer:0,bytes:0,cancelled:false,released:false,tooLarge:false};voiceRecording.current=entry;
   recorder.ondataavailable=event=>{if(event.data.size){entry.chunks.push(event.data);entry.bytes+=event.data.size;if(entry.bytes>2*1024*1024){entry.tooLarge=true;stopVoice();}}};
   recorder.onerror=()=>{entry.cancelled=true;stopVoice(true);if(mounted.current){setVoiceStage(chatId,null);patchDraft(chatId,{error:'录音中断，请重试。'});}};
   recorder.onstop=()=>{window.clearTimeout(entry.timer);releaseVoice(entry);if(voiceRecording.current===entry)voiceRecording.current=null;
    if(!mounted.current||entry.cancelled){setVoiceStage(chatId,null);return;}
    if(entry.tooLarge){setVoiceStage(chatId,null);patchDraft(chatId,{error:'录音过大，请缩短后重试。'});return;}
    setVoiceStage(chatId,'transcribing');void transcribeVoice(entry);
   };
   recorder.start(1000);entry.timer=window.setTimeout(()=>stopVoice(),55000);setVoiceStage(chatId,'recording');if(activeChatRef.current===chatId)setView('create');
  }catch(cause){
   if(voiceRecording.current&&voiceRecording.current.stream===stream){const entry=voiceRecording.current;entry.cancelled=true;window.clearTimeout(entry.timer);releaseVoice(entry);}else if(stream)stream.getTracks().forEach(track=>track.stop());
   if(token===voiceToken.current&&mounted.current){voiceStarting.current=null;voiceRecording.current=null;setVoiceStage(chatId,null);const name=cause&&typeof cause==='object'&&'name' in cause?String(cause.name):'';patchDraft(chatId,{error:name==='NotAllowedError'||name==='SecurityError'?'请允许麦克风权限后重试。':name==='NotFoundError'?'没有检测到麦克风。':'无法开始录音，请重试。'});}
  }
 }
 function requestVoice(){
  const chatId=activeChatRef.current,stage=voiceStatesRef.current[chatId];
  if(stage==='recording'){stopVoice();return;}
  if(stage||voiceRecording.current)return;
  if(!accessCode){setPending(null);setPendingVoice(chatId);setAccessDraft('');setAccessError('');if(voiceButton.current)openOverlay('access',voiceButton.current);return;}
  void beginVoice(chatId,accessCode);
 }

 useEffect(()=>{
  let live=true;loadChatIndex().then(saved=>{
   if(!live)return;
   const chats=new Map(saved.chats.map(item=>[item.id,item]));for(const item of conversationsRef.current)chats.set(item.id,item);
   const messages=new Map(saved.messages.map(item=>[item.id,item.status==='pending'?{...item,status:'failed' as const,error:'上次任务未完成，请重新发送。'}:item]));
   for(const item of creationsRef.current)messages.set(item.id,item);
   replaceConversations([...chats.values()]);replaceCreations([...messages.values()]);setCacheLoading(false);
  }).catch(()=>{if(live){setCacheError('本地记录不可用，请及时保存图片。');setCacheLoading(false);}});
  return()=>{live=false;};
 },[]);
 useEffect(()=>{
  if(!activeChatId)return;
  for(const item of creations){
   if(item.chatId!==activeChatId||mediaLoading.current.has(item.id)||(!(item.hasImage&&!item.image)&&!(item.hasReference&&!item.brief.reference)))continue;
   mediaLoading.current.add(item.id);
   loadMessageMedia(item.id).then(media=>{
    if(!mounted.current)return;const current=creationsRef.current.find(entry=>entry.id===item.id);if(!current)return;
    const missing=current.hasImage&&!current.image&&!media.image;
    const next={...current,image:current.image||media.image,brief:{...current.brief,reference:current.brief.reference||media.reference},hasImage:false,hasReference:false,...(missing?{status:'failed' as const,error:'本地图片无法读取，请重新生成。'}:{})};
    replaceCreations(creationsRef.current.map(entry=>entry.id===item.id?next:entry));
    if(activeChatRef.current===item.chatId)bottom();
   }).catch(()=>{if(mounted.current)setCacheError('部分本地图片无法读取。');}).finally(()=>mediaLoading.current.delete(item.id));
  }
 },[activeChatId,creations]);

 useEffect(()=>{
  if(!closing)return;
  // Release the modal even if the browser skips or cancels animationend.
  const timer=window.setTimeout(()=>{setOverlay(null);setClosing(false);},340);
  return()=>window.clearTimeout(timer);
 },[closing]);

 useEffect(()=>{
  const viewport=window.visualViewport;
  const sync=()=>{const height=Math.round(viewport?.height||window.innerHeight);root.current?.style.setProperty('--viewport-h',`${height}px`);if(root.current)root.current.dataset.keyboard=String(height<500&&['INPUT','TEXTAREA'].includes(document.activeElement?.tagName||''));};
  sync();viewport?.addEventListener('resize',sync);window.addEventListener('resize',sync);document.addEventListener('focusin',sync);document.addEventListener('focusout',sync);
  return()=>{viewport?.removeEventListener('resize',sync);window.removeEventListener('resize',sync);document.removeEventListener('focusin',sync);document.removeEventListener('focusout',sync);};
 },[]);
 useLayoutEffect(()=>{
  const el=promptRef.current;if(!el)return;el.style.height='auto';el.style.height=`${Math.min(112,Math.max(48,el.scrollHeight))}px`;
 },[prompt]);
 useEffect(()=>{
  const measure=()=>{root.current?.style.setProperty('--dock-h',`${dock.current?.getBoundingClientRect().height||170}px`);};
  measure();if(typeof ResizeObserver==='undefined')return;
  const observer=new ResizeObserver(measure);if(dock.current)observer.observe(dock.current);return()=>observer.disconnect();
 },[]);
 useEffect(()=>{
  if(!overlay)return;
  const prior=document.body.style.overflow;document.body.style.overflow='hidden';
  // The panel is still sliding in; focusing must not scroll its hidden ancestors.
  dialog.current?.querySelector<HTMLElement>('[data-initial-focus]')?.focus({preventScroll:true});
  const key=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){event.preventDefault();closeOverlay();}
   if(event.key==='Tab'){
    const nodes=[...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input,select,textarea,[tabindex="0"]')||[])].filter(e=>e.getClientRects().length);
    const first=nodes[0],last=nodes[nodes.length-1];if(!first)return;
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
   }
  };
  window.addEventListener('keydown',key);
  return()=>{document.body.style.overflow=prior;window.removeEventListener('keydown',key);restoreFocus.current?.focus({preventScroll:true});};
 },[overlay]);
 useEffect(()=>()=>{mounted.current=false;uploadToken.current++;generation.current++;voiceToken.current++;reader.current?.abort();stopVoice(true);},[]);
 const top=()=>{if(scrollArea.current)scrollArea.current.scrollTop=0;};
 const bottom=()=>{window.setTimeout(()=>{if(scrollArea.current)scrollArea.current.scrollTop=scrollArea.current.scrollHeight;},0);};
 const rememberDraft=()=>{
  const id=activeChatRef.current;const draft=draftsRef.current[id]||emptyDraft();
  if((!draft.prompt.trim()&&!draft.selected&&!draft.reference&&!voiceStatesRef.current[id])||conversationsRef.current.some(chat=>chat.id===id))return;
  const now=Date.now();const title=draft.prompt.trim().slice(0,36)||templates.find(item=>item.id===draft.selected)?.name||(voiceStatesRef.current[id]?'语音草稿':'未发送的草稿');
  replaceConversations([{id,title,createdAt:now,updatedAt:now},...conversationsRef.current]);
 };
 const switchView=(value:'create'|'templates')=>{setView(value);top();};
 const choose=(template:Template,trigger:HTMLElement)=>{uploadToken.current++;reader.current?.abort();setSelected(template.id);setPrompt(template.prompt);setRatio(template.ratio);setStyle(template.style);setError('');if(reference){setView('create');bottom();}else openOverlay('upload',trigger);};
 const startNew=()=>{rememberDraft();leaveVoiceChat();uploadToken.current++;reader.current?.abort();const nextId=newId();activeChatRef.current=nextId;setActiveChatId(nextId);setPending(null);setPendingVoice(null);setView('create');closeOverlay();if(fileInput.current)fileInput.current.value='';top();};
 const generate=async(next:Brief,code:string,chatId:string,rawPrompt:string)=>{
  if(running.current.has(chatId))return;
  running.current.add(chatId);const run=generation.current;const now=Date.now();const existing=conversationsRef.current.find(item=>item.id===chatId);
  const chat:Conversation=existing?{...existing,updatedAt:now}:{id:chatId,title:next.prompt.slice(0,36),createdAt:now,updatedAt:now};
  const item:Creation={id:newId(),chatId,brief:next,image:null,favorite:false,status:'pending',createdAt:now};
  replaceConversations([chat,...conversationsRef.current.filter(value=>value.id!==chatId)]);replaceCreations([item,...creationsRef.current]);persist(chat,item);
  patchDraft(chatId,{error:''});if(activeChatRef.current===chatId){setView('create');promptRef.current?.blur();bottom();}
  try{
   const call=async(url:string,options:RequestInit)=>{
    const response=await fetch(url,options);const data=await response.json().catch(()=>({}));
    if(!response.ok){if(response.status===401){setAccessCode('');try{window.sessionStorage.removeItem('yero-access-code');}catch{}}throw new Error(typeof data.error==='string'?data.error:'生图服务暂时不可用，请稍后再试。');}
    return data;
   };
   const headers={'Content-Type':'application/json','Authorization':'Bearer '+code};
   const submitted=await call('/api/jobs',{method:'POST',headers,body:JSON.stringify(next)});
   if(!/^[0-9a-f]{32}$/.test(submitted.id||''))throw new Error('生图任务创建失败，请重试。');
   if(run!==generation.current)return;updateCreation(item.id,{remoteId:submitted.id});
   const currentDraft=draftsRef.current[chatId];const clear:Partial<ChatDraft>={};if(currentDraft?.prompt===rawPrompt)clear.prompt='';if(currentDraft?.reference?.url===next.reference){clear.reference=null;clear.mask=null;clear.selected=null;}patchDraft(chatId,clear);
   let completed=false;
   for(let attempt=0;attempt<(next.resolution==='2K'||next.resolution==='4K'?300:200);attempt++){
    if(run!==generation.current)return;
    const job=await call('/api/jobs/'+submitted.id,{method:'GET',headers});
    if(job.status==='failed')throw new Error(typeof job.error==='string'?job.error:'生图失败，请重试。');
    if(job.status==='completed'){
     if(typeof job.image!=='string'||!/^data:image\/(?:png|webp);base64,[A-Za-z0-9+/=]+$/.test(job.image))throw new Error('返回的图片无效，请重试。');
     updateCreation(item.id,{status:'completed',image:job.image,hasImage:true});if(activeChatRef.current===chatId)bottom();completed=true;break;
    }
    await new Promise(resolve=>window.setTimeout(resolve,5000));
   }
   if(!completed&&run===generation.current)throw new Error('等待时间过长，请稍后重试。');
  }catch(cause){if(run===generation.current){const message=cause instanceof Error?cause.message:'生图服务暂时不可用，请稍后再试。';updateCreation(item.id,{status:'failed',error:message});patchDraft(chatId,{error:message});}}
  finally{running.current.delete(chatId);}
 };
 const submit=(event:React.FormEvent)=>{event.preventDefault();const chatId=activeChatRef.current;if(running.current.has(chatId)||voiceStatesRef.current[chatId])return;if(selected&&!reference){setError('请先上传图片。');if(attachButton.current)openOverlay('upload',attachButton.current);return;}if(!prompt.trim()){setError('先描述一下你想要的画面。');promptRef.current?.focus({preventScroll:true});return;}const next={prompt:prompt.trim(),ratio,style,resolution,reference:reference?.url||null,mask};if(!accessCode){setPendingVoice(null);setPending({brief:next,chatId,rawPrompt:prompt});setAccessDraft('');setAccessError('');if(sendButton.current)openOverlay('access',sendButton.current);return;}void generate(next,accessCode,chatId,prompt);};
 const saveAccess=(event:React.FormEvent)=>{event.preventDefault();const code=accessDraft.trim();if(!code){setAccessError('请输入访问码。');return;}setAccessCode(code);try{window.sessionStorage.setItem('yero-access-code',code);}catch{}setAccessError('');closeOverlay();if(pending){const next=pending;setPending(null);void generate(next.brief,code,next.chatId,next.rawPrompt);}else if(pendingVoice){const chatId=pendingVoice;setPendingVoice(null);void beginVoice(chatId,code);}};
 const readReference=(file?:File)=>{
  if(!file)return;
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)){setError('请选择 JPG、PNG 或 WebP 图片。');return;}
  if(file.size>17*1024*1024){setError('参考图请不大于 17 MB。');return;}
  const token=++uploadToken.current;reader.current?.abort();const next=new FileReader();reader.current=next;
  next.onload=()=>{if(token!==uploadToken.current)return;setReference({name:file.name,url:String(next.result)});setError('');if(selected){setView('create');top();}if(overlay==='upload'){restoreFocus.current=attachButton.current;closeOverlay();}};
  next.onerror=()=>{if(token===uploadToken.current)setError('图片读取失败，请重新选择。');};next.readAsDataURL(file);
 };
 const visible=templates.filter(t=>category==='全部'||t.group===category);
 const selectedTemplate=templates.find(t=>t.id===selected);
 const activeMessages=creations.filter(item=>item.chatId===activeChatId).sort((a,b)=>a.createdAt-b.createdAt);
 const generating=activeMessages.some(item=>item.status==='pending');
 const voiceStage=voiceStates[activeChatId];
 const visibleChats=conversations.filter(chat=>!search.trim()||chat.title.toLowerCase().includes(search.trim().toLowerCase())||creations.some(item=>item.chatId===chat.id&&item.brief.prompt.toLowerCase().includes(search.trim().toLowerCase()))).sort((a,b)=>b.updatedAt-a.updatedAt);
 const visibleCreations=creations.filter(item=>item.status==='completed'&&(historyFilter!=='收藏'||item.favorite)&&item.brief.prompt.toLowerCase().includes(search.trim().toLowerCase())).sort((a,b)=>b.createdAt-a.createdAt);
 const openChat=(chatId:string)=>{if(chatId!==activeChatRef.current){rememberDraft();leaveVoiceChat();}uploadToken.current++;reader.current?.abort();activeChatRef.current=chatId;setActiveChatId(chatId);setPending(null);setPendingVoice(null);setView('create');closeOverlay();if(fileInput.current)fileInput.current.value='';bottom();};
 const toggleFavorite=(item:Creation)=>{const favorite=!item.favorite;replaceCreations(creationsRef.current.map(entry=>entry.id===item.id?{...entry,favorite}:entry));cacheQueue.current=cacheQueue.current.then(()=>setMessageFavorite(item.id,favorite)).catch(()=>{if(mounted.current)setCacheError('收藏未能保存到本机。');});};
 const drawMask=(event:React.PointerEvent<HTMLCanvasElement>,start=false)=>{const canvas=event.currentTarget;if(start){drawing.current=true;canvas.setPointerCapture(event.pointerId);}if(!drawing.current)return;const rect=canvas.getBoundingClientRect(),ctx=canvas.getContext('2d');if(!ctx||!rect.width||!rect.height)return;const x=(event.clientX-rect.left)*canvas.width/rect.width,y=(event.clientY-rect.top)*canvas.height/rect.height;ctx.strokeStyle='#4e79ff';ctx.fillStyle='#4e79ff';ctx.lineWidth=Math.max(20,canvas.width*.05);ctx.lineCap='round';ctx.lineJoin='round';if(start){ctx.beginPath();ctx.arc(x,y,ctx.lineWidth/2,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.moveTo(x,y);}else{ctx.lineTo(x,y);ctx.stroke();}setPainted(true);};
 const applyMask=()=>{const canvas=maskCanvas.current;if(!canvas||!preview||!painted)return;const output=document.createElement('canvas');output.width=canvas.width;output.height=canvas.height;const ctx=output.getContext('2d');if(!ctx)return;ctx.fillStyle='#fff';ctx.fillRect(0,0,output.width,output.height);ctx.globalCompositeOperation='destination-out';ctx.drawImage(canvas,0,0);patchDraft(activeChatRef.current,{reference:{name:'局部修改',url:preview},mask:output.toDataURL('image/png'),resolution:'原图',selected:null,error:''});setPreview(null);setPainting(false);setPainted(false);setView('create');promptRef.current?.focus();};

 const uploadPanel=<section ref={dialog} className="settings-sheet upload-sheet" role="dialog" aria-modal="true" aria-labelledby="upload-title">
  <span className="sheet-handle"/>
  <div className="sheet-heading"><h2 id="upload-title">先上传你的图片</h2><button data-initial-focus className="round-button" aria-label="关闭模板上传提示" onClick={closeOverlay}><Glyph name="close"/></button></div>
  <div className="upload-template-summary">{selectedTemplate&&<span className="upload-template-thumb"><TemplateArt template={selectedTemplate}/></span>}<div><p>使用「{selectedTemplate?.name}」需要一张图片。</p><span>上传后，可以继续描述。</span></div></div>
  <p className="upload-formats">请选择 JPG、PNG 或 WebP 图片，不大于 17 MB。参考图会发送至生图服务处理，结果按生成图片的原始比例显示。</p>
  {error&&<p className="mobile-error" role="alert">{error}</p>}
  <button className="sheet-done upload-primary" onClick={()=>fileInput.current?.click()} aria-label="选择模板图片"><Glyph name="plus" size={21}/>上传图片</button>
 </section>;

 const accessPanel=<section ref={dialog} className="settings-sheet access-sheet" role="dialog" aria-modal="true" aria-labelledby="access-title">
  <span className="sheet-handle"/><div className="sheet-heading"><h2 id="access-title">连接生图服务</h2><button className="round-button" aria-label="关闭访问码" onClick={()=>{setPendingVoice(null);closeOverlay();}}><Glyph name="close"/></button></div>
  <p className="access-note">输入测试访问码。参考图和描述会发送至生图服务处理。</p>
  <form onSubmit={saveAccess}><label htmlFor="access-code">访问码</label><input data-initial-focus id="access-code" type="password" autoComplete="off" value={accessDraft} onChange={e=>{setAccessDraft(e.target.value);setAccessError('');}} placeholder="输入访问码"/>
   {accessError&&<p className="mobile-error" role="alert">{accessError}</p>}<button className="sheet-done" type="submit">{pending?'连接并生成':pendingVoice?'连接并录音':'保存访问码'}</button></form>
 </section>;

 return <div ref={root} className={`mobile-studio mode-${theme}`}>
  <div className="phone-shell">
   <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e=>readReference(e.target.files?.[0])}/>
   <div className="phone-content" inert={overlay?true:undefined}>
    <header className="mobile-header"><button className="round-button" onClick={e=>openOverlay('history',e.currentTarget)} aria-label="打开侧边栏" aria-expanded={overlay==='history'}><Glyph name="menu"/></button><div className="yero-brand"><img src={yeroLogo} alt=""/><span>Yero</span></div><div className="view-switch" data-view={view} aria-label="生图工作区"><button aria-pressed={view==='create'} className={view==='create'?'active':''} onClick={()=>switchView('create')}>创作</button><button aria-pressed={view==='templates'} className={view==='templates'?'active':''} onClick={()=>switchView('templates')}>模板</button></div><button className="round-button" onClick={startNew} aria-label="新建聊天"><Glyph name="edit" size={21}/></button></header>
    <main ref={scrollArea} className="mobile-scroll">
     {view==='templates'?<section className="template-browser"><div className="template-title"><h1>从灵感开始</h1><span>示例模板</span></div><p id="template-upload-note" className="template-upload-note"><Glyph name="image" size={16}/>使用模板前，请先上传一张图片。</p><div className="category-scroll" aria-label="模板分类">{['全部','设计','空间','插画','人像'].map(c=><button key={c} className={category===c?'active':''} aria-pressed={category===c} onClick={()=>setCategory(c)}>{c}</button>)}</div><div key={category} className="mobile-template-grid">{visible.map(t=><button key={t.id} aria-describedby="template-upload-note" className={`mobile-template tile-${t.id}`} onClick={e=>choose(t,e.currentTarget)} aria-label={`使用${t.name}模板`}><TemplateArt template={t}/><span className="template-shade"/><span className="template-requirement"><Glyph name="image" size={12}/>需上传图片</span><span className="mobile-template-label">{t.name}<Glyph name="chevron" size={15}/></span></button>)}</div></section>:activeMessages.length?<section className="mobile-conversation" aria-label="聊天与结果区">{activeMessages.map(item=><article className="conversation-turn" key={item.id}>
      <div className="user-request"><p>{item.brief.prompt}</p><span>{item.brief.style} · {item.brief.ratio} · {item.brief.resolution||'原图'}</span></div>{item.brief.reference&&<div className="user-reference"><img src={item.brief.reference} alt="本次参考图片"/></div>}
      {item.image?<div className="mobile-result has-image"><button type="button" className="image-open" aria-label="放大查看图片" onClick={()=>{setPreview(item.image);setPainting(false);setPainted(false);}}><img className="generated-image" src={item.image} alt="生成的图片"/></button><div className="result-actions"><a className="save-image" href={item.image} download={item.image.startsWith('data:image/webp')?'Yero-image.webp':'Yero-image.png'}>保存图片</a><button className="result-favorite" aria-label={item.favorite?'取消收藏':'收藏图片'} aria-pressed={item.favorite} onClick={()=>toggleFavorite(item)}><Glyph name="star" size={18}/></button></div><p>点击图片放大或局部修改</p></div>:<div className="mobile-result" aria-live="polite">{item.status==='pending'?<div className="image-wait" aria-hidden="true"><PixelWave/><span className="generation-loading"><i/><i/><i/></span></div>:<span className="result-line-icon"><Glyph name="image" size={28}/></span>}<h1>{item.status==='failed'?'暂时没有生成图片':item.status==='completed'?'正在读取图片':'正在生成图片'}</h1><p>{item.status==='failed'?item.error:item.status==='completed'?'正在从本机记录中读取。':'通常需要几分钟，请保持页面打开。'}</p>{item.status==='pending'&&<span className="demo-status">正在处理</span>}</div>}
     </article>)}</section>:<section className="mobile-start"><span className="start-mark"><img className="start-logo" src={yeroLogo} alt=""/></span><h1>让想法，有画面。</h1><p>{selectedTemplate?(reference?`已选择「${selectedTemplate.name}」，可以继续描述。`:'请先上传图片，继续使用模板。'):'写下一个想法，或从模板开始。'}</p></section>}
    </main>
    <div ref={dock} className="mobile-dock">
     {view==='create'&&!activeMessages.length&&!selected&&<div className="quick-prompts" aria-label="创作灵感">{[templates[0],templates[1],templates[4]].map(t=><button key={t.id} onClick={e=>choose(t,e.currentTarget)}>{t.name}<Glyph name="chevron" size={14}/></button>)}</div>}
     <form className={`mobile-composer ${error?'invalid':''}`} onSubmit={submit}>
      {(selectedTemplate||reference)&&<div className="composer-attachments">{selectedTemplate&&<span className="template-token"><span className="mini-template"><TemplateArt template={selectedTemplate}/></span>{selectedTemplate.name}{!reference&&<small>待上传</small>}<button type="button" aria-label="移除模板标记" onClick={()=>{setSelected(null);setError('');}}><Glyph name="close" size={14}/></button></span>}{reference&&<span className="reference-token"><img src={reference.url} alt="已选择的参考图"/><span>参考图</span><button type="button" aria-label="移除参考图" onClick={()=>{uploadToken.current++;setReference(null);if(fileInput.current)fileInput.current.value='';}}><Glyph name="close" size={14}/></button></span>}</div>}
      <label className="visually-hidden" htmlFor="mobile-prompt">描述你想生成的图片</label><textarea id="mobile-prompt" ref={promptRef} value={prompt} maxLength={4000} onChange={e=>{setPrompt(e.target.value);setError('');}} rows={2} placeholder="描述你想创作的画面…" aria-invalid={!!error} aria-describedby={error?'mobile-error':'preview-note'}/>
      <div className="mobile-composer-tools"><div className="mobile-tools-left"><button type="button" ref={attachButton} className="attach-button" aria-label="添加本地参考图" title="参考图会发送至生图服务处理" onClick={e=>selected&&!reference?openOverlay('upload',e.currentTarget):fileInput.current?.click()}><Glyph name="plus" size={26}/></button><button type="button" className="setting-chip" aria-label={`画面比例 ${ratio}`} onClick={e=>openOverlay('settings',e.currentTarget)}><span className="ratio-icon"/>{ratio}<span className="resolution-inline">{resolution}</span><Glyph name="down" size={12}/></button><button type="button" className="setting-chip style-chip" aria-label={`图片风格 ${style}`} onClick={e=>openOverlay('settings',e.currentTarget)}>{style}<Glyph name="down" size={12}/></button></div><div className="mobile-tools-right"><button ref={voiceButton} className={`voice-button${voiceStage==='recording'?' is-recording':''}`} type="button" disabled={voiceStage==='starting'||voiceStage==='transcribing'} aria-label={voiceStage==='recording'?'停止录音':voiceStage==='starting'?'正在打开麦克风':voiceStage==='transcribing'?'正在转文字':'语音输入'} aria-pressed={voiceStage==='recording'} onClick={requestVoice}><Glyph name={voiceStage==='recording'?'stop':'mic'} size={20}/></button><button ref={sendButton} className="send-button" type="submit" disabled={generating||!!voiceStage} aria-label={generating?'正在生成图片':voiceStage?'等待语音转录':'生成图片'}><Glyph name="arrow" size={25}/></button></div></div>
      {voiceStage&&<div className="voice-status" role="status"><span>{voiceStage==='starting'?'正在打开麦克风':voiceStage==='recording'?'录音中 · 点击停止':'正在转成文字'}</span>{voiceStage==='recording'&&<small>语音将加密发送到本机转录</small>}</div>}
      {error&&<p id="mobile-error" className="mobile-error" role="alert">{error}</p>}
     </form><p id="preview-note" className="preview-note">{cacheError||'聊天记录保存在本机浏览器'}　<button type="button" onClick={e=>{setPending(null);setPendingVoice(null);setAccessDraft('');setAccessError('');openOverlay('access',e.currentTarget);}}>管理访问码</button></p>
    </div>
   </div>
   {preview&&<section className="image-viewer" role="dialog" aria-modal="true" aria-label="图片预览"><div className="viewer-header"><button type="button" onClick={()=>{setPreview(null);setPainting(false);}} aria-label="关闭图片预览"><Glyph name="close"/></button><span>{painting?'涂抹要修改的区域':'图片预览'}</span><a href={preview} download="Yero-image.png">保存</a></div><div className="viewer-actions" aria-label="图片编辑工具">{painting?<><button type="button" onClick={()=>{const c=maskCanvas.current;c?.getContext('2d')?.clearRect(0,0,c.width,c.height);setPainted(false);}}>清除涂抹</button><button type="button" className="viewer-primary" disabled={!painted} onClick={applyMask}>使用选区</button></>:<button type="button" className="viewer-primary" onClick={()=>setPainting(true)}><Glyph name="edit" size={18}/>涂抹局部修改</button>}</div><div className="viewer-stage"><div className="viewer-image"><img src={preview} alt="放大的生成图片" onLoad={e=>{const canvas=maskCanvas.current;if(canvas){canvas.width=e.currentTarget.naturalWidth;canvas.height=e.currentTarget.naturalHeight;}}}/><canvas ref={maskCanvas} className={painting?'viewer-mask active':'viewer-mask'} onPointerDown={e=>drawMask(e,true)} onPointerMove={e=>drawMask(e)} onPointerUp={()=>{drawing.current=false;}} onPointerCancel={()=>{drawing.current=false;}}/></div></div></section>}
   {overlay&&<div className={`overlay-layer overlay-${overlay}${closing?' is-closing':''}`} onAnimationEnd={event=>{if(closing&&event.target===dialog.current)finishClose();}}>
    <button className="overlay-backdrop" aria-label="关闭弹层遮罩" onClick={closeOverlay}/>
    {overlay==='payment'?<section ref={dialog} className="settings-sheet payment-sheet" role="dialog" aria-modal="true" aria-label="模拟付款"><PaymentDemo onClose={closeOverlay}/></section>:overlay==='history'?<aside ref={dialog} className="history-drawer" role="dialog" aria-modal="true" aria-labelledby="history-title">
     <div className="drawer-profile"><span className="drawer-avatar"><img src={yeroLogo} alt=""/></span><div><strong>Yero</strong><p>我的创作空间</p></div><button data-initial-focus className="round-button" aria-label="关闭侧边栏" onClick={closeOverlay}><Glyph name="chevron"/></button></div>
     <button className="drawer-new" onClick={startNew}><Glyph name="plus" size={20}/>新建聊天</button>
     <button className="drawer-payment" onClick={e=>openOverlay('payment',root.current?.querySelector<HTMLElement>('[aria-label="打开侧边栏"]')||e.currentTarget)}>测试订单</button>
     <div className="history-tabs">{['聊天','图片','收藏'].map(c=><button key={c} aria-pressed={historyFilter===c} className={historyFilter===c?'active':''} onClick={()=>setHistoryFilter(c)}>{c}</button>)}</div>
     <div className="history-title"><h2 id="history-title">{historyFilter==='聊天'?'聊天记录':historyFilter==='收藏'?'我的收藏':'我的图片'}</h2><span>{historyFilter==='聊天'?`${conversations.length} 条`:`${visibleCreations.length} 张`}</span></div>
     {cacheLoading&&!conversations.length?<div className="history-empty" aria-live="polite"><p>正在读取本地记录…</p></div>:historyFilter==='聊天'?(visibleChats.length?<div className="chat-list">{visibleChats.map(chat=><button key={chat.id} className={`chat-open ${activeChatId===chat.id?'active':''}`} onClick={()=>openChat(chat.id)}><span>{chat.title}</span><small>{new Date(chat.updatedAt).toLocaleDateString('zh-CN',{month:'short',day:'numeric'})}</small></button>)}</div>:<div className="history-empty" aria-live="polite"><Glyph name="edit" size={30}/><h3>{search?'没有匹配的聊天':'还没有聊天记录'}</h3><p>{search?'可以清除搜索后再看看。':'开始创作后，聊天会保存在本机。'}</p>{search&&<button onClick={()=>setSearch('')}>清除搜索</button>}</div>):visibleCreations.length?<div className="history-list">{visibleCreations.map(item=><div className="history-item" key={item.id}><button className="history-open" onClick={()=>openChat(item.chatId)}>{item.image?<img src={item.image} alt=""/>:<span className="history-image-placeholder"><Glyph name="image" size={20}/></span>}<span>{item.brief.prompt}</span></button><button className="history-favorite" aria-label={item.favorite?'取消收藏':'收藏图片'} aria-pressed={item.favorite} onClick={()=>toggleFavorite(item)}><Glyph name="star" size={18}/></button></div>)}</div>:<div className="history-empty" aria-live="polite"><Glyph name="image" size={30}/><h3>{search?'没有匹配的图片':historyFilter==='收藏'?'还没有收藏':'还没有作品'}</h3><p>{search?'可以清除搜索后再看看。':historyFilter==='收藏'?'收藏后的图片会显示在这里。':'生成的图片会显示在这里。'}</p>{search&&<button onClick={()=>setSearch('')}>清除搜索</button>}</div>}
     <div className="drawer-bottom">{showAbout&&<p className="drawer-about">聊天和图片保存在当前设备的浏览器中，清除浏览器数据会删除记录。参考图、描述和结果也会在本机服务保留，任务在云端加密暂存约一小时。</p>}<button className="about-button" aria-expanded={showAbout} onClick={()=>setShowAbout(!showAbout)}>本地记录说明 <Glyph name="down" size={13}/></button><div className="drawer-bottom-tools"><button className="round-button" aria-label={theme==='light'?'切换深色主题':'切换浅色主题'} onClick={()=>setTheme(theme==='light'?'dark':'light')}><Glyph name={theme==='light'?'moon':'sun'}/></button><label className="history-search"><Glyph name="search" size={19}/><input aria-label="搜索聊天和图片" value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜索记录"/>{search&&<button aria-label="清除搜索" onClick={()=>setSearch('')}><Glyph name="close" size={16}/></button>}</label><button className="drawer-compose" aria-label="从侧边栏新建聊天" onClick={startNew}><Glyph name="edit" size={22}/></button></div></div>
    </aside>:overlay==='upload'?uploadPanel:overlay==='access'?accessPanel:<section ref={dialog} className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title"><span className="sheet-handle"/><div className="sheet-heading"><h2 id="settings-title">画面设置</h2><button data-initial-focus className="round-button" aria-label="关闭画面设置" onClick={closeOverlay}><Glyph name="close"/></button></div><fieldset><legend>画面比例</legend><div className="ratio-grid">{ratios.map(r=><button key={r} aria-pressed={ratio===r} className={ratio===r?'active':''} onClick={()=>setRatio(r)}><span className={`ratio-drawing ratio-${r.replace(':','-')}`}/><span>{r}</span></button>)}</div></fieldset><fieldset><legend>分辨率</legend><div className="resolution-grid">{resolutions.map(value=><button key={value} aria-pressed={resolution===value} className={resolution===value?'active':''} onClick={()=>setResolution(value)}>{value}</button>)}<button disabled title="原生接口待配置">2K Ultra</button><button disabled title="原生接口待配置">4K Ultra</button></div><p className="resolution-note">2K / 4K 使用本机 Upscayl 超分；Ultra 原生接口待配置。</p></fieldset><fieldset><legend>风格方向</legend><div className="style-grid">{styles.map(s=><button key={s} aria-pressed={style===s} className={style===s?'active':''} onClick={()=>setStyle(s)}>{s}{style===s&&<Glyph name="check" size={15}/>}</button>)}</div></fieldset><button className="sheet-done" onClick={closeOverlay}>完成</button></section>}
   </div>}
  </div>
 </div>;
}

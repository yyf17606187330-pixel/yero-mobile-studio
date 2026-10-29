export type Brief={prompt:string;ratio:string;style:string;resolution:string;reference:string|null};
export type Creation={id:string;chatId:string;brief:Brief;image:string|null;favorite:boolean;status:'pending'|'completed'|'failed';createdAt:number;error?:string;remoteId?:string;hasImage?:boolean;hasReference?:boolean};
export type Conversation={id:string;title:string;createdAt:number;updatedAt:number};

const DB_NAME='yero-conversations-v1';
let connection:Promise<IDBDatabase>|null=null;

function database():Promise<IDBDatabase>{
 if(!connection){
  connection=new Promise((resolve,reject)=>{
   if(typeof indexedDB==='undefined'){reject(new Error('Local storage unavailable'));return;}
   const request=indexedDB.open(DB_NAME,1);
   request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('chats'))db.createObjectStore('chats',{keyPath:'id'});if(!db.objectStoreNames.contains('messages'))db.createObjectStore('messages',{keyPath:'id'});if(!db.objectStoreNames.contains('media'))db.createObjectStore('media',{keyPath:'id'});};
   request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();connection=null;};resolve(db);};
   request.onerror=()=>reject(request.error||new Error('Local storage unavailable'));
   request.onblocked=()=>reject(new Error('Local storage is blocked'));
  }).catch(error=>{connection=null;throw error;});
 }
 return connection;
}
function transactionDone(tx:IDBTransaction):Promise<void>{return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||new Error('Local storage failed'));tx.onerror=()=>reject(tx.error||new Error('Local storage failed'));});}
function requestValue<T>(request:IDBRequest<T>):Promise<T>{return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error||new Error('Local storage failed'));});}
function toBlob(data:string):Blob{
 const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data);if(!match)throw new Error('Invalid image data');
 const decoded=atob(match[2]);const bytes=new Uint8Array(decoded.length);for(let i=0;i<decoded.length;i++)bytes[i]=decoded.charCodeAt(i);
 return new Blob([bytes],{type:match[1]});
}
async function toDataUrl(blob:Blob|null|undefined):Promise<string|null>{
 if(!blob)return null;const bytes=new Uint8Array(await blob.arrayBuffer());let data='';
 for(let i=0;i<bytes.length;i+=8192)data+=String.fromCharCode(...bytes.subarray(i,i+8192));
 return 'data:'+blob.type+';base64,'+btoa(data);
}

export async function saveChatMessage(chat:Conversation,message:Creation):Promise<void>{
 const image=message.image?toBlob(message.image):null;const reference=message.brief.reference?toBlob(message.brief.reference):null;
 const stored={...message,brief:{...message.brief,reference:null},image:null,hasImage:!!image||!!message.hasImage,hasReference:!!reference||!!message.hasReference};
 const db=await database();const tx=db.transaction(['chats','messages','media'],'readwrite');
 tx.objectStore('chats').put(chat);tx.objectStore('messages').put(stored);
 if(image)tx.objectStore('media').put({id:'image:'+message.id,blob:image});
 if(reference)tx.objectStore('media').put({id:'reference:'+message.id,blob:reference});
 await transactionDone(tx);
}
export async function loadChatIndex():Promise<{chats:Conversation[];messages:Creation[]}>{
 const db=await database();const tx=db.transaction(['chats','messages'],'readonly');
 const chats=requestValue<Conversation[]>(tx.objectStore('chats').getAll());const messages=requestValue<Creation[]>(tx.objectStore('messages').getAll());
 const [chatRows,messageRows]=await Promise.all([chats,messages]);await transactionDone(tx);return {chats:chatRows,messages:messageRows};
}
export async function loadMessageMedia(id:string):Promise<{image:string|null;reference:string|null}>{
 const db=await database();const tx=db.transaction('media','readonly');const store=tx.objectStore('media');
 const image=requestValue<{blob:Blob}|undefined>(store.get('image:'+id));const reference=requestValue<{blob:Blob}|undefined>(store.get('reference:'+id));
 const [a,b]=await Promise.all([image,reference]);await transactionDone(tx);return {image:await toDataUrl(a?.blob),reference:await toDataUrl(b?.blob)};
}
export async function setMessageFavorite(id:string,favorite:boolean):Promise<void>{
 const db=await database();const tx=db.transaction('messages','readwrite');const store=tx.objectStore('messages');
 const request=store.get(id);request.onsuccess=()=>{if(request.result)store.put({...request.result,favorite});};
 await transactionDone(tx);
}

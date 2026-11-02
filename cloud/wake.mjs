// One durable coordinator wakes the local runners and remembers unfinished job IDs.
// Images, audio, credentials and results remain in the encrypted queue, not here.
export class WakeHub {
 constructor(state) { this.state = state; }

 async replay(socket, kind) {
  const pending = await this.state.storage.list({prefix: kind + '/'});
  for (const [key, expiresAt] of pending) {
   if (expiresAt <= Date.now()) await this.state.storage.delete(key);
   else socket.send(JSON.stringify({id: key.slice(kind.length + 1), kind}));
  }
 }

 async fetch(request) {
  const url = new URL(request.url), kind = url.searchParams.get('kind');
  if (url.pathname === '/connect' && request.method === 'GET') {
   if (!['image', 'voice'].includes(kind) || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(null, {status: 400});
   const pair = new WebSocketPair();
   this.state.acceptWebSocket(pair[1], [kind]);
   await this.replay(pair[1], kind);
   return new Response(null, {status: 101, webSocket: pair[0]});
  }
  if (request.method !== 'POST' || !['/enqueue', '/complete'].includes(url.pathname)) return new Response(null, {status: 404});
  let data;
  try { data = await request.json(); } catch { return new Response(null, {status: 400}); }
  if (!data || !/^[a-f0-9]{32}$/.test(data.id) || !['image', 'voice'].includes(data.kind)) return new Response(null, {status: 400});
  const key = data.kind + '/' + data.id;
  if (url.pathname === '/complete') await this.state.storage.delete(key);
  else {
   if (!Number.isFinite(data.expiresAt)) return new Response(null, {status: 400});
   if (data.expiresAt > Date.now()) {
    await this.state.storage.put(key, data.expiresAt);
    for (const socket of this.state.getWebSockets(data.kind)) {
     try { socket.send(JSON.stringify({id: data.id, kind: data.kind})); } catch { /* Replayed on reconnect. */ }
    }
   }
  }
  return new Response(null, {status: 200});
 }

 async webSocketMessage() { /* The server only sends notifications. */ }
 async webSocketClose(socket) { socket.close(); }
 async webSocketError(socket) { socket.close(); }
}

// Only the Pages service binding can reach the coordinator.
export default { fetch() { return new Response(null, {status: 404}); } };

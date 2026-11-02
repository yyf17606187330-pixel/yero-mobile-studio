import assert from 'node:assert/strict';
import test from 'node:test';

const {WakeHub} = await import('./cloud/wake.mjs').catch(() => ({}));

function state() {
  const entries = new Map();
  const sockets = {image: [], voice: []};
  return {
    entries, sockets,
    storage: {
      async put(key, value) { entries.set(key, value); },
      async delete(key) { entries.delete(key); },
      async list({prefix}) { return new Map([...entries].filter(([key]) => key.startsWith(prefix))); }
    },
    getWebSockets(kind) { return sockets[kind]; }
  };
}
const socket = () => ({messages: [], send(message) { this.messages.push(JSON.parse(message)); }});
const post = (path, body) => new Request('https://yero.internal/' + path, {
  method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
});

test('jobs wake only the appropriate connected runner', async () => {
  assert.equal(typeof WakeHub, 'function', 'WakeHub has not been implemented');
  const ctx = state(), image = socket(), voice = socket();
  ctx.sockets.image.push(image); ctx.sockets.voice.push(voice);
  const hub = new WakeHub(ctx, {}), id = 'a'.repeat(32);
  const response = await hub.fetch(post('enqueue', {id, kind: 'image', expiresAt: Date.now() + 60000}));
  assert.equal(response.status, 200);
  assert.deepEqual(image.messages, [{id, kind: 'image'}]);
  assert.deepEqual(voice.messages, []);
});

test('pending jobs survive a coordinator restart and completed jobs are not replayed', async () => {
  assert.equal(typeof WakeHub, 'function', 'WakeHub has not been implemented');
  const ctx = state(), id = 'b'.repeat(32), finished = 'c'.repeat(32);
  const first = new WakeHub(ctx, {});
  await first.fetch(post('enqueue', {id, kind: 'image', expiresAt: Date.now() + 60000}));
  await first.fetch(post('enqueue', {id: finished, kind: 'image', expiresAt: Date.now() + 60000}));
  await first.fetch(post('complete', {id: finished, kind: 'image'}));
  const afterRestart = new WakeHub(ctx, {}), reconnected = socket();
  await afterRestart.replay(reconnected, 'image');
  assert.deepEqual(reconnected.messages, [{id, kind: 'image'}]);
});

test('expired and malformed jobs never reach a runner', async () => {
  assert.equal(typeof WakeHub, 'function', 'WakeHub has not been implemented');
  const ctx = state(), hub = new WakeHub(ctx, {}), reconnected = socket();
  assert.equal((await hub.fetch(post('enqueue', {id: 'bad', kind: 'image', expiresAt: Date.now() + 1000}))).status, 400);
  await hub.fetch(post('enqueue', {id: 'd'.repeat(32), kind: 'image', expiresAt: Date.now() - 1}));
  await hub.replay(reconnected, 'image');
  assert.deepEqual(reconnected.messages, []);
});

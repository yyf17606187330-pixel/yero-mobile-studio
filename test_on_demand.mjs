import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './cloud/worker.mjs';

class CountingKV {
  values = new Map();
  reads = 0;
  lists = 0;
  async get(key, options) {
    this.reads++;
    const value = this.values.get(key);
    if (!value) return null;
    return options?.type === 'arrayBuffer' ? value.slice().buffer : new TextDecoder().decode(value);
  }
  async put(key, value) { this.values.set(key, new Uint8Array(value)); }
  async delete(key) { this.values.delete(key); }
  async list() { this.lists++; return {keys: []}; }
}

function setup() {
  const notifications = [];
  const kv = new CountingKV();
  const dispatch = {
    idFromName: () => 'hub',
    get: () => ({fetch: async request => {
      notifications.push({path: new URL(request.url).pathname, body: await request.json()});
      return new Response('{}', {status: 200});
    }})
  };
  return {notifications, kv, env: {
    YERO_ACCESS_CODE: 'human-secret', YERO_RUNNER_KEY: 'runner-secret',
    YERO_STORAGE_KEY: '01'.repeat(32), YERO_QUEUE: kv, YERO_DISPATCH: dispatch,
    ASSETS: {fetch: async () => new Response('site content')}
  }};
}

const request = (path, options = {}) => new Request('https://yero.example' + path, options);
const human = {Authorization: 'Bearer human-secret', 'Content-Type': 'application/json'};
const runner = {'X-Yero-Runner': 'runner-secret'};

test('retired idle discovery makes no KV read or list', async () => {
  const {env, kv} = setup();
  for (const path of ['/api/runner/next?force=1', '/api/runner/voice-next?force=1']) {
    const response = await worker.fetch(request(path, {headers: runner}), env);
    assert.equal(response.status, 410);
  }
  assert.equal(kv.reads, 0);
  assert.equal(kv.lists, 0);
});

test('unconfigured native image modes cannot create or charge a job', async () => {
  const {env, notifications} = setup();
  for (const resolution of ['2K Ultra', '4K Ultra']) {
    const response = await worker.fetch(new Request('https://yero.example/api/jobs', {
      method: 'POST', headers: {Authorization: 'Bearer human-secret', 'Content-Type': 'application/json'},
      body: JSON.stringify({prompt: 'a landscape', resolution})
    }), env);
    assert.equal(response.status, 400);
  }
  assert.equal(env.YERO_QUEUE.values.size, 0);
  assert.equal(notifications.length, 0);
});

test('submitting a job stores an encrypted payload and notifies the matching runner', async () => {
  const {env, kv, notifications} = setup();
  const response = await worker.fetch(request('/api/jobs', {
    method: 'POST', headers: human, body: JSON.stringify({prompt: 'a blue bird'})
  }), env);
  assert.equal(response.status, 202);
  const {id} = await response.json();
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.ok(kv.values.has('q/' + id));
  assert.equal(new TextDecoder().decode(kv.values.get('q/' + id)).includes('a blue bird'), false);
  assert.equal(kv.values.has('latest'), false);
  assert.deepEqual(notifications.map(({path, body}) => ({path, id: body.id, kind: body.kind})),
    [{path: '/enqueue', id, kind: 'image'}]);
});

test('only the authenticated runner can fetch the specific queued payload', async () => {
  const {env} = setup();
  const response = await worker.fetch(request('/api/jobs', {
    method: 'POST', headers: human, body: JSON.stringify({prompt: 'a blue bird'})
  }), env);
  const {id} = await response.json();
  const path = '/api/runner/job/' + id + '?kind=image';
  assert.equal((await worker.fetch(request(path), env)).status, 401);
  assert.equal((await worker.fetch(request(path, {headers: runner}), env)).status, 200);
});

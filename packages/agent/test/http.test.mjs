import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DurableDaemon } from '../src/daemon.ts';
import { ScriptedTransport } from '../src/transport.ts';
import { readApiKey, resolveApiKey, validBearer } from '../src/auth.ts';
const { startServer } = await import(process.env.RAFTD_TEST_SERVE_SOURCE ?? '../src/serve.ts');

const model = { provider: 'zai-coding-cn', modelId: 'glm-5.3-flash' };
function authEnvironment(t, extra = {}) {
  const names = ['RAFTD_KEY', 'RAFTD_INSECURE', 'RAFTD_ALLOWED_HOSTS', 'RAFTD_WRAPPER_INSTANCE'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, extra);
  t.after(() => { for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } });
}
async function fixture(t, options = {}) {
  authEnvironment(t, options.env);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'raft-http-'));
  const open = () => DurableDaemon.open({ stateDir, providers: [], defaultModel: model, transport: new ScriptedTransport() });
  let daemon = await open();
  let server;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await daemon.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  server = await startServer(daemon, { host: options.host ?? '127.0.0.1', port: 0, allowedHosts: options.allowedHosts });
  const host = options.host === '::1' ? '[::1]' : '127.0.0.1';
  const base = `http://${host}:${server.address().port}`;
  const key = await readApiKey(stateDir);
  async function api(route, { method = 'GET', body, headers = {}, authorize = true } = {}) {
    const actualHeaders = { ...(authorize && key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers };
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    // Node's fetch may normalize/replace Host. Raw HTTP is required to test the
    // authority that actually arrives on the wire rather than the API input.
    if (headers.host) return rawHttp(base, { route, method, headers: actualHeaders, chunks: payload === undefined ? [] : [payload] });
    const response = await fetch(`${base}${route}`, {
      method,
      headers: actualHeaders,
      body: payload,
    });
    return { status: response.status, body: await response.json() };
  }
  return {
    get daemon() { return daemon; }, get server() { return server; }, stateDir, base, key, api,
    async restart() {
      const port = server.address().port;
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
      await daemon.close(); daemon = await open();
      server = await startServer(daemon, { host: options.host ?? '127.0.0.1', port, allowedHosts: options.allowedHosts });
    },
  };
}
async function rawHttp(base, { route = '/api/agents', headers = {}, chunks = [], method = 'POST' }) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${route}`, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test('loopback defaults to persistent 0600 token and rejects unauthenticated API access', async (t) => {
  const f = await fixture(t);
  assert.match(f.key, /^[a-f0-9]{64}$/);
  assert.equal((await stat(path.join(f.stateDir, 'raftd.token'))).mode & 0o777, 0o600);
  assert.equal(new URL(f.server.consoleUrl).hash, `#key=${f.key}`);
  assert.equal((await f.api('/api/state', { authorize: false })).status, 401);
  assert.equal((await f.api('/api/state', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await f.api('/api/state')).status, 200);
  assert.equal(await resolveApiKey(f.stateDir), f.key);
  assert.equal((await readFile(path.join(f.stateDir, 'raftd.port'), 'utf8')), new URL(f.base).host);
});

test('cross-site, DNS-rebinding Host and simple text/plain requests cannot create agents or enqueue commands', async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { origin: 'http://evil.example', host: 'evil.example:4777', 'content-type': 'text/plain;charset=UTF-8' },
    { origin: 'http://evil.example' },
    { host: `evil.example:${f.server.address().port}` },
    { 'content-type': 'text/plain;charset=UTF-8' },
    { origin: 'null' },
  ]) {
    const response = await f.api('/api/agents', { method: 'POST', body: { name: 'attacker' }, headers });
    assert.ok([401, 403, 415].includes(response.status), JSON.stringify({ headers, response }));
    assert.deepEqual(await f.daemon.listAgents(), []);
  }
  const created = await f.api('/api/agents', { method: 'POST', body: { name: 'legitimate' } });
  assert.equal(created.status, 201);
  const before = await f.daemon.chatFeed(created.body.agentId);
  const marker = path.join(f.stateDir, 'must-not-exist');
  const blocked = await f.api('/api/agents/legitimate/messages', { method: 'POST', body: { text: `run bash: touch ${marker}` }, headers: { origin: 'http://evil.example' } });
  assert.equal(blocked.status, 403);
  assert.deepEqual(await f.daemon.chatFeed(created.body.agentId), before, 'blocked request must not enter the conversation');
  assert.equal(existsSync(marker), false);
  assert.equal((await f.api('/api/state', { headers: { origin: f.base } })).status, 200);
});

test('JSON body limit rejects both declared and chunked payloads without mutations', async (t) => {
  const f = await fixture(t);
  const oversized = JSON.stringify({ name: 'oversized', instructions: 'x'.repeat(1024 * 1024) });
  const common = { authorization: `Bearer ${f.key}`, 'content-type': 'application/json' };
  const declared = await rawHttp(f.base, { headers: { ...common, 'content-length': Buffer.byteLength(oversized) }, chunks: [oversized] });
  assert.equal(declared.status, 413);
  const chunked = await rawHttp(f.base, { headers: { ...common, 'transfer-encoding': 'chunked' }, chunks: [oversized.slice(0, 500_000), oversized.slice(500_000)] });
  assert.equal(chunked.status, 413);
  const nonJson = await rawHttp(f.base, { headers: { authorization: `Bearer ${f.key}` }, chunks: ['{"name":"missing-content-type"}'] });
  assert.equal(nonJson.status, 415);
  assert.deepEqual(await f.daemon.listAgents(), []);
});

test('every lifecycle mutation rejects malformed JSON and invalid fields before changing state', async (t) => {
  const f = await fixture(t);
  const agent = (await f.api('/api/agents', { method: 'POST', body: { name: 'lifecycle' } })).body;
  for (const action of ['stop', 'start', 'resolve', 'abort', 'compact', 'reset']) {
    const before = await f.daemon.getAgent(agent.agentId);
    const feed = await f.daemon.chatFeed(agent.agentId);
    const malformed = await f.api(`/api/agents/${agent.agentId}/${action}`, { method: 'POST', body: '{bad' });
    assert.equal(malformed.status, 400, action);
    const invalidField = await f.api(`/api/agents/${agent.agentId}/${action}`, { method: 'POST', body: { instructions: 42 } });
    assert.equal(invalidField.status, 400, action);
    assert.deepEqual(await f.daemon.getAgent(agent.agentId), before, action);
    assert.deepEqual(await f.daemon.chatFeed(agent.agentId), feed, action);
  }
  const stopped = await f.api(`/api/agents/${agent.agentId}/stop`, { method: 'POST' });
  assert.equal(stopped.status, 200, 'empty body remains valid for lifecycle actions');
  assert.equal(stopped.body.lifecycle.kind, 'stopped');
  const before = await f.daemon.chatFeed(agent.agentId);
  const blocked = await f.api(`/api/agents/${agent.agentId}/messages`, { method: 'POST', body: { text: 'must not enqueue' } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /stopped/);
  assert.deepEqual(await f.daemon.chatFeed(agent.agentId), before);
  assert.equal((await f.api('/api/agents/missing/messages', { method: 'POST', body: { text: 'missing' } })).status, 404);
});

test('create and PATCH validate model, thinking, names and preserve records on rejection', async (t) => {
  const f = await fixture(t);
  for (const body of [
    { name: 'bare', model: 'glm-5.3-flash' },
    { name: 'bad-provider', model: 'nosuch/model' },
    { name: 'bad-model', model: 'zai-coding-cn/does-not-exist' },
    { name: 'bad-thinking', thinking: 'extreme' },
  ]) {
    assert.equal((await f.api('/api/agents', { method: 'POST', body })).status, 400);
    assert.deepEqual(await f.daemon.listAgents(), []);
  }
  const created = await f.api('/api/agents', { method: 'POST', body: { name: 'before' } });
  assert.equal(created.status, 201);
  const id = created.body.agentId;
  const renamed = await f.api(`/api/agents/${id}`, { method: 'PATCH', body: { name: 'after', instructions: 'Updated instructions', thinking: 'low' } });
  assert.equal(renamed.status, 200);
  assert.equal((await f.daemon.getAgent('after')).agentId, id);
  assert.equal(renamed.body.instructions, 'Updated instructions');
  for (const body of [{ model: 'bare' }, { model: 'nosuch/model' }, { thinking: 'extreme' }, { name: 'Main' }, { instructions: null, workspace: 'unsupported' }, {}]) {
    const before = await f.daemon.getAgent(id);
    assert.equal((await f.api(`/api/agents/${id}`, { method: 'PATCH', body })).status, 400);
    assert.deepEqual(await f.daemon.getAgent(id), before);
  }
  const other = await f.api('/api/agents', { method: 'POST', body: { name: 'other' } });
  assert.equal(other.status, 201);
  assert.equal((await f.api(`/api/agents/${id}`, { method: 'PATCH', body: { name: 'other' } })).status, 409);
  assert.equal((await f.api(`/api/agents/${id}/usage`)).status, 200);
  assert.equal((await f.api('/api/usage?agent=after')).status, 200);
  assert.equal((await f.api('/api/usage?agent=missing')).status, 404);
});

test('PATCH can clear nullable settings and its record survives a real host reopen', async (t) => {
  const f = await fixture(t);
  const created = await f.api('/api/agents', { method: 'POST', body: { name: 'persisted', instructions: 'before clearing', thinking: 'high' } });
  assert.equal(created.status, 201);
  const id = created.body.agentId;
  const changed = await f.api(`/api/agents/${id}`, { method: 'PATCH', body: { name: 'renamed after patch', instructions: null, thinking: null } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.instructions, null);
  assert.equal(changed.body.thinkingLevel, null);
  const token = f.key;
  await f.restart();
  assert.equal(await readApiKey(f.stateDir), token, 'restarting the host preserves CLI and console credentials');
  const state = await f.api('/api/state');
  assert.equal(state.status, 200);
  const record = state.body.agents.find((a) => a.agentId === id);
  assert.equal(record.name, 'renamed after patch');
  assert.equal(record.instructions, null);
  assert.equal(record.thinkingLevel, null);
  assert.equal((await f.daemon.getAgent('renamed after patch')).agentId, id);
});

test('500 responses hide internal paths while server diagnostics retain the failure', async (t) => {
  const f = await fixture(t);
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  t.after(() => { console.error = original; });
  f.daemon.inspect = async () => { throw new Error('injected I/O failure at /private/state/session.sqlite'); };
  const result = await f.api('/api/inspect');
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: 'internal server error' });
  assert.ok(errors.some((line) => line.includes('/private/state/session.sqlite')));
  const badPath = await f.api('/api/agents/%E0%A4%A/events');
  assert.equal(badPath.status, 400);
  assert.equal(badPath.body.error, 'invalid URL encoding');
});

test('token initialization is atomic and explicit authentication settings retain precedence', async (t) => {
  authEnvironment(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'raft-token-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await readApiKey(dir), undefined);
  const keys = await Promise.all(Array.from({ length: 20 }, () => resolveApiKey(dir)));
  assert.equal(new Set(keys).size, 1);
  await chmod(path.join(dir, 'raftd.token'), 0o644);
  assert.equal(await resolveApiKey(dir), keys[0]);
  assert.equal((await stat(path.join(dir, 'raftd.token'))).mode & 0o777, 0o600);
  process.env.RAFTD_INSECURE = '1';
  assert.equal(await resolveApiKey(dir), undefined);
  process.env.RAFTD_KEY = 'explicit-key';
  assert.equal(await resolveApiKey(dir), 'explicit-key');
  assert.equal(validBearer('Bearer explicit-key', 'explicit-key'), true);
  assert.equal(validBearer('Bearer explicit-kex', 'explicit-key'), false);
  assert.equal(validBearer('Bearer short', 'explicit-key'), false);
});

test('explicit insecure mode still rejects foreign origins, and public bind still requires a configured key', async (t) => {
  const f = await fixture(t, { env: { RAFTD_INSECURE: '1' } });
  assert.equal(f.key, undefined);
  assert.equal((await f.api('/api/state', { authorize: false })).status, 200);
  assert.equal((await f.api('/api/agents', { method: 'POST', body: { name: 'blocked' }, headers: { origin: 'http://evil.example' }, authorize: false })).status, 403);
  assert.deepEqual(await f.daemon.listAgents(), []);
  delete process.env.RAFTD_INSECURE;
  await assert.rejects(startServer(f.daemon, { host: '0.0.0.0', port: 0 }), /RAFTD_KEY is not set/);
});

test('IPv6 and explicitly allowed public DNS hosts use the same token and origin protections', async (t) => {
  const f = await fixture(t, { host: '::1', allowedHosts: ['console.example'] });
  assert.equal((await f.api('/api/state', { headers: { origin: f.base } })).status, 200);
  const authority = `console.example:${f.server.address().port}`;
  assert.equal((await f.api('/api/state', { headers: { host: authority, origin: `http://${authority}` } })).status, 200);
  assert.equal((await f.api('/api/state', { headers: { host: authority, origin: 'https://console.example' } })).status, 403);
  assert.equal((await f.api('/api/state', { headers: { host: 'localhost:1' } })).status, 403);
});

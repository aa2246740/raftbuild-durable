import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const token = 'cli-regression-local-token';
function run(state, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(?:RAFTD_|NODE_OPTIONS$|ZAI_|zhipu$|MINIMAX|DEEPSEEK_|OPENAI_|ANTHROPIC_)/.test(key)) delete env[key];
    }
    const child = spawn(process.execPath, [cli, ...args, '--state', state], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timed out: ${args.join(' ')}\n${out}\n${err}`)); }, 20_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
async function fixture(t, handler) {
  const state = await mkdtemp(path.join(tmpdir(), 'raft-cli-test-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  if (handler) {
    const server = createServer(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'missing discovered token' });
      await handler(req, text ? JSON.parse(text) : undefined, reply);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
    await writeFile(path.join(state, 'raftd.port'), `127.0.0.1:${server.address().port}`);
    await writeFile(path.join(state, 'raftd.token'), token, { mode: 0o600 });
  }
  return state;
}

test('real thin CLI discovers token, reads -m UTF-8 file and continues the same answer after two 504s', async (t) => {
  let posts = 0, answers = 0;
  const state = await fixture(t, (req, body, reply) => {
    if (req.method === 'POST') {
      posts++;
      assert.equal(body.text, '第一行\nsecond line\n');
      return reply(202, { submissionId: '42' });
    }
    const url = new URL(req.url, 'http://fixture');
    assert.equal(url.searchParams.get('submissionId'), '42');
    answers++;
    reply(answers < 3 ? 504 : 200, answers < 3 ? { error: 'still running' } : { status: 'done', text: 'eventually completed' });
  });
  const file = path.join(state, 'message.txt');
  await writeFile(file, '第一行\nsecond line\n');
  const r = await run(state, ['send', 'worker', '-m', file]);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /eventually completed/);
  assert.equal(posts, 1); assert.equal(answers, 3);
});

test('explicit wait timeout prints a resumable command; another wait reads the same submission without submitting', async (t) => {
  let done = false, gets = 0;
  const state = await fixture(t, (req, _body, reply) => {
    assert.equal(req.method, 'GET'); gets++;
    assert.equal(new URL(req.url, 'http://fixture').searchParams.get('submissionId'), '73');
    reply(done ? 200 : 504, done ? { status: 'done', text: 'saved answer' } : { error: 'still running' });
  });
  const pending = await run(state, ['wait', 'worker', '73', '--timeout', '150ms']);
  assert.equal(pending.code, 1); assert.match(pending.err, /still running.*raftd wait.*worker.*73/);
  done = true;
  const finished = await run(state, ['wait', 'worker', '73', '--timeout', '2s']);
  assert.equal(finished.code, 0, finished.err); assert.match(finished.out, /saved answer/); assert.ok(gets >= 2);
});

test('invalid timeout and ambiguous -m are rejected before any submission', async (t) => {
  let calls = 0;
  const state = await fixture(t, (_req, _body, reply) => { calls++; reply(500, { error: 'must not be called' }); });
  assert.equal((await run(state, ['send', 'a', 'hello', '--timeout', '-1'])).code, 1);
  assert.equal((await run(state, ['send', 'a', 'hello', '-m', '/nonexistent-fixture'])).code, 1);
  assert.equal(calls, 0);
});

test('missing agent or message never makes a request, even when an agent could be named undefined', async (t) => {
  let calls = 0;
  const state = await fixture(t, (_req, _body, reply) => { calls++; reply(200, { ok: true }); });
  for (const args of [['stop'], ['delete'], ['update'], ['send'], ['send', 'undefined'], ['wait', 'a'], ['remind', 'a']]) {
    const r = await run(state, args);
    assert.equal(r.code, 1, JSON.stringify({ args, ...r }));
    assert.match(r.err, /requires/);
  }
  assert.equal(calls, 0);
});

test('thin CLI exposes a scrubbed failure diagnostic and does not retry authorization errors', async (t) => {
  let requests = 0;
  const state = await fixture(t, (_req, _body, reply) => {
    requests++;
    if (requests === 1) reply(200, { status: 'unanswered', reason: 'model_error', detail: 'invalid api key OPENAI_API_KEY=secret-placeholder-1234' });
    else reply(401, { error: 'unauthorized' });
  });
  const failed = await run(state, ['wait', 'a', '1']);
  assert.equal(failed.code, 2); assert.match(failed.err, /invalid api key/); assert.doesNotMatch(failed.err, /secret-placeholder/);
  assert.equal((await run(state, ['wait', 'a', '1'])).code, 1); assert.equal(requests, 2);
});

test('offline CLI delivers by agent name and sends only a durable queued submission', async (t) => {
  const state = await fixture(t);
  const created = await run(state, ['create', '中文 agent', '--model', 'zai-coding-cn/glm-5.3-flash']);
  assert.equal(created.code, 0, created.err);
  const id = /created (agent-[^ ]+)/.exec(created.out)?.[1]; assert.ok(id);
  await mkdir(path.join(state, '.deliveries'), { recursive: true });
  await writeFile(path.join(state, '.deliveries', `${id}.jsonl`), '{"proof":"name-resolved-ledger"}\n');
  const deliveries = await run(state, ['deliveries', '中文 agent']);
  assert.equal(deliveries.code, 0, deliveries.err); assert.match(deliveries.out, /name-resolved-ledger/);
  const sent = await run(state, ['send', '中文 agent', 'persist this, do not run']);
  assert.equal(sent.code, 0, sent.err); assert.match(sent.out, /queued submission \d+/); assert.match(sent.out, /no tasks were started/);
  const wait = await run(state, ['wait', '中文 agent', '1']);
  assert.equal(wait.code, 1); assert.match(wait.err, /requires a running serve/);
});

test('thin CLI update and per-agent usage use the correct API routes', async (t) => {
  const seen = [];
  const state = await fixture(t, (req, body, reply) => {
    seen.push([req.method, req.url, body]);
    reply(200, req.method === 'PATCH' ? { agentId: 'agent-a', name: body.name } : { totalTokens: 7 });
  });
  assert.equal((await run(state, ['update', 'old name', '--name', '新名字', '--instructions', 'new instructions'])).code, 0);
  const usage = await run(state, ['usage', '新名字']);
  assert.equal(usage.code, 0, usage.err); assert.match(usage.out, /totalTokens/);
  assert.deepEqual(seen[0], ['PATCH', '/api/agents/old%20name', { name: '新名字', instructions: 'new instructions' }]);
  assert.equal(seen[1][1], '/api/agents/%E6%96%B0%E5%90%8D%E5%AD%97/usage');
});

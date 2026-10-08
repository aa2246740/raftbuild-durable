import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { AgentDoc, UsageDoc } from '@earendil-works/pi-durable';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { zaiCodingCnProvider } from '@earendil-works/pi-ai/providers/zai-coding-cn';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { DurableDaemon } from '../src/daemon.ts';
import { ToolExecutionEnv } from '../src/toolEnv.ts';
import { AgentsDoc } from '../src/agents.ts';
import { pickDefaultModel } from '../src/modelPolicy.ts';
import { ScriptedTransport } from '../src/transport.ts';

const model = { provider: 'zai-coding-cn', modelId: 'glm-5.3-flash' };
const invalid = (error) => error?.code === 'invalid';
async function fixture(t, options = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'raft-core-'));
  const d = await DurableDaemon.open({ stateDir, providers: [], defaultModel: model, transport: new ScriptedTransport(), ...options });
  t.after(async () => { await d.close(); await rm(stateDir, { recursive: true, force: true }); });
  return d;
}
async function exists(file) { return !!await lstat(file).catch(() => undefined); }

test('workspace borrowing rejects existing directories, files and symlinks without changing their data', async (t) => {
  const d = await fixture(t);
  const external = path.join(d.stateDir, 'external');
  const folder = path.join(d.workspacesDir, 'borrowed');
  await mkdir(external); await writeFile(path.join(external, 'sentinel'), 'external');
  await mkdir(folder); await writeFile(path.join(folder, 'MEMORY.md'), 'user memory');
  await writeFile(path.join(d.workspacesDir, 'file'), 'user file');
  await symlink(external, path.join(d.workspacesDir, 'alias'), 'dir');
  for (const workspace of ['borrowed', 'file', 'alias']) {
    await assert.rejects(d.createAgent({ name: workspace, workspace }), (e) => e.code === 'name_taken');
  }
  assert.equal(await readFile(path.join(folder, 'MEMORY.md'), 'utf8'), 'user memory');
  assert.equal(await readFile(path.join(d.workspacesDir, 'file'), 'utf8'), 'user file');
  assert.equal(await readFile(path.join(external, 'sentinel'), 'utf8'), 'external');
  assert.deepEqual(await d.listAgents(), []);
});

test('A/B/C workspace collisions and deletes only affect the successful owner', async (t) => {
  const d = await fixture(t);
  const a = (await d.createAgent({ name: 'A', workspace: 'shared' })).record;
  await writeFile(path.join(a.workspacePath, 'sentinel'), 'A data');
  const conflicts = await Promise.allSettled(['B', 'C'].map((name) => d.createAgent({ name, workspace: 'shared' })));
  assert.equal(conflicts.filter((r) => r.status === 'rejected').length, 2);
  assert.equal(await readFile(path.join(a.workspacePath, 'sentinel'), 'utf8'), 'A data');
  const racing = await Promise.allSettled(['B', 'C'].map((name) => d.createAgent({ name, workspace: 'race' })));
  assert.equal(racing.filter((r) => r.status === 'fulfilled').length, 1);
  const winner = racing.find((r) => r.status === 'fulfilled').value.record;
  await writeFile(path.join(winner.workspacePath, 'sentinel'), 'winner data');
  await d.deleteAgent('A', { deleteWorkspace: true });
  assert.equal(await exists(a.workspacePath), false);
  assert.equal(await readFile(path.join(winner.workspacePath, 'sentinel'), 'utf8'), 'winner data');
  await d.deleteAgent(winner.agentId, { deleteWorkspace: true });
  assert.equal(await exists(winner.workspacePath), false);
});

test('concurrent identical names roll back only the losing workspace and conversation', async (t) => {
  const d = await fixture(t);
  const results = await Promise.allSettled(['first', 'second'].map((workspace) => d.createAgent({ name: 'same', workspace })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const winner = results.find((r) => r.status === 'fulfilled').value.record;
  assert.deepEqual(await readdir(d.workspacesDir), [path.basename(winner.workspacePath)]);
  assert.equal((await d.listAgents()).length, 1);
});

test('a blocked delete excludes another delete and a new workspace owner until cleanup finishes', async (t) => {
  const d = await fixture(t);
  const a = (await d.createAgent({ name: 'A', workspace: 'reusable' })).record;
  const originalRm = fs.rm;
  let entered, release;
  const reached = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  let removes = 0, created = false;
  fs.rm = async (target, options) => {
    if (target === a.workspacePath && options?.recursive) {
      removes++; entered(); await barrier;
    }
    return originalRm(target, options);
  };
  syncBuiltinESMExports();
  let first, second, successor;
  try {
    first = d.deleteAgent(a.agentId, { deleteWorkspace: true });
    second = d.deleteAgent(a.agentId, { deleteWorkspace: true });
    await reached;
    successor = d.createAgent({ name: 'B', workspace: 'reusable' }).then((result) => { created = true; return result; });
    // Give both queued operations an event-loop turn while filesystem removal
    // is held at the exact TOCTOU boundary. They must not enter that boundary.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(removes, 1, 'another delete entered check/remove while the first still owns the operation');
    assert.equal(created, false, 'a successor borrowed the directory before deletion finished');
    release();
    await Promise.all([first, second]);
    const b = (await successor).record;
    await writeFile(path.join(b.workspacePath, 'B-data'), 'precious B');
    assert.equal(await readFile(path.join(b.workspacePath, 'B-data'), 'utf8'), 'precious B');
    assert.equal((await d.getAgent('B')).agentId, b.agentId);
    assert.equal(removes, 1);
  } finally {
    release();
    await Promise.allSettled([first, second, successor].filter(Boolean));
    fs.rm = originalRm; syncBuiltinESMExports();
  }
});

test('failed conversation init rolls back its registry and its own directory', async (t) => {
  const d = await fixture(t);
  const create = d.harness.createConversation.bind(d.harness);
  d.harness.createConversation = (options, context) => create({ ...options, init: async (...args) => {
    await options.init(...args); throw new Error('injected transaction failure');
  } }, context);
  await assert.rejects(d.createAgent({ name: 'failed', workspace: 'failed' }), /injected transaction failure/);
  d.harness.createConversation = create;
  assert.deepEqual(await d.listAgents(), []);
  assert.deepEqual(await readdir(d.workspacesDir), []);
  await d.createAgent({ name: 'failed', workspace: 'failed' });
});

test('deleting a replaced or legacy workspace preserves unowned contents', async (t) => {
  const d = await fixture(t);
  const a = (await d.createAgent({ name: 'replaced' })).record;
  await rename(a.workspacePath, a.workspacePath + '.backup');
  await mkdir(a.workspacePath); await writeFile(path.join(a.workspacePath, 'sentinel'), 'replacement');
  await d.deleteAgent(a.agentId, { deleteWorkspace: true });
  assert.equal(await readFile(path.join(a.workspacePath, 'sentinel'), 'utf8'), 'replacement');
  const legacy = (await d.createAgent({ name: 'legacy' })).record;
  await d.harness.commit(async (tx) => { delete (await tx.doc(AgentsDoc)).records[legacy.agentId].workspaceOwnership; }, ctx);
  await d.deleteAgent(legacy.agentId, { deleteWorkspace: true });
  assert.equal(await exists(path.join(legacy.workspacePath, 'MEMORY.md')), true);
});

test('symlinked workspace root is refused before writing outside state', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'raft-root-alias-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const stateDir = path.join(base, 'state'), external = path.join(base, 'external');
  await mkdir(stateDir); await mkdir(external); await writeFile(path.join(external, 'sentinel'), 'unchanged');
  await symlink(external, path.join(stateDir, 'workspaces'), 'dir');
  await assert.rejects(DurableDaemon.open({ stateDir, providers: [] }), invalid);
  assert.deepEqual(await readdir(external), ['sentinel']);
});

test('library create validates models, thinking levels, reserved names and ID collisions before disk effects', async (t) => {
  const noDefault = await fixture(t, { defaultModel: undefined });
  await assert.rejects(noDefault.createAgent({ name: 'needs-model' }), (error) => {
    assert.equal(error.code, 'invalid');
    assert.match(error.message, /model.*provider.*modelId/);
    return true;
  });
  assert.deepEqual(await noDefault.listAgents(), []);
  assert.deepEqual(await readdir(noDefault.workspacesDir), []);
  const offline = await noDefault.createAgent({ name: 'explicit-offline', model });
  assert.deepEqual(offline.record.model, model);
  const d = await fixture(t);
  for (const change of [
    { name: '' }, { name: 'Main' }, { name: 'MAIN' }, { name: '../x' },
    { name: 'bad', model: { provider: 'unknown', modelId: 'bad' } },
    { name: 'bad', model: { ...model, modelId: 'unknown' } },
    { name: 'bad', thinkingLevel: 'extreme' }, { name: 'bad', instructions: 42 },
  ]) await assert.rejects(d.createAgent(change), invalid);
  assert.deepEqual(await readdir(d.workspacesDir), []);
  const a = (await d.createAgent({ name: 'valid' })).record;
  await assert.rejects(d.createAgent({ name: a.agentId }), invalid);
  await assert.rejects(d.getAgent('__proto__'), (e) => e.code === 'not_found');
});

test('recommended provider defaults do not depend on the oldest first catalog entry', async (t) => {
  for (const [id, factory, expected] of [
    ['zai-coding-cn', 'zaiCodingCnProvider', 'glm-5.3-flash'],
    ['zai', 'zaiProvider', 'glm-5.3-flash'],
    ['minimax-cn', 'minimaxCnProvider', 'MiniMax-M3'],
    ['minimax', 'minimaxProvider', 'MiniMax-M3'],
    ['deepseek', 'deepseekProvider', 'deepseek-flash'],
    ['openai', 'openaiProvider', 'gpt-5.4-mini'],
    ['anthropic', 'anthropicProvider', 'claude-sonnet-4-6'],
  ]) {
    const module = await import(`@earendil-works/pi-ai/providers/${id}`);
    const provider = module[factory]();
    const chosen = pickDefaultModel([provider]);
    assert.deepEqual(chosen, { provider: id, modelId: expected });
    assert.ok(provider.getModels().some((entry) => entry.id === chosen.modelId), `${id} default must exist in its installed catalog`);
  }
  assert.equal(pickDefaultModel([openaiProvider()]).modelId, 'gpt-5.4-mini');
  assert.equal(pickDefaultModel([anthropicProvider()]).modelId, 'claude-sonnet-4-6');
  assert.equal(pickDefaultModel([{ id: 'toString', getModels: () => [{ id: 'custom' }] }]).modelId, 'custom');
  assert.equal(pickDefaultModel([{ id: 'broken', getModels: () => { throw new Error('catalog unavailable'); } }, openaiProvider()]).modelId, 'gpt-5.4-mini');
  const d = await fixture(t, { providers: [openaiProvider()], defaultModel: undefined });
  assert.equal((await d.createAgent({ name: 'default' })).record.model.modelId, 'gpt-5.4-mini');
  await assert.rejects(d.createAgent({ name: 'unconfigured', model }), invalid);
});

test('update validates settings and commits registry and runtime configuration together', async (t) => {
  const d = await fixture(t);
  const a = (await d.createAgent({ name: 'first' })).record;
  await d.createAgent({ name: 'second' });
  for (const change of [{ name: 'Main' }, { model: { ...model, modelId: 'missing' } }, { thinkingLevel: 'bad' }, { instructions: 1 }, { name: '' }, { override: 'stopped' }]) {
    await assert.rejects(d.updateAgent(a.agentId, change), invalid);
  }
  await assert.rejects(d.updateAgent(a.agentId, { name: 'second' }), (e) => e.code === 'name_taken');
  const changed = await d.updateAgent(a.agentId, { name: 'renamed', instructions: 'new instruction', thinkingLevel: 'high' });
  const runtime = await d.harness.snapshot(AgentDoc, Number(a.conversationId), ctx);
  assert.equal(changed.name, 'renamed'); assert.equal(runtime.instructions, changed.instructions); assert.equal(runtime.thinkingLevel, changed.thinkingLevel);
  const commit = d.harness.commit.bind(d.harness);
  d.harness.commit = (fn, context) => commit(async (tx) => { await fn(tx); throw new Error('injected write failure'); }, context);
  await assert.rejects(d.updateAgent(a.agentId, { name: 'failed', instructions: 'must rollback' }), /injected write failure/);
  d.harness.commit = commit;
  assert.equal((await d.getAgent(a.agentId)).name, 'renamed');
  assert.equal((await d.harness.snapshot(AgentDoc, Number(a.conversationId), ctx)).instructions, 'new instruction');
  await d.close();
  const reopened = await DurableDaemon.open({ stateDir: d.stateDir, providers: [], defaultModel: model, transport: new ScriptedTransport() });
  try {
    assert.equal((await reopened.getAgent(a.agentId)).instructions, 'new instruction');
    assert.equal((await reopened.harness.snapshot(AgentDoc, Number(a.conversationId), ctx)).instructions, 'new instruction');
    const changedModel = { ...model, modelId: 'glm-5.3' };
    await reopened.updateAgent(a.agentId, { model: changedModel, instructions: null, thinkingLevel: null });
    assert.deepEqual((await reopened.getAgent(a.agentId)).model, changedModel);
    const cleared = await reopened.harness.snapshot(AgentDoc, Number(a.conversationId), ctx);
    assert.deepEqual(cleared.model, changedModel);
    assert.equal(cleared.instructions, undefined); assert.equal(cleared.thinkingLevel, undefined);
  } finally { await reopened.close(); }
});

test('concurrent updates preserve disjoint fields and allow only one rename winner', async (t) => {
  const d = await fixture(t);
  await d.createAgent({ name: 'A' }); await d.createAgent({ name: 'B' });
  await Promise.all([d.updateAgent('A', { instructions: 'kept' }), d.updateAgent('A', { thinkingLevel: 'high' })]);
  const a = await d.getAgent('A'); assert.equal(a.instructions, 'kept'); assert.equal(a.thinkingLevel, 'high');
  const results = await Promise.allSettled(['A', 'B'].map((name) => d.updateAgent(name, { name: 'winner' })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await d.listAgents()).filter((r) => r.name === 'winner').length, 1);
});

test('per-agent usage reads the selected conversation and rejects an unknown agent', async (t) => {
  const d = await fixture(t);
  const a = (await d.createAgent({ name: 'A' })).record, b = (await d.createAgent({ name: 'B' })).record;
  await d.harness.commit(async (tx) => {
    for (const [record, input] of [[a, 7], [b, 11]]) {
      (await tx.doc(UsageDoc, Number(record.conversationId))).models.test = { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    }
  }, ctx);
  assert.equal((await d.usage('A')).models.test.input, 7);
  assert.equal((await d.usage(b.agentId)).models.test.input, 11);
  assert.equal((await d.usage()).models.test.input, 18);
  await assert.rejects(d.usage('missing'), (e) => e.code === 'not_found');
});

test('delete agent also deletes its reminders while preserving other agents timers', async (t) => {
  const d = await fixture(t);
  const a = (await d.createAgent({ name: 'A' })).record;
  await d.createAgent({ name: 'B' });
  await d.remind('A', 'in 1h', 'A reminder'); await d.remind('B', 'in 1h', 'B reminder');
  let resyncs = 0; d.setReminderHook(() => { resyncs++; });
  await d.deleteAgent(a.agentId);
  assert.equal(resyncs, 1);
  assert.deepEqual((await d.listReminders()).map((r) => r.text), ['B reminder']);
});

test('real shell printenv receives only allowed values, never inherited host credentials', async (t) => {
  const d = await fixture(t);
  const values = { OPENAI_API_KEY: 'sentinel-provider-key', RAFTD_KEY: 'sentinel-admin-key', RAFTD_INTERNAL_KEY: 'sentinel-child-key', DATABASE_URL: 'sentinel-private-url', BUILD_MODE: 'allowed-build-mode', RAFTD_TOOL_ENV_ALLOW: 'BUILD_MODE,OPENAI_API_KEY,RAFTD_KEY' };
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const env = new ToolExecutionEnv({ cwd: d.stateDir });
  const chunks = [];
  const result = await env.exec('printenv', { onOutput: (data) => chunks.push(data) }, ctx);
  assert.equal(result.ok, true);
  const text = chunks.join('');
  assert.match(text, /BUILD_MODE=allowed-build-mode/); assert.match(text, /PATH=/);
  assert.equal(/sentinel-|OPENAI_API_KEY|RAFTD_KEY|RAFTD_INTERNAL_KEY|DATABASE_URL/.test(text), false, 'shell inherited a private environment value');
  assert.equal(process.env.OPENAI_API_KEY, 'sentinel-provider-key');
});

test('daemon model calls retain credentials while its actual bash tool cannot print them', async (t) => {
  const previous = process.env.ZAI_CODING_CN_API_KEY;
  process.env.ZAI_CODING_CN_API_KEY = 'provider-only-sentinel';
  t.after(() => { if (previous === undefined) delete process.env.ZAI_CODING_CN_API_KEY; else process.env.ZAI_CODING_CN_API_KEY = previous; });
  let calls = 0, authentications = 0;
  const source = zaiCodingCnProvider();
  const stream = (selected) => {
    assert.equal(process.env.ZAI_CODING_CN_API_KEY, 'provider-only-sentinel');
    const first = calls++ === 0;
    const response = {
      role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id,
      content: first ? [{ type: 'toolCall', id: 'environment-probe', name: 'bash', arguments: { command: 'printenv > tool-environment.txt' } }] : [{ type: 'text', text: 'environment checked' }],
      usage: { input: 3, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now(),
    };
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => { events.push({ type: 'done', reason: response.stopReason, message: response }); });
    return events;
  };
  const provider = { ...source, auth: { apiKey: { name: 'local test', resolve: async () => {
    authentications++; return { auth: { apiKey: process.env.ZAI_CODING_CN_API_KEY }, source: 'test environment' };
  } } }, stream, streamSimple: stream };
  const d = await fixture(t, { providers: [provider] });
  const a = (await d.createAgent({ name: 'environment' })).record;
  const submitted = await d.postMessage(a.agentId, 'run the environment check');
  const answer = await d.waitForAnswer(submitted.submissionId);
  assert.equal(answer.status, 'done'); assert.equal(answer.text, 'environment checked');
  assert.equal(calls, 2); assert.ok(authentications >= 1);
  const printed = await readFile(path.join(a.workspacePath, 'tool-environment.txt'), 'utf8');
  assert.match(printed, /PATH=/);
  assert.equal(/provider-only-sentinel|ZAI_CODING_CN_API_KEY/.test(printed), false, 'daemon bash tool inherited the provider credential');
  assert.equal((await d.usage(a.agentId)).models[`${model.provider}/${model.modelId}`].totalTokens, 20);
});

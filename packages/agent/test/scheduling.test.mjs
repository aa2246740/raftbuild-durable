import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { DurableDaemon } from '../src/daemon.ts';
import { ScriptedTransport } from '../src/transport.ts';
import { OutcomeReceiptDoc, outcomeReceiptKey } from '../src/outbox.ts';

async function until(check, description = 'condition', timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    assert.ok(Date.now() < end, `timed out: ${description}`);
    await sleep(5);
  }
}
async function setup(t, extra = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'raft-scheduling-'));
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  const transport = new ScriptedTransport();
  const options = { stateDir, providers: [faux.provider], transport, settings: { retry: { baseDelayMs: 1, maxRetries: 1 } }, ...extra };
  const opened = [];
  const open = async () => { const daemon = await DurableDaemon.open(options); opened.push(daemon); return daemon; };
  t.after(async () => { for (const daemon of opened) await daemon.close(); await rm(stateDir, { recursive: true, force: true }); });
  return { stateDir, faux, transport, open, daemon: await open() };
}
const outcomeFor = (transport, id) => transport.sent.find((e) => e.frame.type === 'agent:runtime:outcome' && e.frame.submissionId === id)?.frame.outcome;
const blockUntilAbort = async (_context, options) => {
  await sleep(60_000, undefined, { signal: options?.signal });
  return answer('unexpected');
};

test('offline admission preserves another agent pending work without starting any provider or shell', async (t) => {
  const f = await setup(t);
  const a = (await f.daemon.createAgent({ name: 'A' })).record;
  const b = (await f.daemon.createAgent({ name: 'B' })).record;
  const marker = path.join(b.workspacePath, 'side-effect.txt');
  const original = await f.daemon.postMessage(b.agentId, 'B durable tool task', { execute: false, requestId: 'original-b' });
  await f.daemon.close();
  const d = await f.open();
  const queued = await d.postMessage(a.agentId, 'A answer only', { execute: false, requestId: 'offline-a' });
  assert.deepEqual(await d.postMessage(a.agentId, 'duplicate A', { execute: false, requestId: 'offline-a' }), queued);
  assert.equal((await d.inspect()).scheduling, 'paused');
  await sleep(50);
  assert.equal(f.faux.state.callCount, 0);
  await assert.rejects(access(marker));
  const response = (context) => {
    if (context.messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('B durable tool task'))) {
      return context.messages.some((m) => m.role === 'toolResult') ? answer('B done')
        : answer(fauxToolCall('bash', { command: 'printf "once\\n" >> side-effect.txt' }), { stopReason: 'toolUse' });
    }
    return answer('A done');
  };
  f.faux.setResponses(Array(8).fill(response));
  await d.resume();
  assert.equal((await d.waitForAnswer(original.submissionId)).status, 'done');
  assert.equal((await d.waitForAnswer(queued.submissionId)).status, 'done');
  assert.equal(await readFile(marker, 'utf8'), 'once\n');
  assert.equal((await d.submissions(a.agentId)).filter((s) => s.type === 'input').length, 1);
});

test('429 followed by successful retry produces one turn_completed with recovered error telemetry', async (t) => {
  const f = await setup(t);
  const a = (await f.daemon.createAgent({ name: 'retry' })).record;
  f.faux.setResponses([answer('', { stopReason: 'error', errorMessage: 'HTTP 429 Too Many Requests' }), answer('success after retry')]);
  const s = await f.daemon.postMessage(a.agentId, 'please answer');
  assert.deepEqual(await f.daemon.waitForAnswer(s.submissionId), { submissionId: s.submissionId, status: 'done', text: 'success after retry' });
  await until(() => outcomeFor(f.transport, s.submissionId));
  const outcome = outcomeFor(f.transport, s.submissionId);
  assert.equal(outcome.kind, 'turn_completed');
  assert.ok(outcome.recoveredErrors >= 1);
  assert.equal(f.faux.state.callCount, 2);
  assert.equal((await f.daemon.lifecycle(a.agentId)).kind, 'idle');
  assert.equal(f.transport.sent.filter((e) => e.frame.submissionId === s.submissionId).length, 1);
});

test('abort returns idle; exhausted failures are terminal until start or resolve, with scrubbed detail', async (t) => {
  const f = await setup(t);
  const a = (await f.daemon.createAgent({ name: 'lifecycle' })).record;
  f.faux.setResponses([blockUntilAbort]);
  const cancelled = await f.daemon.postMessage(a.agentId, 'wait for cancellation');
  await until(() => f.faux.state.callCount === 1);
  await f.daemon.abort(a.agentId);
  assert.equal((await f.daemon.waitForAnswer(cancelled.submissionId)).reason, 'aborted');
  await until(() => outcomeFor(f.transport, cancelled.submissionId));
  assert.equal((await f.daemon.lifecycle(a.agentId)).kind, 'idle');
  f.faux.setResponses([answer('', { stopReason: 'error', errorMessage: 'HTTP 401 invalid api key OPENAI_API_KEY=should-not-leak' })]);
  const failed = await f.daemon.postMessage(a.agentId, 'fail authentication');
  const result = await f.daemon.waitForAnswer(failed.submissionId);
  assert.equal(result.status, 'unanswered');
  assert.match(result.detail, /invalid api key/);
  assert.doesNotMatch(result.detail, /should-not-leak/);
  await until(() => outcomeFor(f.transport, failed.submissionId));
  assert.equal((await f.daemon.lifecycle(a.agentId)).kind, 'terminal');
  await assert.rejects(f.daemon.postMessage(a.agentId, 'rejected while terminal'), /start or resolve/);
  await f.daemon.startAgent(a.agentId);
  assert.equal((await f.daemon.lifecycle(a.agentId)).kind, 'idle');
  assert.equal((await f.daemon.getAgent(a.agentId)).lastOutcome.submissionId, failed.submissionId);
  await f.daemon.close();
  const reopened = await f.open();
  await reopened.resume();
  assert.equal((await reopened.lifecycle(a.agentId)).kind, 'idle');
  f.faux.setResponses([answer('fixed')]);
  const final = await reopened.postMessage(a.agentId, 'try now');
  assert.equal((await reopened.waitForAnswer(final.submissionId)).text, 'fixed');
});

test('a persisted unavailable model is terminal, and resolve actually clears it', async (t) => {
  const f = await setup(t);
  const a = (await f.daemon.createAgent({ name: 'missing-model' })).record;
  const conversation = await f.daemon.harness.conversation(Number(a.conversationId), ctx);
  await conversation.configure({ model: { provider: 'missing', modelId: 'removed-model' } }, ctx);
  const s = await f.daemon.postMessage(a.agentId, 'unavailable');
  assert.equal((await f.daemon.waitForAnswer(s.submissionId)).reason, 'no_model');
  await until(() => outcomeFor(f.transport, s.submissionId));
  assert.equal((await f.daemon.lifecycle(a.agentId)).kind, 'terminal');
  assert.equal(outcomeFor(f.transport, s.submissionId).errorClass, 'ModelConfigError');
  await f.daemon.resolveAgent(a.agentId, 'model restored');
  assert.equal((await f.daemon.lifecycle(a.agentId)).kind, 'idle');
});

test('actual outbox overflow is visible immediately in lifecycle and resolve restores admission', async (t) => {
  let deliver = false;
  const delivered = [];
  const f = await setup(t, { transport: { async send(envelope) { if (!deliver) throw new Error('offline'); delivered.push(envelope); } }, retryDelayMs: () => 5 });
  const a = (await f.daemon.createAgent({ name: 'overflow' })).record;
  const outbox = f.daemon.outboxFor(a.agentId);
  for (let i = 0; i < 127; i++) await outbox.append({ type: 'agent:start:outcome', agentId: a.agentId, name: 'overflow', model: a.model, workspacePath: a.workspacePath, at: new Date().toISOString() });
  await assert.rejects(outbox.append({ type: 'agent:start:outcome', agentId: a.agentId, name: 'overflow', model: a.model, workspacePath: a.workspacePath, at: new Date().toISOString() }), /overflow/);
  assert.equal((await f.daemon.outboxState(a.agentId)).entries.length, 128);
  const state = await f.daemon.lifecycle(a.agentId);
  assert.equal(state.kind, 'terminal');
  assert.match(state.detail, /unreliable.*resolve/i);
  await assert.rejects(f.daemon.postMessage(a.agentId, 'no loss'), /unreliable/);
  deliver = true;
  await f.daemon.resolveAgent(a.agentId, 'transport repaired');
  await until(async () => (await f.daemon.outboxState(a.agentId)).entries.length === 0);
  assert.equal(delivered.filter((e) => e.clientSeq > 0).length, 128);
  f.faux.setResponses([answer('delivered')]);
  const s = await f.daemon.postMessage(a.agentId, 'new work');
  assert.equal((await f.daemon.waitForAnswer(s.submissionId)).text, 'delivered');
});

test('recovery epoch is durable, precedes resumed execution, and never adds model submissions', async (t) => {
  const f = await setup(t);
  const a = (await f.daemon.createAgent({ name: 'recovery' })).record;
  const original = await f.daemon.postMessage(a.agentId, 'original unfinished request', { execute: false });
  await f.daemon.close();
  for (let restart = 0; restart < 2; restart++) {
    const d = await f.open();
    let observed = false;
    f.faux.setResponses([async (context, options) => {
      const feed = await d.chatFeed(a.agentId);
      assert.equal(feed.filter((r) => r.from === 'system' && r.text.includes('Host restarted')).length, 1);
      assert.equal(context.messages.filter((m) => m.role === 'user').length, 1);
      observed = true;
      return blockUntilAbort(context, options);
    }]);
    await d.resume();
    await until(() => observed);
    assert.equal((await d.submissions(a.agentId)).filter((s) => s.type === 'input').length, 1);
    await d.close();
  }
  const final = await f.open();
  f.faux.setResponses([answer('recovered original')]);
  await final.resume();
  assert.equal((await final.waitForAnswer(original.submissionId)).text, 'recovered original');
  const feed = await final.chatFeed(a.agentId);
  assert.equal(feed.filter((r) => r.from === 'system').length, 1);
  assert.equal(f.faux.state.callCount, 3);
});

test('2000 settled history rows are reconciled once; feed reads only enough newest entries in stable order', async (t) => {
  const f = await setup(t);
  const a = (await f.daemon.createAgent({ name: 'long-history' })).record;
  await until(async () => (await f.daemon.outboxState(a.agentId)).entries.length === 0);
  await f.daemon.close();
  const seeded = await f.open();
  // Explicit durable history fixture, not 2000 faux requests. The public Tx
  // API creates genuine entries/settlements/receipts; read instrumentation
  // counts actual storage calls and never substitutes their results.
  for (let offset = 0; offset < 2000; offset += 100) {
    await seeded.harness.commit(async (tx) => {
      for (let i = offset; i < offset + 100; i++) {
        const entry = await tx.appendEntry(Number(a.conversationId), {
          kind: 'test.history', model: [{ role: 'user', content: `request ${i}`, timestamp: i }, answer(`answer ${i}`)],
        });
        const s = await tx.createSubmission({ conversationId: Number(a.conversationId), type: 'input', status: 'done', entry: entry.id, answer: entry.id });
        const receipt = await tx.doc(OutcomeReceiptDoc, outcomeReceiptKey(a.agentId, String(s.id)), String(s.id));
        receipt.produced = true;
        receipt.projected = true;
      }
    }, ctx);
  }
  await seeded.close();
  const d = await f.open();
  const storage = d.storage;
  let settledScans = 0;
  let entriesScanned = 0;
  const scanSubmissions = storage.scanSubmissions.bind(storage);
  const scanEntries = storage.scanEntries.bind(storage);
  storage.scanSubmissions = (...args) => { if (['done', 'unanswered'].includes(args[0].status)) settledScans++; return scanSubmissions(...args); };
  storage.scanEntries = async (...args) => { const page = await scanEntries(...args); entriesScanned += page.items.length; return page; };
  await d.resume();
  assert.ok(settledScans >= 20);
  settledScans = 0;
  entriesScanned = 0;
  const first = await d.chatFeed(a.agentId, 40);
  assert.equal(first.length, 40);
  assert.equal(first[0].text, 'request 1980');
  assert.equal(first[1].text, 'answer 1980');
  assert.equal(first.at(-1).text, 'answer 1999');
  assert.ok(entriesScanned <= 40, `requested 40 rows but loaded ${entriesScanned} entries`);
  assert.equal(new Set(first.map((r) => r.id)).size, 40);
  f.faux.setResponses([answer('new one'), answer('new two')]);
  for (let i = 0; i < 2; i++) {
    const s = await d.postMessage(a.agentId, `fresh ${i}`);
    assert.equal((await d.waitForAnswer(s.submissionId)).status, 'done');
    await until(() => outcomeFor(f.transport, s.submissionId));
  }
  assert.equal(settledScans, 0, 'hot admission must not rescan settled history');
  const second = await d.chatFeed(a.agentId, 48);
  for (const row of first) assert.equal(second.find((r) => r.id === row.id)?.text, row.text);
});

test('the live settlement observer does not miss an older ID settling after a newer ID', async (t) => {
  const f = await setup(t);
  const a = (await f.daemon.createAgent({ name: 'late-old-id' })).record;
  await f.daemon.resume();
  let older;
  await f.daemon.harness.commit(async (tx) => {
    older = await tx.createSubmission({ conversationId: Number(a.conversationId), type: 'input', status: 'queued' });
  }, ctx);
  f.faux.setResponses([answer('newer completed')]);
  const newer = await f.daemon.postMessage(a.agentId, 'newer real request');
  assert.ok(Number(newer.submissionId) > older.id);
  await f.daemon.waitForAnswer(newer.submissionId);
  await until(() => outcomeFor(f.transport, newer.submissionId));
  await f.daemon.harness.commit(async (tx) => { tx.settleSubmission(older.id, { status: 'unanswered', reason: 'aborted' }); }, ctx);
  await until(() => outcomeFor(f.transport, String(older.id)));
  assert.equal(f.transport.sent.filter((e) => e.frame.submissionId === String(older.id)).length, 1);
  assert.equal((await f.daemon.getAgent(a.agentId)).lastOutcome.submissionId, newer.submissionId);
  await f.daemon.close();
  const reopened = await f.open();
  await reopened.resume();
  await sleep(20);
  assert.equal(f.transport.sent.filter((e) => e.frame.submissionId === String(older.id)).length, 1);
});

test('cold admission is durable before slow real summarization, and steer and stop stay responsive', async (t) => {
  const f = await setup(t, { compactOnWakeMs: 20, settings: { retry: { maxRetries: 0 }, compaction: { enabled: false, keepRecentTokens: 1 } } });
  const a = (await f.daemon.createAgent({ name: 'cold' })).record;
  f.faux.setResponses([answer('first '.repeat(200)), answer('second '.repeat(200))]);
  for (const text of ['seed one '.repeat(150), 'seed two '.repeat(150)]) {
    const s = await f.daemon.postMessage(a.agentId, text);
    await f.daemon.waitForAnswer(s.submissionId);
  }
  await until(async () => (await f.daemon.lifecycle(a.agentId)).kind === 'idle');
  await sleep(25);
  let summarizing = false;
  let coldRunning = false;
  const response = async (context, options) => {
    const summary = JSON.stringify(context).includes('You are a context summarization assistant');
    if (summary) summarizing = true;
    else coldRunning = true;
    return blockUntilAbort(context, options);
  };
  f.faux.setResponses(Array(10).fill(response));
  const started = performance.now();
  const cold = await f.daemon.postMessage(a.agentId, 'cold request persisted first');
  assert.ok(performance.now() - started < 300, 'cold message waits for summary');
  assert.ok((await f.daemon.submissions(a.agentId)).some((s) => String(s.id) === cold.submissionId));
  await until(() => summarizing && coldRunning, 'real model and summary invocations both started');
  await sleep(25);
  const steerStarted = performance.now();
  const steer = await f.daemon.postMessage(a.agentId, 'urgent steer', { whenBusy: 'steer' });
  assert.ok(performance.now() - steerStarted < 300, 'steer waits for background summary');
  assert.ok((await f.daemon.submissions(a.agentId)).some((s) => String(s.id) === steer.submissionId));
  const stopStarted = performance.now();
  await f.daemon.stopAgent(a.agentId);
  assert.ok(performance.now() - stopStarted < 500, 'stop waits for background summary instead of aborting it');
  assert.equal((await f.daemon.lifecycle(a.agentId)).kind, 'stopped');
  assert.equal((await f.daemon.waitForAnswer(cold.submissionId)).reason, 'aborted');
  assert.equal((await f.daemon.waitForAnswer(steer.submissionId)).reason, 'aborted');
});

test('offline send leaves a previously interrupted real shell task untouched across repeated commands', async (t) => {
  const f = await setup(t);
  const a = (await f.daemon.createAgent({ name: 'one-shot-target' })).record;
  const b = (await f.daemon.createAgent({ name: 'interrupted-peer' })).record;
  const marker = path.join(b.workspacePath, 'started');
  f.faux.setResponses([answer(fauxToolCall('bash', { command: 'printf "start\\n" >> started; sleep 60; printf "done\\n" >> started' }), { stopReason: 'toolUse' })]);
  const original = await f.daemon.postMessage(b.agentId, 'start a long shell task');
  await until(async () => await readFile(marker, 'utf8').catch(() => '') === 'start\n', 'real shell side effect');
  await f.daemon.close();
  const before = f.faux.state.callCount;
  for (let command = 0; command < 2; command++) {
    const d = await f.open();
    const result = await d.postMessage(a.agentId, `offline command ${command}`, { execute: false });
    assert.match(result.submissionId, /^\d+$/);
    await sleep(30);
    assert.equal((await d.inspect()).scheduling, 'paused');
    assert.equal(f.faux.state.callCount, before);
    assert.equal(await readFile(marker, 'utf8'), 'start\n');
    const originalStatus = (await d.submissions(b.agentId)).find((s) => String(s.id) === original.submissionId);
    assert.ok(['queued', 'placed'].includes(originalStatus.status));
    await d.close();
  }
});

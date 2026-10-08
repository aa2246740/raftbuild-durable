import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { DurableDaemon } from '../src/daemon.ts';
import { AgentsDoc } from '../src/agents.ts';
import { OutboxDoc, OutcomeReceiptDoc, outcomeReceiptKey } from '../src/outbox.ts';
import { ScriptedTransport } from '../src/transport.ts';

const model = { provider: 'zai-coding-cn', modelId: 'glm-5.3-flash' };
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(check) {
  const end = Date.now() + 10_000;
  while (!await check()) { assert.ok(Date.now() < end, 'timed out'); await pause(); }
}

// Explicit historical-schema fixture, not 4097 model/user requests: use the
// official transaction primitives to persist settlements and the old bounded
// ledgers. No direct SQLite edits or reduced ring size. Real old-version
// crash/healthy native-serve checks are additionally run against review data.
async function fixture(t, { count, bounded = false, lostProjection = false, ledger = false, mixed = false, reason = 'no_model' }) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'raft-history-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let daemon = await DurableDaemon.open({ stateDir, providers: [], defaultModel: model, transport: new ScriptedTransport() });
  const { record } = await daemon.createAgent({ name: 'history' });
  await until(async () => !(await daemon.outboxState(record.agentId)).entries.length);
  await daemon.close();
  daemon = await DurableDaemon.open({ stateDir, providers: [], defaultModel: model, transport: new ScriptedTransport() });
  const ids = [];
  let runs = 0;
  for (let offset = 0; offset < count; offset += 100) {
    await daemon.harness.commit(async (tx) => {
      for (let i = offset; i < Math.min(offset + 100, count); i++) {
        const done = mixed && i % 3 === 0;
        let submission;
        if (done) {
          const entry = await tx.appendEntry(Number(record.conversationId), { kind: 'test.input', data: { index: i } });
          const answer = await tx.appendEntry(Number(record.conversationId), { kind: 'test.answer', data: { text: 'done' } });
          submission = await tx.createSubmission({ conversationId: Number(record.conversationId), type: 'input', status: 'done', entry: entry.id, answer: answer.id });
          runs++;
        } else {
          submission = await tx.createSubmission({ conversationId: Number(record.conversationId), type: 'input', status: 'unanswered', reason });
        }
        ids.push(String(submission.id));
      }
    }, ctx);
  }
  await daemon.harness.commit(async (tx) => {
    const r = (await tx.doc(AgentsDoc)).records[record.agentId];
    delete r.outcomeReceiptsVersion;
    if (bounded) r.projectedSubmissions = ids.slice(-4096);
    else delete r.projectedSubmissions;
    r.runs = lostProjection ? 0 : runs;
    r.failures = lostProjection ? 0 : count - runs;
    r.lastOutcome = null;
    const outbox = await tx.doc(OutboxDoc, record.agentId, record.agentId);
    outbox.producedSubmissionIds = ids.slice(-4096);
    outbox.nextClientSeq = count + 2;
  }, ctx);
  await daemon.close();
  if (ledger) {
    const first = { agentId: record.agentId, clientSeq: 2, attempt: 1, frame: { type: 'agent:runtime:outcome', agentId: record.agentId, submissionId: ids[0], outcome: { kind: 'terminal_failure', failureKind: 'sticky_runtime_error' } } };
    await writeFile(path.join(stateDir, '.deliveries', `${record.agentId}.jsonl`), JSON.stringify(first) + '\n{"torn":');
  }
  return { stateDir, agentId: record.agentId, ids, runs, failures: count - runs };
}

for (const bounded of [false, true]) {
  for (const count of [4095, 4096, 4097]) {
    test(`upgrade ${bounded ? 'bounded' : 'pre-ledger'} ${count} outcomes without cascading replay`, async (t) => {
      const f = await fixture(t, { count, bounded, mixed: true });
      const transport = new ScriptedTransport();
      let d = await DurableDaemon.open({ stateDir: f.stateDir, providers: [], defaultModel: model, transport });
      t.after(async () => { await d.close(); });
      await Promise.all([d.resume(), d.resume()]);
      await until(async () => !(await d.outboxState(f.agentId)).entries.length);
      const r = (await d.listAgents())[0];
      assert.equal(r.runs, f.runs);
      assert.equal(r.failures, f.failures);
      assert.equal(r.lastOutcome.submissionId, f.ids.at(-1));
      assert.equal(r.outcomeReceiptsVersion, 1);
      assert.equal((await d.outboxState(f.agentId)).unreliable, null);
      assert.equal(transport.sent.filter((e) => e.frame.type === 'agent:runtime:outcome').length, Math.max(0, count - 4096));
      await d.resume();
      assert.deepEqual([(await d.listAgents())[0].runs, (await d.listAgents())[0].failures], [f.runs, f.failures]);
      await d.close();
      const reopenedTransport = new ScriptedTransport();
      d = await DurableDaemon.open({ stateDir: f.stateDir, providers: [], defaultModel: model, transport: reopenedTransport });
      await d.resume();
      assert.equal(reopenedTransport.sent.filter((e) => e.frame.type === 'agent:runtime:outcome').length, 0);
      assert.deepEqual([(await d.listAgents())[0].runs, (await d.listAgents())[0].failures], [f.runs, f.failures]);
      for (const id of [f.ids[0], f.ids.at(-1)]) {
        const receipt = await d.harness.snapshot(OutcomeReceiptDoc, outcomeReceiptKey(f.agentId, id), ctx);
        assert.deepEqual(receipt, { produced: true, projected: true });
      }
    });
  }
}

test('delivery ledger proves forgotten prefix; torn tail never suppresses an unknown frame', async (t) => {
  const f = await fixture(t, { count: 4097, ledger: true });
  const transport = new ScriptedTransport();
  const d = await DurableDaemon.open({ stateDir: f.stateDir, providers: [], defaultModel: model, transport });
  t.after(() => d.close());
  await d.resume();
  assert.equal(transport.sent.filter((e) => e.frame.type === 'agent:runtime:outcome').length, 0);
  assert.equal((await d.listAgents())[0].failures, 4097);
});

test('frame-only legacy crash repairs projection exactly once, then new outcomes stay atomic', async (t) => {
  const f = await fixture(t, { count: 1, lostProjection: true });
  const transport = new ScriptedTransport();
  const d = await DurableDaemon.open({ stateDir: f.stateDir, providers: [], defaultModel: model, transport });
  t.after(() => d.close());
  await d.resume();
  assert.equal((await d.listAgents())[0].failures, 1);
  assert.equal(transport.sent.filter((e) => e.frame.type === 'agent:runtime:outcome').length, 0);
  const { submissionId } = await d.postMessage(f.agentId, 'real no-model admission');
  await d.waitForAnswer(submissionId);
  await until(async () => (await d.listAgents())[0].failures === 2 && !(await d.outboxState(f.agentId)).entries.length);
  await d.resume();
  assert.equal((await d.listAgents())[0].failures, 2);
  assert.deepEqual(await d.harness.snapshot(OutcomeReceiptDoc, outcomeReceiptKey(f.agentId, submissionId), ctx), { produced: true, projected: true });
  assert.equal(transport.sent.filter((e) => e.frame.type === 'agent:runtime:outcome').length, 1);
});

test('interrupted batched migration restarts before exposing partial projections', async (t) => {
  const f = await fixture(t, { count: 205, mixed: true, lostProjection: true });
  let d = await DurableDaemon.open({ stateDir: f.stateDir, providers: [], defaultModel: model, transport: new ScriptedTransport() });
  t.after(() => d.close());
  const commit = d.harness.commit.bind(d.harness);
  let interrupted = false;
  d.harness.commit = async (...args) => {
    const result = await commit(...args);
    const first = await d.harness.snapshot(OutcomeReceiptDoc, outcomeReceiptKey(f.agentId, f.ids[0]), ctx);
    const record = (await d.listAgents())[0];
    if (!interrupted && first && record.outcomeReceiptsVersion !== 1) {
      interrupted = true;
      throw new Error('test interruption after first durable receipt batch');
    }
    return result;
  };
  await assert.rejects(d.resume(), /test interruption/);
  assert.equal((await d.listAgents())[0].outcomeReceiptsVersion, undefined);
  d.harness.commit = commit;
  await d.close();
  d = await DurableDaemon.open({ stateDir: f.stateDir, providers: [], defaultModel: model, transport: new ScriptedTransport() });
  await d.resume();
  assert.deepEqual([(await d.listAgents())[0].runs, (await d.listAgents())[0].failures], [f.runs, f.failures]);
  await d.resume();
  assert.deepEqual([(await d.listAgents())[0].runs, (await d.listAgents())[0].failures], [f.runs, f.failures]);
});

test('new outcome receipts retain the first identity beyond 4096 appends and restart', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'raft-receipts-'));
  let d;
  t.after(async () => { await d?.close(); await rm(stateDir, { recursive: true, force: true }); });
  const transport = new ScriptedTransport();
  d = await DurableDaemon.open({ stateDir, providers: [], defaultModel: model, transport });
  const { record } = await d.createAgent({ name: 'receipt-growth' });
  let box = d.outboxFor(record.agentId);
  const frame = (id) => ({ type: 'agent:runtime:outcome', agentId: record.agentId, submissionId: id, outcome: { kind: 'turn_completed', textEvents: 1, toolCalls: 0 } });
  for (let i = 0; i < 4097; i++) {
    const id = `identity-${i}`;
    await box.append(frame(id), id);
    // Normal producer backpressure: this test measures receipt retention,
    // not the separate, intentional 128-entry queue capacity policy.
    if (i % 32 === 31) await until(async () => !(await box.state()).entries.length);
  }
  await until(async () => !(await box.state()).entries.length);
  const sequence = (await box.state()).nextClientSeq;
  assert.deepEqual(await box.append(frame('identity-0'), 'identity-0'), { duplicate: true });
  assert.equal((await box.state()).nextClientSeq, sequence);
  assert.equal(transport.sent.filter((e) => e.frame.type === 'agent:runtime:outcome').length, 4097);
  await d.close();
  d = await DurableDaemon.open({ stateDir, providers: [], defaultModel: model, transport: new ScriptedTransport() });
  box = d.outboxFor(record.agentId);
  assert.deepEqual(await box.append(frame('identity-0'), 'identity-0'), { duplicate: true });
  assert.equal((await box.state()).nextClientSeq, sequence);
});

for (const resolved of [true, false]) {
  test(`migration preserves ${resolved ? 'human-resolved' : 'richer'} terminal failure on an already-projected latest outcome`, async (t) => {
    const f = await fixture(t, { count: 1, bounded: true, reason: 'invalid api key' });
    const d = await DurableDaemon.open({ stateDir: f.stateDir, providers: [], defaultModel: model, transport: new ScriptedTransport() });
    t.after(() => d.close());
    const lastOutcome = { kind: 'terminal_failure', status: 'unanswered', submissionId: f.ids[0], reason: 'invalid api key', errorClass: 'AuthError', at: '2026-01-01T00:00:00.000Z' };
    const richFailure = { failureKind: 'sticky_runtime_error', fingerprint: 'richer-original-fingerprint', detail: 'original provider detail, retained through upgrade', at: '2026-01-01T00:00:00.000Z' };
    await d.harness.commit(async (tx) => {
      const r = (await tx.doc(AgentsDoc)).records[f.agentId];
      r.lastOutcome = lastOutcome;
      r.terminalFailure = richFailure;
    }, ctx);
    if (resolved) await d.resolveAgent(f.agentId, 'credentials replaced');
    const expected = resolved ? null : richFailure;
    assert.deepEqual((await d.listAgents())[0].terminalFailure, expected);
    await d.resume();
    await d.resume();
    const after = (await d.listAgents())[0];
    assert.deepEqual(after.terminalFailure, expected);
    assert.deepEqual(after.lastOutcome, lastOutcome);
    assert.equal(after.failures, 1);
  });
}

test('migration still restores a genuinely lost actionable terminal projection', async (t) => {
  const f = await fixture(t, { count: 1, bounded: true, lostProjection: true, reason: 'invalid api key' });
  const d = await DurableDaemon.open({ stateDir: f.stateDir, providers: [], defaultModel: model, transport: new ScriptedTransport() });
  t.after(() => d.close());
  await d.resume();
  const after = (await d.listAgents())[0];
  assert.equal(after.failures, 1);
  assert.equal(after.lastOutcome.submissionId, f.ids[0]);
  assert.equal(after.terminalFailure.detail, 'invalid api key');
  await d.resume();
  assert.deepEqual((await d.listAgents())[0].terminalFailure, after.terminalFailure);
});

/** Opt-in real 115-second Bash task; see this directory's README.md. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { DurableDaemon } from '../src/daemon.ts';
import { MachineLock } from '../src/machineLock.ts';
import { startServer } from '../src/serve.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const usage = `Usage: node packages/agent/test-manual/long-cli.mjs [--output <directory>]

Runs the actual daemon, HTTP server, thin CLI and a real Bash sleep 115.
No API key or external model service is used. The provider response is scripted.
The server's unmodified 110-second answer deadline must expire once; the CLI
must continue waiting and return success without submitting the task again.

Optional BASELINE_REPO: checkout of the old 39b5c25 code with dependencies installed.
Optional BASELINE_NODE: Node 24 executable for that checkout (defaults to this Node).
With a baseline, two agents run in parallel: old send must exit 1 after 110s,
new send must succeed, and new wait must recover the old submission's answer.

Evidence is saved to --output, or to a printed temporary directory. Temporary
daemon state and owned child processes are cleaned up. This takes about 116s.
`;

async function main() {
  let output;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') { console.log(usage); return; }
    if (args[i] === '--output' && args[i + 1] && !args[i + 1].startsWith('-')) output = path.resolve(args[++i]);
    else throw new Error(`unknown or incomplete option: ${args[i]}\n${usage}`);
  }
  const baseline = process.env.BASELINE_REPO ? path.resolve(process.env.BASELINE_REPO) : undefined;
  const baselineNode = process.env.BASELINE_NODE || process.execPath;
  if (baseline) {
    await access(path.join(baseline, 'packages/agent/src/cli.ts'));
    const version = spawnSync(baselineNode, ['--version'], { encoding: 'utf8' });
    if (version.error || version.status !== 0 || !/^v24\./.test(version.stdout.trim())) {
      throw new Error('The 39b5c25 baseline requires Node 24 for --experimental-transform-types. Set BASELINE_NODE to a Node 24 executable.');
    }
  }
  output ??= await mkdtemp(path.join(tmpdir(), 'raft-long-cli-evidence-'));
  await mkdir(output, { recursive: true });
  const eventsFile = path.join(output, 'events.jsonl');
  const resultFile = path.join(output, 'result.json');
  // Refuse to overwrite evidence from a previous run.
  for (const file of [eventsFile, resultFile]) {
    try { await access(file); throw new Error(`Evidence already exists: ${file}; choose another --output directory`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writeFile(eventsFile, '', { flag: 'wx', mode: 0o600 });
  const started = Date.now();
  const publicKey = `long-task-test-${randomUUID()}`;
  process.env.RAFTD_KEY = publicKey;
  delete process.env.RAFTD_WRAPPER_INSTANCE;
  delete process.env.RAFTD_INSECURE;
  const stateDir = await mkdtemp(path.join(tmpdir(), 'raft-long-cli-state-'));
  const requests = [];
  const children = new Set();
  let daemon, server, lock, summary, watchdog, interrupt;
  const event = (kind, details = {}) => {
    const line = JSON.stringify({ kind, elapsedMs: Date.now() - started, ...details });
    appendFileSync(eventsFile, line + '\n');
    console.log(line);
  };
  const heartbeat = setInterval(() => event('heartbeat', { completedRequests: requests.filter((r) => r.status).length }), 25_000);
  function cli(version, command) {
    const cliPath = path.join(version === 'old' ? baseline : repo, 'packages/agent/src/cli.ts');
    const began = Date.now();
    event('cli_start', { version, command });
    const child = spawn(version === 'old' ? baselineNode : process.execPath,
      [...(version === 'old' ? ['--experimental-transform-types'] : []), cliPath, ...command, '--state', stateDir], {
        cwd: repo,
        env: { PATH: process.env.PATH, HOME: stateDir, RAFTD_KEY: publicKey },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        children.delete(child);
        const result = { version, command, code, signal, durationMs: Date.now() - began, stdout, stderr };
        event('cli_exit', result);
        resolve(result);
      });
    });
  }

  try {
    event('evidence', { directory: output, node: process.version, baseline: baseline ?? null });
    lock = await MachineLock.acquire(stateDir);
    const faux = fauxProvider({ tokensPerSecond: Infinity });
    faux.setResponses(Array(8).fill((context) => context.messages.some((message) => message.role === 'toolResult')
      ? answer('LONG_TOOL_DONE: actual 115-second bash task completed')
      : answer(fauxToolCall('bash', {
        command: "printf 'once\\n' >> side-effect.txt; sleep 115; printf 'done\\n' >> completed.txt; printf 'LONG_TOOL_DONE\\n'",
        timeout: 150,
      }), { stopReason: 'toolUse' })));
    daemon = await DurableDaemon.open({ stateDir, providers: [faux.provider] });
    const oldAgent = baseline ? (await daemon.createAgent({ name: 'baseline-long' })).record : undefined;
    const newAgent = (await daemon.createAgent({ name: 'fixed-long' })).record;
    const agents = [oldAgent, newAgent].filter(Boolean);
    await daemon.resume();
    server = await startServer(daemon, { host: '127.0.0.1', port: 0 });
    server.prependListener('request', (req, res) => {
      const record = { method: req.method, url: req.url, startedMs: Date.now() - started };
      requests.push(record);
      res.once('finish', () => {
        Object.assign(record, { status: res.statusCode, finishedMs: Date.now() - started });
        event('http_finish', record);
      });
    });
    event('server_ready', { port: server.address().port, agents: agents.map((a) => a.agentId), sleepSeconds: 115 });
    const interrupted = new Promise((_, reject) => {
      interrupt = () => reject(new Error('Long-task verification interrupted by signal'));
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
    });
    const oldRun = oldAgent ? cli('old', ['send', oldAgent.agentId, 'run one real 115-second bash task']) : Promise.resolve(null);
    const newRun = cli('new', ['send', newAgent.agentId, 'run one real 115-second bash task']);
    const recovered = oldRun.then(async (result) => {
      if (!result) return null;
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /still running after 110s/);
      assert.ok(result.durationMs >= 110_000);
      const submissionId = result.stdout.match(/submission (\S+)/)?.[1];
      assert.ok(submissionId);
      return cli('new', ['wait', oldAgent.agentId, submissionId]);
    });
    const [oldResult, newResult, recoveredResult] = await Promise.race([
      Promise.all([oldRun, newRun, recovered]),
      interrupted,
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Long-task verification exceeded 180 seconds')), 180_000); }),
    ]);
    assert.equal(newResult.code, 0, newResult.stderr);
    assert.match(newResult.stdout, /LONG_TOOL_DONE/);
    assert.ok(newResult.durationMs >= 115_000);
    if (recoveredResult) {
      assert.equal(recoveredResult.code, 0, recoveredResult.stderr);
      assert.match(recoveredResult.stdout, /LONG_TOOL_DONE/);
    }
    const evidence = [];
    for (const agent of agents) {
      const sideEffect = await readFile(path.join(agent.workspacePath, 'side-effect.txt'), 'utf8');
      const completed = await readFile(path.join(agent.workspacePath, 'completed.txt'), 'utf8');
      assert.equal(sideEffect, 'once\n');
      assert.equal(completed, 'done\n');
      const submissions = (await daemon.submissions(agent.agentId)).filter((s) => s.type === 'input');
      assert.equal(submissions.length, 1);
      assert.equal(submissions[0].status, 'done');
      const posts = requests.filter((r) => r.method === 'POST' && r.url === `/api/agents/${agent.agentId}/messages`);
      assert.equal(posts.length, 1);
      evidence.push({ agentId: agent.agentId, sideEffect, completed, submissionCount: submissions.length });
    }
    const newAnswers = requests.filter((r) => r.url.startsWith(`/api/agents/${newAgent.agentId}/answer?`));
    assert.deepEqual(newAnswers.map((r) => r.status), [504, 200]);
    assert.equal(faux.state.callCount, agents.length * 2);
    summary = { ok: true, model: 'local faux provider; real Bash and HTTP; no external model API', elapsedMs: Date.now() - started,
      oldResult, newResult, recoveredResult, providerCalls: faux.state.callCount, evidence, requests };
    event('validated', { providerCalls: faux.state.callCount, evidence });
  } catch (error) {
    summary = { ok: false, error: error.stack, requests };
    process.exitCode = 1;
    event('failure', { error: error.stack });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(watchdog);
    if (interrupt) {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
    for (const child of children) child.kill('SIGKILL');
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    try { if (daemon) await daemon.close(); }
    finally {
      if (lock) await lock.release();
      await writeFile(resultFile, JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 });
      await rm(stateDir, { recursive: true, force: true });
      console.log(`Evidence: ${output}`);
    }
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

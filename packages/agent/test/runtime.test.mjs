import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const cli = path.join(repo, 'packages/agent/src/cli.ts');

async function environment(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'raft-runtime-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  // No inherited provider keys, runtime flags or preload hooks. Commands must
  // work exactly as shipped, with the same Node binary as this test process.
  return {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: home,
    TMPDIR: tmpdir(),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('native Node CLI loads its complete import graph without transform flags', async (t) => {
  assert.match(run(process.execPath, [cli, '--help'], await environment(t)), /raftd — durable agent daemon/);
});

test('executable raftd shebang works with the selected Node version', { skip: process.platform === 'win32' }, async (t) => {
  assert.match(run(cli, ['--help'], await environment(t)), /raftd — durable agent daemon/);
});

test('documented pnpm raftd entry creates durable state readable by native Node', async (t) => {
  const env = await environment(t);
  const state = path.join(env.HOME, 'state');
  const created = run('pnpm', ['raftd', 'create', 'native-smoke', '--model', 'zai-coding-cn/glm-5.3-flash', '--state', state], env);
  assert.match(created, /created .* \(native-smoke\)/);
  const agentId = created.match(/created (\S+) \(native-smoke\)/)?.[1];
  assert.ok(agentId);
  const listed = run(process.execPath, [cli, 'list', '--state', state], env);
  assert.ok(listed.includes(agentId), 'native CLI must read the same persisted agent');
  assert.match(listed, /native-smoke/);
  assert.match(listed, /zai-coding-cn\/glm-5\.3-flash/);
});

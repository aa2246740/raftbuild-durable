import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MachineLock, MachineLockError, procInfo, processStartTime } from '../src/machineLock.ts';

const holder = fileURLToPath(new URL('./fixtures/lock-holder.mjs', import.meta.url));
const zombieParent = fileURLToPath(new URL('./fixtures/lock-zombie-parent.py', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const linux = process.platform === 'linux';

function channel(child) {
  const messages = [];
  const waiters = new Set();
  let stderr = '';
  let closed = false;
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try { messages.push(JSON.parse(line)); }
    catch { stderr += `\nnon-JSON stdout: ${line}`; }
    for (const check of waiters) check();
  });
  const exited = new Promise((resolve) => child.once('close', (code, signal) => {
    closed = true;
    resolve({ code, signal });
    for (const check of waiters) check();
  }));
  // Cleanup may race a child that has already closed stdin.
  child.stdin.on('error', () => {});
  return {
    child,
    exited,
    send(command) { child.stdin.write(command + '\n'); },
    wait(events, timeout = 15_000) {
      const accepted = new Set(Array.isArray(events) ? events : [events]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`waiting for ${[...accepted]}: ${stderr}`)), timeout);
        const finish = (error, value) => {
          clearTimeout(timer);
          waiters.delete(check);
          if (error) reject(error); else resolve(value);
        };
        const check = () => {
          const found = messages.find((message) => accepted.has(message.event));
          if (found) finish(null, found);
          else if (closed) finish(new Error(`child exited before ${[...accepted]}: ${stderr}`));
        };
        waiters.add(check);
        check();
      });
    },
    async stop() {
      if (closed) return;
      // A paused publication fixture must be resumed before graceful cleanup.
      if (linux && procInfo(child.pid)?.state === 'T') child.kill('SIGCONT');
      child.stdin.end('release\n');
      await Promise.race([exited, sleep(2_000)]);
      if (!closed) { child.kill('SIGTERM'); await Promise.race([exited, sleep(2_000)]); }
      if (!closed) { child.kill('SIGKILL'); await exited; }
    },
  };
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'raft-machine-lock-'));
  const workers = [];
  const locks = [];
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.stop()));
    for (const lock of locks) await lock.release();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    locks,
    async acquire(options) { const lock = await MachineLock.acquire(dir, options); locks.push(lock); return lock; },
    worker(mode = 'hold') {
      const worker = channel(spawn(process.execPath, [holder, dir, mode], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }));
      workers.push(worker);
      return worker;
    },
    zombie() {
      const worker = channel(spawn('python3', [zombieParent, process.execPath, holder, dir], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }));
      workers.push(worker);
      return worker;
    },
  };
}

const legacyOwner = (pid = process.pid) => {
  const start = pid === process.pid ? processStartTime(pid) : undefined;
  return {
    pid, token: 'legacy-test-token', startedAt: new Date().toISOString(),
    ...(start !== undefined ? { pidStart: start } : {}),
  };
};
async function writeOwner(dir, owner) {
  await writeFile(path.join(dir, 'raftd.lock'), JSON.stringify(owner));
}
async function denied(worker) {
  await worker.wait('ready');
  worker.send('go');
  assert.equal((await worker.wait(['acquired', 'denied', 'error'])).event, 'denied');
}

function probeDatabase(dir, filename, busy) {
  const db = new DatabaseSync(path.join(dir, filename), { timeout: 0 });
  try {
    if (busy) assert.throws(() => db.exec('BEGIN IMMEDIATE'), (error) => error.errcode % 256 === 5);
    else db.exec('BEGIN IMMEDIATE');
  } finally { db.close(); }
}

async function stopped(pid) {
  for (let i = 0; i < 200 && procInfo(pid)?.state !== 'T'; i++) await sleep(5);
  assert.equal(procInfo(pid)?.state, 'T');
}

test('a wrapper manager reserves restart gaps against native owners while permitting its managed child', async (t) => {
  const f = await fixture(t);
  const manager = new DatabaseSync(path.join(f.dir, 'raftd.wrapper.sqlite'), { timeout: 0 });
  manager.exec('BEGIN IMMEDIATE');
  try {
    await assert.rejects(() => f.acquire(), MachineLockError);
    await denied(f.worker());
    const child = await f.acquire({ managedByWrapper: true });
    await denied(f.worker('managed-child'));
    await child.release();
    // Child death/release leaves storage free but native entry still blocked.
    probeDatabase(f.dir, 'raftd.lock.sqlite', false);
    await denied(f.worker());
    probeDatabase(f.dir, 'raftd.wrapper.sqlite', true);
  } finally { manager.close(); }
  await f.acquire();
});

test('failure on the second (storage) lock releases the first manager lock without unlocking the child', async (t) => {
  const f = await fixture(t);
  const child = await f.acquire({ managedByWrapper: true });
  await assert.rejects(() => f.acquire(), MachineLockError);
  probeDatabase(f.dir, 'raftd.wrapper.sqlite', false);
  probeDatabase(f.dir, 'raftd.lock.sqlite', true);
  await denied(f.worker('managed-child'));
  await child.release();
  await f.acquire();
});

test('native acquisition holds manager before opening storage', { skip: !linux }, async (t) => {
  const f = await fixture(t);
  const worker = f.worker('pause-before-storage');
  await worker.wait('ready'); worker.send('go');
  const pause = await worker.wait('before-storage');
  await stopped(pause.pid);
  await assert.rejects(() => stat(path.join(f.dir, 'raftd.lock.sqlite')), { code: 'ENOENT' });
  probeDatabase(f.dir, 'raftd.wrapper.sqlite', true);
  probeDatabase(f.dir, 'raftd.lock.sqlite', false);
  await denied(f.worker());
  worker.child.kill('SIGCONT');
  await worker.wait('acquired');
});

test('native release cleans metadata and closes storage before releasing manager', { skip: !linux }, async (t) => {
  const f = await fixture(t);
  const worker = f.worker('pause-after-storage-close');
  await worker.wait('ready'); worker.send('go'); await worker.wait('acquired');
  worker.send('release');
  const pause = await worker.wait('before-manager-release');
  await stopped(pause.pid);
  await assert.rejects(() => stat(path.join(f.dir, 'raftd.lock')), { code: 'ENOENT' });
  probeDatabase(f.dir, 'raftd.lock.sqlite', false);
  probeDatabase(f.dir, 'raftd.wrapper.sqlite', true);
  await denied(f.worker());
  worker.child.kill('SIGCONT');
  await worker.wait('released');
  await f.acquire();
});

test('32 same-process connections produce one winner; closing losers preserves its OS lock', async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 32 }, () => f.acquire()));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  for (const result of results.filter((result) => result.status === 'rejected')) {
    assert.ok(result.reason instanceof MachineLockError);
  }
  await assert.rejects(() => f.acquire(), MachineLockError);
  // An independent process catches accidental release of POSIX locks when a
  // losing same-process SQLite connection closes.
  await denied(f.worker());
});

test('32 OS processes racing dead JSON plus a dead legacy takeover have exactly one winner', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => dead.once('close', resolve));
  await writeOwner(f.dir, legacyOwner(dead.pid));
  const takeover = path.join(f.dir, 'raftd.lock.takeover');
  await mkdir(takeover);
  await writeFile(path.join(takeover, 'owner.json'), JSON.stringify(legacyOwner(dead.pid)));
  const workers = Array.from({ length: 32 }, () => f.worker());
  await Promise.all(workers.map((worker) => worker.wait('ready')));
  for (const worker of workers) worker.send('go');
  const results = await Promise.all(workers.map((worker) => worker.wait(['acquired', 'denied', 'error'])));
  assert.equal(results.filter((result) => result.event === 'acquired').length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => result.event === 'denied').length, 31, JSON.stringify(results));
});

test('SIGSTOP before JSON publication retains the lock beyond the old 30-second takeover timeout', { skip: !linux, timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const worker = f.worker('pause-before-publish');
  await worker.wait('ready');
  worker.send('go');
  const paused = await worker.wait('before-publish');
  for (let i = 0; i < 200 && procInfo(paused.pid)?.state !== 'T'; i++) await sleep(5);
  assert.equal(procInfo(paused.pid)?.state, 'T');
  await assert.rejects(() => readFile(path.join(f.dir, 'raftd.lock')), { code: 'ENOENT' });
  await denied(f.worker());
  await sleep(31_000);
  assert.equal(procInfo(paused.pid)?.state, 'T');
  await denied(f.worker());
  worker.child.kill('SIGCONT');
  assert.equal((await worker.wait(['acquired', 'error'])).event, 'acquired');
  worker.send('release');
  await worker.wait('released');
  await f.acquire();
});

test('SIGKILL releases the OS lock without deleting the persistent SQLite file', { skip: !linux }, async (t) => {
  const f = await fixture(t);
  const worker = f.worker();
  await worker.wait('ready'); worker.send('go'); await worker.wait('acquired');
  const inode = (await stat(path.join(f.dir, 'raftd.lock.sqlite'))).ino;
  worker.child.kill('SIGKILL');
  assert.equal((await worker.exited).signal, 'SIGKILL');
  await f.acquire();
  assert.equal((await stat(path.join(f.dir, 'raftd.lock.sqlite'))).ino, inode);
});

test('an unreaped zombie releases SQLite ownership before its parent calls wait', { skip: !linux }, async (t) => {
  if (spawnSync('python3', ['--version']).status !== 0) return t.skip('requires python3 to retain an unreaped child');
  const f = await fixture(t);
  const parent = f.zombie();
  await parent.wait('acquired');
  parent.send('kill');
  const zombie = await parent.wait('zombie');
  assert.equal(procInfo(zombie.pid)?.state, 'Z');
  await f.acquire();
  assert.equal(procInfo(zombie.pid)?.state, 'Z', 'acquisition completed before parent reaped owner');
  parent.send('reap');
  await parent.wait('reaped');
});

test('a live legacy JSON owner is refused and rejection releases the SQLite transaction', async (t) => {
  const f = await fixture(t);
  const owner = legacyOwner();
  await writeOwner(f.dir, owner);
  await assert.rejects(() => f.acquire(), (error) => error instanceof MachineLockError && /legacy pid/.test(error.message));
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'raftd.lock'), 'utf8')), owner);
  await rm(path.join(f.dir, 'raftd.lock'));
  await f.acquire();
});

test('a live legacy takeover owner is refused and can release without stranding the new lock', async (t) => {
  const f = await fixture(t);
  const takeover = path.join(f.dir, 'raftd.lock.takeover');
  await mkdir(takeover);
  await writeFile(path.join(takeover, 'owner.json'), JSON.stringify(legacyOwner()));
  await assert.rejects(() => f.acquire(), (error) => error instanceof MachineLockError && /takeover is still running/.test(error.message));
  await rm(takeover, { recursive: true });
  await f.acquire();
});

test('sqlite-v1 diagnostic JSON with a still-live PID does not override an available SQLite lock', async (t) => {
  const f = await fixture(t);
  await writeOwner(f.dir, { ...legacyOwner(), protocol: 'sqlite-v1' });
  await f.acquire();
  const owner = JSON.parse(await readFile(path.join(f.dir, 'raftd.lock'), 'utf8'));
  assert.equal(owner.protocol, 'sqlite-v1');
  assert.notEqual(owner.token, 'legacy-test-token');
});

test('metadata publication failure closes SQLite and cleans its private temporary file', async (t) => {
  const f = await fixture(t);
  // rename(file, directory) must fail, independent of test user's privileges.
  await mkdir(path.join(f.dir, 'raftd.lock'));
  await assert.rejects(() => f.acquire(), (error) => !(error instanceof MachineLockError) && ['EISDIR', 'EPERM', 'EACCES'].includes(error.code));
  assert.equal((await readdir(f.dir)).filter((name) => name.startsWith('raftd.lock.tmp-')).length, 0);
  await rm(path.join(f.dir, 'raftd.lock'), { recursive: true });
  await f.acquire();
});

test('release is idempotent and an old release cannot remove a successor or unlock its transaction', async (t) => {
  const f = await fixture(t);
  const first = await f.acquire();
  const inode = (await stat(path.join(f.dir, 'raftd.lock.sqlite'))).ino;
  const release = first.release();
  assert.equal(first.release(), release);
  await release;
  const second = await f.acquire();
  const owner = await readFile(path.join(f.dir, 'raftd.lock'), 'utf8');
  await first.release();
  assert.equal(await readFile(path.join(f.dir, 'raftd.lock'), 'utf8'), owner);
  await denied(f.worker());
  await second.release();
  assert.equal((await stat(path.join(f.dir, 'raftd.lock.sqlite'))).ino, inode);
  await f.acquire();
});

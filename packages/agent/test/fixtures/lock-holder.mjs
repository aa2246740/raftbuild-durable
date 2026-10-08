// Process boundary fixture: only the metadata-publication syscall is gated.
// SQLite acquisition and every lock result come from the real implementation.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const [stateDir, mode = 'hold'] = process.argv.slice(2);
const emit = (value) => fs.writeSync(1, JSON.stringify(value) + '\n');
if (mode === 'pause-before-storage' || mode === 'pause-after-storage-close') {
  const exec = DatabaseSync.prototype.exec;
  const close = DatabaseSync.prototype.close;
  const acquired = new WeakMap();
  let next = 0;
  DatabaseSync.prototype.exec = function (sql) {
    const result = exec.call(this, sql);
    if (sql === 'BEGIN IMMEDIATE') {
      acquired.set(this, ++next);
      if (mode === 'pause-before-storage' && next === 1) {
        emit({ event: 'before-storage', pid: process.pid });
        process.kill(process.pid, 'SIGSTOP');
      }
    }
    return result;
  };
  DatabaseSync.prototype.close = function () {
    const result = close.call(this);
    if (mode === 'pause-after-storage-close' && acquired.get(this) === 2) {
      emit({ event: 'before-manager-release', pid: process.pid });
      process.kill(process.pid, 'SIGSTOP');
    }
    return result;
  };
}
if (mode === 'pause-before-publish') {
  const rename = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (path.basename(to) === 'raftd.lock') {
      emit({ event: 'before-publish', pid: process.pid });
      process.kill(process.pid, 'SIGSTOP');
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
}
const { MachineLock, MachineLockError } = await import('../../src/machineLock.ts');
const input = createInterface({ input: process.stdin });
const commands = input[Symbol.asyncIterator]();
emit({ event: 'ready', pid: process.pid });
if ((await commands.next()).value !== 'go') process.exit(2);
let lock;
try {
  lock = await MachineLock.acquire(stateDir, { managedByWrapper: mode === 'managed-child' });
  emit({ event: 'acquired', pid: process.pid });
} catch (error) {
  emit({ event: error instanceof MachineLockError ? 'denied' : 'error', message: String(error) });
  input.close();
  process.stdin.destroy();
  process.exit(error instanceof MachineLockError ? 0 : 1);
}
try {
  await commands.next(); // explicit release, or EOF if the test is cleaning up
} finally {
  await lock.release();
  emit({ event: 'released' });
  input.close();
  process.stdin.destroy();
}

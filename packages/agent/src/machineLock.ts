/**
 * Machine lock — the daemon's machineLock.ts, reduced to one lock file.
 *
 * One `raftd` owns a state dir at a time. The lock file holds {pid, token,
 * startedAt}: a live pid refuses a second open; a dead pid means a crash —
 * the next open takes over (that's the whole point of durable state).
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const LOCK_NAME = "raftd.lock";

export class MachineLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineLockError";
  }
}

type LockOwner = { pid: number; token: string; startedAt: string };

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class MachineLock {
  private constructor(
    private readonly file: string,
    private readonly token: string,
  ) {}

  static async acquire(stateDir: string): Promise<MachineLock> {
    await mkdir(stateDir, { recursive: true });
    const file = path.join(stateDir, LOCK_NAME);
    if (existsSync(file)) {
      try {
        const owner = JSON.parse(readFileSync(file, "utf8")) as LockOwner;
        if (typeof owner.pid === "number" && pidAlive(owner.pid)) {
          throw new MachineLockError(
            `state dir already locked by pid ${owner.pid} (started ${owner.startedAt})`,
          );
        }
      } catch (err) {
        if (err instanceof MachineLockError) throw err;
        // Unreadable lock → stale file from a crash; take over.
      }
    }
    const token = randomUUID();
    const owner: LockOwner = { pid: process.pid, token, startedAt: new Date().toISOString() };
    await writeFile(file, JSON.stringify(owner, null, 2) + "\n", "utf8");
    return new MachineLock(file, token);
  }

  async release(): Promise<void> {
    try {
      const owner = JSON.parse(readFileSync(this.file, "utf8")) as LockOwner;
      if (owner.token === this.token) await rm(this.file, { force: true });
      // Token mismatch → someone else took over; leave their lock alone.
    } catch {
      // Lock file already gone.
    }
  }
}

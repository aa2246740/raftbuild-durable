/**
 * Machine lock — the daemon's machineLock.ts, reduced to one lock file.
 *
 * One `raftd` owns a state dir at a time. The lock file holds {pid, token,
 * startedAt}. Semantics:
 * - a live pid that still looks like a raftd process → refuse (locked);
 * - EPERM probing (live process owned by another user) → refuse, never
 *   "take over" a process we can't inspect;
 * - a dead pid, or a live pid whose /proc cmdline is clearly not ours
 *   (pid reuse after reboot) → stale lock, take over;
 * - acquire is an atomic create (O_EXCL) — two racing serves cannot both win.
 */
import { readFileSync } from "node:fs";
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

/** true = alive; false = dead; "foreign" = alive but clearly not raftd. */
function pidStatus(pid: number): "alive" | "dead" | "foreign" {
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = the process exists but is another user's — alive, not dead.
    if (code === "EPERM") return "alive";
    return "dead";
  }
  // Alive: verify it isn't a recycled pid wearing our lock. On Linux read
  // /proc/<pid>/cmdline; unreadable (macOS, sandbox) → trust the pid.
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (cmdline && !/cli\.ts|raftd/i.test(cmdline)) return "foreign";
  } catch {
    /* no /proc or races — treat as ours */
  }
  return "alive";
}

/** Read the lock; null = absent/unreadable, owner.alive reports pid state. */
export function inspectLock(stateDir: string): { owner: LockOwner; alive: boolean } | null {
  const file = path.join(stateDir, LOCK_NAME);
  try {
    const owner = JSON.parse(readFileSync(file, "utf8")) as LockOwner;
    if (typeof owner.pid !== "number") return null;
    const status = pidStatus(owner.pid);
    return { owner, alive: status === "alive" };
  } catch {
    return null;
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
    for (let attempt = 0; attempt < 5; attempt++) {
      const token = randomUUID();
      const owner: LockOwner = { pid: process.pid, token, startedAt: new Date().toISOString() };
      try {
        // O_EXCL: atomic create — two racing acquires cannot both succeed.
        await writeFile(file, JSON.stringify(owner, null, 2) + "\n", { flag: "wx" });
        return new MachineLock(file, token);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const existing = inspectLock(stateDir);
        if (!existing) {
          // Unreadable lock file → stale debris from a crash; take over.
          await rm(file, { force: true });
          continue;
        }
        if (existing.alive) {
          throw new MachineLockError(
            `state dir already locked by pid ${existing.owner.pid} (started ${existing.owner.startedAt})`,
          );
        }
        // Dead or pid-reused foreign process → stale lock; take it over.
        await rm(file, { force: true });
      }
    }
    throw new MachineLockError(`could not acquire ${file} after 5 attempts (contention)`);
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

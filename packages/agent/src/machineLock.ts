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

type LockOwner = { pid: number; token: string; startedAt: string; pidStart?: string };

/** /proc/<pid>/stat field 22 — kernel starttime, survives nothing but the pid itself. */
function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm may contain spaces/parens — parse after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19]; // field 22 overall
  } catch {
    return undefined;
  }
}

/** true = the recorded owner is alive; false = dead or a recycled pid. */
function ownerAlive(owner: LockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (err) {
    // EPERM = the process exists but is another user's — alive, never
    // "take over" a process we can't inspect. ESRCH = dead.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
  // A live pid can still be a RECYCLED pid after a reboot: compare kernel
  // start times. Old locks without pidStart get the benefit of the doubt.
  if (owner.pidStart !== undefined) {
    const now = processStartTime(owner.pid);
    if (now !== undefined && now !== owner.pidStart) return false;
  }
  return true;
}

/** Read the lock; null = absent/unreadable, owner.alive reports pid state. */
export function inspectLock(stateDir: string): { owner: LockOwner; alive: boolean } | null {
  const file = path.join(stateDir, LOCK_NAME);
  try {
    const owner = JSON.parse(readFileSync(file, "utf8")) as LockOwner;
    if (typeof owner.pid !== "number") return null;
    return { owner, alive: ownerAlive(owner) };
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
      const owner: LockOwner = {
        pid: process.pid,
        token,
        startedAt: new Date().toISOString(),
        pidStart: processStartTime(process.pid),
      };
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

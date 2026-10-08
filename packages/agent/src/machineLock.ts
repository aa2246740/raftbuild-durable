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
import { readFileSync, statSync } from "node:fs";
import { link, mkdir, rm, stat, writeFile } from "node:fs/promises";
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
export function processStartTime(pid: number): string | undefined {
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
export function inspectLock(stateDir: string): { owner: LockOwner; alive: boolean; ino?: number } | null {
  const file = path.join(stateDir, LOCK_NAME);
  try {
    const ino = statSync(file).ino;
    const owner = JSON.parse(readFileSync(file, "utf8")) as LockOwner;
    if (typeof owner.pid !== "number") return null;
    return { owner, alive: ownerAlive(owner), ino };
  } catch {
    return null;
  }
}

/**
 * Serializes stale-lock takeover. A stale lock must be removed before a fresh
 * link() can land, and inspect→remove is a check-then-act window: without a
 * mutex two racers can each delete the other's just-created live lock. mkdir()
 * is atomic on POSIX, so `<lock>.takeover/` is the mutex. Holders finish in
 * microseconds; a dir older than 30s belongs to a crashed holder and is
 * force-reaped. Returns false when the mutex stayed contended — callers retry.
 */
async function withTakeoverMutex<T>(dir: string, fn: () => Promise<T>): Promise<T | undefined> {
  for (let i = 0; i < 200; i++) {
    try {
      await mkdir(dir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const st = await stat(dir).catch(() => null);
      if (st === null) continue;
      if (Date.now() - st.mtimeMs > 30_000) {
        await rm(dir, { recursive: true, force: true });
        continue;
      }
      await new Promise((r) => setTimeout(r, 25));
      if (i === 199) return undefined;
    }
  }
  try {
    return await fn();
  } finally {
    await rm(dir, { recursive: true, force: true });
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
    const token = randomUUID();
    const owner: LockOwner = {
      pid: process.pid,
      token,
      startedAt: new Date().toISOString(),
      pidStart: processStartTime(process.pid),
    };
    const tmp = `${file}.tmp-${process.pid}-${token}`;
    for (let attempt = 0; attempt < 8; attempt++) {
      // Atomic create-with-content: write the owner JSON to a private temp
      // file, then hard-link it into place. link() fails EEXIST atomically —
      // a reader NEVER sees a half-written lock, so an unreadable file can
      // only be debris, not a concurrent writer mid-write (this used to be
      // the race: writeFile('wx') creates the name before the JSON lands).
      await writeFile(tmp, JSON.stringify(owner, null, 2) + "\n");
      try {
        await link(tmp, file);
        return new MachineLock(file, token);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      } finally {
        await rm(tmp, { force: true });
      }

      const existing = inspectLock(stateDir);
      if (existing?.alive) {
        throw new MachineLockError(
          `state dir already locked by pid ${existing.owner.pid} (started ${existing.owner.startedAt})`,
        );
      }
      // Dead owner or debris → remove it, but only under the takeover mutex
      // and only after a FRESH re-inspection inside the critical section:
      // the file we looked at may have been rotated into a live lock while
      // we waited. Deletion is unlink-not-rename — afterwards the plain
      // link() create decides the winner atomically.
      await withTakeoverMutex(`${file}.takeover`, async () => {
        const st = await stat(file).catch(() => null);
        if (st === null) return; // already gone — just retry the link
        if (existing !== null && existing.ino !== undefined && st.ino !== existing.ino) {
          return; // rotated since we looked — next iteration re-inspects
        }
        if (inspectLock(stateDir)?.alive) return; // live owner now — hands off
        await rm(file, { force: true });
      });
    }
    throw new MachineLockError(`could not acquire ${file} after 8 attempts (contention)`);
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

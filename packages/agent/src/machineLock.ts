/**
 * Machine lock — the daemon's machineLock.ts, reduced to one lock file.
 *
 * One `raftd` owns a state dir at a time. The lock file holds {pid, token,
 * startedAt, pidStart}. Semantics:
 * - a live pid that still looks like a raftd process → refuse (locked);
 * - EPERM probing (live process owned by another user) → refuse, never
 *   "take over" a process we can't inspect;
 * - a dead pid, a ZOMBIE pid (dead but not yet waited on), or a live pid
 *   whose kernel starttime differs from the recorded one (pid reuse) →
 *   stale lock, take over;
 * - acquire is an atomic create (link()) — two racing serves cannot both win.
 */
import { readFileSync, statSync } from "node:fs";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

export type ProcInfo = { state: string; pgrp: number; start: string };

/** /proc/<pid>/stat parsed once: state, process group, kernel starttime. */
export function procInfo(pid: number): ProcInfo | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm may contain spaces/parens — parse after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], pgrp: Number(fields[2]), start: fields[19] }; // fields 3/5/22 overall
  } catch {
    return undefined;
  }
}

/** /proc/<pid>/stat field 22 — kernel starttime, survives nothing but the pid itself. */
export function processStartTime(pid: number): string | undefined {
  return procInfo(pid)?.start;
}

/** States that are dead-for-real: zombie (dead, not yet reaped) and exiting. */
export const DEAD_STATES = new Set(["Z", "X", "x"]);

/**
 * true = the pid belongs to a live, executing process. A zombie fails
 * kill(0) semantics the other way — it EXISTS so kill(0) succeeds, but it
 * is dead, so /proc state is consulted first (falling back to kill(0) on
 * platforms without /proc). pidStart disambiguates recycled pids.
 */
export function processAlive(pid: number, pidStart?: string): boolean {
  const info = procInfo(pid);
  if (info === undefined) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      // EPERM = the process exists but is another user's — alive, never
      // "take over" a process we can't inspect. ESRCH = dead.
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
    return true;
  }
  if (DEAD_STATES.has(info.state)) return false;
  if (pidStart !== undefined && info.start !== pidStart) return false;
  return true;
}

/** true = the recorded owner is alive; false = dead, zombie, or recycled pid. */
function ownerAlive(owner: LockOwner): boolean {
  return processAlive(owner.pid, owner.pidStart);
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

const TAKEOVER_OWNER_FILE = "owner.json";

/**
 * Try to remove a takeover-mutex dir. Reaping rules:
 * - owner.json present and its process ALIVE (a SIGSTOP'd holder counts —
 *   pausing is not crashing) → never reap;
 * - owner.json present and its process dead/zombie/reused → reap;
 * - owner.json absent (holder died between mkdir and the identity write)
 *   → reap only once the dir is older than 30s.
 */
async function reapMutexDirIfDead(dir: string): Promise<boolean> {
  const st = await stat(dir).catch(() => null);
  if (st === null) return false;
  let owner: LockOwner | null = null;
  try {
    owner = JSON.parse(await readFile(path.join(dir, TAKEOVER_OWNER_FILE), "utf8")) as LockOwner;
  } catch {
    /* absent or malformed */
  }
  if (owner !== null && typeof owner.pid === "number") {
    if (ownerAlive(owner)) return false;
    // Re-verify in the last instant before rm: the dir at this path may have
    // been reaped and recreated since our stat — deleting by path would then
    // remove someone else's LIVE mutex. Same inode + owner still dead = the
    // dir we judged is still the dir we delete.
    const now = await stat(dir).catch(() => null);
    if (now === null || now.ino !== st.ino) return false;
    try {
      const fresh = JSON.parse(await readFile(path.join(dir, TAKEOVER_OWNER_FILE), "utf8")) as LockOwner;
      if (typeof fresh.pid !== "number" || ownerAlive(fresh)) return false;
    } catch {
      return false; // owner file vanished or turned unreadable — don't rm
    }
    await rm(dir, { recursive: true, force: true });
    return true;
  }
  if (Date.now() - st.mtimeMs > 30_000) {
    const now = await stat(dir).catch(() => null);
    if (now === null || now.ino !== st.ino) return false;
    await rm(dir, { recursive: true, force: true });
    return true;
  }
  return false;
}

/**
 * Serializes stale-lock takeover. mkdir() is the atomic claim, then the
 * winner writes owner.json — its identity — inside the dir. A contender may
 * only break the mutex when that identity is DEAD (see reapMutexDirIfDead),
 * so a holder paused mid-critical-section keeps exclusive ownership.
 *
 * The mkdir→owner.json gap is guarded by a post-write verification: if the
 * dir was legitimately reaped and recreated while we wrote, the inode moved
 * and we abort instead of acting on someone else's mutex. Release is
 * token-checked for the same reason.
 */
async function withTakeoverMutex<T>(dir: string, fn: () => Promise<T>): Promise<T | undefined> {
  const token = randomUUID();
  for (let i = 0; i < 240; i++) {
    let ino: number;
    try {
      await mkdir(dir);
      ino = (await stat(dir)).ino;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      await reapMutexDirIfDead(dir);
      await new Promise((r) => setTimeout(r, 25));
      if (i === 239) return undefined;
      continue;
    }
    // Claimed. Publish identity before running fn; a pre-publish crash leaves
    // a fileless dir that ages out on the 30s fallback.
    try {
      await writeFile(
        path.join(dir, TAKEOVER_OWNER_FILE),
        JSON.stringify({
          pid: process.pid,
          token,
          startedAt: new Date().toISOString(),
          pidStart: processStartTime(process.pid),
        } satisfies LockOwner),
      );
    } catch {
      continue; // dir vanished underneath us — recreate next round
    }
    if ((await stat(dir).catch(() => null))?.ino !== ino) continue; // reaped+recreated
    try {
      return await fn();
    } finally {
      try {
        const owner = JSON.parse(
          await readFile(path.join(dir, TAKEOVER_OWNER_FILE), "utf8"),
        ) as LockOwner;
        if (owner.token === token) await rm(dir, { recursive: true, force: true });
      } catch {
        /* mutex dir already gone */
      }
    }
  }
  return undefined;
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

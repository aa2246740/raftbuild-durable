/**
 * Single-writer ownership of a state directory. Native owners first reserve
 * the wrapper manager slot, then storage. A wrapper holds the manager slot
 * across child restarts; its managed child reserves only storage. SQLite
 * transactions live until release; process death releases them, while a
 * paused process retains ownership.
 *
 * raftd.lock is diagnostic metadata / a legacy-upgrade guard. It is NOT the
 * lock primitive. Never unlink, rename, or read/close raftd.lock.sqlite or
 * raftd.wrapper.sqlite through ordinary fs APIs while running: SQLite must
 * manage all descriptors/locking.
 */
import { readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { randomUUID } from "node:crypto";

const LOCK_NAME = "raftd.lock";
const LOCK_PROTOCOL = "sqlite-v1";

export class MachineLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineLockError";
  }
}

type LockOwner = { pid: number; token: string; startedAt: string; pidStart?: string; protocol?: string };

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

/** Only contention is a MachineLockError; I/O/corruption errors stay visible. */
function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: number }).errcode;
  return typeof code === "number" && (code % 256 === 5 || code % 256 === 6);
}

/** Reverse acquisition order, keeping manager ownership through cleanup. */
function closeDatabases(storage?: DatabaseSync, manager?: DatabaseSync): void {
  try { storage?.close(); }
  finally { manager?.close(); }
}

export class MachineLock {
  private readonly file: string;
  private readonly token: string;
  private readonly database: DatabaseSync;
  private readonly manager: DatabaseSync | undefined;
  private releasePromise: Promise<void> | undefined;

  private constructor(
    file: string,
    token: string,
    database: DatabaseSync,
    manager: DatabaseSync | undefined,
  ) {
    this.file = file;
    this.token = token;
    this.database = database;
    this.manager = manager;
  }

  static async acquire(stateDir: string, options: { managedByWrapper?: boolean } = {}): Promise<MachineLock> {
    const dir = path.resolve(stateDir);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, LOCK_NAME);
    let database: DatabaseSync | undefined;
    let manager: DatabaseSync | undefined;
    try {
      // Native CLI/serve must not take over a wrapper's state while its child
      // is starting or restarting. The wrapper retains this first lock over
      // those gaps; its explicitly managed child acquires only storage.
      if (!options.managedByWrapper) {
        manager = new DatabaseSync(path.join(dir, "raftd.wrapper.sqlite"), { timeout: 0 });
        manager.exec("BEGIN IMMEDIATE");
      }
      database = new DatabaseSync(path.join(dir, "raftd.lock.sqlite"), { timeout: 0 });
      database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      closeDatabases(database, manager);
      if (isBusy(error)) {
        throw new MachineLockError(`state dir already locked: ${dir}`);
      }
      throw error;
    }

    const token = randomUUID();
    const tmp = `${file}.tmp-${process.pid}-${token}`;
    try {
      // A running pre-SQLite daemon does not know our lock protocol. Refuse
      // its live metadata rather than opening its state concurrently. Stop
      // old binaries before upgrading; their own takeover race cannot be
      // repaired by a new binary running alongside them.
      const legacy = inspectLock(dir);
      if (legacy?.alive && legacy.owner.protocol !== LOCK_PROTOCOL) {
        throw new MachineLockError(`state dir already locked by legacy pid ${legacy.owner.pid}`);
      }
      let legacyTakeover: LockOwner | undefined;
      try {
        legacyTakeover = JSON.parse(readFileSync(path.join(dir, `${LOCK_NAME}.takeover`, "owner.json"), "utf8")) as LockOwner;
      } catch { /* stale or absent legacy mutex */ }
      if (legacyTakeover && typeof legacyTakeover.pid === "number" && ownerAlive(legacyTakeover)) {
        throw new MachineLockError(`legacy lock takeover is still running by pid ${legacyTakeover.pid}; stop the old daemon before upgrading`);
      }

      const owner: LockOwner = {
        protocol: LOCK_PROTOCOL,
        pid: process.pid,
        token,
        startedAt: new Date().toISOString(),
        pidStart: processStartTime(process.pid),
      };
      await writeFile(tmp, JSON.stringify(owner, null, 2) + "\n", { mode: 0o600 });
      // The SQLite transaction protects both publication and release, even
      // if either process is paused between any of these filesystem calls.
      await rename(tmp, file);
      return new MachineLock(file, token, database, manager);
    } catch (error) {
      closeDatabases(database, manager); // releases both locks on every failure
      throw error;
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  release(): Promise<void> {
    this.releasePromise ??= this.releaseOwned();
    return this.releasePromise;
  }

  private async releaseOwned(): Promise<void> {
    try {
      let owner: LockOwner | undefined;
      try { owner = JSON.parse(readFileSync(this.file, "utf8")) as LockOwner; }
      catch { /* metadata may have been removed; SQLite still owns the lock */ }
      if (owner?.token === this.token) await rm(this.file, { force: true });
    } finally {
      // Do not delete the database. A stable inode is part of the locking
      // protocol, and a later acquire must contend on this same file.
      closeDatabases(this.database, this.manager);
    }
  }
}

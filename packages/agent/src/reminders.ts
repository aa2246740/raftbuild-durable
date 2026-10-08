/**
 * Reminders — the daemon's reminder app, rebuilt as a durable timer doc.
 *
 * `remind()` commits a timer row; a service arms a setTimeout per pending
 * timer, fires it as a system notice to the agent, then marks it fired (or
 * re-arms it for `every` repeats). On resume every pending timer re-arms —
 * a crash can delay a reminder, never lose it.
 */
import { randomUUID } from "node:crypto";

import { defineDoc } from "@earendil-works/pi-durable";

import type { DurableDaemon } from "./daemon.ts";
import { AgentRegistryError } from "./agents.ts";

export type Reminder = {
  id: string;
  agentId: string;
  text: string;
  /** ISO instant of the next fire. */
  dueAt: string;
  /** Zone used to interpret the request; older persisted rows default to UTC. */
  timeZone?: string;
  /** Repeat interval in ms; null = one-shot. */
  everyMs: number | null;
  createdAt: string;
};

export type RemindersState = { timers: Reminder[] };

export const RemindersDoc = defineDoc<RemindersState>({
  kind: "raft.reminders",
  version: 1,
  scope: "session",
  initial: () => ({ timers: [] }),
});

/** Parse "in 30m" | "in 2h" | "every 10m" | "at 14:30" | ISO into {dueAt, everyMs}. */
export function parseWhen(spec: string, now = new Date()): { dueAt: string; everyMs: number | null; timeZone: string } {
  const text = spec.trim();
  const invalid = () => new Error(`cannot parse when: "${spec}" (use "in 30m", "every 1h", "at 14:30", or a future ISO timestamp with Z/offset)`);
  const rel = text.match(/^(in|every)\s+(\d+)\s*(s|m|h|d)$/i);
  if (rel) {
    const n = Number(rel[2]);
    const unit = rel[3]!.toLowerCase();
    const ms = n * (unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
    if (!Number.isSafeInteger(ms) || ms < 1_000 || !Number.isFinite(new Date(now.getTime() + ms).getTime())) throw invalid();
    return { dueAt: new Date(now.getTime() + ms).toISOString(), everyMs: rel[1]!.toLowerCase() === "every" ? ms : null, timeZone: "UTC" };
  }
  const at = text.match(/^at\s+(\d{1,2}):(\d{2})$/i);
  if (at) {
    const hh = Number(at[1]), mm = Number(at[2]);
    if (hh > 23 || mm > 59) throw invalid();
    const d = new Date(now);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return { dueAt: d.toISOString(), everyMs: null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  // Date.parse alone accepts numbers, locale dates, missing zones, and even
  // normalizes impossible calendar days. Validate all fields before parsing.
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!iso) throw invalid();
  const [year, month, day, hour, minute, second] = iso.slice(1, 7).map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year!, month! - 1, day!);
  calendar.setUTCHours(hour!, minute!, second!, 0);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month! - 1 || calendar.getUTCDate() !== day || hour! > 23 || minute! > 59 || second! > 59) throw invalid();
  const zone = iso[8]!;
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) throw invalid();
  const due = new Date(text);
  if (!Number.isFinite(due.getTime())) throw invalid();
  if (due.getTime() <= now.getTime()) throw new Error(`reminder time must be in the future: "${spec}"`);
  return { dueAt: due.toISOString(), everyMs: null, timeZone: zone === "Z" ? "UTC" : `UTC${zone}` };
}

// Node clamps setTimeout delays > ~24.8 days to 1ms — without a wake-up
// dueAt recheck, a "in 30d" reminder would fire (and be consumed) at once.
const MAX_TIMEOUT_MS = 2_147_483_000;

export class ReminderService {
  private readonly daemon: DurableDaemon;
  private readonly timers = new Map<string, { handle: NodeJS.Timeout; dueAt: string }>();
  private stopped = false;

  constructor(daemon: DurableDaemon) {
    this.daemon = daemon;
    daemon.setReminderHook(() => void this.resync());
  }

  /** Arm setTimeouts for every pending reminder; safe to call repeatedly. */
  async start(): Promise<void> {
    await this.resync();
  }

  /**
   * Reconcile armed setTimeouts with the durable doc — called on start and
   * after every remind/reschedule/delete so live-created reminders fire
   * without a restart.
   */
  async resync(): Promise<void> {
    const timers = await this.daemon.listReminders();
    const byId = new Map(timers.map((t) => [t.id, t]));
    for (const [id, armed] of [...this.timers]) {
      const t = byId.get(id);
      if (!t || t.dueAt !== armed.dueAt) {
        clearTimeout(armed.handle);
        this.timers.delete(id);
      }
    }
    for (const t of timers) this.arm(t);
  }

  stop(): void {
    this.stopped = true;
    for (const armed of this.timers.values()) clearTimeout(armed.handle);
    this.timers.clear();
  }

  private arm(t: Reminder): void {
    if (this.stopped || this.timers.has(t.id)) return;
    const delay = Math.min(Math.max(0, new Date(t.dueAt).getTime() - Date.now()), MAX_TIMEOUT_MS);
    const handle = setTimeout(() => void this.fire(t.id), delay);
    handle.unref?.();
    this.timers.set(t.id, { handle, dueAt: t.dueAt });
  }

  private async fire(id: string): Promise<void> {
    this.timers.delete(id);
    if (this.stopped) return;
    let t: Reminder | undefined;
    try {
      t = (await this.daemon.listReminders()).find((r) => r.id === id);
    } catch {
      return; // session already closed
    }
    if (!t) return;
    // Woke early (clamped long delay or clock jump): not due yet → re-arm.
    const dueMs = new Date(t.dueAt).getTime() - Date.now();
    if (dueMs > 60_000) {
      this.arm(t);
      return;
    }
    let permanentlyMissing = false;
    const delivered = await this.daemon
      .postMessage(t.agentId, `Reminder: ${t.text}`, {
        systemNotice: true,
        requestId: `reminder:${t.id}:${t.dueAt}`,
      })
      .then(() => true)
      .catch((err) => {
        permanentlyMissing = err instanceof AgentRegistryError && err.code === "not_found";
        if (permanentlyMissing) return false;
        console.error(`[reminders] fire ${t!.id} failed:`, err);
        return false;
      });
    if (!delivered && permanentlyMissing) {
      await this.daemon.deleteReminder(t.id).catch(() => {});
      return;
    }
    if (!delivered) {
      // Keep the row AND re-arm for a retry — a stopped agent that later
      // starts must still get the reminder (startAgent/resolveAgent also
      // trigger resync via the daemon's reminder hook).
      const retryAt = new Date(Date.now() + 60_000).toISOString();
      this.arm({ ...t, dueAt: retryAt });
      return;
    }
    try {
      if (t.everyMs != null) {
        await this.daemon.rescheduleReminder(t.id, new Date(Date.now() + t.everyMs).toISOString());
      } else {
        await this.daemon.deleteReminder(t.id);
      }
    } catch {
      return; // session closed mid-fire; the row settles on next start
    }
    // Re-arm whatever came back (the repeat's next dueAt).
    const next = (await this.daemon.listReminders().catch(() => [] as Reminder[])).find((r) => r.id === t!.id);
    if (next) this.arm(next);
  }
}

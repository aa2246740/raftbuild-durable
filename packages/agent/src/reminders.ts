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

export type Reminder = {
  id: string;
  agentId: string;
  text: string;
  /** ISO instant of the next fire. */
  dueAt: string;
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
export function parseWhen(spec: string, now = new Date()): { dueAt: string; everyMs: number | null } {
  const rel = spec.match(/^(in|every)\s+(\d+)\s*(s|m|h|d)$/i);
  if (rel) {
    const n = Number(rel[2]);
    const unit = rel[3].toLowerCase();
    const ms = n * (unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
    const everyMs = rel[1].toLowerCase() === "every" ? ms : null;
    return { dueAt: new Date(now.getTime() + ms).toISOString(), everyMs };
  }
  const at = spec.match(/^at\s+(\d{1,2}):(\d{2})$/i);
  if (at) {
    const d = new Date(now);
    d.setHours(Number(at[1]), Number(at[2]), 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return { dueAt: d.toISOString(), everyMs: null };
  }
  const iso = new Date(spec);
  if (!Number.isNaN(iso.getTime())) return { dueAt: iso.toISOString(), everyMs: null };
  throw new Error(`cannot parse when: "${spec}" (try "in 30m", "every 1h", "at 14:30", or ISO)`);
}

export class ReminderService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(private readonly daemon: DurableDaemon) {}

  /** Arm setTimeouts for every pending reminder; safe to call repeatedly. */
  async start(): Promise<void> {
    const timers = await this.daemon.listReminders();
    for (const t of timers) this.arm(t);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private arm(t: Reminder): void {
    if (this.stopped || this.timers.has(t.id)) return;
    const delay = Math.max(0, new Date(t.dueAt).getTime() - Date.now());
    const handle = setTimeout(() => void this.fire(t.id), delay);
    handle.unref?.();
    this.timers.set(t.id, handle);
  }

  private async fire(id: string): Promise<void> {
    this.timers.delete(id);
    const t = (await this.daemon.listReminders()).find((r) => r.id === id);
    if (!t) return;
    await this.daemon
      .postMessage(t.agentId, `Reminder: ${t.text}`, {
        systemNotice: true,
        requestId: `reminder:${t.id}:${t.dueAt}`,
      })
      .catch((err) => console.error(`[reminders] fire ${t.id} failed:`, err));
    if (t.everyMs != null) {
      await this.daemon.rescheduleReminder(t.id, new Date(Date.now() + t.everyMs).toISOString());
    } else {
      await this.daemon.deleteReminder(t.id);
    }
    // Re-arm whatever came back (the repeat's next dueAt).
    const next = (await this.daemon.listReminders()).find((r) => r.id === t.id);
    if (next) this.arm(next);
  }
}

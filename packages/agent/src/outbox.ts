/**
 * Durable port of reference/raft-daemon/src/runtimeOutcomeOutbox.ts.
 *
 * What is kept (same rules, new substrate):
 *  - write-ahead: a frame enters the durable doc in one commit before any send;
 *    the send happens only after the commit returns;
 *  - entry identity: per-agent `clientSeq`, monotonic across restarts;
 *  - stop-and-wait: at most one in-flight entry per agent, the oldest; the next
 *    is sent only after the exact ack; an ack deletes only that entry;
 *  - retransmission: un-acked in-flight entries resend with the SAME identity,
 *    backoff 5s → 10s → 20s … capped at 5min with ±20% jitter;
 *  - capacity: 128 entries per agent; overflow drops the oldest not-in-flight
 *    `turn_completed`; if none is droppable the append fails closed and the
 *    agent is marked unreliable;
 *  - unreliable: a failed write or fail-closed drop marks the agent unreliable
 *    (durable `unreliable` marker); only a human `resolve()` clears it;
 *  - restart: in-flight entries requeue on open (they may have been sent;
 *    the consumer dedupes by (agentId, clientSeq)).
 *
 * What is dropped, honestly: the daemon's gap/cross markers, takeover epochs
 * and server-capability negotiation exist for multi-daemon-machine takeover.
 * One storage has exactly one Harness owner at a time, so there is no second
 * instance to attribute gaps to — a drop is simply fail-closed → unreliable.
 */
import { defineDocFamily } from "@earendil-works/pi-durable";
import type { Harness, Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { OutboxDocEntry, OutboxDocState, OutboxFrame } from "./types.ts";
import type { OutboxTransport } from "./transport.ts";

export const OUTBOX_NORMAL_CAP = 128;
export const OUTBOX_RETRANSMIT_BASE_MS = 5_000;
export const OUTBOX_RETRANSMIT_MAX_MS = 300_000;
export const OUTBOX_RETRANSMIT_JITTER = 0.2;

/** Same schedule as the daemon's retransmitDelayMs. */
export function retransmitDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(OUTBOX_RETRANSMIT_BASE_MS * 2 ** attempt, OUTBOX_RETRANSMIT_MAX_MS);
  const jitter = base * OUTBOX_RETRANSMIT_JITTER;
  return Math.max(0, Math.round(base - jitter + random() * jitter * 2));
}

export const OutboxDoc = defineDocFamily<OutboxDocState, string>({
  kind: "raft.outbox",
  version: 1,
  scope: "session",
  family: true,
  initial: (agentId) => ({
    agentId: String(agentId),
    nextClientSeq: 1,
    entries: [],
    unreliable: null,
    resolution: null,
    producedSubmissionIds: [],
  }),
});

/** Permanent per-key receipt. Unlike the legacy 4096-key ring, one receipt
 * never evicts another; each document stays constant-sized. */
export const OutcomeReceiptDoc = defineDocFamily<{ produced: boolean; projected: boolean }, string>({
  kind: "raft.outcomeReceipt",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ produced: false, projected: false }),
});

export const outcomeReceiptKey = (agentId: string, submissionId: string): string =>
  JSON.stringify([agentId, submissionId]);

export class OutboxError extends Error {
  readonly code: "unreliable" | "overflow" | "not_found";

  constructor(
    message: string,
    code: "unreliable" | "overflow" | "not_found",
  ) {
    super(message);
    this.code = code;
    this.name = "OutboxError";
  }
}

export type OutboxAppendResult = "appended" | "dropped_turn_completed" | "unreliable";

/**
 * Shared doc-level append: dedupe ring + entry push + cap drop/fail-closed.
 * Used by `AgentOutbox.append()` and by tools writing route frames inside
 * their own `api.commit` — same discipline either way.
 */
export function appendToOutboxDoc(
  doc: OutboxDocState,
  frame: OutboxFrame,
  dedupeKey?: string,
): { clientSeq: number; result: OutboxAppendResult } | { duplicate: true } {
  if (dedupeKey !== undefined) {
    if (doc.producedSubmissionIds.includes(dedupeKey)) return { duplicate: true };
    doc.producedSubmissionIds.push(dedupeKey);
    // Legacy/tool-call compatibility ring. Outcome appends through AgentOutbox
    // use permanent OutcomeReceiptDoc members instead of this bounded set.
    if (doc.producedSubmissionIds.length > 4096) {
      doc.producedSubmissionIds.splice(0, doc.producedSubmissionIds.length - 4096);
    }
  }
  const clientSeq = doc.nextClientSeq++;
  doc.entries.push({
    clientSeq,
    frame,
    enqueuedAt: new Date().toISOString(),
    inFlight: false,
    attempts: 0,
    lastAttemptAt: null,
  });
  let result: OutboxAppendResult = "appended";
  if (doc.entries.length > OUTBOX_NORMAL_CAP) {
    const victimIndex = doc.entries.findIndex(
      // The newly appended frame is never a drop victim — dropping the
      // fresh evidence to make room for itself defeats the write-ahead.
      (e) => !e.inFlight && e.clientSeq !== clientSeq && isTurnCompleted(e),
    );
    if (victimIndex >= 0) {
      doc.entries.splice(victimIndex, 1);
      result = "dropped_turn_completed";
    } else {
      // Fail closed: a throw aborts the commit — no entry was added and
      // no marker could be lost half-written.
      throw new OutboxError("outbox overflow: refused to drop non-turn_completed evidence", "overflow");
    }
  }
  return { clientSeq, result };
}

function isTurnCompleted(entry: OutboxDocEntry): boolean {
  const frame = entry.frame;
  return frame.type === "agent:runtime:outcome" && frame.outcome.kind === "turn_completed";
}

/**
 * One agent's outbox: the durable doc plus an in-process delivery pump.
 * State changes are commits; delivery is a stop-and-wait pump driven by a
 * timer (started lazily on first append).
 */
export class AgentOutbox {
  private readonly harness: Harness;
  private readonly ctx: Context;
  readonly agentId: string;
  private readonly transport: OutboxTransport;
  private pumpTimer: NodeJS.Timeout | null = null;
  private pumping = false;
  private stopped = false;
  private readonly retryDelayMs: (attempt: number) => number;
  private pendingNotify: (() => void) | null = null;
  /** Retain a wake that races the current pump's final state read/exit. */
  private wakeRequested = false;
  /** In-memory unreliability (a commit failure we couldn't even durably record). */
  private memoryUnreliable: string | undefined;

  constructor(
    harness: Harness,
    ctx: Context,
    agentId: string,
    transport: OutboxTransport,
    opts: { retryDelayMs?: (attempt: number) => number } = {},
  ) {
    this.harness = harness;
    this.ctx = ctx;
    this.agentId = agentId;
    this.transport = transport;
    this.retryDelayMs = opts.retryDelayMs ?? ((attempt) => retransmitDelayMs(attempt));
  }

  /** Current committed state, or undefined before the first append. */
  async state(): Promise<Readonly<OutboxDocState> | undefined> {
    return this.harness.snapshot(OutboxDoc, this.agentId, this.ctx);
  }

  async isUnreliable(): Promise<boolean> {
    return this.memoryUnreliable != null || (await this.state())?.unreliable != null;
  }

  /**
   * Write-ahead append: the frame is committed first; only after the commit
   * resolves does the pump consider it deliverable. A commit failure marks the
   * agent unreliable and throws.
   *
   * `dedupeKey` (a submission id) is recorded in the same commit: a crash can
   * never produce "marked but no frame" or "frame but no mark".
   */
  async append(
    frame: OutboxFrame,
    dedupeKey?: string,
    inTx?: (tx: Tx) => Promise<void>,
  ): Promise<{ clientSeq: number; result: OutboxAppendResult } | { duplicate: true }> {
    if (this.memoryUnreliable) {
      throw new OutboxError(`agent ${this.agentId} outbox is unreliable: ${this.memoryUnreliable}`, "unreliable");
    }
    try {
      return await this.harness.commit(async (tx) => {
        const doc = await tx.doc(OutboxDoc, this.agentId, this.agentId);
        if (doc.unreliable) {
          throw new OutboxError(`agent ${this.agentId} outbox is unreliable since ${doc.unreliable.since}`, "unreliable");
        }
        // Outcome receipts outlive the bounded legacy/tool-call ring. Check
        // them inside the SAME transaction as the frame and projection.
        const receipt = dedupeKey !== undefined && frame.type === "agent:runtime:outcome"
          ? await tx.doc(OutcomeReceiptDoc, outcomeReceiptKey(this.agentId, dedupeKey), dedupeKey)
          : undefined;
        const duplicate = receipt?.produced || (receipt && doc.producedSubmissionIds.includes(dedupeKey!));
        const result = duplicate
          ? { duplicate: true as const }
          : appendToOutboxDoc(doc, frame, receipt ? undefined : dedupeKey);
        if (receipt) receipt.produced = true;
        // Legacy frame-only commits can still need projection. The callback
        // owns its own persistent receipt, so it is safe on duplicates too.
        if (receipt || !("duplicate" in result)) await inTx?.(tx);
        return result;
      }, this.ctx);
    } catch (err) {
      const benignClose = err instanceof Error && /session is closed/i.test(err.message);
      if (!benignClose && (!(err instanceof OutboxError) || err.code === "overflow")) {
        // A failed write or a fail-closed drop of known evidence marks the
        // agent unreliable (durable marker, human resolve to clear). A commit
        // racing daemon close is not corruption evidence.
        await this.markUnreliable(err instanceof Error ? err.message : String(err));
      }
      throw err;
    } finally {
      this.kick();
    }
  }

  /** Durable marker; retries its own commit until it lands (or the doc is unreadable). */
  async markUnreliable(cause: string): Promise<void> {
    // Memory fail-closed FIRST: the same failure that broke the write usually
    // breaks the marker commit too (sustained ENOSPC etc.). Only an explicit
    // resolve() clears the agent — never a lucky next commit.
    this.memoryUnreliable = cause;
    try {
      await this.harness.commit(async (tx) => {
        const doc = await tx.doc(OutboxDoc, this.agentId, this.agentId);
        if (!doc.unreliable) {
          doc.unreliable = { since: new Date().toISOString(), reason: cause };
        }
      }, this.ctx);
    } catch {
      this.memoryUnreliable = `${cause} (unreliable-marker write also failed)`;
    }
    // Tell the consumer, best-effort, bypassing the outbox itself.
    try {
      await this.transport.send({
        agentId: this.agentId,
        clientSeq: -1,
        attempt: 0,
        frame: {
          type: "agent:outcome_unreliable",
          agentId: this.agentId,
          reason: cause,
          detail: null,
          since: new Date().toISOString(),
        },
      });
    } catch {
      // best-effort only
    }
  }

  /** Human recovery: durably record the resolution, clear the marker, requeue in-flight. */
  async resolve(note?: string): Promise<void> {
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(OutboxDoc, this.agentId, this.agentId);
      doc.resolution = { kind: "human_resolve", note: note ?? "", at: new Date().toISOString() };
      doc.unreliable = null;
      for (const entry of doc.entries) {
        entry.inFlight = false;
      }
    }, this.ctx);
    this.memoryUnreliable = undefined;
    this.kick();
  }

  /** Reopen: any committed in-flight entry may or may not have been sent — requeue all. */
  async requeueInFlight(): Promise<void> {
    try {
      await this.harness.commit(async (tx) => {
        const doc = await tx.doc(OutboxDoc, this.agentId, this.agentId);
        for (const entry of doc.entries) {
          entry.inFlight = false;
        }
      }, this.ctx);
    } catch (err) {
      // A storage that cannot commit the requeue must not silently stall:
      // mark the outbox memory-unreliable so appends/pumps surface it.
      this.memoryUnreliable = `in-flight requeue failed: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    this.kick();
  }

  /** Wake the pump (after append/requeue/resolve). */
  kick(): void {
    if (this.stopped) return;
    this.wakeRequested = true;
    if (this.pumpTimer === null && !this.pumping) {
      this.pumpTimer = setTimeout(() => {
        this.pumpTimer = null;
        this.wakeRequested = false;
        void this.pumpOnce();
      }, 0);
      this.pumpTimer.unref?.();
    } else {
      this.pendingNotify?.();
    }
  }

  /** Stop the pump. Committed state is untouched. */
  stop(): void {
    this.stopped = true;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    this.pendingNotify?.();
    this.pendingNotify = null;
  }

  private async pumpOnce(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.stopped) return;
        const state = await this.state();
        if (!state || state.unreliable || this.memoryUnreliable) return;
        const next = state.entries.find((e) => !e.inFlight);
        if (!next) return;
        // Claim it durably first: a crash between mark and send is fine —
        // reopen requeues in-flight entries, and the consumer dedupes.
        // Two processes racing the same entry: only the commit that flipped
        // inFlight may send — the loser skips (verified double-delivery bug).
        let claimed = false;
        try {
          claimed = await this.harness.commit(async (tx) => {
            const doc = await tx.doc(OutboxDoc, this.agentId, this.agentId);
            const entry = doc.entries.find((e) => e.clientSeq === next.clientSeq);
            if (!entry || entry.inFlight) return false;
            entry.inFlight = true;
            entry.attempts++;
            entry.lastAttemptAt = new Date().toISOString();
            return true;
          }, this.ctx);
        } catch (err) {
          await this.markUnreliable(`in-flight mark write failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        if (!claimed) continue;
        try {
          await this.transport.send({
            agentId: this.agentId,
            clientSeq: next.clientSeq,
            attempt: next.attempts + 1,
            frame: next.frame,
          });
        } catch {
          // Retransmission: same identity, after backoff. The entry stays
          // in-flight (never folded), exactly like the daemon.
          const delay = this.retryDelayMs(next.attempts + 1);
          await new Promise<void>((resolve) => {
            const wake = () => {
              if (this.pumpTimer) clearTimeout(this.pumpTimer);
              this.pumpTimer = null;
              this.pendingNotify = null;
              resolve();
            };
            this.pendingNotify = wake;
            this.pumpTimer = setTimeout(wake, delay);
            this.pumpTimer.unref?.();
          });
          if (this.stopped) return;
          try {
            await this.harness.commit(async (tx) => {
              const doc = await tx.doc(OutboxDoc, this.agentId, this.agentId);
              const entry = doc.entries.find((e) => e.clientSeq === next.clientSeq);
              if (entry) entry.inFlight = false;
            }, this.ctx);
          } catch {
            /* unreliable is already marked or storage is gone */
          }
          continue;
        }
        // Exact ack: the transport committed → delete only this entry.
        try {
          await this.harness.commit(async (tx) => {
            const doc = await tx.doc(OutboxDoc, this.agentId, this.agentId);
            const index = doc.entries.findIndex((e) => e.clientSeq === next.clientSeq);
            if (index >= 0) doc.entries.splice(index, 1);
          }, this.ctx);
        } catch (err) {
          await this.markUnreliable(`ack delete write failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }
    } finally {
      this.pumping = false;
      this.pendingNotify = null;
      if (this.wakeRequested) {
        this.wakeRequested = false;
        this.kick();
      }
    }
  }
}

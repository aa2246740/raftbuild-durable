/**
 * Lifecycle projection — the durable analog of reference/raft-daemon/src/
 * agentLifecycleRecord.ts.
 *
 * The daemon's kinds are process states (queued for spawn → starting →
 * running → idle → cooldown on spawn failure → terminal). There is no process
 * here: the same labels are projected from the conversation's committed view
 * (`pi.live`, `pi.inbox`) plus registry bookkeeping:
 *
 *   queued    — submissions waiting in `pi.inbox` to be placed
 *   starting  — record exists but the conversation has no run yet and inbox empty
 *   running   — `pi.live` has a live generation or tool call
 *   idle      — conversation exists, nothing running, nothing queued
 *   cooldown  — the live generation is waiting for its next retry
 *   terminal  — terminalFailure recorded (unreliable outbox, action-required error)
 *   stopped   — host marked the agent stopped (daemon's stop epochs)
 */
import type { ConversationView } from "@earendil-works/pi-durable";
import type { AgentLifecycleKind, AgentRecord } from "./types.ts";

export interface AgentLifecycleRecord {
  kind: AgentLifecycleKind;
  agentId: string;
  detail?: string;
}

interface LiveDocShape {
  run?: unknown;
  generation?: { retry?: { at: number; error: string } };
  tools?: Readonly<Record<string, unknown> | readonly unknown[]>;
}

interface InboxDocShape {
  items?: readonly unknown[];
}

export function projectLifecycle(
  record: AgentRecord,
  view: ConversationView | undefined,
  outboxUnreliable = false,
): AgentLifecycleRecord {
  if (outboxUnreliable) {
    return { kind: "terminal", agentId: record.agentId, detail: "Outbox is unreliable; use resolve to resume delivery." };
  }
  if (record.override === "stopped") {
    return { kind: "stopped", agentId: record.agentId };
  }
  if (record.terminalFailure) {
    return { kind: "terminal", agentId: record.agentId, detail: record.terminalFailure.detail };
  }

  const live = view?.docs["pi.live"] as LiveDocShape | undefined;
  const inbox = view?.docs["pi.inbox"] as InboxDocShape | undefined;
  const busy = Boolean(live?.run) || Boolean(live?.generation) || (live?.tools != null && Object.keys(live.tools).length > 0);
  const queued = (inbox?.items?.length ?? 0) > 0;

  if (live?.generation?.retry) return { kind: "cooldown", agentId: record.agentId, detail: "Waiting for an automatic retry." };
  if (busy) return { kind: "running", agentId: record.agentId };
  if (queued) return { kind: "queued", agentId: record.agentId };
  if (view === undefined) return { kind: "starting", agentId: record.agentId };
  if (unresolvedFailure(record)) {
    return { kind: "terminal", agentId: record.agentId, detail: `${record.lastOutcome?.reason ?? "unanswered"}; use start or resolve before sending more work.` };
  }
  if (record.lastOutcome) return { kind: "idle", agentId: record.agentId };
  if (view.entries.length <= 1) return { kind: "starting", agentId: record.agentId };
  return { kind: "idle", agentId: record.agentId };
}

/** Exhausted failures do not schedule another attempt. Abort is a user
 * cancellation, while start/resolve explicitly clear the last failed result. */
export function unresolvedFailure(record: AgentRecord): boolean {
  const outcome = record.lastOutcome;
  return outcome?.status === "unanswered"
    && outcome.reason !== "aborted"
    && outcome.errorClass !== "OperationAbortedError"
    && outcome.submissionId !== record.resolvedSubmissionId;
}

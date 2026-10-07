/**
 * Normalizer: pi-durable `watchEvents` AgentEvents → the daemon's ParsedEvent
 * vocabulary (drivers/types.ts subset) plus per-turn outcome counters.
 *
 * Includes a verbatim port of reference/raft-daemon/src/drivers/piEventNormalizer.ts
 * (usage attr extraction) so the `token_usage` telemetry events match.
 */
import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ParsedEvent } from "./types.ts";
import { createTurnOutcomeCounters, noteTurnOutcomeEvent, type TurnOutcomeCounters } from "./outcome.ts";

// ── usage attrs (piEventNormalizer.ts, verbatim) ────────────────────────────

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const PI_TOKEN_MAPPINGS = [
  ["input", "input_tokens"],
  ["output", "output_tokens"],
  ["cacheRead", "cached_read_tokens"],
  ["cacheWrite", "cache_write_tokens"],
  ["cacheWrite1h", "cache_write_1h_tokens"],
  ["reasoning", "reasoning_tokens"],
  ["totalTokens", "total_tokens"],
] as const;

const PI_COST_MAPPINGS = [
  ["total", "totalCostUsd"],
  ["input", "cost_input_usd"],
  ["output", "cost_output_usd"],
  ["cacheRead", "cost_cache_read_usd"],
  ["cacheWrite", "cost_cache_write_usd"],
] as const;

export function extractPiUsageAttrs(usage: unknown): Record<string, number> {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};
  const source = usage as Record<string, unknown>;
  const attrs: Record<string, number> = {};
  for (const [wireKey, attrKey] of PI_TOKEN_MAPPINGS) {
    const candidate = finiteNumber(source[wireKey]);
    if (candidate !== undefined) attrs[attrKey] = candidate;
  }
  const cost = source.cost;
  if (cost && typeof cost === "object" && !Array.isArray(cost)) {
    const costSource = cost as Record<string, unknown>;
    for (const [wireKey, attrKey] of PI_COST_MAPPINGS) {
      const candidate = finiteNumber(costSource[wireKey]);
      if (candidate !== undefined) attrs[attrKey] = candidate;
    }
  }
  return attrs;
}

export function buildPiTokenUsageEvent(
  message: unknown,
  sessionId: string | null,
): Extract<ParsedEvent, { kind: "telemetry" }> | null {
  if (!message || typeof message !== "object") return null;
  const attrs = extractPiUsageAttrs((message as Record<string, unknown>).usage);
  if (Object.keys(attrs).length === 0) return null;
  return {
    kind: "telemetry",
    name: "token_usage",
    source: "pi_message_end_usage",
    usageKind: "per_turn",
    sessionId: sessionId ?? undefined,
    attrs,
  };
}

// ── normalizer ────────────────────────────────────────────────────────────

function assistantMessageOf(entry: { model?: readonly unknown[] } | undefined): AssistantMessage | undefined {
  const first = entry?.model?.[0];
  if (first && typeof first === "object" && (first as { role?: string }).role === "assistant") {
    return first as AssistantMessage;
  }
  return undefined;
}

function messageHasText(message: AssistantMessage | undefined): boolean {
  return Boolean(message?.content?.some((b) => b.type === "text" && typeof b.text === "string" && b.text.length > 0));
}

/**
 * Stateful per-conversation normalizer. Feed it the snapshot at attach and
 * each AgentEvent batch afterwards; it yields ParsedEvents and keeps the
 * outcome counters the outbox pump reads at run end.
 */
export class DurableEventNormalizer {
  private counters: TurnOutcomeCounters = createTurnOutcomeCounters();
  /** Sticky: once a terminal-path error is seen, later turn ends stay tainted. */
  stickyTerminalFailure = false;
  /** First error text seen this run — fingerprint input for E1. */
  firstErrorText: string | null = null;
  private pendingTextDelta = "";
  private pendingThinkingDelta = "";

  resetRun(): void {
    this.counters = createTurnOutcomeCounters();
    this.stickyTerminalFailure = false;
    this.firstErrorText = null;
    this.pendingTextDelta = "";
    this.pendingThinkingDelta = "";
  }

  get outcomeCounters(): TurnOutcomeCounters {
    return this.counters;
  }

  private note(event: ParsedEvent): void {
    noteTurnOutcomeEvent(this.counters, event);
  }

  private noteError(message: string): void {
    if (this.firstErrorText === null) this.firstErrorText = message;
    this.stickyTerminalFailure = true;
  }

  /** Events produced by attaching (the snapshot itself). */
  normalizeSnapshot(snapshot: SnapshotEvent, sessionId: string): ParsedEvent[] {
    const out: ParsedEvent[] = [{ kind: "session_init", sessionId }];
    if (snapshot.run) {
      const e: ParsedEvent = { kind: "run_start", inputs: snapshot.run.inputs.map(String) };
      out.push(e);
    }
    return out;
  }

  normalize(events: readonly AgentEvent[]): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    const push = (e: ParsedEvent) => {
      out.push(e);
      this.note(e);
    };
    const flushText = () => {
      if (this.pendingTextDelta) {
        push({ kind: "text", text: this.pendingTextDelta });
        this.pendingTextDelta = "";
      }
      if (this.pendingThinkingDelta) {
        push({ kind: "thinking", text: this.pendingThinkingDelta });
        this.pendingThinkingDelta = "";
      }
    };

    for (const event of events) {
      switch (event.type) {
        case "run_start":
          flushText();
          push({ kind: "run_start", inputs: event.inputs.map(String) });
          break;
        case "run_end":
          flushText();
          push({ kind: "run_end", inputs: event.inputs.map(String) });
          break;
        case "turn_start":
          flushText();
          break;
        case "turn_end":
          flushText();
          push({ kind: "turn_end" });
          break;
        case "message_update":
          for (const change of event.changes) {
            if (change.type === "text_delta") {
              this.pendingTextDelta += change.delta;
            } else if (change.type === "thinking_delta") {
              this.pendingThinkingDelta += change.delta;
            } else if (change.type === "text_start" || change.type === "thinking_start" || change.type === "toolcall_start" || change.type === "block" || change.type === "message") {
              flushText();
            }
          }
          break;
        case "message_end": {
          const message = assistantMessageOf(event.entry);
          if (!this.pendingTextDelta && message) {
            // Non-streaming providers emit one whole block: no deltas ever
            // arrived — emit the text now instead of only counting it.
            const text = message.content
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("");
            if (text) this.pendingTextDelta = text;
          }
          flushText();
          if (messageHasText(message) && this.counters.textEvents === 0) {
            this.note({ kind: "text", text: " " });
          }
          if (message?.stopReason === "error" || message?.errorMessage) {
            const msg = message.errorMessage ?? `provider stop reason: ${message.stopReason}`;
            this.noteError(msg);
            push({ kind: "error", message: msg, nativeReasonPresent: true });
          }
          const usage = buildPiTokenUsageEvent(message, null);
          if (usage) out.push(usage);
          break;
        }
        case "tool_execution_start":
          flushText();
          push({ kind: "tool_call", name: event.toolName, input: event.args });
          break;
        case "tool_execution_update":
          break;
        case "tool_execution_end":
          push({ kind: "tool_output", name: event.toolName });
          break;
        case "submission": {
          const rec = event.record;
          if (rec.status === "done" || rec.status === "unanswered") {
            const e: ParsedEvent = {
              kind: "submission_settled",
              submissionId: String(rec.id),
              status: rec.status,
              ...(rec.status === "unanswered" ? { reason: rec.reason } : {}),
            };
            if (rec.status === "unanswered") {
              this.noteError(rec.reason);
            }
            out.push(e);
          }
          break;
        }
        case "task_failed":
          this.noteError(event.message);
          push({ kind: "error", message: `${event.kind}: ${event.message}`, nativeReasonPresent: true });
          break;
        case "compaction_start":
          push({ kind: "compaction_started", reason: event.reason });
          break;
        case "compaction_end":
          push({ kind: "compaction_finished", reason: event.reason });
          break;
        case "auto_retry_start":
          break;
        case "auto_retry_end":
        case "deferred_poll":
        case "inbox_update":
        case "agent_changed":
        case "usage_changed":
        case "entry_appended":
        case "message_start":
          break;
        default:
          break;
      }
    }
    return out;
  }
}

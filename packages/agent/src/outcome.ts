/**
 * Port of reference/raft-daemon/src/runtimeOutcome.ts — the E1/E2 evidence
 * construction for the `agent:runtime:outcome` frame:
 *  - E1 `terminal_failure`: which terminal path ended the run, plus a
 *    fingerprint of the (scrubbed) runtime text;
 *  - E2 `turn_completed`: per-turn counters and the rule deciding whether a
 *    turn end is clean evidence.
 *
 * Durable settlement is authoritative: done remains successful after a
 * recovered retry; transient errors are kept in the event transcript.
 */
import { buildRuntimeErrorDiagnostic } from "./diagnostics.ts";
import type { AgentRuntimeOutcome, ParsedEvent, TerminalFailureKind } from "./types.ts";
import type { RuntimeErrorClass } from "./diagnostics.ts";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _KeepAgentRuntimeOutcome = AgentRuntimeOutcome;

export interface TerminalRuntimeFailureEvidence {
  failureKind: TerminalFailureKind;
  /** 16 hex, from the scrubbed runtime text. */
  fingerprint: string;
  errorClass: RuntimeErrorClass;
  errorReason: string | null;
  errorAction: string | null;
  detail: string | null;
}

/** Fingerprint and class of a raw runtime text (same rules as the daemon). */
export function terminalFailureFromRawText(
  failureKind: TerminalFailureKind,
  rawText: string,
): TerminalRuntimeFailureEvidence {
  const diagnostic = buildRuntimeErrorDiagnostic(rawText);
  return {
    failureKind,
    fingerprint: diagnostic.fingerprint,
    errorClass: diagnostic.errorClass,
    errorReason: diagnostic.errorReason ?? null,
    errorAction: diagnostic.errorAction ?? null,
    detail: diagnostic.excerpt.slice(0, 512),
  };
}

/**
 * Per-turn facts for E2. Recoverable attempt errors remain useful telemetry;
 * the durable submission's final settlement decides success or failure.
 */
export interface TurnOutcomeCounters {
  textEvents: number;
  toolCalls: number;
  runtimeErrors: number;
}

export function createTurnOutcomeCounters(): TurnOutcomeCounters {
  return { textEvents: 0, toolCalls: 0, runtimeErrors: 0 };
}

export function noteTurnOutcomeEvent(counters: TurnOutcomeCounters, event: ParsedEvent): void {
  switch (event.kind) {
    case "text":
      counters.textEvents++;
      break;
    case "tool_call":
      counters.toolCalls++;
      break;
    case "error":
      counters.runtimeErrors++;
      break;
  }
}

/**
 * A done submission is successful even after retryable attempt errors.
 * Call only after the authoritative durable settlement is `done`.
 */
export function turnCompletedOutcome(
  counters: TurnOutcomeCounters,
  _stickyTerminalFailure = false,
): Extract<AgentRuntimeOutcome, { kind: "turn_completed" }> {
  return {
    kind: "turn_completed",
    textEvents: counters.textEvents,
    toolCalls: counters.toolCalls,
    ...(counters.runtimeErrors > 0 ? { recoveredErrors: counters.runtimeErrors } : {}),
  };
}

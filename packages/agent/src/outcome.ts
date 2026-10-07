/**
 * Port of reference/raft-daemon/src/runtimeOutcome.ts — the E1/E2 evidence
 * construction for the `agent:runtime:outcome` frame:
 *  - E1 `terminal_failure`: which terminal path ended the run, plus a
 *    fingerprint of the (scrubbed) runtime text;
 *  - E2 `turn_completed`: per-turn counters and the rule deciding whether a
 *    turn end is clean evidence.
 *
 * Semantics unchanged; the types are this port's local ones.
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
 * Per-turn facts for E2. Reset only at run end: an error anywhere since the
 * previous run end disqualifies the run. Mirrors the daemon's rule — it can
 * delay evidence, never produce a false one.
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
 * Conditions: no sticky terminal failure, zero runtime errors in the run, and
 * model output. Returns the E2 outcome or null.
 */
export function turnCompletedOutcome(
  counters: TurnOutcomeCounters,
  stickyTerminalFailure: boolean,
): Extract<AgentRuntimeOutcome, { kind: "turn_completed" }> | null {
  if (stickyTerminalFailure || counters.runtimeErrors > 0) return null;
  if (counters.textEvents + counters.toolCalls === 0) return null;
  return {
    kind: "turn_completed",
    textEvents: counters.textEvents,
    toolCalls: counters.toolCalls,
  };
}

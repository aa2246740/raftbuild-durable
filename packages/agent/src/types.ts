/**
 * Shared types. Anything stored inside a durable document is strict JSON:
 * object literals only, `null` instead of `undefined` — pi-durable's
 * JsonObject constraint. Wire/projected types (ParsedEvent, IncomingMessage,
 * AgentConfigInput) are transient and may use optionals.
 */

// ---------- wire events (transcript JSONL + onEvent, not a doc) ----------

/** The daemon's normalized event vocabulary (drivers/types.ts subset). */
export type ParsedEvent =
  | { kind: "session_init"; sessionId: string; model?: string; provider?: string }
  | { kind: "thinking"; text: string; signature?: string }
  | { kind: "text"; text: string }
  | { kind: "tool_call"; name: string; toolCallId?: string; input?: unknown }
  | { kind: "tool_output"; name?: string; toolCallId?: string; isError?: boolean; text?: string }
  | { kind: "compaction_started"; reason?: string; willRetry?: boolean }
  | { kind: "compaction_finished"; reason?: string; aborted?: boolean }
  | { kind: "run_start"; inputs?: string[] }
  | { kind: "run_end"; inputs?: string[] }
  | { kind: "turn_end" }
  | { kind: "error"; message: string; errorType?: string; retryable?: boolean; nativeReasonPresent?: boolean }
  | {
      kind: "submission_settled";
      submissionId: string;
      status: "done" | "unanswered";
      reason?: string;
    }
  | {
      kind: "telemetry";
      name: string;
      source: string;
      usageKind: string;
      sessionId?: string;
      attrs: Record<string, number>;
    };

// ---------- inbound message formatting ----------

/** A context message inside thread-join context (no nesting). */
export type ContextMessage = {
  message_id: string;
  timestamp: string;
  sender_name: string;
  sender_type: "user" | "agent" | "system" | string;
  sender_description?: string;
  target: string;
  content: string;
  seq?: number;
};

/** The daemon's message-envelope fields (verbatim names from raft-daemon). */
export type IncomingMessage = {
  message_id: string;
  timestamp: string;
  sender_name: string;
  sender_type: "user" | "agent" | "system" | string;
  sender_description?: string;
  target: string;
  content: string;
  seq?: number;
  /** Explicit send_message reply destination, distinct from this recipient. */
  reply_to?: string;
  chain_id?: string;
  hop?: number;
  thread_join_context?: {
    parent_target: string;
    thread_target: string;
    suggested_read_history_target: string;
    parent_message: ContextMessage;
    recent_messages: ContextMessage[];
    history_truncated?: boolean;
  };
};

// ---------- outbox frames (stored inside the outbox doc → strict JSON) ----------

export type AgentRuntimeOutcome =
  | { kind: "turn_completed"; textEvents: number; toolCalls: number; recoveredErrors?: number }
  | {
      kind: "terminal_failure";
      failureKind: TerminalFailureKind;
      fingerprint: string;
      errorClass: string;
      errorReason: string | null;
      errorAction: string | null;
      detail: string | null;
    };

export type TerminalFailureKind =
  | "sticky_runtime_error"
  | "compaction_failed"
  | "compaction_input_too_large"
  | "compaction_recovery_exhausted"
  | "submission_unanswered"
  | "outcome_unreliable";

export type OutboxFrame =
  | {
      type: "agent:start:outcome";
      agentId: string;
      name: string;
      model: { provider: string; modelId: string };
      workspacePath: string;
      at: string;
    }
  | {
      type: "agent:runtime:outcome";
      agentId: string;
      submissionId: string;
      outcome: AgentRuntimeOutcome;
    }
  | {
      type: "agent:outcome_unreliable";
      agentId: string;
      reason: string;
      detail: string | null;
      since: string;
    }
  | {
      /** Inter-agent / agent→operator message produced by the send_message tool. */
      type: "agent:message";
      agentId: string;
      /** Tool call id — doubles as the dedupe key for the route. */
      msgId: string;
      /** Target agent name/agentId, or "main" (the human operator). */
      to: string;
      content: string;
      at: string;
      /** Durable conversation chain; legacy queued frames may omit it. */
      chainId?: string;
      hop?: number;
    };

// ---------- agent registry (session doc "raft.agents") ----------

export type AgentModelRef = { provider: string; modelId: string };

export type AgentConfigInput = {
  name: string;
  /** Omitted → daemon defaultModel (createAgent throws if neither exists). */
  model?: AgentModelRef;
  instructions?: string;
  workspace?: string;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  initialMemoryMd?: string;
};

export type AgentLifecycleKind =
  | "queued"
  | "starting"
  | "running"
  | "idle"
  | "cooldown"
  | "stopped"
  | "terminal";

export type AgentRecord = {
  agentId: string;
  name: string;
  model: AgentModelRef;
  instructions: string | null;
  workspacePath: string;
  conversationId: string;
  /** Only directories created and still owned by this agent may be removed. */
  workspaceOwnership?: { token: string; device: string; inode: string };
  thinkingLevel: string | null;
  createdAt: string;
  updatedAt: string;
  override: "stopped" | null;
  terminalFailure: {
    failureKind: string;
    fingerprint: string;
    detail: string;
    at: string;
  } | null;
  lastOutcome: {
    kind: string;
    status: string;
    submissionId: string;
    reason: string | null;
    errorClass: string | null;
    at: string;
  } | null;
  runs: number;
  failures: number;
  /** Legacy bounded projection ledger, emptied after receipt migration.
   * Permanent per-outcome documents now provide projection idempotency. */
  projectedSubmissions: string[];
  /** Versioned migration marker; authoritative dedupe lives in per-outcome docs. */
  outcomeReceiptsVersion?: number;
  /** Last outcome explicitly cleared by start/resolve; retained for audit. */
  resolvedSubmissionId?: string;
};

export type AgentsDocState = {
  records: Record<string, AgentRecord>;
};

// ---------- outbox doc (session family "raft.outbox" keyed by agentId) ----------

export type OutboxDocEntry = {
  clientSeq: number;
  frame: OutboxFrame;
  enqueuedAt: string;
  inFlight: boolean;
  attempts: number;
  lastAttemptAt: string | null;
};

export type OutboxDocState = {
  agentId: string;
  nextClientSeq: number;
  entries: OutboxDocEntry[];
  /** Fail-closed marker: a commit failure marks the agent unreliable. */
  unreliable: { reason: string; since: string } | null;
  /** Human resolution — the only way a marked agent delivers again. */
  resolution: { kind: string; note: string; at: string } | null;
  /** Legacy outcome/tool-call ring; new outcome receipts live in their own docs. */
  producedSubmissionIds: string[];
};

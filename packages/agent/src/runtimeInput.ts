/**
 * Port of reference/raft-daemon/src/agentRuntimeInput.ts — the message→input
 * formatting surfaces, trimmed to what this port's IncomingMessage carries:
 * the `[target=.. msg=.. time=.. type=..] @sender: body` envelope, thread-join
 * context, inbox notice, and the standing reply hint.
 *
 * Dropped server-only suffixes (attachments, task projection, third-party
 * payload, follow-reactivation) have no carrier in IncomingMessage; add them
 * back when a transport supplies them.
 */
import type { IncomingMessage } from "./types.ts";

export const RESPONSE_TARGET_HINT =
  "Normal answer text stays in this agent's conversation. To reply to another agent, explicitly call send_message with the envelope's reply_to target; use target \"main\" to notify the human operator. Do not send acknowledgements that only invite another acknowledgement.";

export function formatUtcTimestamp(value: string | number | Date | undefined): string {
  if (value === undefined) return "-";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "-" : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Continuation lines of a free-text field are indented so a newline in
 * sender_name/sender_description/content cannot start a forged header line.
 */
export function indentAgentBodyContinuationLines(text: string): string {
  return text.replace(/\n/g, "\n  ");
}

export function getMessageShortId(messageId: string): string {
  const id = messageId.startsWith("thread-") ? messageId.slice(7) : messageId;
  return id.slice(0, 8);
}

function formatSenderHandle(message: Pick<IncomingMessage, "sender_name" | "sender_description">): string {
  const name = indentAgentBodyContinuationLines(message.sender_name);
  return message.sender_description
    ? `@${name} — ${indentAgentBodyContinuationLines(message.sender_description)}`
    : `@${name}`;
}

function formatVisibleActorType(type: IncomingMessage["sender_type"]): string {
  return ` type=${type}`;
}

type ContextMessage = Omit<IncomingMessage, "thread_join_context">;

function formatThreadContextMessage(message: ContextMessage): string {
  const msgId = message.message_id ? getMessageShortId(message.message_id) : "-";
  const time = message.timestamp ? formatUtcTimestamp(message.timestamp) : "-";
  const senderType = formatVisibleActorType(message.sender_type);
  const seq = typeof message.seq === "number" ? ` seq=${message.seq}` : "";
  return `- [msg=${msgId}${seq} time=${time}${senderType}] ${formatSenderHandle(message)}: ${indentAgentBodyContinuationLines(message.content)}`;
}

/** `[target=.. msg=.. time=.. type=..] @sender — desc: body` (+ thread-join prefix). */
export function formatIncomingMessage(message: IncomingMessage): string {
  const threadJoinPrefix = message.thread_join_context
    ? [
        "[Raft thread context: you were mentioned in a thread without model-visible context.]",
        `parent: ${message.thread_join_context.parent_target}`,
        `thread: ${message.thread_join_context.thread_target}`,
        `suggested next step: raft message read --target "${message.thread_join_context.suggested_read_history_target}"`,
        "",
        "Parent message:",
        formatThreadContextMessage(message.thread_join_context.parent_message),
        "",
        `Recent thread context${message.thread_join_context.history_truncated ? " (truncated)" : ""}:`,
        message.thread_join_context.recent_messages.length > 0
          ? message.thread_join_context.recent_messages.map(formatThreadContextMessage).join("\n")
          : "- (no earlier thread replies)",
        "",
      ].join("\n")
    : "";

  const target = encodeURIComponent(message.target ?? "-");
  const msgId = message.message_id ? getMessageShortId(message.message_id) : "-";
  const time = message.timestamp ? formatUtcTimestamp(message.timestamp) : "-";
  const senderType = formatVisibleActorType(message.sender_type);
  const reply = message.reply_to ? ` reply_to=${encodeURIComponent(message.reply_to)}` : "";
  const chain = message.chain_id ? ` chain=${encodeURIComponent(message.chain_id)} hop=${message.hop ?? 0}` : "";
  const description = message.sender_description ? ` description=${encodeURIComponent(message.sender_description)}` : "";
  const body = `[target=${target} msg=${msgId} time=${time}${senderType}${reply}${chain} sender=${encodeURIComponent(message.sender_name)}${description}] ${formatSenderHandle(message)}: ${indentAgentBodyContinuationLines(message.content)}`;
  return threadJoinPrefix ? `${threadJoinPrefix}\n${body}` : body;
}

/** Envelope around one or more concrete delivered messages (formatConcreteMessagesRuntimeInput). */
export function formatConcreteMessagesRuntimeInput(messages: readonly IncomingMessage[]): string {
  const header = messages.length === 1 ? "New message received:" : "New messages received:";
  const concreteMessages = messages.map(formatIncomingMessage).join("\n");
  return `${header}\n\n${concreteMessages}\n\nRespond as appropriate. Complete all your work before stopping.\n${RESPONSE_TARGET_HINT}`;
}

/** Envelope around a system notice (formatSystemNoticeRuntimeInput). */
export function formatSystemNoticeRuntimeInput(message: IncomingMessage): string {
  return `System notice received:\n\n${formatIncomingMessage(message)}\n\nRespond as appropriate. Complete all your work before stopping.\n${RESPONSE_TARGET_HINT}`;
}

/** Content-free inbox notice batched into a busy turn (formatInboxUpdateRuntimeInput). */
export function formatInboxUpdateRuntimeInput(
  pendingByTarget: Readonly<Record<string, number>>,
  totalPendingMessages?: number,
): string {
  const rows = Object.entries(pendingByTarget)
    .map(([target, count]) => `- ${target}: ${count} pending`)
    .join("\n");
  const total = totalPendingMessages ?? Object.values(pendingByTarget).reduce((a, b) => a + b, 0);
  return [
    "[Raft inbox notice:",
    `pending messages: ${total}`,
    rows,
    "]",
    "These messages have not been read. Choose when to read them: `raft message read --target <target> --unread` reads one conversation's unread messages; `raft message check` reads all of them. Deferring them does not establish that there is no work.",
  ].join("\n");
}

/** A plain text input from the local operator, no envelope. */
export function formatOperatorInput(text: string): string {
  return text;
}

/** Parse our visible envelope without restricting sender names to ASCII.
 * New envelopes carry an encoded sender field, so colons/spaces/descriptions
 * are unambiguous. Old envelopes are accepted for persisted history. */
export function parseIncomingEnvelope(raw: string): { from: string; text: string } | undefined {
  const match = raw.match(/(?:^|\n)\[target=([^\]\n]*)\] (@[^\n]*)(?:\n((?: {2}[^\n]*(?:\n|$))*))?/);
  if (!match) return undefined;
  const sender = match[1].match(/(?:^| )sender=([^ ]+)/)?.[1];
  let from: string;
  let firstLine: string;
  if (sender) {
    try {
      from = decodeURIComponent(sender);
      const description = match[1].match(/(?:^| )description=([^ ]+)/)?.[1];
      const prefix = formatSenderHandle({ sender_name: from, ...(description ? { sender_description: decodeURIComponent(description) } : {}) }) + ": ";
      if (!match[2].startsWith(prefix)) return undefined;
      firstLine = match[2].slice(prefix.length);
    } catch { return undefined; }
  } else {
    const legacy = match[2].match(/^@(.+?): (.*)$/);
    if (!legacy) return undefined;
    from = legacy[1].split(" — ")[0];
    firstLine = legacy[2];
  }
  const continuation = match[3]?.replace(/\n$/, "").split("\n").map((line) => line.replace(/^ {2}/, "")).join("\n");
  return { from, text: firstLine + (continuation ? `\n${continuation}` : "") };
}

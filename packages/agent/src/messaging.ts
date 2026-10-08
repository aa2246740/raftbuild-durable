/** Durable, explicitly addressed messages with persisted chain and send budgets. */
import { defineDocFamily, defineExtension, defineTool, LiveDoc, section } from "@earendil-works/pi-durable";
import type { ConversationId, Storage } from "@earendil-works/pi-durable";
import { Type } from "typebox";

import { AgentBindingDoc } from "./agents.ts";
import { appendToOutboxDoc, OutboxDoc } from "./outbox.ts";

export const SEND_MESSAGE_TOOL = "send_message";
export type MessageChain = { chainId: string; hop: number };
export type MessagingLimits = { maxHops?: number; maxMessagesPerMinute?: number };

/** Written before admission, keyed by the same idempotency key as the input. */
export const MessageContextDoc = defineDocFamily<{ value: MessageChain | null }, string>({
  kind: "raft.messageContext", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true,
  initial: () => ({ value: null }),
});
export const MessageChainDoc = defineDocFamily<{ blocked: string | null; notified: boolean }, string>({
  kind: "raft.messageChain", version: 1, scope: "session", family: true,
  initial: () => ({ blocked: null, notified: false }),
});
export const MessageRateDoc = defineDocFamily<{ sentAt: number[] }, string>({
  kind: "raft.messageRate", version: 1, scope: "session", family: true,
  initial: () => ({ sentAt: [] }),
});
export const MessageSendReceiptDoc = defineDocFamily<{
  result: { clientSeq: number | null; blocked: string | null } | null;
}, string>({
  kind: "raft.messageSendReceipt", version: 1, scope: "session", family: true,
  initial: () => ({ result: null }),
});

function limit(value: number | string | undefined, fallback: number, name: string): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}
export function messagingLimits(options: MessagingLimits = {}): Required<MessagingLimits> {
  return {
    maxHops: limit(options.maxHops ?? process.env.RAFTD_MESSAGE_MAX_HOPS, 8, "RAFTD_MESSAGE_MAX_HOPS"),
    maxMessagesPerMinute: limit(options.maxMessagesPerMinute ?? process.env.RAFTD_MESSAGE_RATE_PER_MINUTE, 30, "RAFTD_MESSAGE_RATE_PER_MINUTE"),
  };
}

const SendMessageParams = Type.Object({
  target: Type.String({ minLength: 1, description: 'Agent name/id, or "main" for the operator inbox. For a reply, use the incoming envelope\'s reply_to.' }),
  text: Type.String({ minLength: 1, description: "Message body to deliver." }),
});

export function createSendMessageTool(readSubmission?: Storage["submission"], configured: MessagingLimits = {}) {
  const limits = messagingLimits(configured);
  return defineTool({
    name: SEND_MESSAGE_TOOL,
    description: "Explicitly deliver a message to an agent or the operator inbox (target main). Normal answer text is not forwarded. Delivery is durable; forwarding chains and per-agent sends are bounded.",
    parameters: SendMessageParams,
    replay: "safe",
    async execute(args, api, context) {
      const result = await api.commit(async (tx) => {
        const conversationId = api.conversationId as ConversationId;
        const binding = await tx.doc(AgentBindingDoc, conversationId);
        const agentId = binding.agentId || `conv-${String(conversationId)}`;
        const callIdentity = `${api.taskId}:${api.callId}`;
        const receiptKey = JSON.stringify([agentId, String(api.taskId), api.callId]);
        const receipt = await tx.doc(MessageSendReceiptDoc, receiptKey, receiptKey);
        // Provider call IDs can repeat in different model responses. The durable
        // tool task disambiguates them while remaining stable on replay.
        // A replay neither spends the budget again nor produces another notice.
        if (receipt.result) return { ...receipt.result };
        const live = await tx.doc(LiveDoc, conversationId);
        const inputs = live.run?.inputs ?? [];
        let parent: MessageChain = { chainId: `input:${conversationId}:${inputs[0] ?? api.taskId}`, hop: 0 };
        let inheritedBlock: string | null = null;
        // Read the inputs of THIS running turn, not the newest queued input.
        // Follow-ups cannot accidentally reset a chain and these references
        // survive restart. A merged/steered run inherits its strictest input.
        for (const id of inputs) {
          const submission = await readSubmission?.(id, context);
          if (!submission?.requestId) continue;
          const doc = await tx.doc(MessageContextDoc, conversationId, submission.requestId, submission.requestId);
          if (!doc.value) continue;
          const chain = await tx.doc(MessageChainDoc, doc.value.chainId, doc.value.chainId);
          inheritedBlock ??= chain.blocked;
          if (doc.value.hop >= parent.hop) parent = doc.value;
        }
        const hop = parent.hop + 1;
        const chain = await tx.doc(MessageChainDoc, parent.chainId, parent.chainId);
        const rate = await tx.doc(MessageRateDoc, agentId, agentId);
        const now = Date.now();
        rate.sentAt = rate.sentAt.filter((at) => at > now - 60_000);
        const blocked = inheritedBlock ?? chain.blocked
          ?? (hop > limits.maxHops ? `hop limit ${limits.maxHops} reached` : null)
          ?? (rate.sentAt.length >= limits.maxMessagesPerMinute ? `send rate limit ${limits.maxMessagesPerMinute}/minute reached` : null);
        const doc = await tx.doc(OutboxDoc, agentId, agentId);
        if (doc.unreliable) throw new Error(`outbox unreliable since ${doc.unreliable.since}: ${doc.unreliable.reason}`);
        if (blocked) {
          chain.blocked = blocked;
          if (!chain.notified) {
            appendToOutboxDoc(doc, {
              type: "agent:message", agentId, msgId: `limit:${callIdentity}`, to: "main",
              content: `Messaging stopped for chain ${parent.chainId}: ${blocked} (sender ${agentId}, target ${args.target}).`,
              at: new Date(now).toISOString(), chainId: parent.chainId, hop,
            }, `limit:${parent.chainId}`);
            chain.notified = true;
          }
          receipt.result = { clientSeq: null, blocked };
          return { ...receipt.result };
        }
        const queued = appendToOutboxDoc(doc, {
          type: "agent:message", agentId, msgId: callIdentity, to: args.target,
          content: args.text, at: new Date(now).toISOString(), chainId: parent.chainId, hop,
        }, `send:${callIdentity}`);
        rate.sentAt.push(now);
        receipt.result = { clientSeq: "clientSeq" in queued ? queued.clientSeq : null, blocked: null };
        return { ...receipt.result };
      }, context);
      if (result.blocked) return { isError: true, control: { terminate: true }, content: [{ type: "text", text: `Message not sent: ${result.blocked}. This chain is stopped; do not retry. The operator inbox was notified.` }] };
      return { content: [{ type: "text", text: `Queued for delivery to ${args.target}${result.clientSeq === null ? "" : ` (clientSeq ${result.clientSeq})`}.` }] };
    },
  });
}

export function createMessagingExtension(readSubmission?: Storage["submission"], configured?: MessagingLimits) {
  return defineExtension({
    name: "raft-messaging",
    tools: [createSendMessageTool(readSubmission, configured)],
    sections: [section("messaging", () => [
      "Use send_message to deliver a reply to another agent: target the envelope's reply_to.",
      'Use target "main" to deliver a report to the human operator inbox.',
      "Normal answer text stays in your conversation; it is not forwarded to the sender.",
      "Send useful deliverables, not reciprocal acknowledgements. Forwarding chains and send rate are bounded.",
      "If delivery is blocked, stop sending on that chain and let the operator decide how to continue.",
    ].join("\n"), { tag: false })],
  });
}
// Standalone exports retain the public library surface. The daemon supplies a
// storage reader so a tool can inherit the exact durable input's chain.
export const SendMessageTool = createSendMessageTool();
export const MessagingExtension = createMessagingExtension();

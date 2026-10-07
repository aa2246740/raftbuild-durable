/**
 * Agent→world messaging — the send_message tool every agent gets.
 *
 * A call commits an `agent:message` frame into the caller's own outbox doc
 * (inside the tool's own commit — write-ahead, dedupe key = call id), and the
 * normal outbox pump delivers it to the `RoutingTransport`, which routes it
 * to the target agent's conversation or to `main` (the operator inbox).
 *
 * Crash semantics for free: queued-but-undelivered messages survive kill -9
 * and route on resume; a retried tool call rewrites the same dedupe key.
 */
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Type } from "typebox";

import { AgentBindingDoc } from "./agents.ts";
import { appendToOutboxDoc, OutboxDoc } from "./outbox.ts";

export const SEND_MESSAGE_TOOL = "send_message";

const SendMessageParams = Type.Object({
  target: Type.String({
    description:
      'Where to deliver: another agent\'s name or id, or "main" for the human operator\'s console inbox.',
  }),
  text: Type.String({ description: "The message body to deliver." }),
});

export const SendMessageTool = defineTool({
  name: SEND_MESSAGE_TOOL,
  description:
    "Deliver a message to another agent or to the operator console (target \"main\"). " +
    "Delivery is durable and exactly-once; the message arrives as an envelope " +
    "addressed from you.",
  parameters: SendMessageParams,
  async execute(args, api, context) {
    const result = await api.commit(async (tx) => {
      const binding = await tx.doc(AgentBindingDoc, api.conversationId as ConversationId);
      const agentId = binding.agentId || `conv-${String(api.conversationId)}`;
      const doc = await tx.doc(OutboxDoc, agentId, agentId);
      if (doc.unreliable) {
        throw new Error(`outbox unreliable since ${doc.unreliable.since}: ${doc.unreliable.reason}`);
      }
      return appendToOutboxDoc(
        doc,
        {
          type: "agent:message",
          agentId,
          msgId: api.callId,
          to: args.target,
          content: args.text,
          at: new Date().toISOString(),
        },
        `send:${api.callId}`,
      );
    }, context);
    if ("duplicate" in result) {
      return { content: [{ type: "text", text: "Message already queued (duplicate call)." }] };
    }
    return { content: [{ type: "text", text: `Queued for delivery to ${args.target} (clientSeq ${result.clientSeq}).` }] };
  },
});

/** Extension bundling the tool plus the prompt section that explains it. */
export const MessagingExtension = defineExtension({
  name: "raft-messaging",
  tools: [SendMessageTool],
  sections: [
    section(
      "messaging",
      () =>
        [
          "You have a `send_message` tool. Use it to talk to other agents by name,",
          'or to report to the human operator with target "main".',
          "Messages arrive at the other side as envelopes addressed from you.",
          "Only call it when the message is a real deliverable — it commits to storage.",
        ].join("\n"),
      { tag: false },
    ),
  ],
});

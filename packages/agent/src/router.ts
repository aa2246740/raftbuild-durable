/**
 * Routing — the daemon's server-side message fabric, expressed as an
 * OutboxTransport: `agent:message` frames are routed inside the host
 * (agent→agent via postMessage, agent→"main" into the durable operator
 * inbox); every other frame falls through to the inner transport.
 *
 * Delivery is at-least-once at the pump and exactly-once at the edge:
 * the router stamps `requestId = route:<agentId>:<clientSeq>` on each
 * delivery, so a retransmitted frame can never submit twice.
 */
import { defineDoc } from "@earendil-works/pi-durable";

import type { OutboxEnvelope, OutboxTransport } from "./transport.ts";
import type { OutboxFrame } from "./types.ts";

export type AgentMessageFrame = Extract<OutboxFrame, { type: "agent:message" }>;

// ---------- operator inbox (session doc "raft.mainInbox") ----------

export type MainInboxEntry = {
  id: string;
  fromAgentId: string;
  fromName: string;
  text: string;
  at: string;
};

export type MainInboxState = { entries: MainInboxEntry[] };

const MAIN_INBOX_CAP = 1000;

export const MainInboxDoc = defineDoc<MainInboxState>({
  kind: "raft.mainInbox",
  version: 1,
  scope: "session",
  initial: () => ({ entries: [] }),
});

// ---------- routing transport ----------

/**
 * The route callback is attached after construction (the daemon wires it to
 * its own routeMessage once it exists); frames arriving before attachment
 * throw so the pump retransmits rather than dropping.
 */
export class RoutingTransport implements OutboxTransport {
  private readonly inner: OutboxTransport;
  private router: ((envelope: OutboxEnvelope & { frame: AgentMessageFrame }) => Promise<void>) | null = null;

  constructor(inner: OutboxTransport) {
    this.inner = inner;
  }

  /** Bind the router (called once by DurableDaemon.open). */
  attach(router: (envelope: OutboxEnvelope & { frame: AgentMessageFrame }) => Promise<void>): void {
    this.router = router;
  }

  async send(envelope: OutboxEnvelope): Promise<void> {
    if (envelope.frame.type === "agent:message") {
      if (!this.router) throw new Error("router not attached");
      await this.router(envelope as OutboxEnvelope & { frame: AgentMessageFrame });
      return;
    }
    await this.inner.send(envelope);
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }
}

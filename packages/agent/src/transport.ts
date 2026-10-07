/**
 * Outbox delivery transports — the "server" the daemon's websocket was.
 *
 * A transport receives one in-flight frame and either commits it upstream
 * (resolves → the outbox deletes the entry) or fails (rejects → retransmission
 * with backoff, same identity). Consumers must dedupe by (agentId, clientSeq):
 * a frame may be sent more than once across retries/restarts.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { OutboxFrame } from "./types.ts";

export interface OutboxEnvelope {
  agentId: string;
  clientSeq: number;
  frame: OutboxFrame;
  attempt: number;
}

export interface OutboxTransport {
  send(envelope: OutboxEnvelope): Promise<void>;
  /** Optional cleanup on daemon close. */
  close?(): Promise<void>;
}

/**
 * Default transport: appends every delivered frame to
 * `<dir>/<agentId>.jsonl` — a durable local delivery ledger. JSONL survives
 * crashes; reading it back shows exactly what the "server" committed, which is
 * what makes the e2e honest.
 */
export class JsonlDeliveryTransport implements OutboxTransport {
  constructor(private readonly dir: string) {}

  async send(envelope: OutboxEnvelope): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const line = JSON.stringify({
      agentId: envelope.agentId,
      clientSeq: envelope.clientSeq,
      attempt: envelope.attempt,
      deliveredAt: new Date().toISOString(),
      frame: envelope.frame,
    });
    await appendFile(path.join(this.dir, `${envelope.agentId}.jsonl`), line + "\n", "utf8");
  }
}

/** Test/verification transport: delivery per scripted plan, inspection via `sent`. */
export class ScriptedTransport implements OutboxTransport {
  readonly sent: OutboxEnvelope[] = [];
  /** Outcomes consumed in order; default success when exhausted. */
  plan: Array<"ok" | "fail" | "hang"> = [];
  failMessage = "scripted delivery failure";

  async send(envelope: OutboxEnvelope): Promise<void> {
    const step = this.plan.length > 0 ? this.plan.shift()! : "ok";
    if (step === "hang") {
      return new Promise(() => {});
    }
    if (step === "fail") {
      throw new Error(this.failMessage);
    }
    this.sent.push(envelope);
  }
}

/** Wrap another transport with failure for the first `failures` sends. */
export class FlakyTransport implements OutboxTransport {
  constructor(
    private readonly inner: OutboxTransport,
    private failures: number,
  ) {}

  async send(envelope: OutboxEnvelope): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error(`flaky transport (${this.failures} failures left)`);
    }
    return this.inner.send(envelope);
  }
}

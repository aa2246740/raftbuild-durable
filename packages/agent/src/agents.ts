/**
 * Agent registry — the daemon's agent table as one session-scoped doc.
 *
 * The daemon kept records in its own database next to the runtimes it spawned;
 * here the registry itself is durable state (`raft.agents`) committed through
 * the same Session line as everything else, so the registry can never disagree
 * with the storage it points into.
 */
import { defineDoc } from "@earendil-works/pi-durable";
import type { AgentsDocState, AgentRecord } from "./types.ts";

export const AgentsDoc = defineDoc<AgentsDocState>({
  kind: "raft.agents",
  version: 1,
  scope: "session",
  initial: () => ({ records: {} }),
});

/** Reverse binding written into each conversation at creation (`init`). */
export const AgentBindingDocKind = "raft.agentBinding";

export const AgentBindingDoc = defineDoc<{ agentId: string }>({
  kind: AgentBindingDocKind,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ agentId: "" }),
});

export class AgentRegistryError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "name_taken" | "invalid",
  ) {
    super(message);
    this.name = "AgentRegistryError";
  }
}

export function sortRecords(records: Record<string, AgentRecord>): AgentRecord[] {
  return Object.values(records).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * DurableDaemon — the durable re-implementation of Raft's daemon core
 * (reference/raft-daemon): an agent registry, per-agent durable conversations,
 * a normalized event stream, an outcome outbox, and per-agent workspaces, all
 * on one pi-durable Harness over one SQLite storage.
 *
 * "Daemon" here is a lifetime, not a process: `open()` on an existing state
 * dir IS the restart — unfinished work resumes via `harness.resume()`.
 */
import { mkdir, appendFile, rm, readdir, readFile, stat } from "node:fs/promises";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { AssistantMessage, Provider } from "@earendil-works/pi-ai";
import {
  createRegistry,
  configure,
  Harness,
  UsageDoc,
  watchEvents,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type HarnessSettings,
  type Registry,
  type Storage,
  type SubmissionId,
  type SubmissionRecord,
  type Tx,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { AgentBindingDoc, AgentsDoc, AgentRegistryError, sortRecords } from "./agents.ts";
import { RaftAgentExtension } from "./extension.ts";
import { createMessagingExtension, MessageContextDoc, MessageChainDoc, messagingLimits, type MessageChain, type MessagingLimits } from "./messaging.ts";
import { parseWhen, RemindersDoc, type Reminder } from "./reminders.ts";
import { MainInboxDoc, RoutingTransport, type AgentMessageFrame } from "./router.ts";
import type { OutboxEnvelope } from "./transport.ts";
import { projectLifecycle, unresolvedFailure, type AgentLifecycleRecord } from "./lifecycle.ts";
import { formatConcreteMessagesRuntimeInput, formatOperatorInput, formatSystemNoticeRuntimeInput } from "./runtimeInput.ts";
import {
  deleteWorkspaceDirectory,
  ensureWorkspaceRoot,
  initializeAgentWorkspace,
  resolveWorkspaceDirectoryPath,
  scanWorkspaceDirectories,
  DELIVERIES_DIR_NAME,
  type AgentWorkspaceSeedFile,
  type WorkspaceDirectoryInfo,
  type WorkspaceOwnership,
} from "./workspaces.ts";
import { ToolExecutionEnv } from "./toolEnv.ts";
import { pickDefaultModel, validateAgentName, validateAgentSettings, validateModel } from "./modelPolicy.ts";
import { DurableEventNormalizer } from "./events.ts";
import { DEAD_STATES, procInfo, processStartTime } from "./machineLock.ts";
import { AgentOutbox, OutboxDoc, OutboxError, OutcomeReceiptDoc, outcomeReceiptKey } from "./outbox.ts";
import { JsonlDeliveryTransport, type OutboxTransport } from "./transport.ts";
import { terminalFailureFromRawText, turnCompletedOutcome } from "./outcome.ts";
import { enqueueInput } from "./admission.ts";
import { RecoveryEpochDoc } from "./recovery.ts";
import { scrubRuntimeErrorDiagnosticText } from "./diagnostics.ts";
import { parseIncomingEnvelope } from "./runtimeInput.ts";
import type {
  AgentConfigInput,
  AgentModelRef,
  AgentRecord,
  IncomingMessage,
  OutboxDocState,
  ParsedEvent,
  TerminalFailureKind,
} from "./types.ts";

export interface DurableDaemonOptions {
  /** Daemon state dir: <dir>/session.sqlite, workspaces/, .deliveries/, transcripts/. */
  stateDir: string;
  /**
   * Provider instances to install (pi-ai `Provider`s), or "env" to auto-detect
   * from the environment: ZAI_CODING_CN_API_KEY, ZAI_API_KEY, MINIMAX_CN_API_KEY,
   * MINIMAX_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY.
   */
  providers?: readonly Provider[] | "env";
  /** Default model for agents created without an explicit one. */
  defaultModel?: AgentModelRef;
  /** Where outbox frames are delivered; default JSONL ledger at <stateDir>/.deliveries. */
  transport?: OutboxTransport;
  /** Harness run policy; see pi-durable HarnessSettings. */
  settings?: HarnessSettings;
  /** Test hook: retransmission delay schedule (default 5s→5min ±20%). */
  retryDelayMs?: (attempt: number) => number;
  /** Extra prompt preamble per agent (kept static — prompt-cache friendly). */
  agentPreamble?: string;
  /** Called for every normalized event of every agent. */
  onEvent?: (agentId: string, event: ParsedEvent) => void;
  /** Called when an outbox frame is produced, before delivery. */
  onFrame?: (agentId: string, clientSeq: number) => void;
  /**
   * Cold-wake recycle (raft RFC 070): when an agent the daemon has seen
   * active goes quiet for longer than this, its next message is persisted
   * before a background compaction pass is queued at an idle boundary. A daemon
   * restart does NOT count as idle — cold start never burns a model call.
   * Default off; `raftd serve` enables it (RAFTD_COMPACT_IDLE_MS, 30m).
   */
  compactOnWakeMs?: number;
  /** Durable message-chain and per-agent send limits. */
  messaging?: MessagingLimits;
  /** Called for non-fatal internal warnings (compaction, routing bounces). */
  onWarn?: (message: string) => void;
}

export interface CreateAgentResult {
  record: AgentRecord;
  conversationId: string;
}

export interface PostMessageOptions {
  /** Admit durably without starting the session-wide scheduler (offline CLI). */
  execute?: boolean;
  whenBusy?: "steer" | "followUp" | "reject";
  /** Idempotent submit key; same requestId never submits twice. */
  requestId?: string;
  /** Raw text bypasses the message envelope formatting. */
  raw?: boolean;
  /** Treat the message as a system notice envelope. */
  systemNotice?: boolean;
  /** Internal routing context; never derived from model-authored tool arguments. */
  messageChain?: MessageChain;
}

export interface Answer {
  submissionId: string;
  status: "done" | "unanswered";
  /** Final assistant text when done. */
  text?: string;
  reason?: string;
  /** Scrubbed provider diagnostic when the submission ended unanswered. */
  detail?: string;
}

/** One row of the console's chat feed for a conversation. */
export type ChatItem = {
  id: string;
  role: "user" | "agent" | "tool";
  text: string;
  /** Envelope sender handle for user rows ("operator", another agent's name). */
  from?: string;
  name?: string;
  args?: string;
  isError?: boolean;
  thinking?: string;
  toolCalls?: { id: string; name: string; args: string }[];
};

const messageText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
          .join("\n")
      : "";


const DEFAULT_MEMORY_MD = (name: string) =>
  `# ${name}\n\nLong-term memory for this agent. Add durable facts here as you learn them.\n`;

export class DurableDaemon {
  readonly stateDir: string;
  readonly workspacesDir: string;
  readonly deliveriesDir: string;
  readonly transcriptsDir: string;
  private readonly storage: Storage;
  readonly harness: Harness;
  readonly registry: Registry;
  private readonly transport: OutboxTransport;
  private readonly opts: Required<Pick<DurableDaemonOptions, "defaultModel">> & DurableDaemonOptions;
  /** How many model providers were installed at open (0 = every turn fails no_model). */
  readonly providerCount: number;

  private constructor(
    stateDir: string,
    workspacesDir: string,
    deliveriesDir: string,
    transcriptsDir: string,
    storage: Storage,
    harness: Harness,
    registry: Registry,
    transport: OutboxTransport,
    opts: Required<Pick<DurableDaemonOptions, "defaultModel">> & DurableDaemonOptions,
    providerCount: number,
  ) {
    this.stateDir = stateDir;
    this.workspacesDir = workspacesDir;
    this.deliveriesDir = deliveriesDir;
    this.transcriptsDir = transcriptsDir;
    this.storage = storage;
    this.harness = harness;
    this.registry = registry;
    this.transport = transport;
    this.opts = opts;
    this.providerCount = providerCount;
  }

  private readonly outcomeMigrations = new Map<string, Promise<void>>();
  private providers: readonly Provider[] = [];
  private readonly outcomeReceiptsReady = new Set<string>();
  private readonly initializedAgents = new Map<string, Promise<void>>();
  private readonly maintenance = new Map<string, Promise<void>>();
  private readonly pendingEmissions = new Set<Promise<void>>();
  private resumePending: Promise<void> | undefined;
  private resumed = false;
  private readonly outboxes = new Map<string, AgentOutbox>();
  private readonly pumps = new Map<string, { stop: () => Promise<unknown> }>();
  private readonly normalizers = new Map<string, DurableEventNormalizer>();
  /** Last daemon-observed inbound activity per agent (cold-wake recycle). */
  private readonly lastActivity = new Map<string, number>();
  /** Wired by ReminderService so live remind/reschedule/delete re-arms timers. */
  private reminderHook: (() => void) | undefined;
  private closed = false;

  /** Called by ReminderService: invoke after every reminder doc mutation. */
  setReminderHook(fn: () => void): void {
    this.reminderHook = fn;
  }

  static async open(options: DurableDaemonOptions): Promise<DurableDaemon> {
    const stateDir = path.resolve(options.stateDir);
    const workspacesDir = path.join(stateDir, "workspaces");
    const deliveriesDir = path.join(stateDir, DELIVERIES_DIR_NAME);
    const transcriptsDir = path.join(stateDir, "transcripts");
    await ensureWorkspaceRoot(workspacesDir);
    await mkdir(deliveriesDir, { recursive: true });
    await mkdir(transcriptsDir, { recursive: true });

    const models = createModels();
    const providers = options.providers === "env" || options.providers === undefined
      ? await detectEnvProviders()
      : options.providers;
    for (const provider of providers) {
      models.setProvider(provider);
    }

    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(RaftAgentExtension);
    registry.install(createMessagingExtension((id, context) => storage.submission(id, context), options.messaging));

    const storage = await openNodeSqliteStorage(path.join(stateDir, "session.sqlite"));
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: options.settings,
        env: (target) => {
          const cwd = target.cwd ?? workspacesDir;
          const env = new ToolExecutionEnv({ cwd });
          trackToolChildren(env, stateDir);
          return env;
        },
      },
      BACKGROUND_CONTEXT,
    );

    const transport = options.transport ?? new RoutingTransport(new JsonlDeliveryTransport(deliveriesDir));
    const resolved = {
      ...options,
      defaultModel: options.defaultModel ?? pickDefaultModel(providers),
    } as Required<Pick<DurableDaemonOptions, "defaultModel">> & DurableDaemonOptions;
    const daemon = new DurableDaemon(
      stateDir,
      workspacesDir,
      deliveriesDir,
      transcriptsDir,
      storage,
      harness,
      registry,
      transport,
      resolved,
      providers.length,
    );
    daemon.providers = providers;
    if (transport instanceof RoutingTransport) {
      transport.attach((envelope) => daemon.routeMessage(envelope));
    }
    return daemon;
  }

  /**
   * Restart entry point: schedule interrupted work, requeue un-acked outbox
   * entries, attach event pumps for every registered agent, and reconcile any
   * submission that settled while nobody was watching.
   */
  async resume(): Promise<void> {
    this.assertOpen();
    if (this.resumed) return;
    if (!this.resumePending) this.resumePending = (async () => {
      const records = await this.listAgents();
      // Record recovery before any outbox routing or provider execution can
      // restart work. This is a display/audit entry, never another submission.
      for (const record of records) await this.announceResume(record);
      for (const record of records) await this.resumeAgent(record);
      this.harness.resume();
      this.resumed = true;
    })();
    try { await this.resumePending; }
    finally { this.resumePending = undefined; }
  }

  private async announceResume(record: AgentRecord): Promise<void> {
    const pending: string[] = [];
    const conversationId = Number(record.conversationId) as ConversationId;
    for (const status of ["queued", "placed"] as const) {
      let cursor;
      for (;;) {
        const page = await this.storage.scanSubmissions({ conversationId, status }, 100, cursor, BACKGROUND_CONTEXT);
        pending.push(...page.items.map((item) => String(item.id)));
        if (page.next === undefined) break;
        cursor = page.next;
      }
    }
    if (pending.length === 0) return;
    pending.sort((a, b) => Number(a) - Number(b));
    const epoch = JSON.stringify([record.agentId, pending]);
    await this.harness.commit(async (tx) => {
      const receipt = await tx.doc(RecoveryEpochDoc, epoch, epoch);
      if (receipt.announced) return;
      receipt.announced = true;
      await tx.appendEntry(conversationId, {
        kind: "raft.recovery",
        data: {
          epoch, pending, at: new Date().toISOString(),
          text: `Host restarted — resuming ${pending.length} unfinished submission(s).`,
        },
      });
    }, BACKGROUND_CONTEXT);
  }

  /**
   * Kill tool processes a PREVIOUS host left behind. Must only run while
   * this process owns the state dir (i.e. after MachineLock.acquire in
   * `serve`): on a live host's dir it would kill the running daemon's
   * children, which is why open() itself never reaps — one-shot CLI opens
   * (`send`, `list`) race a live daemon all the time.
   */
  async reapOrphanedToolChildren(): Promise<number> {
    const n = await reapOrphanedToolChildren(this.stateDir);
    if (n > 0) {
      this.opts.onWarn?.(`reaped ${n} orphaned tool process(es) left by a previous host (SIGKILL window)`);
    }
    return n;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pump of this.pumps.values()) {
      await pump.stop().catch(() => {});
    }
    await Promise.allSettled([...this.pendingEmissions]);
    for (const outbox of this.outboxes.values()) {
      outbox.stop();
    }
    await this.harness.close(BACKGROUND_CONTEXT).catch(() => {});
    await this.transport.close?.().catch(() => {});
  }

  // ── agents ───────────────────────────────────────────────────────────────

  async createAgent(config: AgentConfigInput): Promise<CreateAgentResult> {
    this.assertOpen();
    if (!config || typeof config !== "object") throw new AgentRegistryError("agent config must be an object", "invalid");
    validateAgentName(config.name);
    validateAgentSettings(config);
    if (config.initialMemoryMd !== undefined && typeof config.initialMemoryMd !== "string") {
      throw new AgentRegistryError("initialMemoryMd must be a string", "invalid");
    }
    const model = await validateModel(config.model ?? this.opts.defaultModel, this.providers);
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    const workspaceName = config.workspace ?? agentId;
    const workspacePath = resolveWorkspaceDirectoryPath(this.workspacesDir, workspaceName);
    if (!workspacePath) {
      throw new AgentRegistryError(`workspace must be a single directory under ${this.workspacesDir}: ${workspaceName}`, "invalid");
    }
    // Cheap pre-check so a taken name doesn't leave an orphan workspace +
    // conversation; the commit below re-checks (covers the race window).
    const existing = await this.harness.snapshot(AgentsDoc, BACKGROUND_CONTEXT);
    if (Object.values(existing?.records ?? {}).some((r) => r.name === config.name || r.agentId === config.name)) {
      throw new AgentRegistryError(`agent name already in use: ${config.name}`, "name_taken");
    }
    const seedFiles: AgentWorkspaceSeedFile[] = [
      { relativePath: "notes/.gitkeep", content: "" },
    ];
    const now = new Date().toISOString();
    const record: AgentRecord = {
      agentId,
      conversationId: "",
      name: config.name,
      model,
      instructions: config.instructions ?? null,
      workspacePath,
      thinkingLevel: config.thinkingLevel ?? null,
      createdAt: now,
      updatedAt: now,
      override: null,
      terminalFailure: null,
      lastOutcome: null,
      runs: 0,
      failures: 0,
      projectedSubmissions: [],
      outcomeReceiptsVersion: 1,
    };
    let workspaceOwnership: WorkspaceOwnership | undefined;
    let conversation;
    try {
      workspaceOwnership = await initializeAgentWorkspace(workspacePath, config.initialMemoryMd ?? DEFAULT_MEMORY_MD(config.name), seedFiles);
      record.workspaceOwnership = workspaceOwnership;
      // Registry and conversation creation share the same transaction. A
      // racing name conflict leaves neither an orphan conversation nor a row.
      conversation = await this.harness.createConversation({
        ownership: { kind: "ownerless" },
        agent: { model, instructions: record.instructions, cwd: workspacePath, thinkingLevel: config.thinkingLevel ?? null },
        init: async (tx, conversationId) => {
          const doc = await tx.doc(AgentsDoc);
          const conflict = Object.values(doc.records).some((r) => r.name === config.name || r.agentId === config.name || r.name === agentId || r.agentId === agentId);
          if (conflict) throw new AgentRegistryError(`agent name already in use: ${config.name}`, "name_taken");
          (await tx.doc(AgentBindingDoc, conversationId)).agentId = agentId;
          record.conversationId = String(conversationId);
          doc.records[agentId] = record;
        },
      }, BACKGROUND_CONTEXT);
    } catch (err) {
      if (workspaceOwnership) await deleteWorkspaceDirectory(this.workspacesDir, workspaceName, workspaceOwnership).catch(() => false);
      throw err;
    }

    const outbox = this.outboxFor(agentId);
    const appended = await outbox.append({
      type: "agent:start:outcome",
      agentId,
      name: config.name,
      model,
      workspacePath,
      at: now,
    });
    if (!("duplicate" in appended)) this.opts.onFrame?.(agentId, appended.clientSeq);
    await this.attachPump(agentId, String(conversation.id));
    return { record, conversationId: String(conversation.id) };
  }

  async listAgents(): Promise<AgentRecord[]> {
    const state = await this.harness.snapshot(AgentsDoc, BACKGROUND_CONTEXT);
    return sortRecords(state?.records ?? {});
  }

  async getAgent(agentIdOrName: string): Promise<AgentRecord> {
    const state = await this.harness.snapshot(AgentsDoc, BACKGROUND_CONTEXT);
    const record =
      (Object.hasOwn(state?.records ?? {}, agentIdOrName) ? state?.records[agentIdOrName] : undefined) ??
      Object.values(state?.records ?? {}).find((r) => r.name === agentIdOrName);
    if (!record) throw new AgentRegistryError(`no such agent: ${agentIdOrName}`, "not_found");
    return record;
  }

  async updateAgent(
    agentIdOrName: string,
    change: Partial<Pick<AgentRecord, "name" | "instructions" | "model" | "thinkingLevel">>,
  ): Promise<AgentRecord> {
    this.assertOpen();
    if (!change || typeof change !== "object" || Array.isArray(change)) throw new AgentRegistryError("agent update must be an object", "invalid");
    const allowed = new Set(["name", "instructions", "model", "thinkingLevel"]);
    if (Object.keys(change).some((key) => !allowed.has(key))) throw new AgentRegistryError("unsupported agent update field", "invalid");
    if (change.name !== undefined) validateAgentName(change.name);
    validateAgentSettings(change);
    const model = change.model === undefined ? undefined : await validateModel(change.model, this.providers);
    const record = await this.getAgent(agentIdOrName);
    let updated!: AgentRecord;
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(AgentsDoc);
      const current = doc.records[record.agentId];
      if (!current) throw new AgentRegistryError(`no such agent: ${agentIdOrName}`, "not_found");
      if (change.name !== undefined && Object.values(doc.records).some((r) => r.agentId !== record.agentId && (r.name === change.name || r.agentId === change.name))) {
        throw new AgentRegistryError(`agent name already in use: ${change.name}`, "name_taken");
      }
      updated = { ...current, updatedAt: new Date().toISOString() };
      if (change.name !== undefined) updated.name = change.name;
      if (change.instructions !== undefined) updated.instructions = change.instructions;
      if (change.thinkingLevel !== undefined) updated.thinkingLevel = change.thinkingLevel;
      if (model !== undefined) updated.model = model;
      await configure(tx, Number(record.conversationId) as ConversationId, {
        ...(model !== undefined ? { model } : {}),
        ...(change.instructions !== undefined ? { instructions: change.instructions } : {}),
        ...(change.thinkingLevel !== undefined ? { thinkingLevel: change.thinkingLevel as "minimal" | "low" | "medium" | "high" | null } : {}),
      });
      doc.records[record.agentId] = updated;
    }, BACKGROUND_CONTEXT);
    return this.getAgent(record.agentId);
  }

  /** Host stop: abort live work and mark the record stopped. */
  async stopAgent(agentIdOrName: string): Promise<void> {
    const record = await this.getAgent(agentIdOrName);
    const conversation = await this.requireConversation(record);
    await conversation.abort(BACKGROUND_CONTEXT, { background: true });
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(AgentsDoc);
      const rec = doc.records[record.agentId];
      if (rec) {
        rec.override = "stopped";
        rec.updatedAt = new Date().toISOString();
      }
    }, BACKGROUND_CONTEXT);
  }

  /** Host start: clear the stopped/terminal override so the agent accepts work. */
  async startAgent(agentIdOrName: string): Promise<void> {
    const record = await this.getAgent(agentIdOrName);
    // Flush a settlement whose event callback has not projected yet before
    // recording the human decision; it must not undo start a moment later.
    await this.reconcileSubmissions(record);
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(AgentsDoc);
      const rec = doc.records[record.agentId];
      if (rec) {
        rec.override = null;
        rec.terminalFailure = null;
        if (rec.lastOutcome) rec.resolvedSubmissionId = rec.lastOutcome.submissionId;
        rec.updatedAt = new Date().toISOString();
      }
    }, BACKGROUND_CONTEXT);
    // A started agent may have reminders whose fire failed while it was
    // stopped — re-arm them now (resolveAgent delegates here too).
    this.reminderHook?.();
  }

  /** Human outbox resolution — the daemon's admitted human start. */
  async resolveAgent(agentIdOrName: string, note?: string): Promise<void> {
    const record = await this.getAgent(agentIdOrName);
    await this.outboxFor(record.agentId).resolve(note);
    await this.startAgent(record.agentId);
  }

  async deleteAgent(agentIdOrName: string, opts: { deleteWorkspace?: boolean } = {}): Promise<void> {
    const record = await this.getAgent(agentIdOrName);
    const pump = this.pumps.get(record.agentId);
    if (pump) await pump.stop().catch(() => {});
    this.pumps.delete(record.agentId);
    this.outboxes.get(record.agentId)?.stop();
    this.outboxes.delete(record.agentId);
    const conversation = await this.requireConversation(record).catch(() => undefined);
    await conversation?.abort(BACKGROUND_CONTEXT, { background: true }).catch(() => {});
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(AgentsDoc);
      delete doc.records[record.agentId];
      const reminders = await tx.doc(RemindersDoc);
      reminders.timers = reminders.timers.filter((timer) => timer.agentId !== record.agentId);
      await tx.retireDoc(OutboxDoc, record.agentId);
    }, BACKGROUND_CONTEXT);
    this.reminderHook?.();
    // Agent evidence lives on disk too — remove the transcript + delivery
    // ledger so a deleted agent doesn't leave unbounded files behind.
    await rm(this.transcriptPath(record.agentId), { force: true }).catch(() => {});
    await rm(path.join(this.deliveriesDir, `${record.agentId}.jsonl`), { force: true }).catch(() => {});
    if (opts.deleteWorkspace) {
      const removed = await deleteWorkspaceDirectory(this.workspacesDir, path.basename(record.workspacePath), record.workspaceOwnership);
      if (!removed) this.opts.onWarn?.(`workspace preserved: ownership could not be verified for ${record.workspacePath}`);
    }
  }

  // ── messaging ────────────────────────────────────────────────────────────

  /**
   * Deliver a message into an agent — the daemon's chat-bridge/app-inbox path.
   * Busy handling is pi-durable's own: steer joins the running turn, followUp
   * queues for the next run, reject throws ConversationBusy.
   */
  async postMessage(
    agentIdOrName: string,
    input: string | IncomingMessage | readonly IncomingMessage[],
    options: PostMessageOptions = {},
  ): Promise<{ submissionId: string }> {
    const record = await this.getAgent(agentIdOrName);
    if (record.override === "stopped") {
      throw new AgentRegistryError(`agent ${record.agentId} is stopped`, "conflict");
    }
    if (await this.outboxFor(record.agentId).isUnreliable()) {
      throw new OutboxError(`agent ${record.agentId} outbox is unreliable; use resolve before sending more work`, "unreliable");
    }
    if (record.terminalFailure || unresolvedFailure(record)) {
      throw new AgentRegistryError(`agent ${record.agentId} needs start or resolve before accepting more work`, "conflict");
    }
    if (options.execute !== false) await this.resumeAgent(record);
    const requestId = options.requestId ?? `input:${randomUUID()}`;
    const messageChain = await this.harness.commit(async (tx) => {
      const context = await tx.doc(MessageContextDoc, Number(record.conversationId) as ConversationId, requestId, requestId);
      context.value ??= options.messageChain ?? { chainId: `chain:${randomUUID()}`, hop: 0 };
      return { ...context.value };
    }, BACKGROUND_CONTEXT);
    let content: string;
    if (typeof input === "string" && options.raw && !options.systemNotice) {
      content = formatOperatorInput(input);
    } else {
      const messages: readonly IncomingMessage[] = typeof input === "string" ? [{
        message_id: `local-${randomUUID()}`,
        timestamp: new Date().toISOString(),
        sender_name: options.systemNotice ? "system" : "operator",
        sender_type: options.systemNotice ? "system" : "user",
        target: record.name,
        reply_to: "main",
        chain_id: messageChain.chainId,
        hop: messageChain.hop,
        content: input,
      }] : Array.isArray(input) ? input : [input];
      if (!messages.length) throw new Error("postMessage needs at least one message");
      content = options.systemNotice && messages.length === 1
        ? formatSystemNoticeRuntimeInput({ ...messages[0]!, sender_name: "system", sender_type: "system", reply_to: "main" })
        : formatConcreteMessagesRuntimeInput(messages);
    }
    return this.submitMessage(record, content, { ...options, requestId });
  }

  /** Wait for one submission's settlement and read back the answer text. */
  async waitForAnswer(submissionId: string): Promise<Answer> {
    const submission = await this.harness.submission(Number(submissionId) as SubmissionId, BACKGROUND_CONTEXT);
    if (!submission) throw new Error(`unknown submission: ${submissionId}`);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    return this.readAnswer(settled);
  }

  /** Which agent owns a submission (for API ownership checks); undefined = unknown. */
  async submissionOwner(submissionId: string): Promise<string | undefined> {
    const sub = await this.harness
      .submission(Number(submissionId) as SubmissionId, BACKGROUND_CONTEXT)
      .catch(() => undefined);
    if (!sub) return undefined;
    const rec = await sub.status(BACKGROUND_CONTEXT).catch(() => undefined);
    if (!rec) return undefined;
    const records = await this.listAgents();
    return records.find((r) => r.conversationId === String(rec.conversationId))?.agentId;
  }

  /**
   * Route a delivered `agent:message` frame: to "main" → durable operator
   * inbox; to an agent → a sender-addressed envelope via postMessage with a
   * deterministic requestId (exactly-once under retransmission). Unknown
   * targets bounce back to the sender instead of retrying forever.
   */
  private async routeMessage(envelope: OutboxEnvelope & { frame: AgentMessageFrame }): Promise<void> {
    const frame = envelope.frame;
    const from = await this.getAgent(frame.agentId).catch(() => undefined);
    const fromName = from?.name ?? frame.agentId;
    if (frame.to === "main") {
      const entryId = `msg-${frame.agentId}-${envelope.clientSeq}`;
      await this.harness.commit(async (tx) => {
        const doc = await tx.doc(MainInboxDoc);
        // Retransmitted frames carry the same deterministic id — dedupe or a
        // crash between commit and ack would double-post to the inbox.
        if (doc.entries.some((e) => e.id === entryId)) return;
        doc.entries.push({
          id: entryId,
          fromAgentId: frame.agentId,
          fromName,
          text: frame.content,
          at: frame.at,
        });
        if (doc.entries.length > 1000) doc.entries.splice(0, doc.entries.length - 1000);
      }, BACKGROUND_CONTEXT);
      return;
    }
    const messageChain: MessageChain = { chainId: frame.chainId ?? `legacy-route:${frame.agentId}:${frame.msgId}`, hop: frame.hop ?? 1 };
    const blocked = await this.harness.commit(async (tx) => {
      const chain = await tx.doc(MessageChainDoc, messageChain.chainId, messageChain.chainId);
      if (messageChain.hop > messagingLimits(this.opts.messaging).maxHops) chain.blocked ??= "hop limit reached";
      if (!chain.blocked) return false;
      if (!chain.notified) {
        const inbox = await tx.doc(MainInboxDoc);
        inbox.entries.push({ id: `limit:${messageChain.chainId}`, fromAgentId: "system", fromName: "system",
          text: `Messaging stopped for chain ${messageChain.chainId}: ${chain.blocked}.`, at: new Date().toISOString() });
        if (inbox.entries.length > 1000) inbox.entries.splice(0, inbox.entries.length - 1000);
        chain.notified = true;
      }
      return true;
    }, BACKGROUND_CONTEXT);
    if (blocked) return;
    const bounce = async (why: string) => {
      await this.postMessage(
        frame.agentId,
        `Delivery failed: ${why}. Your message was not delivered.`,
        { systemNotice: true, requestId: `route-bounce:${frame.agentId}:${envelope.clientSeq}`, messageChain },
      ).catch(() => {});
    };
    const target = await this.getAgent(frame.to).catch(() => undefined);
    if (!target) {
      await bounce(`no agent named "${frame.to}"`);
      return;
    }
    if (target.override === "stopped") {
      await bounce(`agent "${frame.to}" is stopped`);
      return;
    }
    try {
      await this.postMessage(
        target.agentId,
        {
          message_id: `route-${frame.msgId}`,
          timestamp: frame.at,
          sender_name: fromName,
          sender_type: "agent",
          target: target.name,
          reply_to: frame.agentId,
          chain_id: messageChain.chainId,
          hop: messageChain.hop,
          content: frame.content,
        },
        { requestId: `route:${frame.agentId}:${envelope.clientSeq}`, messageChain },
      );
    } catch (err) {
      // Permanent target-side failures (stopped / deleted / unreliable
      // outbox) must bounce — retransmitting wedges the sender's outbox
      // head-of-line forever. Transient errors rethrow so the pump retries.
      if (err instanceof AgentRegistryError || err instanceof OutboxError) {
        await bounce(err.message);
        return;
      }
      throw err;
    }
  }

  // ── reminders ───────────────────────────────────────────────────────────

  /** Commit a durable reminder row; ReminderService arms the setTimeout. */
  async remind(agentIdOrName: string, spec: string, text: string): Promise<Reminder> {
    const record = await this.getAgent(agentIdOrName);
    const { dueAt, everyMs, timeZone } = parseWhen(spec);
    const reminder: Reminder = {
      id: `rem-${randomUUID().slice(0, 8)}`,
      agentId: record.agentId,
      text,
      dueAt,
      everyMs,
      timeZone,
      createdAt: new Date().toISOString(),
    };
    await this.harness.commit(async (tx) => {
      if (!(await tx.doc(AgentsDoc)).records[record.agentId]) throw new AgentRegistryError(`agent ${record.agentId} was deleted`, "not_found");
      const doc = await tx.doc(RemindersDoc);
      doc.timers.push(reminder);
    }, BACKGROUND_CONTEXT);
    this.reminderHook?.();
    return reminder;
  }

  async listReminders(): Promise<Reminder[]> {
    const state = await this.harness.snapshot(RemindersDoc, BACKGROUND_CONTEXT);
    return state?.timers ?? [];
  }

  async rescheduleReminder(id: string, dueAt: string): Promise<void> {
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(RemindersDoc);
      const t = doc.timers.find((r) => r.id === id);
      if (t) t.dueAt = dueAt;
    }, BACKGROUND_CONTEXT);
    this.reminderHook?.();
  }

  async deleteReminder(id: string): Promise<void> {
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(RemindersDoc);
      doc.timers = doc.timers.filter((r) => r.id !== id);
    }, BACKGROUND_CONTEXT);
    this.reminderHook?.();
  }

  /** Chat-shaped feed of a conversation for the console: user/agent/tool rows. */
  async chatFeed(agentIdOrName: string, limit = 200): Promise<ChatItem[]> {
    const record = await this.getAgent(agentIdOrName);
    const conversationId = Number(record.conversationId) as ConversationId;
    const count = Math.max(0, Math.min(1000, Math.floor(limit)));
    if (!Number.isFinite(count) || count === 0) return [];
    // Entries are newest-first, but messages within one entry are in their
    // original order. Reverse each entry while collecting, then reverse once.
    const items: ChatItem[] = [];
    let cursor;
    for (;;) {
      const page = await this.storage.scanEntries({ conversationId }, Math.min(100, count), cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) {
        const row: ChatItem[] = [];
        if (entry.kind === "raft.recovery" && entry.data && typeof entry.data === "object" && "text" in entry.data) {
          row.push({ id: `${entry.id}:recovery`, role: "user", from: "system", text: String(entry.data.text) });
        }
        for (const [index, m] of (entry.model ?? []).entries()) {
          const id = `${entry.id}:${index}`;
          if (m.role === "user") {
            const raw = messageText(m.content);
            const envelope = parseIncomingEnvelope(raw);
            row.push({ id, role: "user", text: envelope?.text ?? raw, ...(envelope ? { from: envelope.from } : {}) });
          } else if (m.role === "assistant") {
            const text = m.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
            const thinking = m.content.filter((c) => c.type === "thinking").map((c) => (c as { thinking: string }).thinking).join("\n");
            const toolCalls = m.content.filter((c) => c.type === "toolCall").map((c) => {
              const t = c as { id: string; name: string; arguments: unknown };
              return { id: t.id, name: t.name, args: JSON.stringify(t.arguments).slice(0, 300) };
            });
            row.push({ id, role: "agent", text, ...(thinking ? { thinking } : {}), ...(toolCalls.length ? { toolCalls } : {}) });
          } else if (m.role === "toolResult") {
            const t = m as { toolName: string; content: unknown; isError: boolean };
            row.push({ id, role: "tool", name: t.toolName, text: messageText(t.content).slice(0, 500), isError: t.isError });
          }
        }
        items.push(...row.reverse());
        if (items.length >= count) return items.slice(0, count).reverse();
      }
      if (page.next === undefined) return items.reverse();
      cursor = page.next;
    }
  }

  /** All durable submissions admitted on an agent's conversation, any status. */
  async submissions(agentIdOrName: string): Promise<readonly SubmissionRecord[]> {
    const record = await this.getAgent(agentIdOrName);
    const conversationId = Number(record.conversationId) as ConversationId;
    const out: SubmissionRecord[] = [];
    let cursor;
    for (;;) {
      const page = await this.storage.scanSubmissions({ conversationId }, 200, cursor, BACKGROUND_CONTEXT);
      out.push(...page.items);
      if (page.next === undefined) return out;
      cursor = page.next;
    }
  }

  /** Operator inbox entries (agent → "main" deliveries), oldest first. */
  async mainInbox(): Promise<readonly { id: string; fromAgentId: string; fromName: string; text: string; at: string }[]> {
    const state = await this.harness.snapshot(MainInboxDoc, BACKGROUND_CONTEXT);
    return state?.entries ?? [];
  }

  /** Wait until an agent's conversation is idle (run + owned work drained). */
  async waitForIdle(agentIdOrName: string): Promise<void> {
    const record = await this.getAgent(agentIdOrName);
    const conversation = await this.requireConversation(record);
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
  }

  async abort(agentIdOrName: string): Promise<void> {
    const record = await this.getAgent(agentIdOrName);
    const conversation = await this.requireConversation(record);
    await conversation.abort(BACKGROUND_CONTEXT);
  }

  async compact(agentIdOrName: string, instructions?: string): Promise<void> {
    const record = await this.getAgent(agentIdOrName);
    const conversation = await this.requireConversation(record);
    const taskId = await conversation.compact(instructions, BACKGROUND_CONTEXT);
    await this.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
  }

  async reset(agentIdOrName: string, handoff?: string): Promise<void> {
    const record = await this.getAgent(agentIdOrName);
    const conversation = await this.requireConversation(record);
    await conversation.reset(handoff, BACKGROUND_CONTEXT);
  }

  // ── observation ──────────────────────────────────────────────────────────

  /** Normalized event stream of one agent (the ParsedEvent vocabulary). */
  async *events(agentIdOrName: string): AsyncGenerator<ParsedEvent> {
    const record = await this.getAgent(agentIdOrName);
    const file = this.transcriptPath(record.agentId);
    try {
      const { createReadStream } = await import("node:fs");
      const { createInterface } = await import("node:readline");
      if (existsSync(file)) {
        const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            yield JSON.parse(line) as ParsedEvent;
          } catch {
            // One torn/corrupt transcript line must not truncate the stream.
          }
        }
      }
    } catch {
      /* no transcript yet */
    }
  }

  async lifecycle(agentIdOrName: string): Promise<AgentLifecycleRecord> {
    const record = await this.getAgent(agentIdOrName);
    const view = await this.conversationView(record).catch(() => undefined);
    return projectLifecycle(record, view, await this.outboxFor(record.agentId).isUnreliable());
  }

  async outboxState(agentIdOrName: string): Promise<Readonly<OutboxDocState> | undefined> {
    const record = await this.getAgent(agentIdOrName);
    return this.outboxFor(record.agentId).state();
  }

  async usage(agentIdOrName?: string) {
    if (agentIdOrName !== undefined) {
      const record = await this.getAgent(agentIdOrName);
      return await this.harness.snapshot(UsageDoc, Number(record.conversationId) as ConversationId, BACKGROUND_CONTEXT) ?? { models: {}, tools: {} };
    }
    return this.harness.usage(BACKGROUND_CONTEXT);
  }

  async inspect() {
    return this.harness.inspect(BACKGROUND_CONTEXT);
  }

  async workspaces(): Promise<WorkspaceDirectoryInfo[]> {
    return scanWorkspaceDirectories(this.workspacesDir);
  }

  transcriptPath(agentId: string): string {
    return path.join(this.transcriptsDir, `${agentId}.events.jsonl`);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private assertOpen(): void {
    if (this.closed) throw new Error("daemon is closed");
  }

  outboxFor(agentId: string): AgentOutbox {
    let outbox = this.outboxes.get(agentId);
    if (!outbox) {
      outbox = new AgentOutbox(this.harness, BACKGROUND_CONTEXT, agentId, this.transport, {
        retryDelayMs: this.opts.retryDelayMs,
      });
      this.outboxes.set(agentId, outbox);
    }
    return outbox;
  }

  /** Attach before the first admission. Recovery scans once per process;
   * the live pump observes every later settlement, including old IDs that
   * settle after newer ones. A maximum-ID watermark would lose those. */
  private async resumeAgent(record: AgentRecord): Promise<void> {
    let pending = this.initializedAgents.get(record.agentId);
    if (!pending) {
      pending = (async () => {
        await this.attachPump(record.agentId, record.conversationId);
        await this.outboxFor(record.agentId).requeueInFlight();
        await this.reconcileSubmissions(record);
      })();
      this.initializedAgents.set(record.agentId, pending);
    }
    try { await pending; }
    catch (error) {
      if (this.initializedAgents.get(record.agentId) === pending) this.initializedAgents.delete(record.agentId);
      throw error;
    }
  }

  private async submitMessage(record: AgentRecord, content: string, options: PostMessageOptions): Promise<{ submissionId: string }> {
    const conversationId = Number(record.conversationId) as ConversationId;
    if (options.execute === false) {
      const id = await enqueueInput(this.harness, conversationId, content, options);
      return { submissionId: String(id) };
    }
    const conversation = await this.requireConversation(record);
    const submission = await conversation.submit(
      { type: "input", content, whenBusy: options.whenBusy, requestId: options.requestId }, BACKGROUND_CONTEXT,
    );
    // Cold-wake maintenance is admitted only after the message is durable,
    // and never delays steering, route acknowledgement, or stop requests.
    const last = this.lastActivity.get(record.agentId);
    this.lastActivity.set(record.agentId, Date.now());
    if (this.opts.compactOnWakeMs && last !== undefined && Date.now() - last > this.opts.compactOnWakeMs
      && options.whenBusy !== "steer" && !this.maintenance.has(record.agentId)) {
      const task = Promise.resolve().then(async () => {
        if (this.closed) return;
        await this.compact(record.agentId, "Recycled cold context: keep only what matters for continuing this work.");
      }).catch((error) => this.opts.onWarn?.(`wake-compact failed for ${record.name}: ${error}`))
        .finally(() => { this.maintenance.delete(record.agentId); });
      this.maintenance.set(record.agentId, task);
    }
    return { submissionId: String(submission.id) };
  }

  private async requireConversation(record: AgentRecord): Promise<Conversation> {
    const conversation = await this.harness.conversation(Number(record.conversationId) as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) throw new AgentRegistryError(`conversation ${record.conversationId} is gone`, "not_found");
    return conversation;
  }

  private async conversationView(record: AgentRecord): Promise<ConversationView | undefined> {
    const conversation = await this.requireConversation(record);
    const state = await conversation.viewState(BACKGROUND_CONTEXT);
    try {
      return state.value;
    } finally {
      state.dispose();
    }
  }

  private async readAnswer(settled: SubmissionRecord): Promise<Answer> {
    const base = { submissionId: String(settled.id), status: settled.status } as Answer;
    if (settled.status !== "done" || settled.type !== "input") {
      if (settled.status !== "unanswered") return base;
      const detail = settled.detail === undefined ? undefined : scrubRuntimeErrorDiagnosticText(
        typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail),
      ).slice(0, 512);
      return { ...base, reason: settled.reason, ...(detail ? { detail } : {}) };
    }
    const looked = await this.storage.entry(settled.conversationId, settled.answer, BACKGROUND_CONTEXT).catch(() => undefined);
    const entry = looked?.entry;
    const message = entry?.model?.[0];
    const text =
      message && message.role === "assistant"
        ? message.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("")
        : undefined;
    return { ...base, text };
  }

  /**
   * Attach the event pump: normalized events → transcript JSONL; submission
   * settlements → outbox frames. One pump per agent, reattached on resume().
   */
  private async attachPump(agentId: string, conversationId: string): Promise<void> {
    if (this.pumps.has(agentId)) return;
    // Reserve the slot synchronously — a concurrent attachPump must not
    // double-subscribe the same conversation (check-then-set race).
    let released = false;
    let stream: Awaited<ReturnType<typeof watchEvents>> | undefined;
    const placeholder = {
      stop: async () => {
        released = true;
        await stream?.stop().catch(() => {});
      },
    };
    this.pumps.set(agentId, placeholder);
    try {
      const normalizer = new DurableEventNormalizer();
      this.normalizers.set(agentId, normalizer);
      const transcript = this.transcriptPath(agentId);
      stream = await watchEvents(this.harness, Number(conversationId) as ConversationId, BACKGROUND_CONTEXT);
      if (released || this.closed) {
        await stream.stop().catch(() => {});
        return;
      }

      const emit = (events: ParsedEvent[]) => {
        const pending = (async () => {
          for (const event of events) {
            if (this.closed) return;
            try {
              this.opts.onEvent?.(agentId, event);
            } catch (err) {
              // A throwing listener must not kill the CommittedWatch.
              this.opts.onWarn?.(`onEvent listener threw for ${agentId}: ${err}`);
            }
            await appendFile(transcript, JSON.stringify(event) + "\n", "utf8").catch(() => {});
            if (event.kind === "submission_settled") {
              // A watch listener cannot re-enter the Session line. Capture
              // counters before run_end in the same batch resets them.
              const captured = event;
              const counters = { ...normalizer.outcomeCounters };
              const sticky = normalizer.stickyTerminalFailure;
              const firstError = normalizer.firstErrorText;
              setImmediate(() => {
                if (this.closed) return;
                void this.produceOutcome(agentId, captured, { counters, sticky, firstError }).catch((err) =>
                  console.error(`[outbox] ${agentId} outcome append failed:`, err),
                );
              });
            }
          }
        })();
        this.pendingEmissions.add(pending);
        void pending.then(() => this.pendingEmissions.delete(pending), () => this.pendingEmissions.delete(pending));
        return pending;
      };

      const initial = normalizer.normalizeSnapshot(stream.snapshot, conversationId);
      await emit(initial);
      stream.start(async (batch) => {
        const fresh = normalizer.normalize(batch);
        await emit(fresh);
        if (batch.some((e) => e.type === "run_end")) normalizer.resetRun();
      });
    } catch (err) {
      if (this.pumps.get(agentId) === placeholder) this.pumps.delete(agentId);
      this.normalizers.delete(agentId);
      throw err;
    }
  }

  /**
   * Turn a settled submission into an E1/E2 outbox frame, exactly once.
   * Permanent per-submission receipts preserve identity even after arbitrarily
   * long histories; frame, receipt and registry projection commit together.
   */
  private async produceOutcome(
    agentId: string,
    settled: Extract<ParsedEvent, { kind: "submission_settled" }>,
    run?: { counters: { textEvents: number; toolCalls: number; runtimeErrors: number }; sticky: boolean; firstError: string | null },
  ): Promise<void> {
    await this.ensureOutcomeReceipts(agentId);
    let outcome;
    if (settled.status === "done") {
      // Attempt errors remain telemetry; they cannot turn an authoritative
      // successful settlement into a terminal_failure frame.
      outcome = turnCompletedOutcome(run?.counters ?? { textEvents: 0, toolCalls: 0, runtimeErrors: 0 });
    } else {
      const raw = settled.reason === "aborted" ? "operation aborted"
        : settled.reason === "no_model" ? "configured model not found; select an installed provider/model"
        : run?.firstError ?? settled.reason ?? "submission unanswered";
      const evidence = terminalFailureFromRawText(failureKindFor(settled.reason), raw);
      outcome = {
        kind: "terminal_failure" as const,
        failureKind: evidence.failureKind,
        fingerprint: evidence.fingerprint,
        errorClass: evidence.errorClass,
        errorReason: evidence.errorReason,
        errorAction: evidence.errorAction,
        detail: evidence.detail,
      };
    }

    // Registry projection co-committed WITH the frame: one commit lands
    // frame + dedupe key + lastOutcome/runs/terminalFailure, so a crash can
    // never split "outcome delivered, projection lost". Pre-atomic states
    // (a frame committed without projection) are repaired idempotently below.
    const project = async (tx: Tx): Promise<void> => {
      const doc = await tx.doc(AgentsDoc);
      const record = doc.records[agentId];
      if (!record) return;
      const receipt = await tx.doc(OutcomeReceiptDoc, outcomeReceiptKey(agentId, settled.submissionId), settled.submissionId);
      if (receipt.projected) return;
      receipt.projected = true;
      if (settled.status === "done") record.runs++;
      else record.failures++;
      // Only overwrite lastOutcome with a NEWER-or-equal submission — a
      // late repair of an old submission must not clobber a newer one.
      const cur = Number(record.lastOutcome?.submissionId ?? NaN);
      const nxt = Number(settled.submissionId);
      if (!record.lastOutcome || !Number.isFinite(cur) || !Number.isFinite(nxt) || nxt >= cur) {
        record.lastOutcome = {
          kind: outcome.kind,
          status: settled.status,
          submissionId: settled.submissionId,
          reason: settled.status === "unanswered" ? (settled.reason ?? "unanswered") : null,
          errorClass: outcome.kind === "terminal_failure" ? outcome.errorClass : null,
          at: new Date().toISOString(),
        };
        if (outcome.kind === "turn_completed" || settled.reason === "aborted") record.terminalFailure = null;
        if (outcome.kind === "terminal_failure" && outcome.errorAction !== null && outcome.errorAction !== "none") {
          record.terminalFailure = {
            failureKind: outcome.failureKind,
            fingerprint: outcome.fingerprint,
            detail: outcome.detail ?? settled.reason ?? "terminal failure",
            at: new Date().toISOString(),
          };
        }
      }
      record.updatedAt = new Date().toISOString();
    };

    const outbox = this.outboxFor(agentId);
    const appended = await outbox.append(
      {
        type: "agent:runtime:outcome",
        agentId,
        submissionId: settled.submissionId,
        outcome,
      },
      settled.submissionId,
      project,
    );
    if ("duplicate" in appended) return;
    this.opts.onFrame?.(agentId, appended.clientSeq);
  }

  /**
   * Sweep settled submissions that settled while no pump watched (e.g. daemon
   * was closed between place and settle) — produce any missing outcome frame.
   */
  private async settledSubmissions(record: AgentRecord) {
    const settled: { id: string; status: "done" | "unanswered"; reason?: string }[] = [];
    for (const status of ["done", "unanswered"] as const) {
      let cursor;
      for (;;) {
        const page = await this.storage.scanSubmissions(
          { conversationId: Number(record.conversationId) as ConversationId, status },
          100,
          cursor,
          BACKGROUND_CONTEXT,
        );
        for (const rec of page.items) {
          settled.push({
            id: String(rec.id),
            status,
            reason: status === "unanswered" ? rec.reason : undefined,
          });
        }
        if (page.next === undefined) break;
        cursor = page.next;
      }
    }
    return settled;
  }

  private async reconcileSubmissions(record: AgentRecord): Promise<void> {
    await this.ensureOutcomeReceipts(record.agentId);
    const settled = await this.settledSubmissions(record);
    for (const s of settled) {
      const receipt = await this.harness.snapshot(OutcomeReceiptDoc, outcomeReceiptKey(record.agentId, s.id), BACKGROUND_CONTEXT);
      if (receipt?.produced && receipt.projected) continue;
      await this.produceOutcome(record.agentId, {
        kind: "submission_settled",
        submissionId: s.id,
        status: s.status,
        reason: s.reason,
      });
    }
  }

  /** All live watchers and explicit reconciliation wait for the same migration;
   * otherwise a settlement racing upgrade could be counted, then overwritten. */
  private async ensureOutcomeReceipts(agentId: string): Promise<void> {
    if (this.outcomeReceiptsReady.has(agentId)) return;
    let pending = this.outcomeMigrations.get(agentId);
    if (!pending) {
      pending = (async () => {
        const record = (await this.harness.snapshot(AgentsDoc, BACKGROUND_CONTEXT))?.records[agentId];
        if (!record) return;
        if (record.outcomeReceiptsVersion !== 1) {
          await this.migrateOutcomeReceipts(record, await this.settledSubmissions(record));
        }
        this.outcomeReceiptsReady.add(agentId);
      })();
      this.outcomeMigrations.set(agentId, pending);
    }
    try { await pending; }
    finally { if (this.outcomeMigrations.get(agentId) === pending) this.outcomeMigrations.delete(agentId); }
  }

  /** One-time, restartable migration of BOTH old schemas (absent or bounded
   * projection ledger). Rebuild counters from durable settlements, never from
   * an evicting set. Only evidence proves a frame was produced: the legacy
   * ring, a live outbox entry, or the default delivery ledger. A custom
   * transport's forgotten prefix is unknowable and is conservatively replayed
   * once under the existing at-least-once contract, never silently discarded. */
  private async migrateOutcomeReceipts(
    record: AgentRecord,
    settled: { id: string; status: "done" | "unanswered"; reason?: string }[],
  ): Promise<void> {
    const current = (await this.harness.snapshot(AgentsDoc, BACKGROUND_CONTEXT))?.records[record.agentId];
    if (!current || current.outcomeReceiptsVersion === 1) return;
    const outbox = await this.outboxFor(record.agentId).state();
    const produced = new Set(outbox?.producedSubmissionIds ?? []);
    for (const entry of outbox?.entries ?? []) {
      if (entry.frame.type === "agent:runtime:outcome") produced.add(entry.frame.submissionId);
    }
    try {
      const ledger = await readFile(path.join(this.deliveriesDir, `${record.agentId}.jsonl`), "utf8");
      for (const line of ledger.split("\n")) {
        try {
          const envelope = JSON.parse(line) as OutboxEnvelope;
          if (envelope.agentId === record.agentId && envelope.frame?.type === "agent:runtime:outcome") {
            produced.add(envelope.frame.submissionId);
          }
        } catch { /* ignore torn final line; no proof means conservative replay */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Bounded batches keep each migration transaction small. The final version
    // marker is written only AFTER all receipts, so a crash restarts safely.
    for (let offset = 0; offset < settled.length; offset += 100) {
      const batch = settled.slice(offset, offset + 100);
      await this.harness.commit(async (tx) => {
        for (const s of batch) {
          const receipt = await tx.doc(OutcomeReceiptDoc, outcomeReceiptKey(record.agentId, s.id), s.id);
          receipt.projected = true;
          if (produced.has(s.id)) receipt.produced = true;
        }
      }, BACKGROUND_CONTEXT);
    }
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(AgentsDoc);
      const r = doc.records[record.agentId];
      if (!r || r.outcomeReceiptsVersion === 1) return;
      r.runs = settled.filter((s) => s.status === "done").length;
      r.failures = settled.length - r.runs;
      const latest = settled.reduce<(typeof settled)[number] | undefined>(
        (prev, s) => !prev || Number(s.id) > Number(prev.id) ? s : prev, undefined,
      );
      if (latest) {
        const evidence = latest.status === "done" ? undefined
          : terminalFailureFromRawText(failureKindFor(latest.reason), latest.reason ?? "unanswered");
        // An existing projection for this (or a newer) submission is also
        // evidence that terminalFailure reflects subsequent human decisions.
        // In particular resolveAgent() deliberately clears it; replaying the
        // old diagnostic must not undo that resolution or replace richer data.
        const projectedId = Number(r.lastOutcome?.submissionId);
        if (!r.lastOutcome || !Number.isFinite(projectedId) || projectedId < Number(latest.id)) {
          r.lastOutcome = {
            kind: evidence ? "terminal_failure" : "turn_completed",
            status: latest.status,
            submissionId: latest.id,
            reason: latest.status === "done" ? null : (latest.reason ?? "unanswered"),
            errorClass: evidence?.errorClass ?? null,
            at: new Date().toISOString(),
          };
          if (evidence && evidence.errorAction !== null && evidence.errorAction !== "none") {
            r.terminalFailure = {
              failureKind: evidence.failureKind,
              fingerprint: evidence.fingerprint,
              detail: evidence.detail ?? latest.reason ?? "terminal failure",
              at: new Date().toISOString(),
            };
          }
        }
      }
      r.projectedSubmissions = []; // obsolete ring; receipts are authoritative
      r.outcomeReceiptsVersion = 1;
    }, BACKGROUND_CONTEXT);
  }
}

function failureKindFor(reason: string | undefined): TerminalFailureKind {
  const text = reason ?? "";
  if (/input.*too.*large|context.*too.*long|InputTooLargeError/i.test(text)) return "compaction_input_too_large";
  if (/compaction/i.test(text)) return "compaction_failed";
  return "sticky_runtime_error";
}

/**
 * Orphaned tool children, tracked by LEDGER not by cwd.
 *
 * Tool subprocesses spawn detached (each is its own process-group leader,
 * pgid === pid), so a host SIGKILL orphans them mid-side-effect while the
 * durable run re-executes. Attributing orphans by "cwd under workspaces/"
 * is wrong in both directions: it kills unrelated processes the user is
 * running inside a workspace (editors, debugging), and it misses a real
 * tool child that `cd`'d out of the workspace before the host died.
 *
 * Instead every spawn is recorded at birth in stateDir/tool-children.jsonl
 * (pid + kernel starttime — the pid-reuse guard), and open() SIGKILLs the
 * process groups of exactly those recorded pids that are still alive.
 * Best-effort: a spawn torn down between exec() and the ledger write can
 * still escape; a pid reused for a different process never matches because
 * starttime differs.
 */
const TOOL_CHILDREN_FILE = "tool-children.jsonl";

export function trackToolChildren(env: NodeExecutionEnv, stateDir: string): void {
  // NodeExecutionEnv keeps a private Set<number> of live child pids, added
  // the moment spawn() returns — wrap add() so every spawn is journaled
  // (sync append; spawn bookkeeping cannot await).
  const holder = env as unknown as { activeChildPids?: unknown };
  const pids = holder.activeChildPids;
  if (!(pids instanceof Set)) return;
  const file = path.join(stateDir, TOOL_CHILDREN_FILE);
  const origAdd = pids.add.bind(pids);
  pids.add = (pid: number): Set<number> => {
    try {
      appendFileSync(file, JSON.stringify({ pid, start: processStartTime(pid) }) + "\n");
    } catch {
      /* ledger is best-effort */
    }
    return origAdd(pid);
  };
}

/** Live (non-zombie) processes whose process group equals `pgid`. */
function liveGroupMembers(pgid: number): { pid: number; startJiffies: number }[] {
  const out: { pid: number; startJiffies: number }[] = [];
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      const info = procInfo(pid);
      if (info === undefined || DEAD_STATES.has(info.state) || info.pgrp !== pgid) continue;
      out.push({ pid, startJiffies: Number(info.start) });
    }
  } catch {
    /* /proc unavailable */
  }
  return out;
}

async function reapOrphanedToolChildren(stateDir: string): Promise<number> {
  const file = path.join(stateDir, TOOL_CHILDREN_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return 0; // no ledger → nothing this daemon's lineage ever spawned
  }
  let reaped = 0;
  const done = new Set<number>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let pid: number | undefined;
    let start: string | undefined;
    try {
      const e = JSON.parse(line) as { pid?: number; start?: string };
      pid = e.pid;
      start = e.start;
    } catch {
      continue;
    }
    if (typeof pid !== "number" || pid <= 1 || pid === process.pid || done.has(pid)) continue;
    const info = procInfo(pid);
    if (info !== undefined && !DEAD_STATES.has(info.state)) {
      if (start !== undefined && info.start === start) {
        // Recorded leader still alive, identity proven → kill its group.
        try {
          process.kill(-pid, "SIGKILL"); // detached child = process-group leader
          reaped++;
        } catch {
          try {
            process.kill(pid, "SIGKILL");
            reaped++;
          } catch {
            /* gone */
          }
        }
        done.add(pid);
      }
      // Alive but start missing/mismatched → pid was RECYCLED by someone
      // else's process — never touch it, and don't consume the pid either:
      // a later ledger line may carry the real start for this pid.
      continue;
    }
    // Leader dead/zombie — descendants may still run in pgrp === pid. A
    // process group id only survives while members exist, and no new member
    // can join a dead pid's group (a group id is recreated only by a
    // setsid() from that same pid — which would need the pid alive again,
    // in which case the start-mismatch branch above skips instead). So
    // group members here are descendants of the recorded leader; they must
    // only postdate the leader's own start.
    // Residual corner (documented, astronomically rare): the pid recycled
    // into a setsid'ing process which then ALSO died — its group shares the
    // dead pgid and is indistinguishable from the recorded lineage. Safer
    // than an upper time bound, which systematically spared real orphans
    // that were forked after the ledger's last append.
    if (start === undefined) continue; // no identity — conservative skip
    const leaderJ = Number(start);
    const members = liveGroupMembers(pid).filter((m) => m.pid !== pid);
    if (members.length === 0) continue;
    if (members.every((m) => m.startJiffies >= leaderJ)) {
      try {
        process.kill(-pid, "SIGKILL");
        reaped++;
        done.add(pid);
      } catch {
        /* group already gone */
      }
    }
  }
  // The ledger describes the previous lifetime — consumed once reaped.
  await rm(file, { force: true }).catch(() => {});
  return reaped;
}

async function detectEnvProviders(): Promise<Provider[]> {
  const providers: Provider[] = [];
  const env = process.env;
  const tryLoad = async (spec: string, factory: string, key: string): Promise<void> => {
    try {
      const mod = (await import(`@earendil-works/pi-ai/providers/${spec}`)) as Record<string, () => Provider>;
      const create = mod[factory];
      if (create) providers.push(create());
    } catch {
      /* provider not available */
    }
  };
  if (env.ZAI_CODING_CN_API_KEY || env.zhipu) {
    if (!env.ZAI_CODING_CN_API_KEY && env.zhipu) env.ZAI_CODING_CN_API_KEY = env.zhipu;
    await tryLoad("zai-coding-cn", "zaiCodingCnProvider", "ZAI_CODING_CN_API_KEY");
  }
  if (env.ZAI_API_KEY) await tryLoad("zai", "zaiProvider", "ZAI_API_KEY");
  if (env.MINIMAX_CN_API_KEY || env.MINIMAX_CN) {
    if (!env.MINIMAX_CN_API_KEY && env.MINIMAX_CN) env.MINIMAX_CN_API_KEY = env.MINIMAX_CN;
    await tryLoad("minimax-cn", "minimaxCnProvider", "MINIMAX_CN_API_KEY");
  }
  if (env.MINIMAX_API_KEY) await tryLoad("minimax", "minimaxProvider", "MINIMAX_API_KEY");
  if (env.DEEPSEEK_API_KEY) await tryLoad("deepseek", "deepseekProvider", "DEEPSEEK_API_KEY");
  if (env.OPENAI_API_KEY) await tryLoad("openai", "openaiProvider", "OPENAI_API_KEY");
  if (env.ANTHROPIC_API_KEY) await tryLoad("anthropic", "anthropicProvider", "ANTHROPIC_API_KEY");
  return providers;
}

export { OutboxError };

/**
 * DurableDaemon — the durable re-implementation of Raft's daemon core
 * (reference/raft-daemon): an agent registry, per-agent durable conversations,
 * a normalized event stream, an outcome outbox, and per-agent workspaces, all
 * on one pi-durable Harness over one SQLite storage.
 *
 * "Daemon" here is a lifetime, not a process: `open()` on an existing state
 * dir IS the restart — unfinished work resumes via `harness.resume()`.
 */
import { mkdir, appendFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { AssistantMessage, Provider } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  watchEvents,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type HarnessSettings,
  type Registry,
  type Storage,
  type SubmissionId,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { AgentBindingDoc, AgentsDoc, AgentRegistryError, sortRecords } from "./agents.ts";
import { RaftAgentExtension } from "./extension.ts";
import { MessagingExtension } from "./messaging.ts";
import { parseWhen, RemindersDoc, type Reminder } from "./reminders.ts";
import { MainInboxDoc, RoutingTransport, type AgentMessageFrame } from "./router.ts";
import type { OutboxEnvelope } from "./transport.ts";
import { projectLifecycle, type AgentLifecycleRecord } from "./lifecycle.ts";
import { formatConcreteMessagesRuntimeInput, formatOperatorInput, formatSystemNoticeRuntimeInput } from "./runtimeInput.ts";
import {
  deleteWorkspaceDirectory,
  initializeAgentWorkspace,
  resolveWorkspaceDirectoryPath,
  scanWorkspaceDirectories,
  DELIVERIES_DIR_NAME,
  type AgentWorkspaceSeedFile,
  type WorkspaceDirectoryInfo,
} from "./workspaces.ts";
import { DurableEventNormalizer } from "./events.ts";
import { AgentOutbox, OutboxDoc, OutboxError } from "./outbox.ts";
import { JsonlDeliveryTransport, type OutboxTransport } from "./transport.ts";
import { terminalFailureFromRawText, turnCompletedOutcome } from "./outcome.ts";
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
   * active goes quiet for longer than this, its next postMessage first runs
   * a compaction pass so the resumed turn starts on a lean context. A daemon
   * restart does NOT count as idle — cold start never burns a model call.
   * Default off; `raftd serve` enables it (RAFTD_COMPACT_IDLE_MS, 30m).
   */
  compactOnWakeMs?: number;
  /** Called for non-fatal internal warnings (compaction, routing bounces). */
  onWarn?: (message: string) => void;
}

export interface CreateAgentResult {
  record: AgentRecord;
  conversationId: string;
}

export interface PostMessageOptions {
  whenBusy?: "steer" | "followUp" | "reject";
  /** Idempotent submit key; same requestId never submits twice. */
  requestId?: string;
  /** Raw text bypasses the message envelope formatting. */
  raw?: boolean;
  /** Treat the message as a system notice envelope. */
  systemNotice?: boolean;
}

export interface Answer {
  submissionId: string;
  status: "done" | "unanswered";
  /** Final assistant text when done. */
  text?: string;
  reason?: string;
}

/** One row of the console's chat feed for a conversation. */
export type ChatItem = {
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
  private constructor(
    readonly stateDir: string,
    readonly workspacesDir: string,
    readonly deliveriesDir: string,
    readonly transcriptsDir: string,
    private readonly storage: Storage,
    readonly harness: Harness,
    readonly registry: Registry,
    private readonly transport: OutboxTransport,
    private readonly opts: Required<Pick<DurableDaemonOptions, "defaultModel">> & DurableDaemonOptions,
    /** How many model providers were installed at open (0 = every turn fails no_model). */
    readonly providerCount: number,
  ) {}

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
    await mkdir(workspacesDir, { recursive: true });
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
    registry.install(MessagingExtension);

    const storage = await openNodeSqliteStorage(path.join(stateDir, "session.sqlite"));
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: options.settings,
        env: (target) => {
          const cwd = target.cwd ?? workspacesDir;
          return new NodeExecutionEnv({ cwd });
        },
      },
      BACKGROUND_CONTEXT,
    );

    const transport = options.transport ?? new RoutingTransport(new JsonlDeliveryTransport(deliveriesDir));
    const daemon = new DurableDaemon(
      stateDir,
      workspacesDir,
      deliveriesDir,
      transcriptsDir,
      storage,
      harness,
      registry,
      transport,
      options as Required<Pick<DurableDaemonOptions, "defaultModel">> & DurableDaemonOptions,
      providers.length,
    );
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
    this.harness.resume();
    for (const record of await this.listAgents()) {
      const outbox = this.outboxFor(record.agentId);
      await outbox.requeueInFlight();
      await this.attachPump(record.agentId, record.conversationId);
      await this.reconcileSubmissions(record);
      await this.announceResume(record);
    }
  }

  /**
   * Make the killer feature visible: an agent that had unfinished work when
   * the host died gets a durable system notice — the chat feed shows the
   * restart and the agent itself learns it was interrupted mid-turn.
   */
  private async announceResume(record: AgentRecord): Promise<void> {
    const pending = await this.pendingSubmissions(record);
    if (pending === 0) return;
    await this.postMessage(
      record.agentId,
      `Host restarted — resuming ${pending} unfinished submission(s). You may have been interrupted mid-work; check your workspace for partial output.`,
      { systemNotice: true, requestId: `resume-notice:${record.agentId}:${Date.now()}` },
    ).catch((err) => this.opts.onWarn?.(`resume notice failed for ${record.name}: ${err}`));
  }

  private async pendingSubmissions(record: AgentRecord): Promise<number> {
    let count = 0;
    const conversationId = Number(record.conversationId) as ConversationId;
    for (const status of ["queued", "placed"] as const) {
      const page = await this.storage
        .scanSubmissions({ conversationId, status }, 100, undefined, BACKGROUND_CONTEXT)
        .catch(() => undefined);
      count += page?.items.length ?? 0;
    }
    return count;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pump of this.pumps.values()) {
      await pump.stop().catch(() => {});
    }
    for (const outbox of this.outboxes.values()) {
      outbox.stop();
    }
    await this.harness.close(BACKGROUND_CONTEXT).catch(() => {});
    await this.transport.close?.().catch(() => {});
  }

  // ── agents ───────────────────────────────────────────────────────────────

  async createAgent(config: AgentConfigInput): Promise<CreateAgentResult> {
    this.assertOpen();
    const model = config.model ?? this.opts.defaultModel;
    if (!model) {
      throw new Error("createAgent needs a model (or a daemon defaultModel)");
    }
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    const workspaceName = config.workspace ?? agentId;
    const workspacePath = resolveWorkspaceDirectoryPath(this.workspacesDir, workspaceName);
    if (!workspacePath) {
      throw new AgentRegistryError(`workspace must be a single directory under ${this.workspacesDir}: ${workspaceName}`, "invalid");
    }
    // Cheap pre-check so a taken name doesn't leave an orphan workspace +
    // conversation; the commit below re-checks (covers the race window).
    const existing = await this.harness.snapshot(AgentsDoc, BACKGROUND_CONTEXT);
    if (Object.values(existing?.records ?? {}).some((r) => r.name === config.name)) {
      throw new AgentRegistryError(`agent name already in use: ${config.name}`, "name_taken");
    }
    const seedFiles: AgentWorkspaceSeedFile[] = [
      { relativePath: "notes/.gitkeep", content: "" },
    ];
    let conversation;
    try {
      await initializeAgentWorkspace(workspacePath, config.initialMemoryMd ?? DEFAULT_MEMORY_MD(config.name), seedFiles);
      conversation = await this.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            model,
            instructions: config.instructions ?? null,
            cwd: workspacePath,
            thinkingLevel: config.thinkingLevel ?? null,
          },
          init: async (tx, conversationId) => {
            (await tx.doc(AgentBindingDoc, conversationId)).agentId = agentId;
          },
        },
        BACKGROUND_CONTEXT,
      );
    } catch (err) {
      await deleteWorkspaceDirectory(this.workspacesDir, workspaceName).catch(() => false);
      throw err;
    }

    const now = new Date().toISOString();
    const record: AgentRecord = {
      agentId,
      conversationId: String(conversation.id),
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
    };
    try {
      await this.harness.commit(async (tx) => {
        const doc = await tx.doc(AgentsDoc);
        const nameTaken = Object.values(doc.records).some((r) => r.name === config.name && r.agentId !== agentId);
        if (nameTaken) throw new AgentRegistryError(`agent name already in use: ${config.name}`, "name_taken");
        doc.records[agentId] = record;
      }, BACKGROUND_CONTEXT);
    } catch (err) {
      await deleteWorkspaceDirectory(this.workspacesDir, workspaceName).catch(() => false);
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
      state?.records[agentIdOrName] ??
      Object.values(state?.records ?? {}).find((r) => r.name === agentIdOrName);
    if (!record) throw new AgentRegistryError(`no such agent: ${agentIdOrName}`, "not_found");
    return record;
  }

  async updateAgent(
    agentIdOrName: string,
    change: Partial<Pick<AgentRecord, "name" | "instructions" | "model" | "thinkingLevel">>,
  ): Promise<AgentRecord> {
    const record = await this.getAgent(agentIdOrName);
    const updated: AgentRecord = { ...record, ...change, updatedAt: new Date().toISOString() };
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(AgentsDoc);
      doc.records[record.agentId] = updated;
    }, BACKGROUND_CONTEXT);
    const conversation = await this.requireConversation(record);
    await conversation.configure(
      {
        ...(change.model !== undefined ? { model: change.model } : {}),
        ...(change.instructions !== undefined ? { instructions: change.instructions } : {}),
        ...(change.thinkingLevel !== undefined
          ? { thinkingLevel: change.thinkingLevel as "minimal" | "low" | "medium" | "high" | null }
          : {}),
      },
      BACKGROUND_CONTEXT,
    );
    return updated;
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
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(AgentsDoc);
      const rec = doc.records[record.agentId];
      if (rec) {
        rec.override = null;
        rec.terminalFailure = null;
        rec.updatedAt = new Date().toISOString();
      }
    }, BACKGROUND_CONTEXT);
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
      await tx.retireDoc(OutboxDoc, record.agentId);
    }, BACKGROUND_CONTEXT);
    // Agent evidence lives on disk too — remove the transcript + delivery
    // ledger so a deleted agent doesn't leave unbounded files behind.
    await rm(this.transcriptPath(record.agentId), { force: true }).catch(() => {});
    await rm(path.join(this.deliveriesDir, `${record.agentId}.jsonl`), { force: true }).catch(() => {});
    if (opts.deleteWorkspace) {
      await deleteWorkspaceDirectory(this.workspacesDir, path.basename(record.workspacePath));
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
      throw new AgentRegistryError(`agent ${record.agentId} is stopped`, "not_found");
    }
    const conversation = await this.requireConversation(record);
    await this.resumeAgent(record);
    if (this.opts.compactOnWakeMs) {
      const last = this.lastActivity.get(record.agentId);
      if (last !== undefined && Date.now() - last > this.opts.compactOnWakeMs) {
        await this.compact(record.agentId, "Recycled cold context: the agent was idle; keep only what matters for continuing this work.")
          .catch((err) => this.opts.onWarn?.(`wake-compact failed for ${record.name}: ${err}`));
      }
    }
    this.lastActivity.set(record.agentId, Date.now());
    let content: string;
    if (typeof input === "string") {
      content = options.raw
        ? formatOperatorInput(input)
        : formatConcreteMessagesRuntimeInput([
            {
              message_id: `local-${randomUUID()}`,
              timestamp: new Date().toISOString(),
              sender_name: "operator",
              sender_type: "user",
              target: record.name,
              content: input,
            },
          ]);
    } else {
      const messages: readonly IncomingMessage[] = Array.isArray(input) ? input : [input];
      const first = messages[0];
      if (!first) throw new Error("postMessage needs at least one message");
      content =
        options.systemNotice === true && messages.length === 1
          ? formatSystemNoticeRuntimeInput(first)
          : formatConcreteMessagesRuntimeInput(messages);
    }
    const submission = await conversation.submit(
      { type: "input", content, whenBusy: options.whenBusy, requestId: options.requestId },
      BACKGROUND_CONTEXT,
    );
    return { submissionId: String(submission.id) };
  }

  /** Wait for one submission's settlement and read back the answer text. */
  async waitForAnswer(submissionId: string): Promise<Answer> {
    const submission = await this.harness.submission(Number(submissionId) as SubmissionId, BACKGROUND_CONTEXT);
    if (!submission) throw new Error(`unknown submission: ${submissionId}`);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    return this.readAnswer(settled);
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
    const bounce = async (why: string) => {
      await this.postMessage(
        frame.agentId,
        `Delivery failed: ${why}. Your message was not delivered.`,
        { systemNotice: true, requestId: `route-bounce:${frame.agentId}:${envelope.clientSeq}` },
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
        content: frame.content,
      },
      { requestId: `route:${frame.agentId}:${envelope.clientSeq}` },
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
    const { dueAt, everyMs } = parseWhen(spec);
    const reminder: Reminder = {
      id: `rem-${randomUUID().slice(0, 8)}`,
      agentId: record.agentId,
      text,
      dueAt,
      everyMs,
      createdAt: new Date().toISOString(),
    };
    await this.harness.commit(async (tx) => {
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
    const items: ChatItem[] = [];
    let cursor;
    for (;;) {
      const page = await this.storage.scanEntries({ conversationId }, 500, cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) {
        for (const m of entry.model ?? []) {
          if (m.role === "user") {
            const raw = messageText(m.content);
            // Strip the [target=…] envelope so the console shows what was meant;
            // indented continuation lines belong to the body, trailers don't.
            const env = raw.match(/\[target=[^\]]*\] @([\w.-]+): ([^\n]*)\n?((?: {2}[^\n]*\n?)*)/);
            const text = env ? env[2] + (env[3] ? "\n" + env[3].split("\n").map((l) => l.replace(/^ {2}/, "")).join("\n").trimEnd() : "") : raw;
            items.push({ role: "user", text, ...(env ? { from: env[1] } : {}) });
          } else if (m.role === "assistant") {
            const text = m.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
            const thinking = m.content.filter((c) => c.type === "thinking").map((c) => (c as { thinking: string }).thinking).join("\n");
            const toolCalls = m.content
              .filter((c) => c.type === "toolCall")
              .map((c) => {
                const t = c as { id: string; name: string; arguments: unknown };
                return { id: t.id, name: t.name, args: JSON.stringify(t.arguments).slice(0, 300) };
              });
            items.push({ role: "agent", text, ...(thinking ? { thinking } : {}), ...(toolCalls.length ? { toolCalls } : {}) });
          } else if (m.role === "toolResult") {
            const t = m as { toolName: string; content: unknown; isError: boolean };
            items.push({ role: "tool", name: t.toolName, text: messageText(t.content).slice(0, 500), isError: t.isError });
          }
        }
      }
      if (page.next === undefined) break;
      cursor = page.next;
    }
    // scanEntries returns newest-first; the console wants chat order.
    return items.reverse().slice(-limit);
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
    return projectLifecycle(record, view);
  }

  async outboxState(agentIdOrName: string): Promise<Readonly<OutboxDocState> | undefined> {
    const record = await this.getAgent(agentIdOrName);
    return this.outboxFor(record.agentId).state();
  }

  async usage() {
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

  /** Lazily start scheduling + this agent's pump/outbox without a full resume(). */
  private async resumeAgent(record: AgentRecord): Promise<void> {
    this.harness.resume();
    await this.outboxFor(record.agentId).requeueInFlight();
    await this.attachPump(record.agentId, record.conversationId);
    await this.reconcileSubmissions(record);
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
      return { ...base, reason: settled.status === "unanswered" ? settled.reason : undefined };
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

      const emit = async (events: ParsedEvent[]) => {
      for (const event of events) {
        try {
          this.opts.onEvent?.(agentId, event);
        } catch (err) {
          // A throwing listener must not kill the CommittedWatch — the pump
          // would freeze silently and outcomes would stop being produced.
          this.opts.onWarn?.(`onEvent listener threw for ${agentId}: ${err}`);
        }
        await appendFile(transcript, JSON.stringify(event) + "\n", "utf8").catch(() => {});
        if (event.kind === "submission_settled") {
          // produceOutcome commits on the Session line; schedule it outside the
          // watch listener so the listener never re-enters it. Counters are
          // snapshotted now, before a run_end in the same batch resets them.
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
   * Dedupe rides on OutboxDoc.producedSubmissionIds so a reopen cannot
   * re-produce a frame a crashed watcher already wrote.
   */
  private async produceOutcome(
    agentId: string,
    settled: Extract<ParsedEvent, { kind: "submission_settled" }>,
    run?: { counters: { textEvents: number; toolCalls: number; runtimeErrors: number }; sticky: boolean; firstError: string | null },
  ): Promise<void> {
    let outcome;
    if (settled.status === "done") {
      const counters = run?.counters ?? { textEvents: 0, toolCalls: 0, runtimeErrors: 0 };
      const sticky = run?.sticky ?? false;
      outcome = turnCompletedOutcome(counters, sticky);
      if (!outcome) {
        // Never fabricate a clean turn when evidence says otherwise (sticky
        // terminal failure / runtime errors) — emit honest terminal_failure;
        // a done submission with zero observed output reports real 0/0
        // counters rather than an invented textEvents:1.
        if (sticky || counters.runtimeErrors > 0) {
          const evidence = terminalFailureFromRawText(
            "sticky_runtime_error",
            run?.firstError ?? "turn ended with runtime errors",
          );
          outcome = {
            kind: "terminal_failure" as const,
            failureKind: evidence.failureKind,
            fingerprint: evidence.fingerprint,
            errorClass: evidence.errorClass,
            errorReason: evidence.errorReason,
            errorAction: evidence.errorAction,
            detail: evidence.detail,
          };
        } else {
          outcome = { kind: "turn_completed" as const, textEvents: counters.textEvents, toolCalls: counters.toolCalls };
        }
      }
    } else {
      const raw = run?.firstError ?? settled.reason ?? "submission unanswered";
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

    const outbox = this.outboxFor(agentId);
    const appended = await outbox.append(
      {
        type: "agent:runtime:outcome",
        agentId,
        submissionId: settled.submissionId,
        outcome,
      },
      settled.submissionId,
    );
    if ("duplicate" in appended) return;
    this.opts.onFrame?.(agentId, appended.clientSeq);

    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(AgentsDoc);
      const record = doc.records[agentId];
      if (!record) return;
      record.lastOutcome = {
        kind: outcome.kind,
        status: settled.status,
        submissionId: settled.submissionId,
        reason: settled.status === "unanswered" ? (settled.reason ?? "unanswered") : null,
        errorClass: outcome.kind === "terminal_failure" ? outcome.errorClass : null,
        at: new Date().toISOString(),
      };
      if (settled.status === "done") record.runs++;
      else record.failures++;
      record.updatedAt = new Date().toISOString();
      if (outcome.kind === "terminal_failure" && outcome.errorAction !== null && outcome.errorAction !== "none") {
        record.terminalFailure = {
          failureKind: outcome.failureKind,
          fingerprint: outcome.fingerprint,
          detail: outcome.detail ?? settled.reason ?? "terminal failure",
          at: new Date().toISOString(),
        };
      }
    }, BACKGROUND_CONTEXT);
  }

  /**
   * Sweep settled submissions that settled while no pump watched (e.g. daemon
   * was closed between place and settle) — produce any missing outcome frame.
   */
  private async reconcileSubmissions(record: AgentRecord): Promise<void> {
    let cursor;
    for (;;) {
      const page = await this.storage.scanSubmissions(
        { conversationId: Number(record.conversationId) as ConversationId, status: "done" },
        100,
        cursor,
        BACKGROUND_CONTEXT,
      );
      for (const rec of page.items) {
        await this.produceOutcome(record.agentId, {
          kind: "submission_settled",
          submissionId: String(rec.id),
          status: "done",
        });
      }
      if (page.next === undefined) break;
      cursor = page.next;
    }
    cursor = undefined;
    for (;;) {
      const page = await this.storage.scanSubmissions(
        { conversationId: Number(record.conversationId) as ConversationId, status: "unanswered" },
        100,
        cursor,
        BACKGROUND_CONTEXT,
      );
      for (const rec of page.items) {
        await this.produceOutcome(record.agentId, {
          kind: "submission_settled",
          submissionId: String(rec.id),
          status: "unanswered",
          reason: rec.status === "unanswered" ? rec.reason : undefined,
        });
      }
      if (page.next === undefined) break;
      cursor = page.next;
    }
  }
}

function failureKindFor(reason: string | undefined): TerminalFailureKind {
  const text = reason ?? "";
  if (/input.*too.*large|context.*too.*long|InputTooLargeError/i.test(text)) return "compaction_input_too_large";
  if (/compaction/i.test(text)) return "compaction_failed";
  return "sticky_runtime_error";
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

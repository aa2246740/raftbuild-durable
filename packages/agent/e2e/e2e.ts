/**
 * End-to-end verification of the pi-durable port, against the real GLM model.
 *
 * Phases:
 *   A  create agent → postMessage → real model answer → normalized transcript
 *      + outbox frame delivered (deliveries JSONL) + workspace files.
 *   B  tool use end-to-end: bash tool writes a file inside the agent workspace.
 *   C  crash: a worker process submits a long-running turn, gets SIGKILLed
 *      mid-tool-call; a fresh daemon resumes, the run completes, and the
 *      outcome frame is delivered exactly once (no duplicate clientSeq).
 *   D  busy inbox: postMessage with whenBusy:"steer" joins the running turn.
 *   E  outbox invariants (fast scripted transports): write-ahead ordering,
 *      retransmission with the same clientSeq, exact-ack deletion, cap-drop
 *      of the oldest turn_completed, fail-closed → unreliable → human resolve.
 *   F  workspace containment (resolveWorkspaceDirectoryPath rules).
 *   G  runtime-input formatting (envelope + anti-forgery + reply hint).
 *   L  hardening regressions: live reminders fire, stopped-target permanent
 *      errors, corrupt-transcript tolerance, lock races, stale-port refusal.
 *
 * Run: pnpm e2e          (needs a real model key: zhipu or ZAI_CODING_CN_API_KEY)
 * Report: e2e/report.md
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  DurableDaemon,
  MachineLock,
  MachineLockError,
  JsonlDeliveryTransport,
  OutboxDoc,
  OutboxError,
  ReminderService,
  AgentRegistryError,
  parseWhen,
  ScriptedTransport,
  FlakyTransport,
  resolveWorkspaceDirectoryPath,
  formatIncomingMessage,
  formatConcreteMessagesRuntimeInput,
  RESPONSE_TARGET_HINT,
  type OutboxEnvelope,
  type OutboxFrame,
} from "../src/index.ts";

const MODEL = { provider: "zai-coding-cn", modelId: "glm-5.3-flash" };
const PKG_DIR = path.resolve(import.meta.dirname, "..");
const STATE_DIR = await mkdtemp(path.join(tmpdir(), "raftd-e2e-"));
const REPORT = path.join(PKG_DIR, "e2e", "report.md");

type Check = { phase: string; name: string; ok: boolean; detail: string };
const checks: Check[] = [];

// No model key → the run used to die 13 checks in and leave the PREVIOUS
// green report.md standing. Stamp the report immediately, then bail.
if (!(process.env.zhipu ?? process.env.ZAI_CODING_CN_API_KEY)) {
  await mkdir(path.dirname(REPORT), { recursive: true });
  await writeFile(REPORT, "# E2E report — raftbuild-durable\n\n**ABORTED**: no model API key (set zhipu or ZAI_CODING_CN_API_KEY).\n");
  console.error("e2e needs a real model key (zhipu / ZAI_CODING_CN_API_KEY) — refusing to leave a stale report");
  process.exit(1);
}
// The report is always this run's, not a stale leftover.
await writeFile(REPORT, "# E2E report — raftbuild-durable\n\n(running…)\n");
let currentPhase = "";
function phase(name: string) {
  currentPhase = name;
  console.log(`\n══ ${name} ══`);
}
function check(name: string, ok: boolean, detail = ""): boolean {
  checks.push({ phase: currentPhase, name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reserve a genuinely free port — a hardcoded port collides with orphans
 * left by a previous crashed e2e run (verified: EADDRINUSE → silent dead srv). */
async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.once("error", reject);
  });
}

/** Wait for a child to exit without hanging when it already did. */
async function waitExit(p: ReturnType<typeof spawn>, graceMs = 8_000): Promise<void> {
  if (p.exitCode !== null || p.signalCode !== null) return;
  await Promise.race([new Promise((r) => p.once("exit", r)), sleep(graceMs)]);
}

async function waitFor(desc: string, fn: () => Promise<boolean> | boolean, timeoutMs = 120_000, interval = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) {
      console.log(`  … timeout waiting: ${desc}`);
      return false;
    }
    await sleep(interval);
  }
}

async function readDeliveries(stateDir: string, agentId: string): Promise<OutboxEnvelope[]> {
  const file = path.join(stateDir, ".deliveries", `${agentId}.jsonl`);
  if (!existsSync(file)) return [];
  const raw = await readFile(file, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as OutboxEnvelope);
}

function transcriptFile(stateDir: string, agentId: string): string {
  return path.join(stateDir, "transcripts", `${agentId}.events.jsonl`);
}

async function transcriptCount(stateDir: string, agentId: string, needle: string): Promise<number> {
  try {
    return (await readFile(transcriptFile(stateDir, agentId), "utf8"))
      .split("\n")
      .filter((l) => l.includes(needle)).length;
  } catch {
    return 0;
  }
}

async function transcriptHas(stateDir: string, agentId: string, needle: string): Promise<boolean> {
  const file = transcriptFile(stateDir, agentId);
  if (!existsSync(file)) return false;
  return (await readFile(file, "utf8")).includes(needle);
}

// ── A: basic real-model round trip ──────────────────────────────────────────

async function phaseA(stateDir: string) {
  phase("A — create agent, real GLM round trip");
  const daemon = await DurableDaemon.open({ stateDir, providers: "env", defaultModel: MODEL });
  try {
    const { record } = await daemon.createAgent({
      name: "alpha",
      model: MODEL,
      instructions: "You are a verification agent. Follow instructions literally and concisely.",
    });
    check("agent created", record.agentId.startsWith("agent-"), record.agentId);
    check(
      "workspace seeded (MEMORY.md + notes/)",
      existsSync(path.join(record.workspacePath, "MEMORY.md")) && existsSync(path.join(record.workspacePath, "notes")),
      record.workspacePath,
    );

    const { submissionId } = await daemon.postMessage(record.agentId, 'Reply with exactly the single word "PONG".', {
      raw: true,
    });
    const answer = await daemon.waitForAnswer(submissionId);
    check("answer status done", answer.status === "done", `status=${answer.status}`);
    check("answer contains PONG", (answer.text ?? "").toUpperCase().includes("PONG"), (answer.text ?? "").slice(0, 120));

    const delivered = await waitFor(
      "outbox delivery for A",
      async () => (await readDeliveries(stateDir, record.agentId)).some((e) => e.frame.type === "agent:runtime:outcome"),
      60_000,
    );
    check("runtime:outcome frame delivered", delivered);
    const env = (await readDeliveries(stateDir, record.agentId)).find((e) => e.frame.type === "agent:runtime:outcome");
    check(
      "outcome is turn_completed",
      env !== undefined && env.frame.type === "agent:runtime:outcome" && env.frame.outcome.kind === "turn_completed",
      env ? JSON.stringify(env.frame) : "none",
    );
    check(
      "start frame delivered first (clientSeq 1)",
      (await readDeliveries(stateDir, record.agentId))[0]?.clientSeq === 1,
    );
    check(
      "transcript has model events",
      await transcriptHas(stateDir, record.agentId, '"kind":"text"'),
    );
    check(
      "transcript has submission_settled",
      await transcriptHas(stateDir, record.agentId, '"kind":"submission_settled"'),
    );
    const life = await daemon.lifecycle(record.agentId);
    check("lifecycle idle", life.kind === "idle", life.kind);
    return { record };
  } finally {
    await daemon.close();
  }
}

// ── B: tool use writes into the workspace ───────────────────────────────────

async function phaseB(stateDir: string, agentId: string) {
  phase("B — tool use: bash writes a file in the workspace");
  const daemon = await DurableDaemon.open({ stateDir, providers: "env", defaultModel: MODEL });
  try {
    await daemon.resume();
    const { submissionId } = await daemon.postMessage(
      agentId,
      'You MUST use the bash tool for this. Run: `printf "hello-e2e-%s" "$(date +%s)" > hello.txt`. Then reply with exactly "FILE-DONE".',
      { raw: true },
    );
    const answer = await daemon.waitForAnswer(submissionId);
    check("answer status done", answer.status === "done", `status=${answer.status} reason=${answer.reason ?? "-"}`);

    const workspaceDir = path.join(stateDir, "workspaces", agentId);
    const target = path.join(workspaceDir, "hello.txt");
    check("hello.txt exists in workspace", existsSync(target));
    if (existsSync(target)) {
      const content = (await readFile(target, "utf8")).trim();
      check("hello.txt content is hello-e2e-*", content.startsWith("hello-e2e-"), content);
    }
    check("transcript saw tool_call bash", await transcriptHas(stateDir, agentId, '"kind":"tool_call"'));
    check("transcript saw tool_output", await transcriptHas(stateDir, agentId, '"kind":"tool_output"'));
  } finally {
    await daemon.close();
  }
}

// ── C: kill -9 mid-run, fresh daemon resumes ────────────────────────────────

function runWorker(mode: string, stateDir: string, agentId: string, submissionId?: string) {
  const args = [
    "--experimental-transform-types",
    path.join(PKG_DIR, "e2e", "crash-worker.ts"),
    mode,
    stateDir,
    agentId,
    ...(submissionId ? [submissionId] : []),
  ];
  return spawn("node", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
}

async function phaseC(stateDir: string, agentId: string) {
  phase("C — SIGKILL mid-run → reopen → resume → delivered exactly once");
  const before = await readDeliveries(stateDir, agentId);
  const beforeSeqs = new Set(before.map((e) => e.clientSeq));

  const worker = runWorker("worker", stateDir, agentId);
  let workerOut = "";
  const submissionId = await new Promise<string>((resolve) => {
    worker.stdout.on("data", (d) => {
      workerOut += String(d);
      const m = workerOut.match(/SUBMISSION (\d+)/);
      if (m) resolve(m[1]);
    });
    setTimeout(() => resolve(""), 60_000);
  });
  if (!check("worker placed a submission", submissionId !== "", workerOut.trim())) {
    worker.kill("SIGKILL");
    return;
  }

  // Wait until THIS turn's tool call is visible (count-relative — phase B
  // already produced tool_call lines in the same transcript), then kill -9.
  const toolCallsBefore = await transcriptCount(stateDir, agentId, '"kind":"tool_call"');
  const sawTool = await waitFor("tool call in transcript", async () => (await transcriptCount(stateDir, agentId, '"kind":"tool_call"')) > toolCallsBefore, 60_000, 500);
  if (sawTool) await sleep(1_500);
  worker.kill("SIGKILL");
  const dead = await new Promise<boolean>((res) => worker.once("exit", () => res(true)));
  check("worker killed mid-run", dead && sawTool, sawTool ? "killed during tool call" : "killed before tool call (timeout)");
  await sleep(1_000);

  const recover = runWorker("recover", stateDir, agentId, submissionId);
  let recOut = "";
  recover.stdout.on("data", (d) => (recOut += String(d)));
  recover.stderr.on("data", (d) => (recOut += String(d)));
  const settled = await waitFor(
    "recovered daemon settles the submission",
    () => new RegExp(`SETTLED ${submissionId} status=done`).test(recOut),
    300_000,
    2_000,
  );
  check("submission settled after reopen+resume", settled, recOut.trim().split("\n").pop() ?? "");
  if (!settled) recover.kill("SIGKILL");
  if (recover.exitCode === null && recover.signalCode === null) {
    await Promise.race([new Promise((r) => recover.once("exit", r)), sleep(15_000)]);
  }

  const after = await readDeliveries(stateDir, agentId);
  const frames = after.filter(
    (e) => e.frame.type === "agent:runtime:outcome" && !beforeSeqs.has(e.clientSeq) && e.frame.submissionId === submissionId,
  );
  check("exactly one outcome frame for the crashed submission", frames.length === 1, `frames=${frames.length}`);
  const allSeqs = after.map((e) => e.clientSeq);
  check("no duplicate clientSeq deliveries", new Set(allSeqs).size === allSeqs.length, `seqs=${allSeqs.join(",")}`);
}

// ── D: steer into a running turn ────────────────────────────────────────────

async function phaseD(stateDir: string, agentId: string) {
  phase("D — whenBusy:steer joins the running turn");
  const daemon = await DurableDaemon.open({ stateDir, providers: "env", defaultModel: MODEL });
  try {
    await daemon.resume();
    const { submissionId: s1 } = await daemon.postMessage(
      agentId,
      'Use the bash tool to run `sleep 15`. While it runs you may receive another message containing a secret word. When sleep finishes, reply with exactly: BASE <the secret word> — or just BASE if no secret word arrived.',
      { raw: true },
    );
    // Wait until it is genuinely mid-run, then steer.
    await waitFor("run started", () => transcriptHas(stateDir, agentId, '"kind":"run_start"'), 30_000, 300);
    const { submissionId: s2 } = await daemon.postMessage(agentId, "The secret word is KUMQUAT.", {
      raw: true,
      whenBusy: "steer",
    });
    check("steered submission placed", s2 !== s1);
    const a1 = await daemon.waitForAnswer(s1);
    const a2 = await daemon.waitForAnswer(s2);
    check("original submission answered", a1.status === "done", a1.status);
    check("steered submission answered", a2.status === "done", `${a2.status} ${a2.reason ?? ""}`);
    check(
      "steer visible in answer (secret word reached the model)",
      /KUMQUAT/i.test(a1.text ?? "") || /KUMQUAT/i.test(a2.text ?? ""),
      `a1=${(a1.text ?? "").slice(0, 60)} a2=${(a2.text ?? "").slice(0, 60)}`,
    );
  } finally {
    await daemon.close();
  }
}

// ── E: outbox invariants on scripted transports ─────────────────────────────

async function phaseE(stateDir: string) {
  phase("E — outbox invariants (scripted transports)");
  const dir = path.join(stateDir, "e-outbox");
  await mkdir(dir, { recursive: true });

  // e1: fail twice, succeed third — same clientSeq retransmitted, delivered once.
  {
    const scripted = new ScriptedTransport();
    scripted.plan = ["fail", "fail", "ok"];
    const daemon = await DurableDaemon.open({
      stateDir: path.join(dir, "retry"),
      providers: [],
      transport: scripted,
      retryDelayMs: () => 20,
    });
    const outbox = daemon.outboxFor("agent-e1");
    await outbox.append({ type: "agent:outcome_unreliable", agentId: "agent-e1", reason: "probe", detail: null, since: "t" });
    const delivered = await waitFor("committed send", () => scripted.sent.length >= 1, 10_000, 20);
    check("exactly one committed delivery after 2 failures", delivered && scripted.sent.length === 1, `sent=${scripted.sent.length}`);
    check(
      "retransmitted with the same clientSeq until 3rd attempt",
      delivered && scripted.sent[0].attempt === 3,
      `attempt=${scripted.sent[0]?.attempt}`,
    );
    check("exact-ack deletion", (await outbox.state())!.entries.length === 0);
    outbox.stop();
    await daemon.close();
  }

  // e2: cap drop — oldest non-in-flight turn_completed is dropped.
  {
    const dir2 = path.join(dir, "cap");
    const daemon = await DurableDaemon.open({ stateDir: dir2, providers: [], transport: new FlakyTransport(new ScriptedTransport(), 1e9), retryDelayMs: () => 10_000 });
    const outbox = daemon.outboxFor("agent-e2");
    const failureFrame: OutboxFrame = {
      type: "agent:runtime:outcome",
      agentId: "agent-e2",
      submissionId: "s-x",
      outcome: {
        kind: "terminal_failure",
        failureKind: "sticky_runtime_error",
        fingerprint: "aa",
        errorClass: "RuntimeError",
        errorReason: null,
        errorAction: null,
        detail: null,
      },
    };
    const turnFrame: OutboxFrame = {
      type: "agent:runtime:outcome",
      agentId: "agent-e2",
      submissionId: "s-t",
      outcome: { kind: "turn_completed", textEvents: 1, toolCalls: 0 },
    };
    // Fill the doc directly: 127 terminal failures + 1 turn_completed = 128 (cap).
    await daemon.harness.commit(async (tx) => {
      const doc = await tx.doc(OutboxDoc, "agent-e2", "agent-e2");
      doc.nextClientSeq = 129;
      for (let i = 0; i < 127; i++) {
        doc.entries.push({ clientSeq: i + 1, frame: failureFrame, enqueuedAt: "t", inFlight: false, attempts: 0, lastAttemptAt: null });
      }
      doc.entries.push({ clientSeq: 128, frame: turnFrame, enqueuedAt: "t", inFlight: false, attempts: 0, lastAttemptAt: null });
    }, BACKGROUND_CONTEXT);
    const appended = await outbox.append({ ...turnFrame, submissionId: "s-t2" });
    check(
      "cap drop prefers oldest non-in-flight turn_completed",
      !("duplicate" in appended) && appended.result === "dropped_turn_completed",
      JSON.stringify(appended),
    );
    const st = (await outbox.state())!;
    check("entries still at cap", st.entries.length === 128, `entries=${st.entries.length}`);
    check("dropped seq was 128", !st.entries.some((e) => e.clientSeq === 128));
    outbox.stop();

    // e3: fail-closed — nothing droppable → unreliable → resolve.
    await daemon.harness.commit(async (tx) => {
      const doc = await tx.doc(OutboxDoc, "agent-e2", "agent-e2");
      for (const e of doc.entries) e.frame = failureFrame; // make all non-droppable
    }, BACKGROUND_CONTEXT);
    let threw = false;
    try {
      await outbox.append({ ...turnFrame, submissionId: "s-t3" });
    } catch (err) {
      threw = err instanceof OutboxError && err.code === "overflow";
    }
    check("fail-closed append throws overflow", threw);
    check("agent marked unreliable durably", (await outbox.state())!.unreliable !== null);
    let appThrows = false;
    try {
      await outbox.append({ ...turnFrame, submissionId: "s-t4" });
    } catch {
      appThrows = true;
    }
    check("appends refused while unreliable", appThrows);
    await outbox.resolve("human verified the overflow");
    check("resolve clears marker + records resolution", (await outbox.state())!.unreliable === null && (await outbox.state())!.resolution !== null);
    // Resolve ≠ purge: the operator's follow-up is to compact the backlog
    // (here: consumer delivered+acked everything), then appends flow again.
    await daemon.harness.commit(async (tx) => {
      const doc = await tx.doc(OutboxDoc, "agent-e2", "agent-e2");
      doc.entries = [];
    }, BACKGROUND_CONTEXT);
    const re = await outbox.append({ ...turnFrame, submissionId: "s-t5" });
    check("append works again after resolve + backlog compacted", !("duplicate" in re));
    outbox.stop();
    await daemon.close();
  }
}

// ── F/G: containment + formatting units ─────────────────────────────────────

async function phaseFG(stateDir: string) {
  phase("F — workspace containment");
  const root = path.join(stateDir, "workspaces");
  check("direct child resolves", resolveWorkspaceDirectoryPath(root, "kid") === path.join(root, "kid"));
  check("nested path rejected", resolveWorkspaceDirectoryPath(root, "a/b") === null);
  check("traversal rejected", resolveWorkspaceDirectoryPath(root, "../x") === null);
  check("absolute rejected", resolveWorkspaceDirectoryPath(root, "/etc") === null);
  check("dot rejected", resolveWorkspaceDirectoryPath(root, ".") === null);

  phase("G — runtime input formatting");
  const msg = formatIncomingMessage({
    message_id: "thread-abcdef1234",
    timestamp: "2026-10-07T12:00:00Z",
    sender_name: "wu",
    sender_type: "user",
    target: "main",
    content: "first line\nsecond line",
  });
  check("envelope has target/msg/time/type", /\[target=main msg=abcdef12 time=2026-10-07T12:00:00Z type=user\]/.test(msg), msg.split("\n").pop() ?? "");
  check("sender handle", msg.includes("@wu: "), msg.slice(0, 80));
  check("continuation lines indented (anti-forgery)", msg.includes("first line\n  second line"));
  const wrapped = formatConcreteMessagesRuntimeInput([
    {
      message_id: "m1",
      timestamp: "2026-10-07T12:00:00Z",
      sender_name: "wu",
      sender_type: "user",
      target: "main",
      content: "hi",
    },
  ]);
  check("envelope + reply hint present", wrapped.startsWith("New message received:") && wrapped.includes(RESPONSE_TARGET_HINT));
}

// ── H: agent↔agent routing + operator inbox + bounce ────────────────────────

async function phaseH(stateDir: string, alphaId: string) {
  phase("H — send_message routing (agent→agent, agent→main, bounce)");
  const daemon = await DurableDaemon.open({ stateDir, providers: "env", defaultModel: MODEL });
  try {
    await daemon.resume();
    const { record: beta } = await daemon.createAgent({
      name: "beta",
      model: MODEL,
      instructions: "You are a verification agent. Follow instructions literally and concisely.",
    });

    // Submissions carry the router's requestId — the durable proof of admission.
    const submissionWithRequestId = async (agentId: string, prefix: string) =>
      (await daemon.submissions(agentId)).find((s) => s.requestId?.startsWith(prefix));

    // 1) alpha → beta, end to end through the real model.
    await daemon.postMessage(
      alphaId,
      'Use the send_message tool exactly once with target "beta" and text "HELLO-FROM-ALPHA". Then reply DONE.',
      { raw: true },
    );
    const routed = await waitFor(
      "routed submission on beta",
      async () => (await submissionWithRequestId(beta.agentId, `route:${alphaId}:`)) !== undefined,
      180_000,
      2_000,
    );
    check("alpha→beta message routed (durable submission on beta)", routed);
    const settled = routed
      ? await waitFor(
          "routed submission settled",
          async () => (await submissionWithRequestId(beta.agentId, `route:${alphaId}:`))?.status === "done",
          180_000,
          2_000,
        )
      : false;
    check("routed submission settled", settled);

    // 2) beta → main (operator inbox).
    await daemon.postMessage(
      beta.agentId,
      'Use the send_message tool exactly once with target "main" and text "B-REPORT-OK". Then reply DONE.',
      { raw: true },
    );
    const gotMain = await waitFor(
      "mainInbox entry",
      async () => (await daemon.mainInbox()).some((m) => m.text.includes("B-REPORT-OK")),
      180_000,
      2_000,
    );
    check("beta→main landed in operator inbox", gotMain);
    const entry = (await daemon.mainInbox()).find((m) => m.text.includes("B-REPORT-OK"));
    check("inbox entry names the sender", entry?.fromName === "beta", entry?.fromName ?? "-");

    // 3) unknown target bounces back to the sender.
    await daemon.postMessage(
      alphaId,
      'Use the send_message tool exactly once with target "ghost-agent" and text "VOID". Then reply DONE.',
      { raw: true },
    );
    const bounced = await waitFor(
      "bounce submission on alpha",
      async () => (await submissionWithRequestId(alphaId, `route-bounce:${alphaId}:`)) !== undefined,
      180_000,
      2_000,
    );
    check("bounce notice returned to sender", bounced);
    return { betaId: beta.agentId };
  } finally {
    await daemon.close();
  }
}

// ── I: durable reminders ────────────────────────────────────────────────────

async function phaseI(stateDir: string, agentId: string) {
  phase("I — durable reminder fires as a system notice");
  const daemon = await DurableDaemon.open({ stateDir, providers: "env", defaultModel: MODEL });
  const svc = new ReminderService(daemon);
  try {
    await daemon.resume();
    const r = await daemon.remind(agentId, "in 5s", "check-in CHIME-42");
    check("reminder committed durably", (await daemon.listReminders()).some((t) => t.id === r.id), r.id);
    await svc.start();
    check(
      "reminder fired into the conversation",
      // The feed carries the submitted input text; the transcript does NOT
      // echo inputs — checking it relied on the model parroting the marker.
      await waitFor(
        "feed saw CHIME-42",
        async () => (await daemon.chatFeed(agentId)).some((i) => (i.text ?? "").includes("CHIME-42")),
        60_000,
        500,
      ),
    );
    check("one-shot removed after firing", !(await daemon.listReminders()).some((t) => t.id === r.id));
  } finally {
    svc.stop();
    await daemon.close();
  }
}

// ── J: machine lock + serve HTTP + thin-CLI ─────────────────────────────────

function runCli(stateDir: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("node", ["--experimental-transform-types", path.join(PKG_DIR, "src", "cli.ts"), ...args], {
      env: { ...process.env, RAFTD_STATE: stateDir, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.stderr.on("data", (d) => (out += String(d)));
    p.once("exit", (code) => resolve({ code, out }));
  });
}

async function phaseJ(stateDir: string, alphaId: string) {
  phase("J — machineLock, raftd serve, console, thin-CLI remote");
  // 1) Lock semantics in-process.
  const lock = await MachineLock.acquire(stateDir);
  check("first lock acquires", existsSync(path.join(stateDir, "raftd.lock")));
  let secondThrew = false;
  try {
    await MachineLock.acquire(stateDir);
  } catch (err) {
    secondThrew = err instanceof MachineLockError;
  }
  check("second acquire refused while live", secondThrew);

  // 2) A second `serve` process refuses to start while the lock is held.
  const dup = await runCli(stateDir, ["serve", "--port", "4899"]);
  check(
    "double serve refused (exit!=0, lock error)",
    dup.code !== 0 && /already locked|already running|MachineLock/i.test(dup.out),
    dup.out.trim().split("\n").pop()?.slice(0, 140) ?? "",
  );

  // 3) Real serve: lock + HTTP + console + thin-CLI + API round trip.
  await lock.release();
  const serve = spawn("node", ["--experimental-transform-types", path.join(PKG_DIR, "src", "cli.ts"), "serve", "--port", "4888"], {
    env: { ...process.env, RAFTD_STATE: stateDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serveOut = "";
  serve.stdout.on("data", (d) => (serveOut += String(d)));
  serve.stderr.on("data", (d) => (serveOut += String(d)));
  try {
    const up = await waitFor("console responds", async () => {
      try {
        return (await fetch("http://127.0.0.1:4888/api/state")).ok;
      } catch {
        return false;
      }
    }, 30_000, 500);
    if (!check("serve came up", up, serveOut.trim().slice(0, 200))) return;

    const st = (await (await fetch("http://127.0.0.1:4888/api/state")).json()) as { agents: { agentId: string }[] };
    check("/api/state lists the agents", st.agents.some((a) => a.agentId === alphaId), `${st.agents.length} agents`);

    const html = await (await fetch("http://127.0.0.1:4888/")).text();
    check("console HTML served", html.includes("raftd") && html.includes("<script") && html.includes("New agent"));

    // Thin-CLI over the port file.
    const remote = await runCli(stateDir, ["list"]);
    check("`raftd list` spoke to the live serve", remote.code === 0 && remote.out.includes("alpha"), remote.out.trim().slice(0, 160));

    // Full API round trip on a fresh agent.
    const gamma: { agentId: string } = await (
      await fetch("http://127.0.0.1:4888/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "gamma" }),
      })
    ).json();
    check("agent created over HTTP", !!gamma.agentId, gamma.agentId);
    const sub: { submissionId: string } = await (
      await fetch(`http://127.0.0.1:4888/api/agents/${gamma.agentId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: 'Reply with exactly the single word "READY".' }),
      })
    ).json();
    const answer = (await (await fetch(`http://127.0.0.1:4888/api/agents/${gamma.agentId}/answer?submissionId=${sub.submissionId}`)).json()) as {
      status: string;
      text?: string;
    };
    check("HTTP round trip answered", answer.status === "done" && /READY/i.test(answer.text ?? ""), (answer.text ?? answer.status).slice(0, 80));

    // API semantics: 409 on name collision, 400 on garbage.
    const dup = await fetch("http://127.0.0.1:4888/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "gamma" }),
    });
    check("duplicate name → 409", dup.status === 409, `status=${dup.status}`);
    const bad = await fetch("http://127.0.0.1:4888/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    check("malformed JSON → 400", bad.status === 400, `status=${bad.status}`);
    const badBusy = await fetch(`http://127.0.0.1:4888/api/agents/${gamma.agentId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", whenBusy: "bogus" }),
    });
    check("garbage whenBusy → 400", badBusy.status === 400, `status=${badBusy.status}`);
    const gone = await fetch(`http://127.0.0.1:4888/api/agents/no-such-agent/lifecycle`);
    check("unknown agent → 404", gone.status === 404, `status=${gone.status}`);
  } finally {
    serve.kill("SIGTERM");
    await Promise.race([new Promise((r) => serve.once("exit", r)), sleep(15_000)]);
  }
  check("serve released the lock on exit", !existsSync(path.join(stateDir, "raftd.lock")));
  check("port file cleaned up", !existsSync(path.join(stateDir, "raftd.port")));
}

// ── K: cold-wake recycle (RFC 070) ──────────────────────────────────────────

async function phaseK(stateDir: string) {
  phase("K — cold-wake recycle compacts after idle silence");
  const daemon = await DurableDaemon.open({
    stateDir,
    providers: "env",
    defaultModel: MODEL,
    compactOnWakeMs: 1_500,
  });
  try {
    const { record } = await daemon.createAgent({
      name: "kappa",
      model: MODEL,
      instructions: "Reply with one short word each time.",
    });
    let compactCalls = 0;
    const orig = daemon.compact.bind(daemon);
    (daemon as unknown as { compact: typeof orig }).compact = async (...a: Parameters<typeof orig>) => {
      compactCalls++;
      return orig(...a);
    };
    const m1 = await daemon.postMessage(record.agentId, "Say ONE", { raw: true });
    const a1 = await daemon.waitForAnswer(m1.submissionId);
    check("first message answered", a1.status === "done", a1.status);
    check("no compact on first message (no observed idle)", compactCalls === 0, `calls=${compactCalls}`);
    await sleep(2_000); // go quiet past the 1.5s threshold
    const m2 = await daemon.postMessage(record.agentId, "Say TWO", { raw: true });
    check("wake-compact triggered once", compactCalls === 1, `calls=${compactCalls}`);
    const a2 = await daemon.waitForAnswer(m2.submissionId);
    check("message still answered after recycle", a2.status === "done", a2.status);
  } finally {
    await daemon.close();
  }
}

// ── L: hardening regressions (critic-driven fixes) ──────────────────────────

// ── M: issue-#2 regression battery (local, no model calls) ────────────────

async function phaseM(stateDir: string) {
  phase("M — issue-#2 regressions");

  // Lock: 32 concurrent acquires → exactly one winner, all others refused.
  const race = await Promise.allSettled([...Array(32)].map(() => MachineLock.acquire(stateDir)));
  const winners = race.filter((r) => r.status === "fulfilled");
  const losers = race.filter((r) => r.status === "rejected" && r.reason instanceof MachineLockError);
  check("32-way lock race: exactly one holder", winners.length === 1, `won=${winners.length} refused=${losers.length}`);
  await (winners[0] as PromiseFulfilledResult<MachineLock> | undefined)?.value.release();

  // Delivery-ledger dedupe: replayed (agentId, clientSeq) never written twice,
  // even across transport instances (delivery-vs-ack crash window).
  const dedupDir = path.join(stateDir, ".deliveries-dedupe");
  await mkdir(dedupDir, { recursive: true });
  const env = (seq: number): OutboxEnvelope => ({
    agentId: "ledger-x",
    clientSeq: seq,
    attempt: 1,
    frame: { type: "agent:runtime:outcome", agentId: "ledger-x", submissionId: "9" } as OutboxFrame,
  });
  const t1 = new JsonlDeliveryTransport(dedupDir);
  await t1.send(env(2));
  await t1.send(env(2));
  const t2 = new JsonlDeliveryTransport(dedupDir);
  await t2.send(env(2));
  await t2.send(env(3));
  const ledgerRaw = await readFile(path.join(dedupDir, "ledger-x.jsonl"), "utf8");
  const seqs = ledgerRaw.trim().split("\n").map((l) => JSON.parse(l).clientSeq);
  check("ledger dedupes replayed clientSeq", seqs.join(",") === "2,3", `seqs=${seqs.join(",")}`);

  // parseWhen rejects out-of-range `at` (was silently rolling to another day).
  let threw2599 = false;
  try { parseWhen("at 25:99"); } catch { threw2599 = true; }
  check("`at 25:99` rejected", threw2599);
  check("`at 23:59` parses", parseWhen("at 23:59").dueAt.length > 0);

  const daemon = await DurableDaemon.open({ stateDir, providers: "env", defaultModel: MODEL });
  try {
    // "main" is the operator inbox — reserved, not a creatable agent name.
    let mainRefused = false;
    try { await daemon.createAgent({ name: "main", model: MODEL }); } catch (err) { mainRefused = err instanceof AgentRegistryError; }
    check('agent named "main" refused', mainRefused);

    // Submission ownership: a foreign/unknown submission answers 404.
    const { record } = await daemon.createAgent({ name: "mike", model: MODEL });
    const owner = await daemon.submissionOwner("999999");
    check("unknown submission has no owner", owner === undefined, String(owner));
    void record;
  } finally {
    await daemon.close();
  }

  // HTTP validation + thin-CLI parity against a real serve.
  const portA = await freePort();
  const srv = spawn("node", ["--experimental-transform-types", path.join(PKG_DIR, "src", "cli.ts"), "serve", "--state", stateDir, "--port", String(portA)], {
    env: { ...process.env, RAFTD_KEY: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let srvOut = "";
  srv.stdout.on("data", (d) => (srvOut += String(d)));
  srv.stderr.on("data", (d) => (srvOut += String(d)));
  const up = await waitFor("serve up", async () => (await fetch(`http://127.0.0.1:${portA}/api/state`).catch(() => null))?.ok ?? false, 60_000, 500);
  check("test serve up", up, srvOut.trim().slice(-120));
  if (up) {
    const post = (p: string, body: unknown) =>
      fetch(`http://127.0.0.1:${portA}/api/${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    check("POST agents body=null → 400", (await post("agents", null)).status === 400);
    check("POST agents name=123 → 400", (await post("agents", { name: 123 })).status === 400);
    check('POST agents name="   " → 400', (await post("agents", { name: "   " })).status === 400);
    check('POST agents name="main" → 400', (await post("agents", { name: "main" })).status === 400);
    const nu = await post("agents", { name: "nova" });
    check("POST agents valid → 201", nu.status === 201, `status=${nu.status}`);
    const nova = (await nu.json()) as { agentId: string };
    check("POST messages text=object → 400", (await post(`agents/${nova.agentId}/messages`, { text: { x: 1 } })).status === 400);
    check("POST reminders when=at 25:99 → 400", (await post("reminders", { agent: "nova", when: "at 25:99", text: "x" })).status === 400);
    check("GET answer foreign submission → 404", (await fetch(`http://127.0.0.1:${portA}/api/agents/${nova.agentId}/answer?submissionId=424242`)).status === 404);

    // Thin-CLI parity (serve holds the state, CLI is remote).
    const delAll = await runCli(stateDir, ["deliveries"], { RAFTD_KEY: "" });
    check("remote deliveries w/o agent works", delAll.code === 0 && !delAll.out.includes("undefined"), delAll.out.trim().slice(0, 80));
    const badSend = await runCli(stateDir, ["send", "ghost", "hi"], { RAFTD_KEY: "" });
    check(
      "remote HTTP error not disguised as unreachable",
      badSend.code !== 0 && badSend.out.includes("remote") && !badSend.out.includes("Refusing"),
      badSend.out.trim().slice(0, 120),
    );
    const mk = await runCli(stateDir, ["create", "remws", "--workspace", "wk-remote", "--thinking", "low"], { RAFTD_KEY: "" });
    const sh = mk.code === 0 ? await runCli(stateDir, ["show", "remws"], { RAFTD_KEY: "" }) : { code: 1, out: mk.out };
    check(
      "remote create forwards --workspace/--thinking",
      sh.code === 0 && sh.out.includes("wk-remote") && sh.out.includes('"thinkingLevel": "low"'),
      sh.out.trim().replace(/\s+/g, " ").slice(0, 140),
    );

    srv.kill("SIGKILL");
    await waitExit(srv);

    // Bearer: keyed serve + thin CLI must authenticate.
    const portB = await freePort();
    const srv2 = spawn("node", ["--experimental-transform-types", path.join(PKG_DIR, "src", "cli.ts"), "serve", "--state", stateDir, "--port", String(portB)], {
      env: { ...process.env, RAFTD_KEY: "k3y" }, stdio: ["ignore", "pipe", "pipe"],
    });
    const up2 = await waitFor("keyed serve up", async () => (await fetch(`http://127.0.0.1:${portB}/api/state`, { headers: { authorization: "Bearer k3y" } }).catch(() => null))?.ok ?? false, 60_000, 500);
    check("keyed serve up", up2);
    if (up2) {
      const noKey = await runCli(stateDir, ["list"], { RAFTD_KEY: "" });
      check("thin CLI without RAFTD_KEY → 401 surfaced", noKey.code !== 0 && /401|unauthorized|remote/i.test(noKey.out), noKey.out.trim().slice(0, 100));
      const withKey = await runCli(stateDir, ["list"], { RAFTD_KEY: "k3y" });
      check("thin CLI with RAFTD_KEY works", withKey.code === 0, withKey.out.trim().slice(0, 100));
    }
    srv2.kill("SIGKILL");
    await waitExit(srv2);
    await rm(path.join(stateDir, "raftd.port"), { force: true });
  } else {
    srv.kill("SIGKILL");
  }

  // Non-loopback without RAFTD_KEY refuses to start.
  const refusedSrv = spawn("node", ["--experimental-transform-types", path.join(PKG_DIR, "src", "cli.ts"), "serve", "--state", stateDir, "--host", "0.0.0.0", "--port", String(await freePort())], {
    env: { ...process.env, RAFTD_KEY: "", RAFTD_INSECURE: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let refOut = "";
  refusedSrv.stdout.on("data", (d) => (refOut += String(d)));
  refusedSrv.stderr.on("data", (d) => (refOut += String(d)));
  const refCode = await Promise.race([
    new Promise<number | null>((r) => refusedSrv.once("exit", (c) => r(c))),
    sleep(20_000).then(() => -1),
  ]);
  if (refCode === -1) refusedSrv.kill("SIGKILL");
  check("--host 0.0.0.0 without RAFTD_KEY refused", refCode !== 0 && refCode !== -1 && /refus/i.test(refOut), `code=${refCode} ${refOut.trim().slice(0, 100)}`);
}

async function phaseL(stateDir: string) {
  phase("L — hardening regressions");

  // Repeating reminders need >= 1s or the submit loop bricks the outbox.
  try {
    parseWhen("every 0s");
    check("`every 0s` rejected", false, "no throw");
  } catch {
    check("`every 0s` rejected", true);
  }

  const daemon = await DurableDaemon.open({ stateDir, providers: "env", defaultModel: MODEL });
  try {
    const { record } = await daemon.createAgent({
      name: "lambda",
      model: MODEL,
      instructions: "Reply with one short word.",
    });

    // Live-created reminder fires without a restart (was BLOCKER #1).
    const service = new ReminderService(daemon);
    await service.start();
    await daemon.remind(record.agentId, "in 1s", "LIVE-FIRE-MARKER");
    const fired = await waitFor(
      "live reminder admitted",
      async () => (await daemon.chatFeed(record.agentId)).some((i) => (i.text ?? "").includes("LIVE-FIRE-MARKER")),
      20_000,
      500,
    );
    check("live-created reminder fires", fired);
    service.stop();

    // Stopped target: postMessage throws a permanent error so routing bounces
    // terminally instead of head-of-line wedging the sender's outbox.
    await daemon.stopAgent(record.agentId);
    let permanent = false;
    try {
      await daemon.postMessage(record.agentId, "hello", { raw: true });
    } catch (err) {
      permanent = err instanceof OutboxError || err instanceof AgentRegistryError;
    }
    check("postMessage to stopped agent is a permanent error", permanent);
    await daemon.startAgent(record.agentId);

    // A torn transcript line must not truncate the event stream.
    const feedBefore = (await daemon.chatFeed(record.agentId)).length;
    await writeFile(transcriptFile(stateDir, record.agentId), "{corrupt!!!\n", { flag: "a" });
    let yielded = 0;
    for await (const _e of daemon.events(record.agentId)) yielded++;
    check("corrupt transcript line tolerated", yielded > 0, `events=${yielded}, feed=${feedBefore}`);

    // Racing lock acquires: exactly one winner.
    const first = await MachineLock.acquire(stateDir).catch(() => null);
    check("first lock acquire succeeds", first !== null);
    const second = await MachineLock.acquire(stateDir).then(
      () => "won",
      (err) => (err instanceof MachineLockError ? "refused" : `unexpected ${err}`),
    );
    check("second live lock acquire refused", second === "refused", String(second));
    await first?.release();
    const third = await MachineLock.acquire(stateDir).catch(() => null);
    check("lock re-acquirable after release", third !== null);
    await third?.release();
  } finally {
    await daemon.close();
  }

  // Stale port file: thin-CLI must refuse instead of opening a second
  // Harness on the same SQLite (verified poison trigger).
  await writeFile(path.join(stateDir, "raftd.port"), "127.0.0.1:4999\n");
  const refused = await runCli(stateDir, ["list"]);
  check("unreachable serve → CLI refuses second Harness", refused.code !== 0 && refused.out.includes("Refusing"), refused.out.trim().slice(0, 140));
  await rm(path.join(stateDir, "raftd.port"), { force: true });
}

// ── main ────────────────────────────────────────────────────────────────────

const t0 = Date.now();
let phaseAFail = false;
try {
  const { record } = await phaseA(STATE_DIR);
  await phaseB(STATE_DIR, record.agentId);
  await phaseC(STATE_DIR, record.agentId);
  await phaseD(STATE_DIR, record.agentId);
  await phaseH(STATE_DIR, record.agentId);
  await phaseI(STATE_DIR, record.agentId);
  await phaseJ(STATE_DIR, record.agentId);
  await phaseK(STATE_DIR);
  await phaseL(STATE_DIR);
  await phaseM(STATE_DIR);
} catch (err) {
  phaseAFail = true;
  check("real-model phases completed", false, err instanceof Error ? err.message : String(err));
}
await phaseE(STATE_DIR).catch((err) => check("E completed", false, err instanceof Error ? err.message : String(err)));
await phaseFG(STATE_DIR).catch((err) => check("F/G completed", false, err instanceof Error ? err.message : String(err)));

const failed = checks.filter((c) => !c.ok);
const report = [
  `# E2E report — raftbuild-durable`,
  ``,
  `stateDir: \`${STATE_DIR}\`  model: ${MODEL.provider}/${MODEL.modelId}  duration: ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  ``,
  `| phase | check | result | detail |`,
  `|---|---|---|---|`,
  ...checks.map((c) => `| ${c.phase} | ${c.name} | ${c.ok ? "PASS" : "FAIL"} | ${c.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
  ``,
  `${checks.length - failed.length}/${checks.length} checks passed.`,
].join("\n");
await mkdir(path.dirname(REPORT), { recursive: true });
await writeFile(REPORT, report);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed — report: ${REPORT}`);
if (failed.length > 0) process.exit(1);
await rm(STATE_DIR, { recursive: true, force: true }).catch(() => {});

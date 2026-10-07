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
  OutboxDoc,
  OutboxError,
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

  // Wait until the turn is actually running (tool call visible), then kill -9.
  const sawTool = await waitFor("tool call in transcript", () => transcriptHas(stateDir, agentId, '"kind":"tool_call"'), 60_000, 500);
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
    () => /SETTLED \d+ status=/.test(recOut),
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

// ── main ────────────────────────────────────────────────────────────────────

const t0 = Date.now();
let phaseAFail = false;
try {
  const { record } = await phaseA(STATE_DIR);
  await phaseB(STATE_DIR, record.agentId);
  await phaseC(STATE_DIR, record.agentId);
  await phaseD(STATE_DIR, record.agentId);
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

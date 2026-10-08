#!/usr/bin/env node
/**
 * Reproduce the existing E2E suite with a local scripted model, never real GLM.
 * From the repo root after pnpm install --frozen-lockfile:
 *   node packages/agent/test-manual/run-scripted-e2e.mjs /tmp/raftd-e2e-node24
 * Use the Node 26 executable instead of node for the same suite on Node 26.
 * Requires Python 3; wrapper checks additionally need deploy's Python packages
 * on PATH, and container checks require a working Docker daemon/build network.
 * Missing optional capabilities are reported as skipped, never as passed.
 * No model credentials are needed. Models and responses are scripted; Bash,
 * SQLite, HTTP, CLI, wrapper, and containers run normally. Real GLM behavior
 * and repeating an interrupted tool's side effect are not validated here.
 * Output: e2e.log, labelled report.md, run.json, and local model-request logs.
 * The original tracked e2e/report.md is restored, including on failure.
 * Use a fresh output directory; do not run suites concurrently in one checkout.
 * RAFTD_TEST_PYTHON selects the SSE server's Python executable if needed.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--help")) {
  console.log("Usage: node packages/agent/test-manual/run-scripted-e2e.mjs [output-directory]\nRuns the existing E2E suite with Python 3 loopback SSE; no real model credentials needed.");
  process.exit(0);
}
if (process.argv.length > 3) throw new Error("Expected at most one output-directory argument");
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const output = process.argv[2] ? path.resolve(process.argv[2]) : await mkdtemp(path.join(tmpdir(), "raftd-scripted-e2e-"));
await mkdir(output, { recursive: true });
const report = path.join(repo, "packages/agent/e2e/report.md");
const originalReport = await readFile(report).catch((err) => { if (err.code === "ENOENT") return null; throw err; });
const fixtureLog = openSync(path.join(output, "model-server.log"), "w");
const fixture = spawn(process.env.RAFTD_TEST_PYTHON || "python3", [path.join(here, "scripted-model.py"), "--log", path.join(output, "model-requests.jsonl")], { stdio: ["ignore", "pipe", fixtureLog] });
let child;
let ran = false;
let exitCode = 1;
const started = Date.now();

function exited(p) {
  if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve(p.exitCode ?? 1);
  return new Promise((resolve, reject) => {
    p.once("error", reject);
    p.once("exit", (code) => resolve(code ?? 1));
  });
}
async function stop(p) {
  if (!p || p.pid === undefined || p.exitCode !== null || p.signalCode !== null) return;
  const done = exited(p).catch(() => {});
  p.kill("SIGTERM");
  const timer = setTimeout(() => p.kill("SIGKILL"), 5_000);
  try { await done; } finally { clearTimeout(timer); }
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { child?.kill(signal); fixture.kill("SIGTERM"); });
}
try {
  const endpoint = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: fixture.stdout });
    const timer = setTimeout(() => reject(new Error("local model fixture did not become ready")), 15_000);
    const fail = (err) => { clearTimeout(timer); lines.close(); reject(err); };
    fixture.once("error", fail);
    fixture.once("exit", () => fail(new Error("local model fixture exited before E2E completed")));
    lines.on("line", (line) => {
      try {
        const ready = JSON.parse(line);
        if (ready.fixture !== "scripted-local-model" || typeof ready.url !== "string") return;
        clearTimeout(timer); lines.close(); resolve(ready.url);
      } catch { /* ignore non-readiness output */ }
    });
  });
  const env = {
    ...process.env,
    PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || ""),
    zhipu: "scripted-test-placeholder",
    ZAI_CODING_CN_API_KEY: "scripted-test-placeholder",
    RAFTD_TEST_MODEL_URL: endpoint,
    NODE_OPTIONS: "--import=" + new URL("scripted-provider.mjs", import.meta.url).href,
  };
  for (const key of ["RAFTD_KEY", "RAFTD_INSECURE", "RAFTD_STATE", "RAFTD_HOST", "RAFTD_PORT"]) delete env[key];
  await writeFile(report, "# Scripted E2E\n\nStarting local fixture run; no result yet.\n");
  ran = true;
  const log = openSync(path.join(output, "e2e.log"), "w");
  console.log(`Local scripted model only; ${process.version}; logs and report: ${output}`);
  try {
    child = spawn(process.execPath, [path.join(repo, "packages/agent/e2e/e2e.ts")], { cwd: repo, env, stdio: ["ignore", log, log] });
    exitCode = await exited(child);
  } finally { closeSync(log); }
} catch (err) {
  console.error(err);
} finally {
  await stop(child);
  await stop(fixture);
  closeSync(fixtureLog);
  const result = ran ? await readFile(report, "utf8").catch(() => "Run did not produce a report.\n") : "ABORTED before E2E startup.\n";
  await writeFile(path.join(output, "report.md"), "**Provider: deterministic local SSE fixture; not real GLM.**\n\n" + result);
  if (originalReport === null) await rm(report, { force: true });
  else await writeFile(report, originalReport);
  await writeFile(path.join(output, "run.json"), JSON.stringify({ node: process.version, exitCode, seconds: (Date.now() - started) / 1000, model: "local scripted SSE; not real GLM" }, null, 2) + "\n");
}
process.exitCode = exitCode;

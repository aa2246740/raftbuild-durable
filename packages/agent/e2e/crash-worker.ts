/**
 * Crash-recovery driver for e2e.ts. Two modes over one stateDir:
 *
 *   worker  — open + resume + postMessage(long-running) + waitForAnswer.
 *             Prints `SUBMISSION <id>` as soon as it is placed. The parent
 *             kills this process with SIGKILL mid-run.
 *   recover — open + resume on the same state, wait for that submission to
 *             settle, print `SETTLED <id> <status>` and exit.
 *
 * Usage: node e2e/crash-worker.ts <worker|recover> <stateDir> <agent> <submissionId?>
 */
import { existsSync, readFileSync } from "node:fs";

import { DurableDaemon } from "../src/index.ts";

const [mode, stateDir, agentId, submissionId] = process.argv.slice(2);
if (!mode || !stateDir || !agentId) {
  console.error("usage: crash-worker.ts <worker|recover> <stateDir> <agentId> [submissionId]");
  process.exit(2);
}

const daemon = await DurableDaemon.open({
  stateDir,
  providers: "env",
  defaultModel: { provider: "zai-coding-cn", modelId: "glm-5.3-flash" },
});

try {
  if (mode === "worker") {
    await daemon.resume();
    const { submissionId: sid } = await daemon.postMessage(
      agentId,
      'Use the bash tool to run `sleep 30`, then reply with exactly "CRASH-TEST-DONE".',
      { raw: true },
    );
    console.log(`SUBMISSION ${sid}`);
    const answer = await daemon.waitForAnswer(sid);
    console.log(`WORKER_DONE ${sid} status=${answer.status} text=${(answer.text ?? "").slice(0, 80)}`);
    process.exit(answer.status === "done" ? 0 : 3);
  } else if (mode === "recover") {
    if (!submissionId) {
      console.error("recover needs submissionId");
      process.exit(2);
    }
    await daemon.resume();
    const answer = await daemon.waitForAnswer(submissionId);
    console.log(`SETTLED ${submissionId} status=${answer.status} text=${(answer.text ?? "").slice(0, 80)}`);
    // The outcome frame is durable the moment reconcile appends it; give the
    // outbox pump a beat to deliver it to .deliveries/ before we close.
    const deliveries = `${stateDir}/.deliveries/${agentId}.jsonl`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      const ok = existsSync(deliveries) && readFileSync(deliveries, "utf8").includes(`"submissionId":"${submissionId}"`);
      if (ok || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    process.exit(0);
  } else {
    console.error(`unknown mode ${mode}`);
    process.exit(2);
  }
} finally {
  await daemon.close();
}

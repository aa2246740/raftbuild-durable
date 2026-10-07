#!/usr/bin/env node
/**
 * raftd — CLI for the durable daemon.
 *
 *   raftd create <name> [--model provider/model] [--instructions "..."]
 *   raftd list | show <agent> | lifecycle <agent>
 *   raftd send <agent> <text...> [--no-wait] [--raw] [--request-id id]
 *   raftd steer <agent> <text...>        (deliver into the running turn)
 *   raftd abort <agent> | stop <agent> | start <agent> | resolve <agent> [note]
 *   raftd reset <agent> [handoff...] | compact <agent> [instructions...]
 *   raftd events <agent>                 (replay the normalized transcript)
 *   raftd outbox <agent>                 (dump the durable outbox doc)
 *   raftd deliveries [agent]             (cat the delivery ledger)
 *   raftd delete <agent> [--workspace]
 *   raftd serve                          (resume + keep pumps alive — the daemon loop)
 *   raftd usage | inspect
 *
 * Env: RAFTD_STATE (default ./.raftd), RAFTD_MODEL (default zai-coding-cn/glm-5.3-flash).
 * Provider keys are auto-detected (ZAI_CODING_CN_API_KEY / $zhipu / MINIMAX_CN…).
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { DurableDaemon } from "./daemon.ts";
import type { AgentModelRef } from "./types.ts";

const USAGE = `raftd — durable agent daemon (pi-durable)

  create <name> [--model p/m] [--instructions "..."]   create agent + workspace
  list                                                all agents
  show <agent>                                        record + lifecycle
  lifecycle <agent>                                   projected lifecycle state
  send <agent> <text...> [--no-wait] [--raw]          submit, wait, print answer
  steer <agent> <text...>                             input into running turn
  abort <agent> | stop <agent> | start <agent>
  resolve <agent> [note...]                           human outbox resolution
  reset <agent> [handoff...] | compact <agent> [...]
  events <agent>                                      normalized transcript
  outbox <agent>                                      outbox doc JSON
  deliveries [agent]                                  delivered-frames ledger
  delete <agent> [--workspace]
  usage | inspect
  serve                                               resume; run pumps until SIGINT

--state <dir> or RAFTD_STATE (default ./.raftd); --model or RAFTD_MODEL.
`;

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--") && !["no-wait", "raw", "workspace"].includes(key)) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function modelRef(spec: string | undefined): AgentModelRef | undefined {
  if (!spec) return undefined;
  const slash = spec.indexOf("/");
  if (slash <= 0) throw new Error(`model must be provider/modelId, got: ${spec}`);
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

const DEFAULT_MODEL: AgentModelRef = { provider: "zai-coding-cn", modelId: "glm-5.3-flash" };

async function main(): Promise<number> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  const stateDir = (flags.state as string) ?? process.env.RAFTD_STATE ?? ".raftd";
  const daemon = await DurableDaemon.open({
    stateDir,
    providers: "env",
    defaultModel: modelRef(process.env.RAFTD_MODEL) ?? DEFAULT_MODEL,
  });
  const shutdown = async () => {
    await daemon.close();
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

  const needAgent = () => {
    const id = positional[1];
    if (!id) throw new Error("missing <agent>");
    return id;
  };
  const text = (from: number) => positional.slice(from).join(" ") || (flags.m as string) || "";

  try {
    switch (cmd) {
      case "create": {
        const name = positional[1];
        if (!name) throw new Error("create needs a name");
        const { record } = await daemon.createAgent({
          name,
          model: modelRef(flags.model as string) ?? modelRef(process.env.RAFTD_MODEL) ?? DEFAULT_MODEL,
          instructions: flags.instructions as string | undefined,
          workspace: flags.workspace as string | undefined,
          thinkingLevel: flags.thinking as "minimal" | "low" | "medium" | "high" | undefined,
        });
        console.log(`created ${record.agentId} (${record.name})  conversation=${record.conversationId}  workspace=${record.workspacePath}`);
        break;
      }
      case "list": {
        const agents = await daemon.listAgents();
        if (agents.length === 0) console.log("(no agents)");
        for (const a of agents) {
          const life = await daemon.lifecycle(a.agentId);
          console.log(`${a.agentId}  ${a.name}  ${a.model.provider}/${a.model.modelId}  ${life.kind}${a.terminalFailure ? "  TERMINAL:" + a.terminalFailure.detail : ""}`);
        }
        break;
      }
      case "show": {
        const record = await daemon.getAgent(needAgent());
        const life = await daemon.lifecycle(record.agentId);
        console.log(JSON.stringify({ record, lifecycle: life }, null, 2));
        break;
      }
      case "lifecycle": {
        const record = await daemon.getAgent(needAgent());
        console.log(JSON.stringify(await daemon.lifecycle(record.agentId), null, 2));
        break;
      }
      case "send": {
        const record = await daemon.getAgent(needAgent());
        const body = text(2);
        if (!body) throw new Error("send needs text");
        const { submissionId } = await daemon.postMessage(record.agentId, body, {
          requestId: flags["request-id"] as string | undefined,
          raw: flags.raw === true,
        });
        console.log(`submission ${submissionId}`);
        if (flags["no-wait"] !== true) {
          const answer = await daemon.waitForAnswer(submissionId);
          if (answer.status === "done") {
            console.log(answer.text ?? "(empty answer)");
          } else {
            console.log(`unanswered: ${answer.reason ?? "?"}`);
            return 2;
          }
        }
        break;
      }
      case "steer": {
        const record = await daemon.getAgent(needAgent());
        const body = text(2);
        if (!body) throw new Error("steer needs text");
        const { submissionId } = await daemon.postMessage(record.agentId, body, { whenBusy: "steer" });
        console.log(`steered submission ${submissionId}`);
        if (flags["no-wait"] !== true) {
          const answer = await daemon.waitForAnswer(submissionId);
          console.log(answer.status === "done" ? (answer.text ?? "(empty)") : `unanswered: ${answer.reason ?? "?"}`);
        }
        break;
      }
      case "abort":
        await daemon.abort(needAgent());
        console.log("aborted");
        break;
      case "stop":
        await daemon.stopAgent(needAgent());
        console.log("stopped");
        break;
      case "start":
        await daemon.startAgent(needAgent());
        console.log("started");
        break;
      case "resolve": {
        await daemon.resolveAgent(needAgent(), text(2) || undefined);
        console.log("resolved (human start)");
        break;
      }
      case "reset": {
        await daemon.reset(needAgent(), text(2) || undefined);
        console.log("reset queued");
        break;
      }
      case "compact": {
        await daemon.compact(needAgent(), text(2) || undefined);
        console.log("compacted");
        break;
      }
      case "events": {
        const record = await daemon.getAgent(needAgent());
        for await (const event of daemon.events(record.agentId)) {
          console.log(JSON.stringify(event));
        }
        break;
      }
      case "outbox": {
        const record = await daemon.getAgent(needAgent());
        console.log(JSON.stringify(await daemon.outboxState(record.agentId), null, 2));
        break;
      }
      case "deliveries": {
        const id = positional[1];
        const dir = daemon.deliveriesDir;
        const files = id ? [`${id}.jsonl`] : undefined;
        if (files) {
          const file = path.join(dir, files[0]);
          if (existsSync(file)) console.log(await readFile(file, "utf8"));
          else console.log("(no deliveries)");
        } else {
          const { readdir } = await import("node:fs/promises");
          for (const f of await readdir(dir)) {
            if (f.endsWith(".jsonl")) {
              console.log(`== ${f} ==`);
              console.log(await readFile(path.join(dir, f), "utf8"));
            }
          }
        }
        break;
      }
      case "delete": {
        await daemon.deleteAgent(needAgent(), { deleteWorkspace: flags.workspace === true });
        console.log("deleted");
        break;
      }
      case "usage": {
        console.log(JSON.stringify(await daemon.usage(), null, 2));
        break;
      }
      case "inspect": {
        console.log(JSON.stringify(await daemon.inspect(), null, 2));
        break;
      }
      case "serve": {
        await daemon.resume();
        const agents = await daemon.listAgents();
        console.log(`serve: ${agents.length} agent(s), state=${daemon.stateDir}`);
        for (const a of agents) console.log(`  ${a.agentId} ${a.name}`);
        await new Promise(() => {});
        break;
      }
      default:
        process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
        return 1;
    }
  } finally {
    if (cmd !== "serve") await shutdown();
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });

#!/usr/bin/env -S node
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
import { MachineLock } from "./machineLock.ts";
import { parseWhen, ReminderService } from "./reminders.ts";
import { startServer } from "./serve.ts";
import { runStack } from "./stack.ts";
import { readApiKey } from "./auth.ts";
import { buildBoundedVisibleCrashDetail } from "./diagnostics.ts";
import { parseArgs, RemoteApiError, timeoutFrom, waitForRemoteAnswer } from "./cliSupport.ts";
import type { AgentModelRef } from "./types.ts";

const USAGE = `raftd — durable agent daemon (pi-durable)

  <agent> below accepts an agent name OR its agent-id.

  create <name> [--model p/m] [--instructions "..."]
         [--thinking minimal|low|medium|high] [--workspace <dirname>]
  list                                                all agents
  show <agent>                                        record + lifecycle
  lifecycle <agent>                                   projected lifecycle state
  send <agent> <text...> [-m file] [--no-wait] [--raw] [--request-id id] [--timeout 5m]
  wait <agent> <submissionId> [--timeout 5m]          continue waiting via serve
  update <agent> [--name name] [--model p/m] [--instructions text] [--thinking level]
  steer <agent> <text...> [--no-wait]                 input into running turn
  abort <agent> | stop <agent> | start <agent>
  resolve <agent> [note...]                           human outbox resolution
  reset <agent> [handoff...] | compact <agent> [...]
  events <agent>                                      normalized transcript
  outbox <agent>                                      outbox doc JSON
  deliveries [agent]                                  delivered-frames ledger
  main                                                operator inbox (agent → main)
  remind <agent> <when> <text...>                     durable reminder ("in 30m"/"every 1h"/"at 14:30")
  reminders                                           pending reminders
  delete <agent> [--workspace]
  usage [agent] | inspect
  serve [--port N] [--host H]                         daemon loop + web console (default :4777)
  stack [start|stop|status]                           embedded upstream platform (pglite+redis+vite web)

--state <dir> or RAFTD_STATE (default ./.raftd); --model or RAFTD_MODEL.
Send without serve only queues work. Start serve to execute it.
Wait is unlimited by default; --timeout accepts seconds or ms/s/m/h.
Serve env: RAFTD_PORT, RAFTD_HOST, RAFTD_KEY (otherwise local raftd.token), RAFTD_COMPACT_IDLE_MS.
`;

function modelRef(spec: string | undefined): AgentModelRef | undefined {
  if (!spec) return undefined;
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) throw new Error(`model must be provider/modelId, got: ${spec}`);
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

// No built-in default model: the daemon picks one from whichever provider is
// configured (see DurableDaemon.open → pickDefaultModel).

async function main(): Promise<number> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (!cmd || cmd === "help" || flags.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  timeoutFrom(flags.timeout); // validate before submitting any work
  if (flags.m !== undefined) {
    if (!["send", "steer"].includes(cmd)) throw new Error("-m is only valid for send or steer");
    if (positional.length > 2) throw new Error("use either message text or -m file, not both");
    positional.push(await readFile(String(flags.m), "utf8"));
  }
  const needsAgent = new Set(["show", "lifecycle", "send", "steer", "wait", "update", "abort", "stop", "start", "resolve", "reset", "compact", "events", "outbox", "delete", "remind"]);
  if (needsAgent.has(cmd) && !positional[1]?.trim()) throw new Error(`${cmd} requires <agent>`);
  if (["send", "steer"].includes(cmd) && !positional.slice(2).join(" ").trim()) throw new Error(`${cmd} requires text or -m file`);
  if (cmd === "wait" && !/^\d+$/.test(positional[2] ?? "")) throw new Error("wait requires a numeric <submissionId>");
  if (cmd === "remind" && (!positional[2] || !positional.slice(3).join(" ").trim())) throw new Error("remind requires <agent> <when> <text>");
  const stateDir = (flags.state as string) ?? process.env.RAFTD_STATE ?? ".raftd";

  // `stack` orchestrates the vendored upstream platform — its own state dir,
  // no raftd storage lock, no thin-client hop.
  if (cmd === "stack") {
    return await runStack(positional[1], flags, stateDir);
  }

  // If `raftd serve` was here (port file), act as a thin client — opening the
  // storage anyway would mean two Harnesses on one SQLite. When the serve
  // process is unreachable, refuse: silently opening a second Harness corrupts
  // the live one's writes (verified: poisons the session mid-turn).
  if (cmd !== "serve") {
    const portFile = path.join(stateDir, "raftd.port");
    if (existsSync(portFile)) {
      const addr = (await readFile(portFile, "utf8")).trim();
      try {
        return await runRemote(`http://${addr}`, cmd, positional, flags, await readApiKey(stateDir));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Only a REAL connection failure means "serve is gone" — an HTTP
        // error the serve returned must reach the user verbatim, not be
        // disguised as an unreachable daemon (verified footgun).
        if (err instanceof RemoteApiError || !/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR|socket|network/i.test(msg)) {
          console.error(`remote: ${msg}`);
          return 1;
        }
        console.error(`error: a raftd serve was started on this state dir (port file ${portFile}) but is unreachable at http://${addr}.\n` +
          "Refusing to open a second local Harness — SQLite is single-holder.\n" +
          "Start `pnpm cli serve --state " + stateDir + "` again, or remove the stale raftd.port file only if no serve process is running.");
        return 1;
      }
    }
  }

  if (["wait", "abort", "stop", "start", "resolve", "reset", "compact", "delete"].includes(cmd)) {
    throw new Error(`${cmd} requires a running serve; start: raftd serve --state ${JSON.stringify(stateDir)}`);
  }

  const compactIdleEnv = String(process.env.RAFTD_COMPACT_IDLE_MS ?? "").trim();
  const compactIdleMs = compactIdleEnv
    ? (/^\d+\s*(s|m|h|d)$/i.test(compactIdleEnv)
        ? parseWhen(`every ${compactIdleEnv}`).everyMs ?? undefined
        : Number(compactIdleEnv) || undefined)
    : (cmd === "serve" ? 30 * 60_000 : undefined);
  // Claim ownership before opening storage: even opening a second Harness
  // can run migrations/recovery. Remote commands above never open storage.
  const lock = await MachineLock.acquire(stateDir, {
    managedByWrapper: Boolean(process.env.RAFTD_WRAPPER_INSTANCE),
  });
  let daemon: DurableDaemon;
  try {
    daemon = await DurableDaemon.open({
      stateDir,
      providers: "env",
      // No hardcoded provider: RAFTD_MODEL wins; otherwise the daemon picks a
      // model from whichever provider is actually configured (OpenAI-only users
      // must not silently end up on the GLM default).
      defaultModel: modelRef(process.env.RAFTD_MODEL),
      compactOnWakeMs: compactIdleMs,
      onWarn: (m) => console.error(`[warn] ${m}`),
    });
  } catch (error) {
    await lock.release();
    throw error;
  }
  if (daemon.providerCount === 0) {
    console.error(
      "warning: no model API keys detected (zhipu / ZAI_CODING_CN_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY).\n" +
        "Without credentials, create requires --model provider/modelId and submitted work cannot call a model. Set OPENAI_API_KEY (or another supported provider key), select --model or RAFTD_MODEL if needed, then restart serve."
    );
  }
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => shutdownPromise ??= (async () => {
    try { await daemon.close(); }
    finally { await lock.release(); }
  })();
  const defaultSigHandler = () => void shutdown().then(() => process.exit(0));
  process.on("SIGINT", defaultSigHandler);
  process.on("SIGTERM", defaultSigHandler);

  const needAgent = () => {
    const id = positional[1];
    if (!id) throw new Error("missing <agent>");
    return id;
  };
  const text = (from: number) => positional.slice(from).join(" ");

  try {
    switch (cmd) {
      case "create": {
        const name = positional[1];
        if (!name) throw new Error("create needs a name");
        if (flags.workspace !== undefined && typeof flags.workspace !== "string") {
          throw new Error("create --workspace needs a directory name");
        }
        const { record } = await daemon.createAgent({
          name,
          model: modelRef(flags.model as string) ?? modelRef(process.env.RAFTD_MODEL),
          instructions: flags.instructions as string | undefined,
          workspace: flags.workspace as string | undefined,
          thinkingLevel: flags.thinking as "minimal" | "low" | "medium" | "high" | undefined,
        });
        console.log(`created ${record.agentId} (${record.name})  conversation=${record.conversationId}  workspace=${record.workspacePath}  model=${record.model.provider}/${record.model.modelId}`);
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
      case "send":
      case "steer": {
        const record = await daemon.getAgent(needAgent());
        const body = text(2);
        if (!body) throw new Error(`${cmd} needs text or -m file`);
        const { submissionId } = await daemon.postMessage(record.agentId, body, {
          requestId: flags["request-id"] as string | undefined,
          raw: flags.raw === true,
          ...(cmd === "steer" ? { whenBusy: "steer" as const } : {}),
          execute: false,
        });
        console.log(`queued submission ${submissionId}; no tasks were started`);
        console.log(`Start: raftd serve --state ${JSON.stringify(stateDir)}`);
        console.log(`Then: raftd wait ${JSON.stringify(record.name)} ${submissionId} --state ${JSON.stringify(stateDir)}`);
        break;
      }
      case "update": {
        const record = await daemon.updateAgent(needAgent(), {
          ...(typeof flags.name === "string" ? { name: flags.name } : {}),
          ...(typeof flags.model === "string" ? { model: modelRef(flags.model) } : {}),
          ...(typeof flags.instructions === "string" ? { instructions: flags.instructions } : {}),
          ...(typeof flags.thinking === "string" ? { thinkingLevel: flags.thinking as "minimal" | "low" | "medium" | "high" } : {}),
        });
        console.log(JSON.stringify(record, null, 2));
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
        const files = id ? [`${(await daemon.getAgent(id)).agentId}.jsonl`] : undefined;
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
      case "main": {
        const entries = await daemon.mainInbox();
        if (entries.length === 0) console.log("(empty)");
        for (const e of entries) console.log(`${e.at}  @${e.fromName}: ${e.text}`);
        break;
      }
      case "remind": {
        const agent = positional[1];
        const when = positional[2];
        const body = positional.slice(3).join(" ");
        if (!agent || !when || !body) throw new Error('usage: remind <agent> <when> <text...> (when: "in 30m" / "every 1h" / "at 14:30" / ISO)');
        const r = await daemon.remind(agent, when, body);
        console.log(`reminder ${r.id} → ${r.agentId} at ${r.dueAt} [${r.timeZone ?? "UTC"}]${r.everyMs ? " (repeats)" : ""}`);
        break;
      }
      case "reminders": {
        const timers = await daemon.listReminders();
        if (timers.length === 0) console.log("(no pending reminders)");
        for (const t of timers) console.log(`${t.id}  ${t.agentId}  due=${t.dueAt} [${t.timeZone ?? "UTC"}]${t.everyMs ? `  every=${t.everyMs}ms` : ""}  "${t.text}"`);
        break;
      }
      case "delete": {
        await daemon.deleteAgent(needAgent(), { deleteWorkspace: flags.workspace !== undefined });
        console.log("deleted");
        break;
      }
      case "usage": {
        console.log(JSON.stringify(await daemon.usage(positional[1]), null, 2));
        break;
      }
      case "inspect": {
        console.log(JSON.stringify(await daemon.inspect(), null, 2));
        break;
      }
      case "serve": {
        // Reap a previous host's orphans only after the lock proves we're
        // the owner — inside open() this would kill a live daemon's tools.
        await daemon.reapOrphanedToolChildren();
        const reminders = new ReminderService(daemon);
        await daemon.resume();
        await reminders.start();
        const port = Number(flags.port ?? process.env.RAFTD_PORT ?? 4777);
        const host = (flags.host as string) ?? process.env.RAFTD_HOST ?? "127.0.0.1";
        const server = await startServer(daemon, { host, port });
        const agents = await daemon.listAgents();
        console.log(`raftd serving — console ${process.env.RAFTD_WRAPPER_INSTANCE ? server.consoleUrl.split("#")[0] : server.consoleUrl}  state=${daemon.stateDir}`);
        console.log(`  ${agents.length} agent(s); ${(await daemon.listReminders()).length} reminder(s) armed`);
        const exit = async () => {
          reminders.stop();
          server.close();
          await shutdown();
          process.exit(0);
        };
        process.off("SIGINT", defaultSigHandler);
        process.off("SIGTERM", defaultSigHandler);
        process.on("SIGINT", () => void exit());
        process.on("SIGTERM", () => void exit());
        await new Promise(() => {});
        break;
      }
      default:
        process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
        return 1;
    }
  } finally {
    await shutdown();
  }
  return 0;
}

/** Run a command against a live `serve` via its HTTP API. Throws if unreachable. */
async function runRemote(
  base: string,
  cmd: string,
  positional: string[],
  flags: Record<string, string | boolean>,
  apiKey?: string,
): Promise<number> {
  const call = async (method: string, p: string, body?: unknown, timeoutMs?: number) => {
    const key = apiKey;
    const r = await fetch(base + "/api/" + p, {
      method,
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs ?? (body !== undefined || p === "state" ? 30_000 : 120_000)))),
    });
    if (!r.ok) throw new RemoteApiError(r.status, `remote ${method} ${p}: ${(await r.json().catch(() => ({}))).error ?? r.statusText}`);
    return r.json();
  };
  const id = positional[1];
  const bodyText = positional.slice(2).join(" ");
  const state = async () => (await call("GET", "state")) as any;

  switch (cmd) {
    case "create": {
      const rec: any = await call("POST", "agents", {
        name: positional[1], instructions: flags.instructions,
        ...(flags.model ? { model: flags.model } : {}),
        ...(typeof flags.workspace === "string" ? { workspace: flags.workspace } : {}),
        ...(flags.thinking ? { thinking: flags.thinking } : {}),
      });
      console.log(`created ${rec.agentId} (${rec.name})  model=${rec.model.provider}/${rec.model.modelId}`);
      return 0;
    }
    case "list": {
      const s = await state();
      const lcs = Object.fromEntries(s.lifecycles.map((l: any) => [l.agentId, l.kind]));
      if (!s.agents.length) console.log("(no agents)");
      for (const a of s.agents) console.log(`${a.agentId}  ${a.name}  ${a.model.provider}/${a.model.modelId}  ${lcs[a.agentId] ?? "?"}`);
      return 0;
    }
    case "send":
    case "steer": {
      const r: any = await call("POST", `agents/${encodeURIComponent(id)}/messages`, {
        text: bodyText,
        ...(cmd === "steer" ? { whenBusy: "steer" } : {}),
        ...(flags["request-id"] ? { requestId: flags["request-id"] } : {}),
        ...(flags.raw === true ? { raw: true } : {}),
      });
      console.log(`submission ${r.submissionId}`);
      if (flags["no-wait"] !== true) {
        const a = await waitForRemoteAnswer((route, ms) => call("GET", route, undefined, ms), id!, r.submissionId, timeoutFrom(flags.timeout));
        return printAnswer(a);
      }
      return 0;
    }
    case "wait": {
      if (!id || !positional[2]) throw new Error("usage: wait <agent> <submissionId> [--timeout 5m]");
      return printAnswer(await waitForRemoteAnswer((route, ms) => call("GET", route, undefined, ms), id, positional[2], timeoutFrom(flags.timeout)));
    }
    case "update": {
      const record = await call("PATCH", `agents/${encodeURIComponent(id!)}`, {
        ...(typeof flags.name === "string" ? { name: flags.name } : {}),
        ...(typeof flags.model === "string" ? { model: flags.model } : {}),
        ...(typeof flags.instructions === "string" ? { instructions: flags.instructions } : {}),
        ...(typeof flags.thinking === "string" ? { thinking: flags.thinking } : {}),
      });
      console.log(JSON.stringify(record, null, 2));
      return 0;
    }
    case "abort": case "stop": case "start": case "resolve": case "compact": case "reset": {
      const result = await call("POST", `agents/${encodeURIComponent(id!)}/${cmd}`, { note: bodyText || undefined, instructions: bodyText || undefined, handoff: bodyText || undefined });
      console.log(`${cmd} ok ${JSON.stringify(result)}`);
      return 0;
    }
    case "lifecycle": console.log(JSON.stringify(await call("GET", `agents/${encodeURIComponent(id)}/lifecycle`), null, 2)); return 0;
    case "show": {
      const s = await state();
      const rec = s.agents.find((a: any) => a.agentId === id || a.name === id);
      console.log(JSON.stringify({ record: rec, lifecycle: await call("GET", `agents/${encodeURIComponent(rec?.agentId ?? id)}/lifecycle`) }, null, 2));
      return 0;
    }
    case "events": {
      const { events }: any = await call("GET", `agents/${encodeURIComponent(id)}/events?tail=500`);
      for (const e of events) console.log(JSON.stringify(e));
      return 0;
    }
    case "outbox": console.log(JSON.stringify(await call("GET", `agents/${encodeURIComponent(id)}/outbox`), null, 2)); return 0;
    case "deliveries": {
      const { deliveries }: any = await call(
        "GET",
        id ? `agents/${encodeURIComponent(id)}/deliveries?tail=200` : "deliveries?tail=200",
      );
      for (const d of deliveries) console.log(JSON.stringify(d));
      return 0;
    }
    case "delete": await call("DELETE", `agents/${encodeURIComponent(id)}${flags.workspace !== undefined ? "?workspace=true" : ""}`); console.log("deleted"); return 0;
    case "usage": console.log(JSON.stringify(id ? await call("GET", `agents/${encodeURIComponent(id)}/usage`) : (await state()).usage, null, 2)); return 0;
    case "inspect": console.log(JSON.stringify(await call("GET", "inspect"), null, 2)); return 0;
    case "main": {
      const box = (await state()).mainInbox;
      if (!box.length) console.log("(empty)");
      for (const e of box) console.log(`${e.at}  @${e.fromName}: ${e.text}`);
      return 0;
    }
    case "remind": {
      const r: any = await call("POST", "reminders", { agent: id, when: positional[2], text: positional.slice(3).join(" ") });
      console.log(`reminder ${r.id} → ${r.agentId} at ${r.dueAt} [${r.timeZone ?? "UTC"}]`);
      return 0;
    }
    case "reminders": {
      const timers = (await state()).reminders;
      if (!timers.length) console.log("(no pending reminders)");
      for (const t of timers) console.log(`${t.id}  ${t.agentId}  due=${t.dueAt} [${t.timeZone ?? "UTC"}]  "${t.text}"`);
      return 0;
    }
    default:
      throw new Error(`no remote path for ${cmd}`);
  }
}

function printAnswer(answer: { status: string; text?: string; reason?: string; detail?: string }): number {
  if (answer.status === "done") { console.log(answer.text ?? "(empty)"); return 0; }
  console.error(`unanswered: ${answer.reason ?? "unknown"}${answer.detail ? " — " + buildBoundedVisibleCrashDetail(answer.detail) : ""}`);
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });

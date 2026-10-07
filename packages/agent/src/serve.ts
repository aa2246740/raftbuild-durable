/**
 * `raftd serve` — the product surface: HTTP API + embedded web console.
 *
 * One process = daemon + router + reminders + console. No build step for the
 * UI: the console is a single HTML file served from memory.
 */
import { createServer, type IncomingMessage as HttpRequest, type Server, type ServerResponse } from "node:http";
import { readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import type { DurableDaemon } from "./daemon.ts";
import { CONSOLE_HTML } from "./consoleHtml.ts";

export interface ServeOptions {
  host?: string;
  port?: number;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req: HttpRequest): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/** Read the last `n` parsed events of an agent's transcript JSONL. */
async function transcriptTail(file: string, n: number): Promise<unknown[]> {
  if (!existsSync(file)) return [];
  const raw = await readFile(file, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .slice(-n)
    .map((l) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return { kind: "unparseable", text: l };
      }
    });
}

export async function startServer(daemon: DurableDaemon, opts: ServeOptions = {}): Promise<Server> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4777;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // ── console ──
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(CONSOLE_HTML);
        return;
      }

      if (parts[0] !== "api") {
        json(res, 404, { error: "not found" });
        return;
      }

      if (req.method === "GET" && parts[1] === "inspect") {
        json(res, 200, await daemon.inspect());
        return;
      }

      // GET /api/state — one call for the whole console refresh.
      if (req.method === "GET" && parts[1] === "state") {
        const agents = await daemon.listAgents();
        const lifecycles = await Promise.all(
          agents.map(async (a) => ({ agentId: a.agentId, ...(await daemon.lifecycle(a.agentId).catch(() => ({ kind: "unknown" }))) })),
        );
        const usage = await daemon.usage().catch(() => null);
        json(res, 200, {
          agents,
          lifecycles,
          reminders: await daemon.listReminders(),
          mainInbox: await daemon.mainInbox(),
          usage,
        });
        return;
      }

      if (parts[1] === "agents") {
        if (req.method === "POST" && parts.length === 2) {
          const body = (await readBody(req)) as { name?: string; instructions?: string; model?: string };
          if (!body.name) return json(res, 400, { error: "name required" });
          const model = body.model
            ? { provider: body.model.split("/")[0] ?? "", modelId: body.model.split("/").slice(1).join("/") }
            : undefined;
          const created = await daemon.createAgent({
            name: body.name,
            instructions: body.instructions,
            ...(model?.modelId ? { model } : {}),
          });
          json(res, 201, created.record);
          return;
        }
        if (parts.length >= 3) {
          const id = decodeURIComponent(parts[2]);
          if (req.method === "POST" && parts[3] === "messages") {
            const body = (await readBody(req)) as { text?: string; whenBusy?: "steer" | "followUp" | "reject" };
            if (!body.text) return json(res, 400, { error: "text required" });
            const r = await daemon.postMessage(id, body.text, { whenBusy: body.whenBusy });
            json(res, 202, r);
            return;
          }
          if (req.method === "GET" && parts[3] === "feed") {
            const tail = Math.min(Number(url.searchParams.get("tail") ?? "200") || 200, 500);
            json(res, 200, { items: await daemon.chatFeed(id, tail) });
            return;
          }
          if (req.method === "GET" && parts[3] === "events") {
            const tail = Math.min(Number(url.searchParams.get("tail") ?? "100") || 100, 500);
            const record = await daemon.getAgent(id);
            const file = path.join(daemon.transcriptsDir, `${record.agentId}.events.jsonl`);
            json(res, 200, { events: await transcriptTail(file, tail) });
            return;
          }
          if (req.method === "GET" && parts[3] === "outbox") {
            const record = await daemon.getAgent(id);
            json(res, 200, (await daemon.outboxFor(record.agentId).state()) ?? { entries: [] });
            return;
          }
          if (req.method === "GET" && parts[3] === "answer") {
            const sid = url.searchParams.get("submissionId");
            if (!sid) return json(res, 400, { error: "submissionId required" });
            json(res, 200, await daemon.waitForAnswer(sid));
            return;
          }
          if (req.method === "GET" && parts[3] === "lifecycle") {
            json(res, 200, await daemon.lifecycle(id));
            return;
          }
          if (req.method === "POST" && ["stop", "start", "resolve", "abort", "compact", "reset"].includes(parts[3])) {
            const body = (await readBody(req).catch(() => ({}))) as { note?: string; instructions?: string; handoff?: string };
            if (parts[3] === "stop") await daemon.stopAgent(id);
            else if (parts[3] === "start") await daemon.startAgent(id);
            else if (parts[3] === "resolve") await daemon.resolveAgent(id, body.note);
            else if (parts[3] === "abort") await daemon.abort(id);
            else if (parts[3] === "compact") await daemon.compact(id, body.instructions);
            else await daemon.reset(id, body.handoff);
            json(res, 200, { ok: true });
            return;
          }
          if (req.method === "DELETE" && parts.length === 3) {
            await daemon.deleteAgent(id, { deleteWorkspace: url.searchParams.get("workspace") === "true" });
            json(res, 200, { ok: true });
            return;
          }
        }
      }

      if (parts[1] === "reminders") {
        if (req.method === "POST" && parts.length === 2) {
          const body = (await readBody(req)) as { agent?: string; when?: string; text?: string };
          if (!body.agent || !body.when || !body.text) return json(res, 400, { error: "agent, when, text required" });
          json(res, 201, await daemon.remind(body.agent, body.when, body.text));
          return;
        }
        if (req.method === "DELETE" && parts.length === 3) {
          await daemon.deleteReminder(decodeURIComponent(parts[2]));
          json(res, 200, { ok: true });
          return;
        }
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  // Port file: local CLI commands discover the live host instead of opening
  // the storage themselves (one Harness per storage — never two).
  const portFile = path.join(daemon.stateDir, "raftd.port");
  await writeFile(portFile, `${host}:${port}`, "utf8");
  server.once("close", () => void rm(portFile, { force: true }).catch(() => {}));
  return server;
}

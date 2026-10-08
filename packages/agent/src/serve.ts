/**
 * `raftd serve` — the product surface: HTTP API + embedded web console.
 *
 * One process = daemon + router + reminders + console. No build step for the
 * UI: the console is a single HTML file served from memory.
 */
import { createServer, type IncomingMessage as HttpRequest, type Server, type ServerResponse } from "node:http";
import { readFile, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import type { DurableDaemon } from "./daemon.ts";
import { AgentRegistryError } from "./agents.ts";
import { OutboxError } from "./outbox.ts";
import { CONSOLE_HTML } from "./consoleHtml.ts";
import { resolveApiKey, validBearer } from "./auth.ts";

export interface ServeOptions {
  host?: string;
  port?: number;
  /** Additional DNS aliases on this HTTP listener's own port. */
  allowedHosts?: string[];
}

export type RaftServer = Server & { consoleUrl: string };

/** Carries an HTTP status through the catch-all error mapper. */
class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

/** Map thrown domain errors to HTTP statuses instead of blanket 500s. */
function statusFor(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  if (err instanceof URIError) return 400;
  if (err instanceof AgentRegistryError) {
    if (err.code === "name_taken" || err.code === "conflict") return 409;
    if (err.code === "not_found") return 404;
    return 400;
  }
  if (err instanceof OutboxError) return 409; // unreliable/overflow → conflict state
  if (err instanceof Error && /\bis busy\b|cannot parse when|invalid (hour|minute)|repeating reminders|reminder time must be in the future/i.test(err.message)) {
    // "Conversation 2 is busy" carries the id — match the phrase, not the
    // literal "conversation is busy".
    return /busy/i.test(err.message) ? 409 : 400;
  }
  return 500;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req: HttpRequest): Promise<unknown> {
  const chunks: Buffer[] = [];
  const limit = 1024 * 1024;
  if (Number(req.headers["content-length"]) > limit) throw new HttpError(413, "request body exceeds 1 MiB");
  let size = 0;
  for await (const c of req.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "request body exceeds 1 MiB");
    if (size && req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      throw new HttpError(415, "non-empty request body requires Content-Type: application/json");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return parsed;
}

/** Non-empty trimmed string field, or a 400. */
function reqString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${field} must be a non-empty string`);
  return v;
}
function optString(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  return v;
}

function modelField(value: unknown): { provider: string; modelId: string } | undefined {
  if (value === undefined) return undefined;
  const spec = reqString(value, "model").trim();
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) throw new HttpError(400, "model must be provider/model-id");
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

function thinkingField(value: unknown): "minimal" | "low" | "medium" | "high" | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !["minimal", "low", "medium", "high"].includes(value)) {
    throw new HttpError(400, "thinking must be minimal|low|medium|high");
  }
  return value as "minimal" | "low" | "medium" | "high";
}

function hostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function validateRequestOrigin(req: HttpRequest, host: string, port: number, allowedHosts: string[]): void {
  const authority = req.headers.host;
  if (!authority || /[\s\\/@?#]/.test(authority)) throw new HttpError(403, "invalid Host");
  let incoming: URL;
  try { incoming = new URL(`http://${authority}`); }
  catch { throw new HttpError(403, "invalid Host"); }
  const accepted = new Set([host, "127.0.0.1", "localhost", "::1", ...allowedHosts].map(hostname));
  // A wildcard bind is not permission for arbitrary DNS names. Accept its
  // concrete interface address; operators can explicitly allow a public name.
  if (host === "0.0.0.0" || host === "::") {
    if (req.socket.localAddress) accepted.add(hostname(req.socket.localAddress.replace(/^::ffff:/, "")));
  }
  if (!accepted.has(hostname(incoming.hostname)) || Number(incoming.port || 80) !== port) {
    throw new HttpError(403, "Host is not allowed");
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== incoming.origin) throw new HttpError(403, "cross-origin request is not allowed");
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

export async function startServer(daemon: DurableDaemon, opts: ServeOptions = {}): Promise<RaftServer> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4777;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  const configuredKey = String(process.env.RAFTD_KEY ?? "").trim() || undefined;
  const wrapperInstance = process.env.RAFTD_WRAPPER_INSTANCE;
  // A public listener without an admin key hands strangers the ability to
  // create agents and run tool calls — refuse unless explicitly opted out.
  if (!loopback && !configuredKey && process.env.RAFTD_INSECURE !== "1") {
    throw new Error(
      `refusing to bind ${host}: RAFTD_KEY is not set. Set RAFTD_KEY=<key> (clients send Bearer <key>), ` +
        `bind 127.0.0.1, or set RAFTD_INSECURE=1 to run unauthenticated on purpose.`,
    );
  }
  if (!loopback && !configuredKey) {
    console.error(`warning: RAFTD_INSECURE=1 — ${host} listener is unauthenticated; anyone on the network controls agents.`);
  }
  const apiKey = await resolveApiKey(daemon.stateDir);
  const allowedHosts = opts.allowedHosts ?? (process.env.RAFTD_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  // Bracket IPv6 literals — `http://::1:4777` is not a valid base URL.
  const base = host.includes(":") ? `http://[${host}]:${port}` : `http://${host}:${port}`;
  const server = createServer(async (req, res) => {
    // The wrapper verifies this instance before forwarding any response and
    // strips the header at its public edge. Never echo a request value here.
    if (wrapperInstance) res.setHeader("x-raftd-instance", wrapperInstance);
    try {
      const address = server.address();
      validateRequestOrigin(req, host, typeof address === "object" && address ? address.port : port, allowedHosts);
      const url = new URL(req.url ?? "/", base);
      const parts = url.pathname.split("/").filter(Boolean);
      // ── console ──
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer", "cache-control": "no-store" });
        res.end(CONSOLE_HTML);
        return;
      }

      if (parts[0] !== "api") {
        json(res, 404, { error: "not found" });
        return;
      }

      if (apiKey && !validBearer(req.headers.authorization, apiKey)) {
        json(res, 401, { error: "unauthorized: use the console URL printed by raftd serve or send your bearer token" });
        return;
      }
      const requestBody = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method ?? "") ? await readBody(req) : {};

      if (req.method === "GET" && parts[1] === "inspect") {
        json(res, 200, await daemon.inspect());
        return;
      }
      if (req.method === "GET" && parts[1] === "usage" && parts.length === 2) {
        json(res, 200, await daemon.usage(url.searchParams.get("agent") ?? undefined));
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
          const body = requestBody as {
            name?: unknown; instructions?: unknown; model?: unknown;
            workspace?: unknown; thinking?: unknown;
          };
          const name = reqString(body.name, "name");
          const instructions = optString(body.instructions, "instructions");
          const workspace = optString(body.workspace, "workspace");
          const thinking = thinkingField(body.thinking);
          const model = modelField(body.model);
          const created = await daemon.createAgent({
            name,
            instructions,
            workspace,
            thinkingLevel: thinking,
            ...(model ? { model } : {}),
          });
          json(res, 201, created.record);
          return;
        }
        if (parts.length >= 3) {
          const id = decodeURIComponent(parts[2]);
          if (req.method === "PATCH" && parts.length === 3) {
            const body = requestBody as { name?: unknown; instructions?: unknown; model?: unknown; thinking?: unknown };
            if (Object.keys(body).some((field) => !["name", "instructions", "model", "thinking"].includes(field))) {
              throw new HttpError(400, "unsupported agent update field");
            }
            const change = {
              ...(body.name !== undefined ? { name: reqString(body.name, "name") } : {}),
              ...(body.instructions !== undefined ? { instructions: body.instructions === null ? null : optString(body.instructions, "instructions") } : {}),
              ...(body.model !== undefined ? { model: modelField(body.model) } : {}),
              ...(body.thinking !== undefined ? { thinkingLevel: body.thinking === null ? null : thinkingField(body.thinking) } : {}),
            };
            if (!Object.keys(change).length) throw new HttpError(400, "provide name, instructions, model, or thinking to update");
            json(res, 200, await daemon.updateAgent(id, change));
            return;
          }
          if (req.method === "GET" && parts[3] === "usage" && parts.length === 4) {
            json(res, 200, await daemon.usage(id));
            return;
          }
          if (req.method === "POST" && parts[3] === "messages") {
            const body = requestBody as {
              text?: string;
              whenBusy?: "steer" | "followUp" | "reject";
              requestId?: string;
              raw?: boolean;
            };
            const text = reqString(body.text, "text");
            if (body.whenBusy !== undefined && !["steer", "followUp", "reject"].includes(body.whenBusy)) {
              return json(res, 400, { error: `whenBusy must be steer|followUp|reject (got "${body.whenBusy}")` });
            }
            if (body.requestId !== undefined && typeof body.requestId !== "string") {
              return json(res, 400, { error: "requestId must be a string" });
            }
            if (body.raw !== undefined && typeof body.raw !== "boolean") {
              return json(res, 400, { error: "raw must be a boolean" });
            }
            const r = await daemon.postMessage(id, text, {
              whenBusy: body.whenBusy,
              requestId: body.requestId,
              raw: body.raw === true,
            });
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
            const record = await daemon.getAgent(id); // 404 for unknown agent
            const sid = url.searchParams.get("submissionId");
            if (!sid) return json(res, 400, { error: "submissionId required" });
            // A submission answer may only be read through its own agent's
            // route — anything else is a 404, not a leak of another agent's.
            const owner = await daemon.submissionOwner(sid);
            if (owner !== record.agentId) {
              return json(res, 404, { error: `submission ${sid} not found for ${record.agentId}` });
            }
            // Server-side ceiling below the thin-CLI's 120s fetch timeout so a
            // hung answer resolves as a real 504 instead of an aborted socket.
            const requestedTimeout = Number(url.searchParams.get("timeout") ?? "110");
            if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) throw new HttpError(400, "timeout must be a positive number of seconds");
            const timeoutMs = Math.min(requestedTimeout, 300) * 1000;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let answer;
            try {
              answer = await Promise.race([
                daemon.waitForAnswer(sid),
                new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
              ]);
            } finally { clearTimeout(timer); }
            if (answer === null) {
              return json(res, 504, { error: `submission ${sid} still running after ${timeoutMs / 1000}s` });
            }
            json(res, 200, answer);
            return;
          }
          if (req.method === "GET" && parts[3] === "deliveries") {
            const record = await daemon.getAgent(id);
            const file = path.join(daemon.deliveriesDir, `${record.agentId}.jsonl`);
            const tail = Math.min(Number(url.searchParams.get("tail") ?? "200") || 200, 500);
            json(res, 200, { deliveries: await transcriptTail(file, tail) });
            return;
          }
          if (req.method === "GET" && parts[3] === "lifecycle") {
            json(res, 200, await daemon.lifecycle(id));
            return;
          }
          if (req.method === "POST" && ["stop", "start", "resolve", "abort", "compact", "reset"].includes(parts[3])) {
            const body = requestBody as { note?: unknown; instructions?: unknown; handoff?: unknown };
            const note = optString(body.note, "note");
            const instructions = optString(body.instructions, "instructions");
            const handoff = optString(body.handoff, "handoff");
            if (parts[3] === "stop") await daemon.stopAgent(id);
            else if (parts[3] === "start") await daemon.startAgent(id);
            else if (parts[3] === "resolve") await daemon.resolveAgent(id, note);
            else if (parts[3] === "abort") await daemon.abort(id);
            else if (parts[3] === "compact") await daemon.compact(id, instructions);
            else await daemon.reset(id, handoff);
            json(res, 200, { ok: true, lifecycle: await daemon.lifecycle(id) });
            return;
          }
          if (req.method === "DELETE" && parts.length === 3) {
            await daemon.deleteAgent(id, { deleteWorkspace: url.searchParams.get("workspace") === "true" });
            json(res, 200, { ok: true });
            return;
          }
        }
      }

      // Every agent's delivery ledgers, flattened (thin-CLI `deliveries` w/o args).
      if (req.method === "GET" && parts[1] === "deliveries") {
        const tail = Math.min(Number(url.searchParams.get("tail") ?? "200") || 200, 500);
        const files = await readdir(daemon.deliveriesDir).catch(() => [] as string[]);
        const all: unknown[] = [];
        for (const f of files.filter((f) => f.endsWith(".jsonl"))) {
          all.push(...(await transcriptTail(path.join(daemon.deliveriesDir, f), tail)));
        }
        json(res, 200, { deliveries: all });
        return;
      }

      if (parts[1] === "reminders") {
        if (req.method === "POST" && parts.length === 2) {
          const body = requestBody as { agent?: unknown; when?: unknown; text?: unknown };
          json(
            res,
            201,
            await daemon.remind(reqString(body.agent, "agent"), reqString(body.when, "when"), reqString(body.text, "text")),
          );
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
      const status = statusFor(err);
      if (status >= 500) console.error("raftd HTTP request failed", err);
      if (status === 413 || status === 415) res.setHeader("connection", "close");
      json(res, status, { error: status >= 500 ? "internal server error" : err instanceof URIError ? "invalid URL encoding" : err instanceof Error ? err.message : String(err) });
    }
  }) as RaftServer;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  // Port file: local CLI commands discover the live host instead of opening
  // the storage themselves (one Harness per storage — never two).
  // A managed child must never publish its internal port as public CLI
  // discovery, even briefly during boot or after a wrapper restart.
  const portFile = path.join(daemon.stateDir, wrapperInstance ? "raftd.internal-port" : "raftd.port");
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const clientHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const authority = clientHost.includes(":") ? `[${clientHost}]:${actualPort}` : `${clientHost}:${actualPort}`;
  server.consoleUrl = `http://${authority}/${apiKey ? `#key=${encodeURIComponent(apiKey)}` : ""}`;
  try { await writeFile(portFile, authority, "utf8"); }
  catch (err) { server.close(); throw err; }
  server.once("close", () => void rm(portFile, { force: true }).catch(() => {}));
  return server;
}

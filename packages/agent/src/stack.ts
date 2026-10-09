/**
 * `raftd stack` — one-command embedded replica of the upstream platform.
 *
 * Spawns the vendored upstream server + web on embedded PGlite, a local
 * redis-server binary, and local-disk attachment storage — no Docker, no
 * external Postgres. `start` launches all children detached, `stop` tears
 * them down by pid file, `status` reports health.
 *
 * State layout under `<stateDir>/stack/`:
 *   pg/        PGlite data dir (real Postgres files, embedded)
 *   redis/     redis working dir (dump disabled; pub/sub is transient anyway)
 *   logs/      child stdout/stderr
 *   seed.json  dev-seed credentials (written once)
 *   stack.json ports + pids + startedAt
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// packages/agent/src -> packages/agent -> repo root -> upstream/
const UPSTREAM = path.resolve(HERE, "../../../upstream");
const SERVER_PKG = path.join(UPSTREAM, "packages/server");
const WEB_PKG = path.join(UPSTREAM, "packages/web");
const VENDOR_REDIS = path.join(UPSTREAM, "vendor/redis");

/** Prefer PATH redis-server; fall back to the vendored glibc build. */
function resolveRedis(): { bin: string; env: NodeJS.ProcessEnv } | null {
  const envOverride = process.env.RAFTD_REDIS_SERVER;
  if (envOverride && existsSync(envOverride)) return { bin: envOverride, env: process.env };
  if (spawnSync("redis-server", ["--version"], { encoding: "utf8" }).status === 0) {
    return { bin: "redis-server", env: process.env };
  }
  const vendored = path.join(VENDOR_REDIS, "bin/redis-server");
  if (existsSync(vendored)) {
    const lib = path.join(VENDOR_REDIS, "lib");
    return {
      bin: vendored,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ? `${lib}:${process.env.LD_LIBRARY_PATH}` : lib,
      },
    };
  }
  return null;
}

interface StackState {
  ports: { web: number; server: number; redis: number; metrics: number };
  pids: { redis?: number; server?: number; web?: number };
  startedAt: string;
}

function stackDir(stateDir: string) {
  return path.join(stateDir, "stack");
}
function stackJsonPath(stateDir: string) {
  return path.join(stackDir(stateDir), "stack.json");
}
function readStack(stateDir: string): StackState | null {
  try {
    return JSON.parse(readFileSync(stackJsonPath(stateDir), "utf8"));
  } catch {
    return null;
  }
}
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function aliveProcNames(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return "";
  }
}

function tcpBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => {
      s.destroy();
      resolve(false);
    });
  });
}

/** PID of the process actually listening on `port` (via ss), or null. */
function listenerPid(port: number): number | null {
  const out = spawnSync("ss", ["-tlnpH", `sport = :${port}`], { encoding: "utf8" });
  const m = /pid=(\d+)/.exec(out.stdout ?? "");
  return m ? Number(m[1]) : null;
}

function tcpReady(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        resolve();
      });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} never came up`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

async function httpReady(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.status < 500) return;
      lastErr = `HTTP ${r.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} not ready: ${lastErr}`);
}

function spawnLogged(
  name: string,
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; logDir: string },
): number {
  const log = openSync(path.join(opts.logDir, `${name}.log`), "a");
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  return child.pid!;
}

function requireUpstream() {
  for (const p of [SERVER_PKG, WEB_PKG]) {
    if (!existsSync(path.join(p, "package.json"))) {
      throw new Error(
        `vendored upstream not found at ${UPSTREAM} — run from the raftbuild-durable repo checkout (upstream/ must be present)`,
      );
    }
  }
}

async function stackStart(stateDir: string, flags: Record<string, unknown>): Promise<number> {
  requireUpstream();
  const dir = stackDir(stateDir);
  const logs = path.join(dir, "logs");
  for (const d of [dir, path.join(dir, "pg"), path.join(dir, "redis"), logs]) mkdirSync(d, { recursive: true });

  const existing = readStack(stateDir);
  if (existing && [existing.pids.redis, existing.pids.server, existing.pids.web].some((p) => p && pidAlive(p))) {
    console.error(`stack already running (web http://localhost:${existing.ports.web}) — use \`raftd stack stop\` first`);
    return 1;
  }

  const ports = {
    web: Number(flags["web-port"]) || 5270,
    server: Number(flags["server-port"]) || 3098,
    redis: Number(flags["redis-port"]) || 6479,
    metrics: Number(flags["metrics-port"]) || 9491,
  };
  const databaseUrl = `pglite://${path.join(dir, "pg")}`;
  const redisUrl = `redis://127.0.0.1:${ports.redis}`;
  const jwtSecret = String(flags["jwt-secret"] ?? `dev-${process.env.USER ?? "stack"}-${path.basename(stateDir)}`);

  // Refuse to silently adopt orphans: if a port is already bound and the
  // listener isn't one of our recorded pids, bail — adopting a foreign
  // listener makes `stop` miss the process actually holding the port.
  const known = new Set(Object.values(existing?.pids ?? {}).filter(Boolean));
  for (const [label, port] of Object.entries({ redis: ports.redis, server: ports.server, web: ports.web })) {
    const bound = await tcpBound(port);
    const owner = bound ? listenerPid(port) : null;
    if (bound && !(owner && known.has(owner))) {
      throw new Error(`port ${port} (${label}) already bound${owner ? ` by pid ${owner}` : ""} — free it or run \`raftd stack stop\` on the owning state dir`);
    }
  }

  // 1. redis — real binary (PATH or vendored), persistence off (pub/sub only)
  const redis = resolveRedis();
  if (!redis) {
    throw new Error("redis-server not found on PATH and no vendored copy at upstream/vendor/redis — install redis-server or set RAFTD_REDIS_SERVER");
  }
  const pids: StackState["pids"] = {};
  const redisSpawn = spawnLogged("redis", redis.bin, [
    "--port", String(ports.redis),
    "--bind", "127.0.0.1",
    "--dir", path.join(dir, "redis"),
    "--save", "",
    "--appendonly", "no",
    "--daemonize", "no",
  ], { cwd: dir, env: redis.env, logDir: logs });
  await tcpReady(ports.redis, 15_000);
  // Record the real listener pid — wrappers can exec into a child, and a
  // crashed prior run may have left an orphan holding the port. `stop` must
  // reach the listener, not a dead spawn handle.
  pids.redis = listenerPid(ports.redis) ?? redisSpawn;
  if (!pidAlive(redisSpawn) && !pidAlive(pids.redis)) {
    throw new Error(`redis spawn died and no listener on :${ports.redis} — see ${path.join(logs, "redis.log")}`);
  }
  console.error(`[stack] redis :${ports.redis} (pid ${pids.redis})`);

  // 2. seed once — the patched seed script runs migratePglite itself, then
  // fills the dev fixture. Must finish before the server opens its own PGlite
  // handle on the same dir (embedded = single holder).
  const seedFile = path.join(dir, "seed.json");
  if (!existsSync(seedFile)) {
    console.error("[stack] migrating + seeding dev fixture into pglite…");
    const seed = spawnSync(
      process.execPath,
      ["--import", "@oxc-node/core/register", "scripts/seed.ts", "--output", seedFile],
      { cwd: SERVER_PKG, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8" },
    );
    if (seed.status !== 0) {
      throw new Error(`seed failed:\n${seed.stderr?.slice(-2000) ?? seed.stdout?.slice(-2000)}`);
    }
    console.error("[stack] seeded — login dev@slock.ai / password123");
  }

  // 3. server — embedded PGlite + local-disk storage (S3_* stripped above)
  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    PORT: String(ports.server),
    METRICS_PORT: String(ports.metrics),
    JWT_SECRET: jwtSecret,
    SCOPE_ATTESTATION_SECRET: jwtSecret,
    AGENT_BOOTSTRAP_TOKEN_PEPPER: jwtSecret,
    DEPLOYMENT_ENV: "slockdev",
    APP_URL: `http://localhost:${ports.web}`,
    CORS_ORIGIN: `http://localhost:${ports.web}`,
    SERVER_URL: `http://localhost:${ports.server}`,
  };
  // keep object storage on local disk — any inherited S3_* would flip the backend
  for (const k of Object.keys(serverEnv)) if (k.startsWith("S3_")) delete serverEnv[k];
  const serverSpawn = spawnLogged("server", process.execPath, [
    "--import", "@oxc-node/core/register", "src/server.ts",
  ], { cwd: SERVER_PKG, env: serverEnv, logDir: logs });
  // server "ready" = login endpoint answers (404 on /healthz is expected — it doesn't exist)
  await httpReady(`http://localhost:${ports.server}/api/auth/login`, 90_000).catch(async () => {
    // /api/auth/login is POST-only (405/404 both prove the HTTP layer is up); fall back to a TCP check + log tail
    await tcpReady(ports.server, 5_000).catch(() => {
      throw new Error(`server never listened — see ${path.join(logs, "server.log")}`);
    });
  });
  pids.server = listenerPid(ports.server) ?? serverSpawn;
  console.error(`[stack] server :${ports.server} (pid ${pids.server}, pglite)`);

  // 4. web — vite dev server proxying /api /internal /socket.io /daemon to the server
  const webSpawn = spawnLogged("web", "pnpm", ["exec", "vite", "--port", String(ports.web), "--strictPort"], {
    cwd: WEB_PKG,
    env: { ...process.env, SLOCK_SERVER_PORT: String(ports.server), VITE_DEV_PORT: String(ports.web) },
    logDir: logs,
  });
  await httpReady(`http://localhost:${ports.web}/`, 60_000);
  pids.web = listenerPid(ports.web) ?? webSpawn;
  console.error(`[stack] web :${ports.web} (pid ${pids.web})`);

  const state: StackState = { ports, pids, startedAt: new Date().toISOString() };
  writeFileSync(stackJsonPath(stateDir), JSON.stringify(state, null, 2));
  console.log(`stack up — open http://localhost:${ports.web}  (login dev@slock.ai / password123)`);
  console.log(`logs: ${logs}/  state: ${dir}/`);
  return 0;
}

function stackStop(stateDir: string): number {
  const st = readStack(stateDir);
  if (!st) {
    console.error("no stack state — nothing to stop");
    return 1;
  }
  for (const [name, pid] of Object.entries(st.pids)) {
    if (pid && pidAlive(pid)) {
      // kill the whole process group — vite/pnpm spawn children
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
      console.error(`[stack] stopped ${name} (pid ${pid})`);
    }
  }
  writeFileSync(stackJsonPath(stateDir), JSON.stringify({ ...st, pids: {} }, null, 2));
  return 0;
}

function stackStatus(stateDir: string): number {
  const st = readStack(stateDir);
  if (!st) {
    console.log("stack: not started");
    return 0;
  }
  for (const [name, pid] of Object.entries(st.pids)) {
    const alive = pid ? pidAlive(pid) : false;
    console.log(`${name.padEnd(7)} pid=${pid ?? "-"} ${alive ? `up (${aliveProcNames(pid!)})` : "down"}`);
  }
  console.log(`web: http://localhost:${st.ports.web}  api: http://localhost:${st.ports.server}`);
  return 0;
}

export async function runStack(sub: string | undefined, flags: Record<string, unknown>, stateDir: string): Promise<number> {
  switch (sub) {
    case "start":
    case undefined:
      return stackStart(stateDir, flags);
    case "stop":
      return stackStop(stateDir);
    case "status":
      return stackStatus(stateDir);
    default:
      throw new Error(`unknown stack subcommand: ${sub} (start|stop|status)`);
  }
}

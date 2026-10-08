"""raftd cloud wrapper — uvicorn on $PORT, raftd serve child on 127.0.0.1:$CHILD_PORT.

Security model:
- The PUBLIC edge is this wrapper. Every route except /healthz and the
  console page (GET /) requires the admin key — `Authorization: Bearer` or
  `?key=` (the web console passes the key as a query param).
- The admin key is $RAFTD_KEY, else a generated key persisted at
  $RAFTD_STATE/admin-key (printed to logs on first boot).
- The child daemon always runs with its own internal RAFTD_KEY; the wrapper
  strips whatever the caller sent and injects it — caller credentials are
  verified HERE, never forwarded.

Endpoints beyond the proxy: /healthz (public), /setup/env + /setup/restart
(admin-keyed; manage provider keys durably in $RAFTD_DATA/.env, merged on
top of the legacy $RAFTD_STATE/child.env so upgrades keep old config).

State lives under $RAFTD_STATE (default /data/.raftd) — mount a volume at
/data so SQLite/deliveries/admin-key survive deploys.
"""
import asyncio
import os
import secrets
import subprocess
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

DATA_DIR = Path(os.environ.get("RAFTD_DATA", "/data"))
STATE = Path(os.environ.get("RAFTD_STATE", str(DATA_DIR / ".raftd")))
CHILD_PORT = int(os.environ.get("RAFTD_CHILD_PORT", "4893"))
PUBLIC_PORT = int(os.environ.get("PORT", "8080"))
REPO_ROOT = Path(os.environ.get("RAFTD_REPO", "/raftbuild-durable"))
ENVFILE = DATA_DIR / ".env"
LEGACY_ENVFILE = STATE / "child.env"  # pre-2026-10 location — still honored
ADMIN_KEY_FILE = STATE / "admin-key"

# Must stay in sync with detectEnvProviders() in packages/agent/src/daemon.ts.
ENV_KEYS = (
    "ZAI_CODING_CN_API_KEY",
    "zhipu",
    "ZAI_API_KEY",
    "MINIMAX_CN_API_KEY",
    "MINIMAX_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
)

_child: subprocess.Popen | None = None
_client: httpx.AsyncClient | None = None
_child_key = f"raftd-child-{secrets.token_hex(16)}"  # internal only, per boot
_ready_task: "asyncio.Task[bool] | None" = None
_child_ready = False


def _load_admin_key() -> str:
    """Public-edge key: env wins, else a generated key persisted on the volume."""
    env = os.environ.get("RAFTD_KEY", "").strip()
    if env:
        return env
    try:
        k = ADMIN_KEY_FILE.read_text().strip()
        if k:
            return k
    except OSError:
        pass
    k = secrets.token_hex(16)
    ADMIN_KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    ADMIN_KEY_FILE.write_text(k)
    print(f"[raftd-wrapper] admin key: {k} (persisted at {ADMIN_KEY_FILE})", flush=True)
    return k


ADMIN_KEY = _load_admin_key()


def _authed(req: Request) -> bool:
    """Caller must prove the PUBLIC key — Bearer header or ?key= query param."""
    if req.headers.get("authorization") == f"Bearer {ADMIN_KEY}":
        return True
    return req.query_params.get("key") == ADMIN_KEY


def _load_envfile() -> dict[str, str]:
    """Provider env for the child: legacy child.env first, .env overrides."""
    merged: dict[str, str] = {}
    for f in (LEGACY_ENVFILE, ENVFILE):
        try:
            lines = f.read_text().splitlines()
        except OSError:
            continue
        for line in lines:
            if "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                merged[k.strip()] = v.strip()
    return merged


async def _wait_ready(timeout_s: int = 120) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if _child is None or _child.poll() is not None:
            return False
        try:
            r = await _client.get("/api/state", headers={"authorization": f"Bearer {_child_key}"})
            if r.status_code == 200:
                return True
        except httpx.HTTPError:
            pass
        await asyncio.sleep(1)
    return False


def _spawn() -> bool:
    """Spawn the node child unless one is already alive. Returns spawned?"""
    global _child
    if _child is not None and _child.poll() is None:
        return False
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update(_load_envfile())
    # The child only ever sees the internal key — the public admin key is
    # verified by the wrapper and never reaches the daemon's trust boundary.
    env["RAFTD_KEY"] = _child_key
    env["RAFTD_STATE"] = str(STATE)
    node = env.get("NODE_BIN", "node")
    _child = subprocess.Popen(
        [node, "--experimental-transform-types",
         str(REPO_ROOT / "packages/agent/src/cli.ts"),
         "serve", "--state", str(STATE), "--host", "127.0.0.1", "--port", str(CHILD_PORT)],
        env=env, stdout=sys.stdout, stderr=sys.stderr,
    )
    return True


def _publish_port() -> None:
    """Thin-CLI discovery: raftd.port must name the PUBLIC entry (this
    wrapper), not the child's loopback port — the key a CLI user holds is
    the public admin key, which only we accept. The child writes its own
    port at startup; we overwrite it once the child is actually ready (and
    after every respawn). raftd.internal-port keeps the real child port
    discoverable for debugging."""
    try:
        (STATE / "raftd.port").write_text(f"127.0.0.1:{PUBLIC_PORT}")
        (STATE / "raftd.internal-port").write_text(f"127.0.0.1:{CHILD_PORT}")
    except OSError:
        pass


async def _bring_up() -> bool:
    """Spawn + wait for readiness. ANY failure (spawn error, child died,
    readiness timeout) returns False so callers refuse with an explicit
    503 — an exception here must never escape as a 500."""
    global _child_ready
    try:
        _spawn()
        ok = await _wait_ready()
    except Exception:
        _child_ready = False
        return False
    _child_ready = ok
    if ok:
        _publish_port()
    return ok


async def _ensure_up() -> bool:
    """Shared bring-up. A live child pid is NOT proof of readiness (the
    process exists before it listens), so every caller — the boot task and
    N concurrent requests after a crash — awaits the SAME readiness task
    instead of each probing/respawning on its own."""
    global _ready_task, _child_ready
    if _child is not None and _child.poll() is not None:
        _child_ready = False
    if _child_ready:
        return True
    if _ready_task is None or _ready_task.done():
        _ready_task = asyncio.create_task(_bring_up())
    return await _ready_task


def _stop_child() -> None:
    if _child is not None and _child.poll() is None:
        _child.terminate()
        try:
            _child.wait(timeout=8)
        except subprocess.TimeoutExpired:
            _child.kill()
            _child.wait(timeout=5)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _client
    _client = httpx.AsyncClient(base_url=f"http://127.0.0.1:{CHILD_PORT}",
                                timeout=httpx.Timeout(120.0))
    asyncio.create_task(_ensure_up())
    yield
    # Uvicorn owns signal handling and reaches here on SIGTERM/SIGINT —
    # reaping the child in lifespan keeps the parent's exit path intact.
    _stop_child()
    await _client.aclose()


app = FastAPI(title="raftd cloud wrapper", lifespan=lifespan)


@app.get("/healthz")
async def healthz():
    alive = _child is not None and _child.poll() is None
    if not alive:
        return JSONResponse({"ok": False, "raftd": "dead"}, status_code=503)
    try:
        r = await _client.get("/api/state",
                              headers={"authorization": f"Bearer {_child_key}"}, timeout=5)
        if r.status_code == 200:
            return {"ok": True, "raftd": "up"}
    except httpx.HTTPError:
        pass
    return JSONResponse({"ok": False, "raftd": "starting"}, status_code=503)


@app.post("/setup/env")
async def setup_env(req: Request):
    if not _authed(req):
        return JSONResponse({"error": "unauthorized — pass ?key= or Authorization: Bearer"},
                            status_code=401)
    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    # Merge into the existing merged view — a partial update must not wipe
    # other keys, and keys living only in the legacy file survive.
    existing = _load_envfile()
    saved = []
    for k in ENV_KEYS:
        v = body.get(k)
        if isinstance(v, str) and v.strip():
            existing[k] = v.strip()
            saved.append(k)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ENVFILE.write_text("".join(f"{k}={v}\n" for k, v in existing.items()))
    return {"ok": True, "saved": saved, "hint": "POST /setup/restart to apply"}


@app.post("/setup/restart")
async def setup_restart(req: Request):
    if not _authed(req):
        return JSONResponse({"error": "unauthorized — pass ?key= or Authorization: Bearer"},
                            status_code=401)
    _stop_child()
    ok = await _ensure_up()
    return {"ok": ok, "health": "up" if ok else "starting"}


async def _send_upstream(req: Request, path: str) -> httpx.Response | None:
    """One upstream request with a single respawn+retry on transport failure."""
    headers = {k: v for k, v in req.headers.items()
               if k.lower() not in ("host", "content-length", "authorization")}
    headers["authorization"] = f"Bearer {_child_key}"
    # Strip the public key param — the child authenticates by Bearer only.
    params = [(k, v) for k, v in req.query_params.multi_items() if k != "key"]
    body = await req.body()
    for attempt in range(2):
        ureq = _client.build_request(req.method, f"/{path}",
                                     headers=headers, params=params, content=body)
        try:
            return await _client.send(ureq, stream=True)
        except httpx.HTTPError:
            # Child died or isn't listening yet — every waiter shares ONE
            # bring-up task; a live pid without readiness is not served.
            global _child_ready
            _child_ready = False
            if attempt == 0 and await _ensure_up():
                continue
            return None
    return None


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy(path: str, req: Request):
    # The console page itself is public (it prompts for the key); everything
    # else — /api/*, any other path — requires the admin key at the edge.
    if not _authed(req) and not (req.method == "GET" and path in ("", "favicon.ico")):
        return JSONResponse({"error": "unauthorized — pass ?key= or Authorization: Bearer"},
                            status_code=401)
    if not _child_ready:
        # Not ready (dead OR still starting) — join the shared bring-up
        # rather than racing a raw connection against a pid that only just
        # spawned. A hard refusal here is an explicit 503, never a 502.
        if not await _ensure_up():
            return JSONResponse({"error": "raftd is starting"}, status_code=503)
    upstream = await _send_upstream(req, path)
    if upstream is None:
        return JSONResponse({"error": "raftd unreachable"}, status_code=502)
    # The upstream response must stay open until the stream finishes — aclose
    # rides on the response background task, not an `async with` (httpx
    # Response is not an async context manager).
    return StreamingResponse(
        upstream.aiter_raw(),
        status_code=upstream.status_code,
        headers={k: v for k, v in upstream.headers.items()
                 if k.lower() not in ("transfer-encoding", "content-length",
                                      "connection", "content-encoding")},
        background=BackgroundTask(upstream.aclose),
    )

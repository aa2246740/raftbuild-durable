"""raftd cloud wrapper — uvicorn on $PORT, raftd serve child on 127.0.0.1:4893.

Every request proxied; the child serves the web console + the full API.
/setup/env writes provider keys to DATA_DIR/.env (raftd reads it on boot).

State lives under $RAFTD_STATE (default /data/.raftd) — mount a Fly volume
at /data so SQLite/deliveries survive deploys.
"""
import asyncio
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

DATA_DIR = Path(os.environ.get("RAFTD_DATA", "/data"))
STATE = os.environ.get("RAFTD_STATE", str(DATA_DIR / ".raftd"))
CHILD_PORT = int(os.environ.get("RAFTD_CHILD_PORT", "4893"))
REPO_ROOT = Path(os.environ.get("RAFTD_REPO", "/raftbuild-durable"))
ENVFILE = DATA_DIR / ".env"
ADMIN_KEY = os.environ.get("RAFTD_KEY", "").strip()

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

app = FastAPI(title="raftd cloud wrapper")
_child: subprocess.Popen | None = None
_client: httpx.AsyncClient | None = None
_child_key: str | None = None


def _headers() -> dict[str, str]:
    return {"authorization": f"Bearer {_child_key}"} if _child_key else {}


async def _wait_ready(timeout_s: int = 180) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if _child is None or _child.poll() is not None:
            return False
        try:
            # Authenticated probe — with a child key the unauthenticated
            # request only ever sees 401 and readiness never lands.
            r = await _client.get("/api/state", headers=_headers())
            if r.status_code == 200:
                return True
        except httpx.HTTPError:
            pass
        await asyncio.sleep(1)
    return False


def _spawn() -> bool:
    """Spawn the node child unless one is already alive. Returns spawned?"""
    global _child, _child_key
    if _child is not None and _child.poll() is None:
        return False
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    if ENVFILE.exists():
        for line in ENVFILE.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip()
    # The child always gets a key on this bind: bearer protects the LAN
    # side; the wrapper injects it on every proxied call.
    _child_key = env.get("RAFTD_KEY", "").strip() or "raftd-cloud-internal"
    env["RAFTD_KEY"] = _child_key
    node = env.get("NODE_BIN", "node")
    _child = subprocess.Popen(
        [node, "--experimental-transform-types",
         str(REPO_ROOT / "packages/agent/src/cli.ts"),
         "serve", "--state", STATE, "--host", "127.0.0.1", "--port", str(CHILD_PORT)],
        env=env, stdout=sys.stdout, stderr=sys.stderr,
    )
    return True


async def _ensure_up() -> bool:
    _spawn()
    return await _wait_ready()


def _stop_child() -> None:
    if _child is not None and _child.poll() is None:
        _child.terminate()
        try:
            _child.wait(timeout=8)
        except subprocess.TimeoutExpired:
            _child.kill()
            _child.wait(timeout=5)


@app.on_event("startup")
async def startup() -> None:
    global _client
    _client = httpx.AsyncClient(base_url=f"http://127.0.0.1:{CHILD_PORT}", timeout=httpx.Timeout(120.0))
    # SIGTERM (Fly scale-down/deploy): reap the node child or it outlives us.
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGTERM, _stop_child)
    loop.add_signal_handler(signal.SIGINT, _stop_child)
    asyncio.create_task(_ensure_up())


@app.on_event("shutdown")
async def shutdown() -> None:
    _stop_child()
    if _client is not None:
        await _client.aclose()


@app.get("/healthz")
async def healthz():
    alive = _child is not None and _child.poll() is None
    if not alive:
        return JSONResponse({"ok": False, "raftd": "dead"}, status_code=503)
    try:
        r = await _client.get("/api/state", headers=_headers(), timeout=5)
        if r.status_code == 200:
            return {"ok": True, "raftd": "up"}
    except httpx.HTTPError:
        pass
    return JSONResponse({"ok": False, "raftd": "starting"}, status_code=503)


@app.post("/setup/env")
async def setup_env(req: Request):
    if ADMIN_KEY and req.headers.get("authorization") != f"Bearer {ADMIN_KEY}":
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    # Merge into the existing file — a partial update must not wipe other keys.
    existing: dict[str, str] = {}
    if ENVFILE.exists():
        for line in ENVFILE.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                existing[k.strip()] = v.strip()
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
    if ADMIN_KEY and req.headers.get("authorization") != f"Bearer {ADMIN_KEY}":
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    _stop_child()
    ok = await _ensure_up()
    return {"ok": ok, "health": "up" if ok else "starting"}


async def _stream(resp):
    async for chunk in resp.aiter_bytes():
        yield chunk


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy(path: str, req: Request):
    if _child is None or _child.poll() is not None:
        # Respawn on demand — a crashed child shouldn't leave every request 502.
        if not await _ensure_up():
            return JSONResponse({"error": "raftd is starting"}, status_code=503)
    url = f"/{path}" + (f"?{req.url.query}" if req.url.query else "")
    headers = dict(req.headers)
    headers.pop("host", None)
    headers.pop("content-length", None)
    # Browser console passes the key as ?key= (EventSource can't set headers) —
    # the child's API only accepts Bearer, so translate it here.
    if ADMIN_KEY:
        headers["authorization"] = f"Bearer {ADMIN_KEY}"
    elif _child_key:
        headers["authorization"] = f"Bearer {_child_key}"
    body = await req.body()
    try:
        upstream = await _client.request(req.method, url, headers=headers, content=body, stream=True)
    except httpx.HTTPError as e:
        # Child died between health and request — respawn once, retry once.
        if _spawn() and await _wait_ready(60):
            try:
                upstream = await _client.request(req.method, url, headers=headers, content=body, stream=True)
            except httpx.HTTPError:
                return JSONResponse({"error": f"raftd unreachable: {e}"}, status_code=502)
        else:
            return JSONResponse({"error": f"raftd unreachable: {e}"}, status_code=502)
    try:
        async with upstream:
            return StreamingResponse(
                _stream(upstream),
                status_code=upstream.status_code,
                headers={k: v for k, v in upstream.headers.items()
                         if k.lower() not in ("transfer-encoding", "content-length", "connection", "content-encoding")},
            )
    except httpx.HTTPError as e:
        return JSONResponse({"error": f"upstream stream failed: {e}"}, status_code=502)

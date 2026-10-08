"""raftd cloud wrapper — uvicorn on $PORT, raftd serve child on 127.0.0.1:$CHILD_PORT.

Security model:
- The PUBLIC edge is this wrapper. Every route except /healthz and the
  console page (GET /) requires the admin key — `Authorization: Bearer` or
  `?key=` (the web console passes the key as a query param).
- The admin key is $RAFTD_KEY, else a generated key persisted with mode 0600 at
  $RAFTD_STATE/admin-key. Secrets are never printed to logs.
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
import json
import os
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

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
    "MINIMAX_CN",
    "MINIMAX_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
)

_child: subprocess.Popen | None = None
_client: httpx.AsyncClient | None = None
_child_key = ""  # internal only, replaced for every child instance
_child_instance = ""
_ready_task: "asyncio.Task[bool] | None" = None
_child_ready = False
_closing = False
_restart_lock = asyncio.Lock()


def _write_private(file: Path, value: str) -> None:
    """Publish complete secret/config files atomically, even over old 0644 files."""
    file.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{file.name}.", dir=file.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, file)
        directory = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _load_admin_key() -> str:
    """Public-edge key: env wins, else a generated key persisted on the volume."""
    env = os.environ.get("RAFTD_KEY", "").strip()
    if env:
        if ADMIN_KEY_FILE.exists():
            ADMIN_KEY_FILE.chmod(0o600)
        return env
    try:
        k = ADMIN_KEY_FILE.read_text().strip()
    except FileNotFoundError:
        k = ""
    if k:
        _write_private(ADMIN_KEY_FILE, k)
        return k
    k = secrets.token_hex(16)
    _write_private(ADMIN_KEY_FILE, k)
    print(f"[raftd-wrapper] admin key persisted at {ADMIN_KEY_FILE}", flush=True)
    return k


ADMIN_KEY = ""  # initialized only after acquiring wrapper ownership


def _recorded_owner_alive(file: Path) -> bool:
    """Reject live pre-SQLite hosts too, without treating zombies as owners."""
    try:
        owner = json.loads(file.read_text())
        pid = owner.get("pid")
        if not isinstance(pid, int) or pid <= 0:
            return False
    except (OSError, ValueError, AttributeError):
        return False
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        fields = stat[stat.rfind(")") + 2:].split()
        if fields[0] in ("Z", "X", "x"):
            return False
        return owner.get("pidStart") in (None, fields[19])
    except (OSError, IndexError):
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True


def _claim_wrapper() -> sqlite3.Connection:
    """Own public discovery for the wrapper lifetime, independent of respawns.

    Keep this database permanently: unlinking a lock database would allow
    contenders to acquire different inodes. SQLite releases ownership even
    when this process is killed or crashes.
    """
    STATE.mkdir(parents=True, exist_ok=True)
    manager = sqlite3.connect(STATE / "raftd.wrapper.sqlite", timeout=0)
    try:
        manager.execute("BEGIN IMMEDIATE")
        # Older native serves and wrappers do not take the manager lock.
        # Check its actual storage lock before touching public discovery.
        storage = sqlite3.connect(STATE / "raftd.lock.sqlite", timeout=0)
        try:
            storage.execute("BEGIN IMMEDIATE")
            if (_recorded_owner_alive(STATE / "raftd.lock")
                    or _recorded_owner_alive(STATE / "raftd.lock.takeover" / "owner.json")):
                raise RuntimeError("state directory already has a live raftd host; stop it before starting the wrapper")
        finally:
            storage.close()
        return manager
    except Exception:
        manager.close()
        raise


def _authed(req: Request) -> bool:
    """Caller must prove the PUBLIC key — Bearer header or ?key= query param."""
    header = req.headers.get("authorization", "")
    if header.startswith("Bearer ") and secrets.compare_digest(header[7:].encode(), ADMIN_KEY.encode()):
        return True
    return secrets.compare_digest(req.query_params.get("key", "").encode(), ADMIN_KEY.encode())


def _load_envfile() -> dict[str, str]:
    """Provider env for the child: legacy child.env first, .env overrides."""
    merged: dict[str, str] = {}
    for f in (LEGACY_ENVFILE, ENVFILE):
        try:
            lines = f.read_text().splitlines()
        except OSError:
            continue
        # Upgrade the permissions of old plaintext configuration too, not
        # only files written through the new setup endpoint.
        f.chmod(0o600)
        for line in lines:
            if "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                k, v = k.strip(), v.strip()
                # Persisted configuration is provider data, never arbitrary
                # process control such as NODE_OPTIONS/NODE_BIN/PATH.
                if k in ENV_KEYS and v and "\x00" not in v:
                    merged[k] = v
    return merged


def _is_current(child: subprocess.Popen, instance: str) -> bool:
    return _child is child and _child_instance == instance and child.poll() is None


def _matches_instance(response: httpx.Response, instance: str) -> bool:
    # The instance is only returned by the child, never sent to an unknown
    # listener. An unrelated HTTP 200 on CHILD_PORT is not readiness.
    return response.headers.get("x-raftd-instance") == instance


async def _wait_ready(child: subprocess.Popen, key: str, instance: str,
                      timeout_s: int = 120) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if not _is_current(child, instance):
            return False
        try:
            r = await _client.get("/api/state", headers={"authorization": f"Bearer {key}"},
                                  timeout=2)
            if r.status_code == 200 and _matches_instance(r, instance) and _is_current(child, instance):
                return True
        except httpx.HTTPError:
            pass
        await asyncio.sleep(0.1)
    return False


def _spawn() -> subprocess.Popen:
    """Return the live child, creating a new authenticated instance if needed."""
    global _child, _child_key, _child_instance
    if _child is not None and _child.poll() is None:
        return _child
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _child_key = f"raftd-child-{secrets.token_hex(16)}"
    _child_instance = secrets.token_hex(32)
    env = os.environ.copy()
    env.update(_load_envfile())
    # Public credentials are checked at this edge, never by the child.
    env["RAFTD_KEY"] = _child_key
    env["RAFTD_WRAPPER_INSTANCE"] = _child_instance
    env["RAFTD_STATE"] = str(STATE)
    node = env.get("NODE_BIN", "node")
    _child = subprocess.Popen(
        [node,
         str(REPO_ROOT / "packages/agent/src/cli.ts"),
         "serve", "--state", str(STATE), "--host", "127.0.0.1", "--port", str(CHILD_PORT)],
        env=env, stdout=sys.stdout, stderr=sys.stderr,
    )
    return _child


def _publish_port() -> None:
    """Only the wrapper owns public discovery; failure must prevent readiness."""
    STATE.mkdir(parents=True, exist_ok=True)
    # The thin CLI must discover the public credential, never an old native
    # token or the private credential of a managed child. Publish it first.
    _write_private(STATE / "raftd.token", ADMIN_KEY)
    port_file = STATE / "raftd.port"
    _write_private(port_file, f"127.0.0.1:{PUBLIC_PORT}")


def _unpublish_port() -> None:
    # Only after the child has exited. Leave a differently configured
    # wrapper's discovery alone if this state was moved during shutdown.
    port_file = STATE / "raftd.port"
    try:
        if port_file.read_text() == f"127.0.0.1:{PUBLIC_PORT}":
            port_file.unlink()
    except OSError:
        pass


async def _bring_up() -> bool:
    """Readiness commits only after this child and public discovery are ready."""
    global _child_ready
    _child_ready = False
    try:
        child = _spawn()
        key, instance = _child_key, _child_instance
        if not await _wait_ready(child, key, instance):
            return False
        _publish_port()
        # No await between the final identity check and publishing readiness.
        _child_ready = _is_current(child, instance)
        return _child_ready
    except Exception:
        return False


async def _ensure_up() -> bool:
    """Share bring-up across requests, without letting one cancellation kill it."""
    global _ready_task, _child_ready
    if _closing:
        return False
    if _child is None or _child.poll() is not None:
        _child_ready = False
    if _child_ready:
        return True
    if _ready_task is None or _ready_task.done():
        _ready_task = asyncio.create_task(_bring_up())
    task = _ready_task
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        # A restart replaces/cancels the old generation. Its existing proxy
        # waiters follow the replacement; cancelling the request itself
        # still propagates normally and never cancels shared startup.
        # task.cancelled() tells the shared bring-up's cancellation apart
        # from this waiter's own cancellation (Task.cancelling() needs 3.11+).
        if task.cancelled():
            return await _ensure_up()
        raise


async def _restart_and_bring_up(previous: "asyncio.Task[bool] | None") -> bool:
    if previous is not None and not previous.done():
        previous.cancel()
        await asyncio.gather(previous, return_exceptions=True)
    _stop_child()
    return await _bring_up()


async def _cancel_bring_up() -> None:
    global _ready_task, _child_ready
    task = _ready_task
    if task is not None and not task.done():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    _ready_task = None
    _child_ready = False


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
    global _client, _closing, _ready_task, ADMIN_KEY
    # A second wrapper must fail before changing discovery, credentials, or
    # child state. Ownership spans every restart and all shutdown cleanup.
    manager = _claim_wrapper()
    try:
        ADMIN_KEY = _load_admin_key()
        _closing = False
        # Publish before accepting requests or spawning: early thin CLI
        # calls must go through this edge, never open storage locally.
        _publish_port()
        _client = httpx.AsyncClient(base_url=f"http://127.0.0.1:{CHILD_PORT}",
                                    timeout=httpx.Timeout(120.0), trust_env=False)
        _ready_task = asyncio.create_task(_bring_up())
        try:
            yield
        finally:
            _closing = True
            await _cancel_bring_up()
            # Uvicorn owns signals. Finish/cancel readiness before reaping
            # so a late boot task cannot publish or respawn during exit.
            _stop_child()
            _unpublish_port()
            await _client.aclose()
    finally:
        manager.close()


app = FastAPI(title="raftd cloud wrapper", lifespan=lifespan)


@app.middleware("http")
async def verify_origin(req: Request, call_next):
    origin = req.headers.get("origin")
    if origin is not None:
        try:
            parsed = urlsplit(origin)
            # Check the browser-visible authority. Ignore forwarded host
            # headers entirely; they are not proof of a trusted proxy.
            valid = (parsed.scheme in ("http", "https") and not parsed.username
                     and not parsed.password and not parsed.path
                     and not parsed.query and not parsed.fragment
                     and parsed.netloc.lower() == req.headers.get("host", "").lower())
        except ValueError:
            valid = False
        if not valid:
            return JSONResponse({"error": "cross-origin request is not allowed"}, status_code=403)
    return await call_next(req)


@app.get("/healthz")
async def healthz():
    child, instance = _child, _child_instance
    if child is None or not _is_current(child, instance):
        return JSONResponse({"ok": False, "raftd": "dead"}, status_code=503)
    if _child_ready:
        try:
            r = await _client.get("/api/state",
                                  headers={"authorization": f"Bearer {_child_key}"}, timeout=5)
            if (r.status_code == 200 and _matches_instance(r, instance)
                    and _child_ready and _is_current(child, instance)):
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
        return JSONResponse({"error": "request body is not valid JSON"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "request body must be a JSON object"}, status_code=400)
    # Merge into the existing merged view — a partial update must not wipe
    # other keys, and keys living only in the legacy file survive.
    existing = _load_envfile()
    saved = []
    for k in ENV_KEYS:
        v = body.get(k)
        if isinstance(v, str) and (any(c in v for c in ("\r", "\n", "\x00")) or len(v.splitlines()) > 1):
            return JSONResponse({"error": f"{k} must be a single-line value without NUL"}, status_code=400)
        if isinstance(v, str) and v.strip():
            existing[k] = v.strip()
            saved.append(k)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _write_private(ENVFILE, "".join(f"{k}={v}\n" for k, v in existing.items()))
    return {"ok": True, "saved": saved, "hint": "POST /setup/restart to apply"}


@app.post("/setup/restart")
async def setup_restart(req: Request):
    global _ready_task, _child_ready
    if not _authed(req):
        return JSONResponse({"error": "unauthorized — pass ?key= or Authorization: Bearer"},
                            status_code=401)
    async with _restart_lock:
        previous = _ready_task
        _child_ready = False
        _ready_task = asyncio.create_task(_restart_and_bring_up(previous))
        ok = await asyncio.shield(_ready_task)
    return {"ok": ok, "health": "up" if ok else "starting"}


async def _send_upstream(req: Request, path: str) -> httpx.Response | None:
    """Forward only responses belonging to the current, live child instance."""
    global _child_ready
    headers = {k: v for k, v in req.headers.items()
               if k.lower() not in ("host", "content-length", "authorization", "origin")}
    params = [(k, v) for k, v in req.query_params.multi_items() if k != "key"]
    body = await req.body()
    for attempt in range(2):
        if not await _ensure_up():
            return None
        child, instance = _child, _child_instance
        headers["authorization"] = f"Bearer {_child_key}"
        timeout = httpx.Timeout(120.0)
        parts = [part for part in path.split("/") if part]
        if req.method == "GET" and len(parts) >= 4 and parts[:2] == ["api", "agents"] and parts[3] == "answer":
            # Match the child's slash-normalized route and allow its full
            # 300-second ceiling plus response time. Let the child interpret
            # query values (including repeated timeout keys); duplicating JS
            # number/query parsing here can make the proxy expire too early.
            timeout = httpx.Timeout(120.0, read=310.0)
        ureq = _client.build_request(req.method, f"/{path}",
                                     headers=headers, params=params, content=body, timeout=timeout)
        try:
            response = await _client.send(ureq, stream=True)
            if _is_current(child, instance) and _matches_instance(response, instance):
                return response
            await response.aclose()
        except httpx.ReadTimeout:
            # A slow answer is not proof of child death. Do not replay it or
            # turn healthy discovery/health into a startup failure.
            raise
        except httpx.HTTPError:
            pass
        _child_ready = False
        # Never retry a mutation after a response: the operation may already
        # have committed. GET/HEAD are safe to retry on a new child instance.
        if req.method not in ("GET", "HEAD"):
            return None
    return None


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy(path: str, req: Request):
    # The console page itself is public (it prompts for the key); everything
    # else — /api/*, any other path — requires the admin key at the edge.
    if not _authed(req) and not (req.method == "GET" and path in ("", "favicon.ico")):
        return JSONResponse({"error": "unauthorized — pass ?key= or Authorization: Bearer"},
                            status_code=401)
    try:
        upstream = await _send_upstream(req, path)
    except httpx.ReadTimeout:
        return JSONResponse({"error": "raftd response timeout"}, status_code=504)
    if upstream is None:
        return JSONResponse({"error": "raftd unavailable"}, status_code=503)
    # The upstream response must stay open until the stream finishes — aclose
    # rides on the response background task, not an `async with` (httpx
    # Response is not an async context manager).
    return StreamingResponse(
        upstream.aiter_raw(),
        status_code=upstream.status_code,
        headers={k: v for k, v in upstream.headers.items()
                 if k.lower() not in ("transfer-encoding", "content-length",
                                      "connection", "content-encoding", "x-raftd-instance")},
        background=BackgroundTask(upstream.aclose),
    )

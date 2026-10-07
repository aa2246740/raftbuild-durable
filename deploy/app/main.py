"""raftd cloud wrapper: spawn `raftd serve` and reverse-proxy the public surface.

Public-internet safety:
- /api/* and /setup are gated by an admin key (env RAFTD_KEY, or generated
  once into $RAFTD_STATE/admin-key and printed to logs).
- POST /setup/env stores the model provider key durably so the deployed
  box needs no Fly secrets; the child env is reloaded on every spawn.
"""
import os, subprocess, time, urllib.request, uuid
from fastapi import FastAPI, Request, Response
import httpx

RAFTD_PORT = int(os.getenv("RAFTD_INTERNAL_PORT", "4777"))
STATE = os.getenv("RAFTD_STATE", "/data/raftd")
REPO = os.getenv("RAFTD_REPO", "/raftbuild-durable")
ENVFILE = os.path.join(STATE, "child.env")
app = FastAPI()
child = None


def _admin_key() -> str:
    key = os.getenv("RAFTD_KEY")
    if key:
        return key
    kf = os.path.join(STATE, "admin-key")
    if os.path.exists(kf):
        return open(kf).read().strip()
    key = uuid.uuid4().hex[:16]
    os.makedirs(STATE, exist_ok=True)
    with open(kf, "w") as f:
        f.write(key)
    print(f"[raftd-wrapper] admin key: {key} (also in {kf})", flush=True)
    return key


def _ok(request: Request) -> bool:
    key = _admin_key()
    if request.headers.get("authorization") == f"Bearer {key}":
        return True
    return request.query_params.get("key") == key


def _child_env() -> dict:
    env = dict(os.environ, RAFTD_STATE=STATE)
    if os.path.exists(ENVFILE):
        for line in open(ENVFILE):
            line = line.strip()
            if line and "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


def _spawn():
    global child
    if child and child.poll() is None:
        return
    child = subprocess.Popen(
        ["node", "--experimental-transform-types",
         f"{REPO}/packages/agent/src/cli.ts",
         "serve", "--port", str(RAFTD_PORT), "--host", "127.0.0.1"],
        env=_child_env())


@app.on_event("startup")
def startup():
    _spawn()
    for _ in range(180):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{RAFTD_PORT}/api/state", timeout=1)
            return
        except Exception:
            time.sleep(1)


@app.get("/healthz")
def healthz():
    return {"raftd": "up" if child and child.poll() is None else "dead"}


@app.post("/setup/env")
async def setup_env(request: Request):
    if not _ok(request):
        return Response('{"error":"unauthorized"}', 401, {"content-type": "application/json"})
    body = await request.json()
    allowed = {"ZAI_CODING_CN_API_KEY", "zhipu", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"}
    lines = []
    for k, v in body.items():
        if k in allowed and isinstance(v, str) and v.strip():
            lines.append(f"{k}={v.strip()}")
    os.makedirs(STATE, exist_ok=True)
    with open(ENVFILE, "w") as f:
        f.write("\n".join(lines) + "\n")
    global child
    if child and child.poll() is None:
        child.terminate()
        child = None
    _spawn()
    return {"saved": sorted(l.split("=")[0] for l in lines)}


@app.api_route("/{path:path}", methods=["GET", "POST", "DELETE", "PUT"])
async def proxy(path: str, request: Request):
    if path.startswith("api/") and not _ok(request):
        return Response('{"error":"unauthorized — pass ?key= or Authorization: Bearer"}',
                        401, {"content-type": "application/json"})
    _spawn()
    url = f"http://127.0.0.1:{RAFTD_PORT}/{path}"
    async with httpx.AsyncClient(timeout=120) as cli:
        body = await request.body()
        r = await cli.request(request.method, url, content=body,
                              headers={k: v for k, v in request.headers.items()
                                       if k.lower() not in ("host", "content-length")},
                              params=dict(request.query_params))
    return Response(r.content, r.status_code,
                    {k: v for k, v in r.headers.items() if k.lower() in ("content-type",)})

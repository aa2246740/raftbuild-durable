---
name: verify-raftd
description: "Verify the raftd durable-agent daemon by driving it the way a user does — real serve process, real HTTP API, real CLI, real model. Use when a change touches packages/agent (daemon, serve, outbox, lifecycle, console, CLI) or deploy/app (wrapper) and you must prove behavior, not just types. Pair with features/ map for coverage."
---

# Verify raftd

raftd is a single-process durable multi-agent host: `serve` runs the daemon + HTTP API + zero-build web console; `cli` is the same binary talking thin over HTTP when a serve is live. Verification = start a real instance in a disposable state dir, drive it through its user-facing surfaces (HTTP API, CLI, console), and capture evidence.

## Launch

```bash
cd packages/agent && pnpm install
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"   # Node ≥24 required; 24 and 26 both run
STATE=/tmp/verify-raftd-$RUN_ID && mkdir -p "$STATE"
node src/cli.ts serve --state "$STATE" --port 4777 > "$STATE/serve.log" 2>&1 &
echo $! > "$STATE/serve.pid"
```

Ready when `serve.log` prints `raftd serving — console http://127.0.0.1:4777/#key=<token>`. The `#key=` token is also at `$STATE/raftd.token` (mode 0600). Teardown: `kill $(cat $STATE/serve.pid)` — the lock file and `raftd.port` are released on exit.

Model key decides what is verifiable:

- `ZAI_CODING_CN_API_KEY` or `zhipu` set → real GLM answers (`zai-coding-cn/glm-5.3-flash` is the smoke model).
- No key → serve still starts; `create` without an explicit `--model` fails fast, and created agents answer `no_model`. Enough for API/security/workspace verification, NOT for answer-content claims.

## Doctor

Run this first whenever anything looks off — answers "is this instance worth driving?":

```bash
TOKEN=$(cat "$STATE/raftd.token")
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4777/api/state          # expect 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4777/api/state  # expect 200
kill -0 $(cat "$STATE/serve.pid") && tail -3 "$STATE/serve.log"
```

401 without key + 200 with key = serve is ours and auth is live. If `raftd.port` exists but the port does not answer, the previous instance died — `node src/cli.ts` one-shot commands will refuse rather than double-open the state; remove the stale `raftd.port` only after confirming the PID is dead. A second `serve` on a live state dir is refused by the SQLite machine lock — that refusal is correct behavior, not a bug; pick another `--state`/`--port` instead.

## Drive

**HTTP API** (stable routes, `Authorization: Bearer $TOKEN`, mutations need `Content-Type: application/json`):

- `POST /api/agents` `{name, model:"provider/model-id"}` → `201 {agentId, workspacePath}` (409 name taken / 400 bad model or reserved name)
- `POST /api/agents/<id|name>/messages` `{text}` → `202 {submissionId}` (409 busy-reject with `whenBusy:"reject"`, 409 stopped)
- `GET /api/agents/<id>/answer?submissionId=<sid>&timeout=<s>` → answer or `504` (server ceiling 300s)
- `GET /api/state`, `/api/agents/<id>/{feed,events,outbox,deliveries,lifecycle,usage}`, `POST /api/agents/<id>/{stop,start,resolve,abort,compact,reset}`, `DELETE /api/agents/<id>?workspace=true`, `PATCH /api/agents/<id>`, `GET/POST/DELETE /api/reminders`, `GET /api/usage`

**CLI**: `node src/cli.ts --state "$STATE" <cmd>` (or `pnpm cli`). With a live serve the thin client auto-discovers `raftd.port` + `raftd.token` and speaks HTTP — `list`, `send`, `wait <agent> <submissionId>`, `answer`, `create`, `remind`, `lifecycle`, `outbox`, `events`, `deliveries`, `stop`, `start`, `resolve`, `update`, `usage`. Offline (no serve) CLI commands open the state read-write through the lock and queue submissions durably without running them.

**Console**: browse `http://127.0.0.1:4777/#key=$TOKEN` (screenshots via computer tool; CDP endpoint localhost:29229 for Playwright). 401 shows an inline login form, not a prompt loop.

## Evidence

- HTTP proof: the curl `-w %{http_code}` line + response body, not just "worked".
- CLI proof: command + stdout + exit code.
- State proof: files under `$STATE` — `workspaces/<agentId>/` for tool side effects, `tool-children.jsonl` for spawned children, `raftd.lock` owner JSON, `deliveries`/`outbox` API output for frames.
- Model proof: answer text + `GET feed` showing the assistant turn; never trust a claimed send without a settled answer (`status:"done"`).
- Keep artifacts in a named dir that survives cleanup, e.g. `$STATE/evidence/` — kill only the PID in `serve.pid`; never `pkill` by name (you might kill the user's own instance on another state dir).

For full-model regression run `pnpm e2e` (needs a key; aborts without one and never leaves a stale green report) and `pnpm test:reliability` (key-free: node `test/*.test.mjs` + python `deploy/tests/`).

## Cleanup

```bash
kill $(cat "$STATE/serve.pid") 2>/dev/null; sleep 1
# confirm: port silent, raftd.port removed; evidence files under $STATE/ persist
rm -rf "$STATE"    # only after evidence is copied out or no longer needed
```

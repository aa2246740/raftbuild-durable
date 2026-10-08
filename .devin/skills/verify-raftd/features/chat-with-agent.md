# Chat with an agent

The core loop: create a named agent, send it a message, and read a settled answer — over HTTP or the CLI. This is the path every user takes first; it also exercises the durable submission → outcome pipeline end to end.

## Sub-features

- `create-http` creates an agent via `POST /api/agents` and returns its `agentId` + workspace.
- `send-answer` posts a message and waits for `status:"done"` via the answer endpoint.
- `feed-replay` shows the same turn again in `GET feed` (user + assistant rows).
- `tool-side-effect` proves tool execution by a file the agent's bash wrote into `workspaces/<agentId>/`.
- `create-cli` does the same create through `node src/cli.ts create`.

## How to get to it (user POV)

- Web console: `/#key=` → create agent button → chat input → answer bubbles.
- HTTP API: `POST /api/agents`, `POST .../messages`, `GET .../answer`, `GET .../feed`.
- CLI: `node src/cli.ts create`, `send`, `wait`, `feed`.

## Driving it with curl + CLI

Preconditions: serve running (SKILL.md Launch), `B` and `TOKEN` set, model key present for answer-content claims.

- Create: `curl -s -H "Authorization: Bearer $TOKEN" -X POST $B/api/agents -H 'Content-Type: application/json' -d '{"name":"probe","model":"zai-coding-cn/glm-5.3-flash"}'` → 201, note `agentId`. Proof: `GET $B/api/state` lists the agent.
- Send: `curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"text":"reply with exactly PONG"}' $B/api/agents/probe/messages` → 202 `{submissionId}`.
- Answer: `curl -s -H "Authorization: Bearer $TOKEN" "$B/api/agents/probe/answer?submissionId=$SID&timeout=120"` → `{status:"done", text:...}` containing `PONG`.
- Feed: `curl -s -H "Authorization: Bearer $TOKEN" $B/api/agents/probe/feed` shows the user turn and the assistant turn.
- Tool side effect: send `"run bash: echo hi-VERIFY > /tmp/verify-file, then say DONE"`; proof = `cat "$STATE/workspaces/<agentId>/tmp/verify-file"`… workspace-relative paths apply — have the agent write `verify-file` and check `$STATE/workspaces/<agentId>/verify-file`.
- CLI path: `node src/cli.ts --state $STATE create probe2 --model zai-coding-cn/glm-5.3-flash` then `send probe2 "reply PONG"` prints the settled answer.

## Gotchas

- A `202` on send only means queued — the proof is the settled answer, not the POST result.
- `answer?timeout` ceiling is 300s server-side; thin CLI resumes automatically across 504s.
- Without a model key `create` needs an explicit `--model`; messages then settle as `no_model`, which is expected, not a failure to mask.
- Agent names map to `agentId`s server-side; prefer id in recipes to avoid name-collision noise across runs.

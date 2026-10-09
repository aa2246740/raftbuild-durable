# P3 — daemon contract survey (raftd-as-computer)

Goal: our raftd (pi-durable) connects to the vendored server as a **machine**,
runs agents as **pi-durable sessions**, and implements everything the server
expects from a computer + agent runtime.

## Transport layer — machine WebSocket

- Endpoint: `ws://<server>/daemon/connect` (upgrade handled in
  `upstream/packages/server/src/routes/daemon.ts` — WebSocketServer, bearer or
  `?key=` machine credential; 401 + `Slock-Reason` header on reject).
- Auth principal: `agentCredentials.ts` (334 lines) + `computerCredentialService.ts`.
- **Machine → server frames** (see `upstream/packages/daemon/src/connection.ts`,
  ack/replay logic ~lines 250-760):
  `ready`, `ping`, `agent:status`, `agent:activity`, `agent:session`,
  `agent:session:invalidate`, `agent:runtime_profile`,
  `agent:runtime_profile:migration:ack`,
  `agent:runtime_profile:migration_done`,
  `agent:runtime_profile:daemon_release_notice:ack`.
  `agent:activity`/`agent:status` carry `clientSeq` — server acks and the client
  must replay unacked frames on reconnect (queue/drop/superseded dispositions in
  connection.ts).
- **Server → machine frames**: agent launches, wake hints, steer/abort,
  runtime-profile migrations — send sites live in
  `services/agentOrchestrator.ts` (15,141 lines — the dispatch brain) and
  `services/machineResponseRelay.ts` / `machineLocalReplay.ts` /
  `runtimeOutcomeOutboxIngest.ts` (the outcome backhaul).
  TODO(next): enumerate the inbound frame vocabulary — grep agentOrchestrator
  for `.send(` / frame builders; catalog into this file.
- Drain semantics: server broadcasts going-away on shutdown (`machineDrain.ts`),
  machines should finish/refuse new launches accordingly.

## Agent runtime layer — session protocol

`upstream/packages/daemon/src/agentProcessManager.ts` (~9k+ lines) drives each
agent process and speaks a per-session frame vocabulary:
`session_init`, `thinking`, `text`, `tool_call`, `tool_output`,
`compaction_started/finished/interrupted`, `review_started/finished`,
`turn_end`, `error`, plus stdin frames `notify_stdin`/`deliver_stdin` and tool
surfaces (`bash`, `check_messages`, `receive_message`, `slock_cli` inputs).

**This maps almost 1:1 onto pi-durable's normalized transcript events** — the
bridge adapter translates Harness session events into these frames (and
wake/steer inputs back into submissions). `apmStateMachine.ts` defines the
lifecycle states the server derives (`running_with_recent_progress`, `idle`,
`runtime_crashed`, `stopped`, …) — our mapping must emit states that keep the
orchestrator's expectations honest.

## REST support surface — /internal/*

`routes/internalAgentApi.ts` (8,692 lines) is the daemon's REST adjunct:
labs flags, server avatar, mention deliveries, channels CRUD + members,
wake-hints (+ stream), activity posts, third-party-events/delivered,
attachment comments/upload sessions, and more. `routes/internal.ts` (5,312
lines) holds the machine/computer REST (registration, heartbeats, versions).
`managedMcp.ts` (487) covers managed MCP config distribution.

TODO(next): full route inventory → `docs/internal-routes.md` (grep patterns
already used: `\.(get|post|put|patch|delete)\(\s*"/` per file).

## Bridge design (sketch)

`packages/agent/src/stack.ts` grows a `computer` child OR a new
`packages/bridge/` package:

1. **Machine client**: WS to `/daemon/connect`, handshake `ready`, heartbeat
   `ping`, replay queue for unacked `clientSeq` frames.
2. **Launch dispatcher**: on server launch frame → create/find a raftd agent
   (pi-durable Harness) in an isolated state dir; map server agent profile →
   `AgentModelRef` + instructions.
3. **Event translator**: Harness transcript → session frames
   (thinking/text/tool_call/turn_end…) + `agent:status`/`agent:activity`
   with monotonically increasing `clientSeq`.
4. **Backhaul**: runtime outcomes via `runtimeOutcomeOutboxIngest` contract —
   verify whether it's WS frames or REST POST (check its imports).
5. **Steer/abort**: inbound frames → `steer`/`abort` on the raftd agent.
6. **Files**: workspace = raftd agent workspace; attachments via local-disk
   storage endpoints.

## Verified so far

- `raftd stack` brings server+web up on pglite (P2 done) — P3's testbed exists:
  connect a bridge to `ws://localhost:3098/daemon/connect` and watch the
  Computers page flip a machine online.
- Seed machines: `seed.json` contains machine + agent records already
  (dev-machine, assistant agent) — registering a real WS under that machine id
  is the fastest first acceptance signal.

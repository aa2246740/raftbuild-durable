# E2E report — raftbuild-durable

stateDir: `/tmp/raftd-e2e-3k7H87`  model: zai-coding-cn/glm-5.3-flash  duration: 121s

| phase | check | result | detail |
|---|---|---|---|
| A — create agent, real GLM round trip | agent created | PASS | agent-7a854a69 |
| A — create agent, real GLM round trip | workspace seeded (MEMORY.md + notes/) | PASS | /tmp/raftd-e2e-3k7H87/workspaces/agent-7a854a69 |
| A — create agent, real GLM round trip | answer status done | PASS | status=done |
| A — create agent, real GLM round trip | answer contains PONG | PASS | PONG |
| A — create agent, real GLM round trip | runtime:outcome frame delivered | PASS |  |
| A — create agent, real GLM round trip | outcome is turn_completed | PASS | {"type":"agent:runtime:outcome","agentId":"agent-7a854a69","submissionId":"12","outcome":{"kind":"turn_completed","textEvents":1,"toolCalls":0}} |
| A — create agent, real GLM round trip | start frame delivered first (clientSeq 1) | PASS |  |
| A — create agent, real GLM round trip | transcript has model events | PASS |  |
| A — create agent, real GLM round trip | transcript has submission_settled | PASS |  |
| A — create agent, real GLM round trip | lifecycle idle | PASS | idle |
| B — tool use: bash writes a file in the workspace | answer status done | PASS | status=done reason=- |
| B — tool use: bash writes a file in the workspace | hello.txt exists in workspace | PASS |  |
| B — tool use: bash writes a file in the workspace | hello.txt content is hello-e2e-* | PASS | hello-e2e-1791394466 |
| B — tool use: bash writes a file in the workspace | transcript saw tool_call bash | PASS |  |
| B — tool use: bash writes a file in the workspace | transcript saw tool_output | PASS |  |
| C — SIGKILL mid-run → reopen → resume → delivered exactly once | worker placed a submission | PASS | SUBMISSION 25 |
| C — SIGKILL mid-run → reopen → resume → delivered exactly once | worker killed mid-run | PASS | killed during tool call |
| C — SIGKILL mid-run → reopen → resume → delivered exactly once | submission settled after reopen+resume | PASS | SETTLED 25 status=done text=CRASH-TEST-DONE |
| C — SIGKILL mid-run → reopen → resume → delivered exactly once | exactly one outcome frame for the crashed submission | PASS | frames=1 |
| C — SIGKILL mid-run → reopen → resume → delivered exactly once | no duplicate clientSeq deliveries | PASS | seqs=1,2,3,4 |
| D — whenBusy:steer joins the running turn | steered submission placed | PASS |  |
| D — whenBusy:steer joins the running turn | original submission answered | PASS | done |
| D — whenBusy:steer joins the running turn | steered submission answered | PASS | done  |
| D — whenBusy:steer joins the running turn | steer visible in answer (secret word reached the model) | PASS | a1=BASE KUMQUAT a2=BASE KUMQUAT |
| H — send_message routing (agent→agent, agent→main, bounce) | alpha→beta message routed (durable submission on beta) | PASS |  |
| H — send_message routing (agent→agent, agent→main, bounce) | routed submission settled | PASS |  |
| H — send_message routing (agent→agent, agent→main, bounce) | beta→main landed in operator inbox | PASS |  |
| H — send_message routing (agent→agent, agent→main, bounce) | inbox entry names the sender | PASS | beta |
| H — send_message routing (agent→agent, agent→main, bounce) | bounce notice returned to sender | PASS |  |
| I — durable reminder fires as a system notice | reminder committed durably | PASS | rem-0bf6ed86 |
| I — durable reminder fires as a system notice | reminder fired into the conversation | PASS |  |
| I — durable reminder fires as a system notice | one-shot removed after firing | PASS |  |
| J — machineLock, raftd serve, console, thin-CLI remote | first lock acquires | PASS |  |
| J — machineLock, raftd serve, console, thin-CLI remote | second acquire refused while live | PASS |  |
| J — machineLock, raftd serve, console, thin-CLI remote | double serve refused (exit!=0, lock error) | PASS | state dir already locked by pid 40181 (started 2026-10-07T17:36:05.171Z) |
| J — machineLock, raftd serve, console, thin-CLI remote | serve came up | PASS | (node:40773) ExperimentalWarning: Transform Types is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created) raftd serving — consol |
| J — machineLock, raftd serve, console, thin-CLI remote | /api/state lists the agents | PASS | 2 agents |
| J — machineLock, raftd serve, console, thin-CLI remote | console HTML served | PASS |  |
| J — machineLock, raftd serve, console, thin-CLI remote | `raftd list` spoke to the live serve | PASS | (node:40785) ExperimentalWarning: Transform Types is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the war |
| J — machineLock, raftd serve, console, thin-CLI remote | agent created over HTTP | PASS | agent-7a1f0a95 |
| J — machineLock, raftd serve, console, thin-CLI remote | HTTP round trip answered | PASS | READY |
| J — machineLock, raftd serve, console, thin-CLI remote | serve released the lock on exit | PASS |  |
| J — machineLock, raftd serve, console, thin-CLI remote | port file cleaned up | PASS |  |
| K — cold-wake recycle compacts after idle silence | first message answered | PASS | done |
| K — cold-wake recycle compacts after idle silence | no compact on first message (no observed idle) | PASS | calls=0 |
| K — cold-wake recycle compacts after idle silence | wake-compact triggered once | PASS | calls=1 |
| K — cold-wake recycle compacts after idle silence | message still answered after recycle | PASS | done |
| E — outbox invariants (scripted transports) | exactly one committed delivery after 2 failures | PASS | sent=1 |
| E — outbox invariants (scripted transports) | retransmitted with the same clientSeq until 3rd attempt | PASS | attempt=3 |
| E — outbox invariants (scripted transports) | exact-ack deletion | PASS |  |
| E — outbox invariants (scripted transports) | cap drop prefers oldest non-in-flight turn_completed | PASS | {"clientSeq":129,"result":"dropped_turn_completed"} |
| E — outbox invariants (scripted transports) | entries still at cap | PASS | entries=128 |
| E — outbox invariants (scripted transports) | dropped seq was 128 | PASS |  |
| E — outbox invariants (scripted transports) | fail-closed append throws overflow | PASS |  |
| E — outbox invariants (scripted transports) | agent marked unreliable durably | PASS |  |
| E — outbox invariants (scripted transports) | appends refused while unreliable | PASS |  |
| E — outbox invariants (scripted transports) | resolve clears marker + records resolution | PASS |  |
| E — outbox invariants (scripted transports) | append works again after resolve + backlog compacted | PASS |  |
| F — workspace containment | direct child resolves | PASS |  |
| F — workspace containment | nested path rejected | PASS |  |
| F — workspace containment | traversal rejected | PASS |  |
| F — workspace containment | absolute rejected | PASS |  |
| F — workspace containment | dot rejected | PASS |  |
| G — runtime input formatting | envelope has target/msg/time/type | PASS |   second line |
| G — runtime input formatting | sender handle | PASS | [target=main msg=abcdef12 time=2026-10-07T12:00:00Z type=user] @wu: first line   |
| G — runtime input formatting | continuation lines indented (anti-forgery) | PASS |  |
| G — runtime input formatting | envelope + reply hint present | PASS |  |

67/67 checks passed.
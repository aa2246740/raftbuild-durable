# E2E report — raftbuild-durable

stateDir: `/tmp/raftd-e2e-MX3RJt`  model: zai-coding-cn/glm-5.3-flash  duration: 80s

| phase | check | result | detail |
|---|---|---|---|
| A — create agent, real GLM round trip | agent created | PASS | agent-c51d8fc4 |
| A — create agent, real GLM round trip | workspace seeded (MEMORY.md + notes/) | PASS | /tmp/raftd-e2e-MX3RJt/workspaces/agent-c51d8fc4 |
| A — create agent, real GLM round trip | answer status done | PASS | status=done |
| A — create agent, real GLM round trip | answer contains PONG | PASS | PONG |
| A — create agent, real GLM round trip | runtime:outcome frame delivered | PASS |  |
| A — create agent, real GLM round trip | outcome is turn_completed | PASS | {"type":"agent:runtime:outcome","agentId":"agent-c51d8fc4","submissionId":"12","outcome":{"kind":"turn_completed","textEvents":1,"toolCalls":0}} |
| A — create agent, real GLM round trip | start frame delivered first (clientSeq 1) | PASS |  |
| A — create agent, real GLM round trip | transcript has model events | PASS |  |
| A — create agent, real GLM round trip | transcript has submission_settled | PASS |  |
| A — create agent, real GLM round trip | lifecycle idle | PASS | idle |
| B — tool use: bash writes a file in the workspace | answer status done | PASS | status=done reason=- |
| B — tool use: bash writes a file in the workspace | hello.txt exists in workspace | PASS |  |
| B — tool use: bash writes a file in the workspace | hello.txt content is hello-e2e-* | PASS | hello-e2e-1791381989 |
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

44/44 checks passed.
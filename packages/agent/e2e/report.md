# E2E report — raftbuild-durable

stateDir: `/tmp/raftd-e2e-UHmk68`  model: zai-coding-cn/glm-5.3-flash  duration: 152s

| phase | check | result | detail |
|---|---|---|---|
| A — create agent, real GLM round trip | agent created | PASS | agent-e967adf0 |
| A — create agent, real GLM round trip | workspace seeded (MEMORY.md + notes/) | PASS | /tmp/raftd-e2e-UHmk68/workspaces/agent-e967adf0 |
| A — create agent, real GLM round trip | answer status done | PASS | status=done |
| A — create agent, real GLM round trip | answer contains PONG | PASS | PONG |
| A — create agent, real GLM round trip | runtime:outcome frame delivered | PASS |  |
| A — create agent, real GLM round trip | outcome is turn_completed | PASS | {"type":"agent:runtime:outcome","agentId":"agent-e967adf0","submissionId":"12","outcome":{"kind":"turn_completed","textEvents":1,"toolCalls":0}} |
| A — create agent, real GLM round trip | start frame delivered first (clientSeq 1) | PASS |  |
| A — create agent, real GLM round trip | transcript has model events | PASS |  |
| A — create agent, real GLM round trip | transcript has submission_settled | PASS |  |
| A — create agent, real GLM round trip | lifecycle idle | PASS | idle |
| B — tool use: bash writes a file in the workspace | answer status done | PASS | status=done reason=- |
| B — tool use: bash writes a file in the workspace | hello.txt exists in workspace | PASS |  |
| B — tool use: bash writes a file in the workspace | hello.txt content is hello-e2e-* | PASS | hello-e2e-1791421474 |
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
| D — whenBusy:steer joins the running turn | steer visible in answer (secret word reached the model) | PASS | a1=BASE a2=Acknowledged — KUMQUAT noted.  Status check on resume: my pr |
| H — send_message routing (agent→agent, agent→main, bounce) | alpha→beta message routed (durable submission on beta) | PASS |  |
| H — send_message routing (agent→agent, agent→main, bounce) | routed submission settled | PASS |  |
| H — send_message routing (agent→agent, agent→main, bounce) | beta→main landed in operator inbox | PASS |  |
| H — send_message routing (agent→agent, agent→main, bounce) | inbox entry names the sender | PASS | beta |
| H — send_message routing (agent→agent, agent→main, bounce) | bounce notice returned to sender | PASS |  |
| I — durable reminder fires as a system notice | reminder committed durably | PASS | rem-ae49efe0 |
| I — durable reminder fires as a system notice | reminder fired into the conversation | PASS |  |
| I — durable reminder fires as a system notice | one-shot removed after firing | PASS |  |
| J — machineLock, raftd serve, console, thin-CLI remote | first lock acquires | PASS |  |
| J — machineLock, raftd serve, console, thin-CLI remote | second acquire refused while live | PASS |  |
| J — machineLock, raftd serve, console, thin-CLI remote | double serve refused (exit!=0, lock error) | PASS | state dir already locked by pid 18657 (started 2026-10-08T01:06:41.953Z) |
| J — machineLock, raftd serve, console, thin-CLI remote | serve came up | PASS | (node:19301) ExperimentalWarning: Transform Types is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created) raftd serving — consol |
| J — machineLock, raftd serve, console, thin-CLI remote | /api/state lists the agents | PASS | 2 agents |
| J — machineLock, raftd serve, console, thin-CLI remote | console HTML served | PASS |  |
| J — machineLock, raftd serve, console, thin-CLI remote | `raftd list` spoke to the live serve | PASS | (node:19316) ExperimentalWarning: Transform Types is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the war |
| J — machineLock, raftd serve, console, thin-CLI remote | agent created over HTTP | PASS | agent-674f8f0b |
| J — machineLock, raftd serve, console, thin-CLI remote | HTTP round trip answered | PASS | READY |
| J — machineLock, raftd serve, console, thin-CLI remote | duplicate name → 409 | PASS | status=409 |
| J — machineLock, raftd serve, console, thin-CLI remote | malformed JSON → 400 | PASS | status=400 |
| J — machineLock, raftd serve, console, thin-CLI remote | garbage whenBusy → 400 | PASS | status=400 |
| J — machineLock, raftd serve, console, thin-CLI remote | unknown agent → 404 | PASS | status=404 |
| J — machineLock, raftd serve, console, thin-CLI remote | serve released the lock on exit | PASS |  |
| J — machineLock, raftd serve, console, thin-CLI remote | port file cleaned up | PASS |  |
| K — cold-wake recycle compacts after idle silence | first message answered | PASS | done |
| K — cold-wake recycle compacts after idle silence | no compact on first message (no observed idle) | PASS | calls=0 |
| K — cold-wake recycle compacts after idle silence | wake-compact triggered once | PASS | calls=1 |
| K — cold-wake recycle compacts after idle silence | message still answered after recycle | PASS | done |
| L — hardening regressions | `every 0s` rejected | PASS |  |
| L — hardening regressions | live-created reminder fires | PASS |  |
| L — hardening regressions | postMessage to stopped agent is a permanent error | PASS |  |
| L — hardening regressions | corrupt transcript line tolerated | PASS | events=3, feed=1 |
| L — hardening regressions | first lock acquire succeeds | PASS |  |
| L — hardening regressions | second live lock acquire refused | PASS | refused |
| L — hardening regressions | lock re-acquirable after release | PASS |  |
| L — hardening regressions | unreachable serve → CLI refuses second Harness | PASS | (node:19368) ExperimentalWarning: Transform Types is an experimental feature and might change at any time (Use `node --trace-warnings ...` t |
| M — issue-#2 regressions | 32-way lock race: exactly one holder | PASS | won=1 refused=31 |
| M — issue-#2 regressions | ledger dedupes replayed clientSeq | PASS | seqs=2,3 |
| M — issue-#2 regressions | `at 25:99` rejected | PASS |  |
| M — issue-#2 regressions | `at 23:59` parses | PASS |  |
| M — issue-#2 regressions | agent named "main" refused | PASS |  |
| M — issue-#2 regressions | unknown submission has no owner | PASS | undefined |
| M — issue-#2 regressions | test serve up | PASS | s created) raftd serving — console http://127.0.0.1:34733  state=/tmp/raftd-e2e-UHmk68   6 agent(s); 0 reminder(s) armed |
| M — issue-#2 regressions | POST agents body=null → 400 | PASS |  |
| M — issue-#2 regressions | POST agents name=123 → 400 | PASS |  |
| M — issue-#2 regressions | POST agents name="   " → 400 | PASS |  |
| M — issue-#2 regressions | POST agents name="main" → 400 | PASS |  |
| M — issue-#2 regressions | POST agents valid → 201 | PASS | status=201 |
| M — issue-#2 regressions | POST messages text=object → 400 | PASS |  |
| M — issue-#2 regressions | POST reminders when=at 25:99 → 400 | PASS |  |
| M — issue-#2 regressions | GET answer foreign submission → 404 | PASS |  |
| M — issue-#2 regressions | remote deliveries w/o agent works | PASS | (node:19392) ExperimentalWarning: Transform Types is an experimental feature and |
| M — issue-#2 regressions | remote HTTP error not disguised as unreachable | PASS | (node:19404) ExperimentalWarning: Transform Types is an experimental feature and might change at any time (Use `node --t |
| M — issue-#2 regressions | remote create forwards --workspace/--thinking | PASS | (node:19430) ExperimentalWarning: Transform Types is an experimental feature and might change at any time (Use `node --trace-warnings ...` t |
| M — issue-#2 regressions | keyed serve up | PASS |  |
| M — issue-#2 regressions | thin CLI without RAFTD_KEY → 401 surfaced | PASS | (node:19454) ExperimentalWarning: Transform Types is an experimental feature and might change at any |
| M — issue-#2 regressions | thin CLI with RAFTD_KEY works | PASS | (node:19466) ExperimentalWarning: Transform Types is an experimental feature and might change at any |
| M — issue-#2 regressions | --host 0.0.0.0 without RAFTD_KEY refused | PASS | code=1 (node:19478) ExperimentalWarning: Transform Types is an experimental feature and might change at any |
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

101/101 checks passed.
# E2E report — raftbuild-durable

commit: `78026cb303a5eaa457c6247ac9690eff019e84c9-dirty`  node: v24.19.0  model: zai-coding-cn/glm-5.3-flash  duration: 212s
stateDir: `/tmp/raftd-e2e-7trZk4`

| phase | check | result | detail |
|---|---|---|---|
| A — create agent, real GLM round trip | agent created | PASS | agent-eb3e92ad |
| A — create agent, real GLM round trip | workspace seeded (MEMORY.md + notes/) | PASS | /tmp/raftd-e2e-7trZk4/workspaces/agent-eb3e92ad |
| A — create agent, real GLM round trip | answer status done | PASS | status=done |
| A — create agent, real GLM round trip | answer contains PONG | PASS | PONG |
| A — create agent, real GLM round trip | runtime:outcome frame delivered | PASS |  |
| A — create agent, real GLM round trip | outcome is turn_completed | PASS | {"type":"agent:runtime:outcome","agentId":"agent-eb3e92ad","submissionId":"12","outcome":{"kind":"turn_completed","textEvents":1,"toolCalls":0}} |
| A — create agent, real GLM round trip | start frame delivered first (clientSeq 1) | PASS |  |
| A — create agent, real GLM round trip | transcript has model events | PASS |  |
| A — create agent, real GLM round trip | transcript has submission_settled | PASS |  |
| A — create agent, real GLM round trip | lifecycle idle | PASS | idle |
| B — tool use: bash writes a file in the workspace | answer status done | PASS | status=done reason=- |
| B — tool use: bash writes a file in the workspace | hello.txt exists in workspace | PASS |  |
| B — tool use: bash writes a file in the workspace | hello.txt content is hello-e2e-* | PASS | hello-e2e-1791435777 |
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
| D — whenBusy:steer joins the running turn | steer visible in answer (secret word reached the model) | PASS | a1=BASE a2=Acknowledged: secret word is KUMQUAT. Workspace check after  |
| H — send_message routing (agent→agent, agent→main, bounce) | alpha→beta message routed (durable submission on beta) | PASS |  |
| H — send_message routing (agent→agent, agent→main, bounce) | routed submission settled | PASS |  |
| H — send_message routing (agent→agent, agent→main, bounce) | beta→main landed in operator inbox | PASS |  |
| H — send_message routing (agent→agent, agent→main, bounce) | inbox entry names the sender | PASS | beta |
| H — send_message routing (agent→agent, agent→main, bounce) | bounce notice returned to sender | PASS |  |
| I — durable reminder fires as a system notice | reminder committed durably | PASS | rem-770a65aa |
| I — durable reminder fires as a system notice | reminder fired into the conversation | PASS |  |
| I — durable reminder fires as a system notice | one-shot removed after firing | PASS |  |
| J — machineLock, raftd serve, console, thin-CLI remote | first lock acquires | PASS |  |
| J — machineLock, raftd serve, console, thin-CLI remote | second acquire refused while live | PASS |  |
| J — machineLock, raftd serve, console, thin-CLI remote | double serve refused (exit!=0, lock error) | PASS | state dir already locked by pid 36377 (started 2026-10-08T05:04:56.308Z) |
| J — machineLock, raftd serve, console, thin-CLI remote | serve came up | PASS | (node:36932) ExperimentalWarning: Transform Types is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created) raftd serving — consol |
| J — machineLock, raftd serve, console, thin-CLI remote | /api/state lists the agents | PASS | 2 agents |
| J — machineLock, raftd serve, console, thin-CLI remote | console HTML served | PASS |  |
| J — machineLock, raftd serve, console, thin-CLI remote | `raftd list` spoke to the live serve | PASS | (node:36944) ExperimentalWarning: Transform Types is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the war |
| J — machineLock, raftd serve, console, thin-CLI remote | agent created over HTTP | PASS | agent-c5fdc5fd |
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
| L — hardening regressions | unreachable serve → CLI refuses second Harness | PASS | (node:36998) ExperimentalWarning: Transform Types is an experimental feature and might change at any time (Use `node --trace-warnings ...` t |
| M — issue-#2 regressions | 32-way lock race: exactly one holder | PASS | won=1 refused=31 |
| M — issue-#2 regressions | ledger dedupes replayed clientSeq | PASS | seqs=2,3 |
| M — issue-#2 regressions | `at 25:99` rejected | PASS |  |
| M — issue-#2 regressions | `at 23:59` parses | PASS |  |
| M — issue-#2 regressions | agent named "main" refused | PASS |  |
| M — issue-#2 regressions | unknown submission has no owner | PASS | undefined |
| M — issue-#2 regressions | test serve up | PASS | s created) raftd serving — console http://127.0.0.1:37859  state=/tmp/raftd-e2e-7trZk4   6 agent(s); 0 reminder(s) armed |
| M — issue-#2 regressions | POST agents body=null → 400 | PASS |  |
| M — issue-#2 regressions | POST agents name=123 → 400 | PASS |  |
| M — issue-#2 regressions | POST agents name="   " → 400 | PASS |  |
| M — issue-#2 regressions | POST agents name="main" → 400 | PASS |  |
| M — issue-#2 regressions | POST agents valid → 201 | PASS | status=201 |
| M — issue-#2 regressions | POST messages text=object → 400 | PASS |  |
| M — issue-#2 regressions | POST reminders when=at 25:99 → 400 | PASS |  |
| M — issue-#2 regressions | GET answer foreign submission → 404 | PASS |  |
| M — issue-#2 regressions | remote deliveries w/o agent works | PASS | (node:37022) ExperimentalWarning: Transform Types is an experimental feature and |
| M — issue-#2 regressions | remote HTTP error not disguised as unreachable | PASS | (node:37034) ExperimentalWarning: Transform Types is an experimental feature and might change at any time (Use `node --t |
| M — issue-#2 regressions | remote create forwards --workspace/--thinking | PASS | (node:37094) ExperimentalWarning: Transform Types is an experimental feature and might change at any time (Use `node --trace-warnings ...` t |
| M — issue-#2 regressions | keyed serve up | PASS |  |
| M — issue-#2 regressions | thin CLI without RAFTD_KEY → 401 surfaced | PASS | (node:37118) ExperimentalWarning: Transform Types is an experimental feature and might change at any |
| M — issue-#2 regressions | thin CLI with RAFTD_KEY works | PASS | (node:37130) ExperimentalWarning: Transform Types is an experimental feature and might change at any |
| M — issue-#2 regressions | --host 0.0.0.0 without RAFTD_KEY refused | PASS | code=1 (node:37142) ExperimentalWarning: Transform Types is an experimental feature and might change at any |
| N — issue-#2 round-2 regressions | stale-lock takeover: exactly one winner every round | PASS | badRounds=0 max=1 |
| N — issue-#2 round-2 regressions | ledger-recorded orphan in workspace reaped | PASS |  |
| N — issue-#2 round-2 regressions | ledger-recorded orphan outside workspace reaped | PASS |  |
| N — issue-#2 round-2 regressions | unrecorded process in workspace spared | PASS |  |
| N — issue-#2 round-2 regressions | legacy submission settled once | PASS |  |
| N — issue-#2 round-2 regressions | legacy upgrade does not double-count outcomes | PASS | runs=0 failures=1 |
| N — issue-#2 round-2 regressions | reject-test serve up | PASS | ving — console http://127.0.0.1:41839  state=/tmp/raftd-e2e-7trZk4   9 agent(s); 0 reminder(s) armed |
| N — issue-#2 round-2 regressions | whenBusy=reject while running → 409 | PASS | status=409 {"error":"Conversation 258 is busy"} |
| O — issue-#2 round-3 regressions (scheduling boundaries) | takeover mutex claimed by separate process | PASS | CLAIMED |
| O — issue-#2 round-3 regressions (scheduling boundaries) | holder actually stopped | PASS | state=T |
| O — issue-#2 round-3 regressions (scheduling boundaries) | live stopped holder's mutex not broken (acquire still pending, dir intact) | PASS | acq=pending dir=true |
| O — issue-#2 round-3 regressions (scheduling boundaries) | acquire completes once the holder is dead | PASS | res=acquired |
| O — issue-#2 round-3 regressions (scheduling boundaries) | zombie owner fixture up (Z state) | PASS | READY state=Z pid=37305 |
| O — issue-#2 round-3 regressions (scheduling boundaries) | zombie-owned lock taken over | PASS |  |
| O — issue-#2 round-3 regressions (scheduling boundaries) | background descendant outlived its ledger leader | PASS | bgpid=37318 |
| O — issue-#2 round-3 regressions (scheduling boundaries) | dead-leader group reaped | PASS |  |
| O — issue-#2 round-3 regressions (scheduling boundaries) | delayed side-effect never landed | PASS |  |
| O — issue-#2 round-3 regressions (scheduling boundaries) | pid-reuse history: later valid entry still reaps | PASS |  |
| O — issue-#2 round-3 regressions (scheduling boundaries) | ledger entry without start never kills | PASS |  |
| O — issue-#2 round-3 regressions (scheduling boundaries) | member forked after last ledger append still reaped | PASS | leader=37360 members=37362→ reaped=1 |
| O — issue-#2 round-3 regressions (scheduling boundaries) | second serve refused | PASS | ready locked by pid 37365 (started 2026-10-08T05:06:03.182Z) |
| O — issue-#2 round-3 regressions (scheduling boundaries) | refused second serve did not kill the live host's children | PASS | serve=true worker=S |
| O — issue-#2 round-3 regressions (scheduling boundaries) | two legacy submissions settled | PASS |  |
| O — issue-#2 round-3 regressions (scheduling boundaries) | lost projection rebuilt to the true counters (runs/failures/lastOutcome) | PASS | runs=0/0 failures=1/1 last=unanswered |
| O — issue-#2 round-3 regressions (scheduling boundaries) | already-projected record lands identical counters on rebuild | PASS | runs=0/0 failures=1/1 |
| O — issue-#2 round-3 regressions (scheduling boundaries) | rebuild is idempotent across resumes | PASS | runs=0 failures=1 |
| O — issue-#2 round-3 regressions (scheduling boundaries) | wrapper up with child | PASS | tmp/raftd-e2e-wstate-w0AwSq   0 agent(s); 0 reminder(s) armed INFO:     127.0.0.1:51588 - "GET /healthz HTTP/1.1" 200 OK |
| O — issue-#2 round-3 regressions (scheduling boundaries) | wrapper child located for SIGKILL | PASS |  |
| O — issue-#2 round-3 regressions (scheduling boundaries) | 16 concurrent post-crash requests all 200 (shared readiness) | PASS | [200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200] |
| O — issue-#2 round-3 regressions (scheduling boundaries) | thin CLI works through published public port | PASS | (node:37460) ExperimentalWarning: Transform Types is an experimental feature and |
| O — issue-#2 round-3 regressions (scheduling boundaries) | raftd.port names the PUBLIC entry; internal-port keeps the child | PASS | port=127.0.0.1:41291 internal=127.0.0.1:36047 |
| O — issue-#2 round-3 regressions (scheduling boundaries) | unspawnable child refuses with explicit 503 | PASS | status=503 |
| O — issue-#2 round-3 regressions (scheduling boundaries) | docker image builds from root context | PASS | #17 naming to docker.io/library/raftd-e2e:78026cb303a5 done #17 unpacking to docker.io/library/raftd-e2e:78026cb303a5 #17 unpacking to docker.io/library/raftd-e2e:78026cb303a5 0.4s done #17 DONE 1.8s  |
| O — issue-#2 round-3 regressions (scheduling boundaries) | container healthy | PASS |  |
| O — issue-#2 round-3 regressions (scheduling boundaries) | authed /api/state in container | PASS | status=200 |
| O — issue-#2 round-3 regressions (scheduling boundaries) | image source matches this commit | PASS | img=5741ad3218415938b9c23c323567e451d6190f08f65f74c0258331743f15c3be src=5741ad3218415938b9c23c323567e451d6190f08f65f74c0258331743f15c3be |
| O — issue-#2 round-3 regressions (scheduling boundaries) | thin CLI inside container via public key | PASS | HROPIC_API_KEY). Agents will be created but every message lands as no_model terminal failure. Export a key and restart.  |
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

138/138 checks passed; 0 skipped.
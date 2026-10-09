# Durability

The product's headline: state lands before execution, so SIGKILL mid-run resumes where it left off and delivers the outcome exactly once. Durable reminders survive restarts too. The machine lock keeps a single writer per state dir.

## Sub-features

- `sigkill-resume` kills the daemon mid-tool-run; a reopened instance finishes the submission and delivers the outcome once.
- `restart-state` keeps agents, main inbox, pending reminders, and stopped flags across a restart.
- `reminder-fires` an `in <dur>` reminder lands in the conversation as a system notice, not an operator message.
- `lock-single` a live holder blocks a second serve; a dead holder's lock is released by the OS.

## How to get to it (user POV)

- Operator: kill -9 the serve pid while a turn runs → relaunch the same command → watch the same answer arrive once.
- Console/CLI: `remind <agent> in 5m "..."` → the notice appears in the feed.

## Driving it with the shell

Preconditions: model key; agent created via chat-with-agent recipe.

- SIGKILL: start a slow turn (`"run bash: sleep 20 then reply AWAKE"`), `kill -9 $(cat $STATE/serve.pid)` mid-run → relaunch `serve` on the same `$STATE` → `GET answer?submissionId=` settles `done` exactly once; `GET deliveries` shows a single outcome frame for that submission.
- Restart state: after relaunch, `GET /api/state` shows all agents; stopped agents stay stopped; `GET feed` replays history.
- Reminder: `node src/cli.ts --state $STATE remind probe "in 2m ping-verify"` → after it fires, `GET feed` shows the reminder as a `system` notice (`from: system`, not `@operator`); `GET /api/reminders` no longer lists the one-shot.
- Lock: with serve live, second `serve --state $STATE` fails fast; after `kill -9`, the same command succeeds (SQLite transaction released by process death).

## Gotchas

- `kill -9` the PID from `serve.pid` — `pkill -f pnpm`/`node` can hit the wrong process or leave the real node child alive.
- After SIGKILL the `raftd.port` file may briefly point at a dead pid — a relaunched serve rewrites it; thin CLI refuses cleanly meanwhile.
- Orphaned tool children from a killed host are reaped via `tool-children.jsonl` on the next serve's startup — a `sleep` left running is expected to die, not a regression.
- Reminder delivery is a system notice; asserting `@operator` text in the raw user message is the old (buggy) behavior.

# CLI and thin CLI

`node src/cli.ts` (same binary as `pnpm cli`/`raftd`) is both the admin interface and the remote client: when a serve is live it auto-discovers `raftd.port` + `raftd.token` and speaks HTTP; when nothing serves it opens the state directly and queues work durably without running it.

## Sub-features

- `thin-discovery` talks to the live serve without any `--host` flag.
- `wait-resume` survives server 504s: `send` auto-resumes waiting; `wait <agent> <sid>` re-reads any submission.
- `offline-queue` with no serve, `send` writes a durable queued submission and exits without executing it.
- `refuse-double` a second `serve` on a live state dir exits non-zero with a lock error.

## How to get to it (user POV)

- Terminal: `node src/cli.ts --state $STATE <command>` — `create send wait feed list remind lifecycle outbox events deliveries stop start resolve update usage serve`.

## Driving it with the shell

Preconditions: SKILL.md Launch for the thin parts; kill the serve (or use a second state dir) for the offline parts.

- Thin path: `node src/cli.ts --state $STATE list` → same agents the API shows; `node src/cli.ts --state $STATE send probe "reply PONG"` waits and prints the settled answer (watch it resume past a 504 on slow turns).
- `wait`: take a `submissionId` from a send's stdout → `node src/cli.ts --state $STATE wait probe $SID` returns the same answer without re-submitting.
- Offline path: stop serve → `node src/cli.ts --state $STATE send probe "queued line"` exits promptly after printing a queued submission (it does NOT run the model); restart serve → the queued submission executes and settles.
- Double-open: with serve live, `node src/cli.ts --state $STATE serve --port 4999` → exit ≠ 0 with `state dir already locked`.

## Gotchas

- `pnpm cli` and `node src/cli.ts` are equivalent; `node` needs no flags on Node 24/26.
- Thin mode needs no `RAFTD_KEY` on loopback — it reads the token file itself. Passing a wrong `RAFTD_KEY` still fails with a surfaced 401.
- Offline `send` on a state dir whose serve is merely unreachable refuses rather than double-opening — that refusal is the protection, not a bug.
- `-m` reads a message file (UTF-8); it is real, not a leftover help lie — but a bare `-m` with no path is a usage error.

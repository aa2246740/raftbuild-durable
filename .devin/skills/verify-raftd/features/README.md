# raftd verification map

This directory is the maintained source for verifying the user-facing behavior of raftd. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch raftd at `http://127.0.0.1:4777` with a disposable state dir `STATE=/tmp/verify-raftd-$RUN_ID` (see SKILL.md Launch).
- Read the API token from `$STATE/raftd.token`; every request carries `Authorization: Bearer $TOKEN` (or `?key=`).
- Set `B=http://127.0.0.1:4777` and `TOKEN=$(cat $STATE/raftd.token)` in the driving shell.
- For model-dependent recipes export `ZAI_CODING_CN_API_KEY` or `zhipu` before launching; model `zai-coding-cn/glm-5.3-flash` is the smoke default.
- Run the Doctor block from SKILL.md before driving; never drive an instance not started by this run, and never drive a second serve against a live state dir.

## Driving conventions

- Prefer API routes and CLI subcommands over DOM; use the console only where the recipe is about the UI itself.
- Treat every command as literal; keep quoted names and flags unchanged.
- Mutations require `Content-Type: application/json`; cross-site Origin/Host and `text/plain` bodies are rejected by design (403/415) — do not "fix" a recipe to bypass them.
- Restore mutated state after a recipe when another recipe depends on baseline; never delete proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- A send is verified by a settled answer (`status:"done"`), a tool effect by the file on disk, a frame by `deliveries`.
- Record the feature ID and the exact command next to every artifact.
- A path that needs a model key is reported as `unverified: no model key`, never silently swapped for a mock.
- Report unreachable paths with the attempted command and the unmet precondition.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>` (starting with `Preconditions:`), `Gotchas`.

## Features

- [Chat with an agent](./chat-with-agent.md) — create, send, answer, feed; the core loop every user hits first.
- [Web console](./console-ui.md) — login by token URL, sidebar, chat, reminders; zero-build UI on the same port.
- [Agent messaging](./agent-messaging.md) — agent→agent `send_message`, `main` inbox, bounce, hop/rate limits.
- [CLI and thin CLI](./cli-and-thin-cli.md) — `raftd` commands, auto-discovery of a live serve, `wait`, offline queueing.
- [Durability](./durability.md) — SIGKILL resume, restart persistence, durable reminders, machine lock.

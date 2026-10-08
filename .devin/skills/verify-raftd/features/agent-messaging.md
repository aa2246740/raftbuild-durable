# Agent messaging

Agents talk to each other and to the operator through the durable outbox → router: `send_message` tool calls produce routed submissions, `main` is the operator inbox, and unreachable/stopped targets bounce back to the sender. Replies are explicit — an ordinary answer stays in the agent's own conversation; a reply goes back via `send_message` (or `reply_to`).

## Sub-features

- `route-agent` delivers a `send_message` tool call as a durable submission on the target.
- `route-main` lands agent→`main` mail in the operator inbox.
- `bounce-terminal` returns a bounce notice when the target is unknown or stopped.
- `hop-limit` stops ping-pong chains at the configured hop/rate ceiling with an operator notice.

## How to get to it (user POV)

- Console: create two agents → instruct one to message the other → watch both feeds and the `main` inbox.
- API: same flow over `messages`/`feed`/`deliveries` routes.

## Driving it with curl + a real model

Preconditions: model key, agents `alpha` and `beta` created (chat-with-agent recipe).

- Instruct alpha: `"use send_message to tell beta the codeword OCTOPUS, then say SENT"` → wait for alpha's answer.
- Proof of delivery: `GET $B/api/agents/beta/feed` shows an incoming message from alpha containing OCTOPUS; `GET $B/api/agents/beta/deliveries` shows the routed frame exactly once.
- main inbox: instruct beta `"send_message to main: hello operator"` → `GET $B/api/state` (or the main inbox route) lists the entry with sender `beta`.
- Bounce: instruct alpha `"send_message to ghost-agent: hi"` → alpha's feed later shows a delivery-failed/bounce system notice, not a silent hang.
- Reply semantics: an ordinary beta answer does NOT appear in alpha's feed — verify the documented contract rather than assuming auto-reply.

## Gotchas

- Routing is asynchronous — poll beta's feed/deliveries with a deadline instead of asserting immediately.
- `main` and `Main` are reserved names; don't create them.
- Hop/rate limits emit one operator notice when they trip — a chain that keeps going past the limit is the failure to report.
- The transcript does not replay submission input text — assert routing via feed/deliveries, not transcript greps.

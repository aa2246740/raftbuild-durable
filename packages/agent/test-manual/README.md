# Real long-task CLI regression

This opt-in check takes about 116 seconds. It runs the actual daemon, HTTP server,
thin CLI and Bash tool with `sleep 115`; a local faux provider supplies only the
model's tool request and final response. It needs Node 24 or 26, Bash and installed
repository dependencies. It makes no external model calls and needs no API key.

From the repository root:

```sh
node packages/agent/test-manual/long-cli.mjs
# Or choose an empty evidence directory:
node packages/agent/test-manual/long-cli.mjs --output /tmp/raft-long-cli-evidence
```

The default verifies the current code. The server's real 110-second answer window
must return 504, then the CLI must keep waiting and finish with exit code 0. The
check also requires exactly one message POST, one durable submission, one tool
side effect and one completion marker. It does not shorten the server timeout.

For an old/new comparison, prepare a separate checkout at `39b5c25`, install its
dependencies, and provide its path:

```sh
# Run using Node 24, or set BASELINE_NODE to a Node 24 executable.
BASELINE_REPO=/path/to/old-checkout \
BASELINE_NODE=/path/to/node24 \
node packages/agent/test-manual/long-cli.mjs --output /tmp/raft-long-cli-comparison
```

The old checkout is used only for its thin CLI. Both CLIs talk to the same current
daemon, with separate agents running in parallel. The old CLI must exit 1 after
the 110-second timeout; the new CLI must finish successfully, and its `wait`
command must retrieve the old submission's eventual answer. The old CLI requires
Node 24's transform flag; the current CLI always runs with native type stripping.

The script prints progress every 25 seconds and saves `events.jsonl` plus
`result.json` to the printed evidence directory. Existing evidence is never
overwritten. Temporary state, the HTTP listener and owned CLI processes are
cleaned up; evidence remains available for inspection. This slow check is separate
from `pnpm test:reliability` and is not included in the fast CI count.

For a quick import/argument check without starting the long task:

```sh
node --check packages/agent/test-manual/long-cli.mjs
node packages/agent/test-manual/long-cli.mjs --help
```

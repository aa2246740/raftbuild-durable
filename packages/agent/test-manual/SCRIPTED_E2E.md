# Scripted E2E reproduction

After `pnpm install --frozen-lockfile`, run from the repository root:

```sh
node packages/agent/test-manual/run-scripted-e2e.mjs /tmp/raftd-e2e-node24
```

Use the desired Node 26 executable instead of `node` for that version. The driver
puts its executable directory first on the child PATH. Paths resolve relative
to the script; no checkout-specific path or model credential is required.

The three executable files are `run-scripted-e2e.mjs`, `scripted-provider.mjs`,
and `scripted-model.py`. The provider uses loopback HTTP only. Its fixed key
strings are placeholders. The Python SSE fixture never contacts an external
model. Model responses and tool choices are scripted; Bash processes, storage,
HTTP, CLI, wrapper, and container behavior run normally. This does not validate
real GLM authentication/reasoning or guarantee a real model will repeat an
interrupted tool's side effect.

Requires Node 24 or newer and Python 3. Wrapper checks additionally need the
Python dependencies from `deploy/pyproject.toml` on PATH. Docker checks need a
working daemon and build network; use your environment's normal proxy/CA setup
without disabling TLS. Missing optional capabilities are explicitly skipped,
never counted as passed. The issue #5 runs had 144/144 checks and zero skips on
both Node versions.

Output defaults to a fresh temporary directory when no path is supplied. It
contains `e2e.log`, a clearly labelled `report.md`, `run.json`, fixture errors,
and local model-request logs. The driver restores the original tracked
`e2e/report.md`, including on failure. Exit 0 means the underlying suite passed;
inspect the report for skipped capabilities. Use a fresh output directory and
do not run suites concurrently in the same checkout. `RAFTD_TEST_PYTHON` can
select the Python executable used by the SSE fixture.

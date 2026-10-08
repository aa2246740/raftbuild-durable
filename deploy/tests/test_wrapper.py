"""Real wrapper/Node regressions; no model credentials or external service required.

Run after pnpm install and installing fastapi, uvicorn, httpx:
    python3 -m unittest discover -s deploy/tests -v
"""
import asyncio
import concurrent.futures
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import httpx

REPO = Path(__file__).resolve().parents[2]
PUBLIC_KEY = "wrapper-regression-public-key"
PROVIDER_KEYS = (
    "ZAI_CODING_CN_API_KEY", "zhipu", "ZAI_API_KEY", "MINIMAX_CN_API_KEY",
    "MINIMAX_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def alive(pid):
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        return stat[stat.rfind(")") + 2:].split()[0] != "Z"
    except FileNotFoundError:
        return False


def eventually(predicate, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if predicate():
                return
        except (OSError, httpx.HTTPError, ValueError):
            pass
        time.sleep(0.02)
    raise AssertionError("condition did not become true before timeout")


class Wrapper:
    def __init__(self, child_port=None, node=None, delayed=False):
        self.temp = tempfile.TemporaryDirectory(prefix="raftd-wrapper-test-")
        self.data = Path(self.temp.name)
        self.state = self.data / "state"
        self.state.mkdir()
        self.port = free_port()
        self.child_port = child_port or free_port()
        while self.child_port == self.port:
            self.port = free_port()
        self.env = os.environ.copy()
        for key in (*PROVIDER_KEYS, "NODE_OPTIONS", "RAFTD_WRAPPER_INSTANCE"):
            self.env.pop(key, None)
        self.env.update(PORT=str(self.port), RAFTD_CHILD_PORT=str(self.child_port),
                        RAFTD_DATA=str(self.data), RAFTD_STATE=str(self.state),
                        RAFTD_REPO=str(REPO), RAFTD_KEY=PUBLIC_KEY,
                        PYTHONPATH=str(REPO / "deploy"))
        if delayed:
            shim = self.data / "delayed-node"
            shim.write_text(f"#!{sys.executable}\nimport os,sys,time\ntime.sleep(0.5)\nos.execvp('node', ['node', *sys.argv[1:]])\n")
            shim.chmod(0o755)
            node = str(shim)
        if node:
            self.env["NODE_BIN"] = node
        else:
            self.env.pop("NODE_BIN", None)
        (self.state / "child.env").write_text("DEEPSEEK_API_KEY=legacy-fixture\nOPENAI_API_KEY=old-fixture\n")
        (self.data / ".env").write_text("OPENAI_API_KEY=current-fixture\n")
        self.log = (self.data / "wrapper.log").open("w+")
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(self.port)],
            cwd=REPO / "deploy", env=self.env, stdout=self.log, stderr=self.log)
        self.client = httpx.Client(base_url=f"http://127.0.0.1:{self.port}", timeout=30, trust_env=False)

    def request(self, path="/api/state", key=PUBLIC_KEY, method="GET", body=None):
        headers = {} if key is None else {"authorization": f"Bearer {key}"}
        return self.client.request(method, path, headers=headers, json=body)

    def ready(self):
        eventually(lambda: self.request("/healthz", key=None).status_code == 200)

    def pid(self):
        return json.loads((self.state / "raftd.lock").read_text())["pid"]

    def cli(self, key=PUBLIC_KEY):
        env = dict(self.env, RAFTD_KEY=key)
        return subprocess.run(["node", "--experimental-transform-types",
                               str(REPO / "packages/agent/src/cli.ts"), "list", "--state", str(self.state)],
                              cwd=REPO, env=env, capture_output=True, text=True, timeout=30)

    def close(self):
        pid = None
        try:
            pid = self.pid()
        except (OSError, ValueError):
            pass
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        self.client.close()
        try:
            if pid:
                eventually(lambda: not alive(pid), timeout=5)
            if (self.state / "raftd.port").exists():
                raise AssertionError("graceful shutdown left stale public discovery")
            self.log.seek(0)
            log = self.log.read()
            # Newer uvicorn re-raises SIGTERM after completing lifespan;
            # both exit conventions must still prove child reaping above.
            if self.proc.returncode not in (0, -signal.SIGTERM) or "Application shutdown complete." not in log:
                raise AssertionError(f"wrapper exit {self.proc.returncode}: {log[-3000:]}")
        finally:
            self.log.close()
            self.temp.cleanup()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        try:
            self.close()
        except Exception as cleanup_error:
            if exc is None:
                raise
            exc.add_note(f"cleanup also failed: {cleanup_error}")


@contextlib.contextmanager
def foreign_server(port=0):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"foreign_fixture":true}')

        def log_message(self, *_):
            pass

    # /proc can report a killed process as gone just before the kernel has
    # released its listener. Wait for that OS cleanup, not a fixed sleep.
    deadline = time.monotonic() + 2
    while True:
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.02)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class WrapperIntegrationTests(unittest.TestCase):
    def test_second_wrapper_cannot_change_first_wrappers_discovery(self):
        with Wrapper() as first:
            first.ready()
            expected = (first.state / "raftd.port").read_text()
            pid = first.pid()
            env = dict(first.env, PORT=str(free_port()), RAFTD_CHILD_PORT=str(free_port()))
            with (first.data / "second-wrapper.log").open("w+") as log:
                second = subprocess.Popen(
                    [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", env["PORT"]],
                    cwd=REPO / "deploy", env=env, stdout=log, stderr=log)
                try:
                    eventually(lambda: second.poll() is not None)
                    self.assertNotEqual(second.returncode, 0)
                    log.seek(0)
                    self.assertIn("database is locked", log.read())
                    self.assertEqual((first.state / "raftd.port").read_text(), expected)
                    self.assertEqual(first.pid(), pid)
                    self.assertEqual(first.request("/healthz", key=None).status_code, 200)
                    cli = first.cli()
                    self.assertEqual(cli.returncode, 0, cli.stderr)
                    self.assertTrue((first.state / "raftd.wrapper.sqlite").exists())
                finally:
                    if second.poll() is None:
                        second.terminate()
                        second.wait(timeout=15)
            self.assertEqual((first.state / "raftd.port").read_text(), expected)

    def test_existing_native_serve_keeps_its_discovery(self):
        with tempfile.TemporaryDirectory(prefix="raftd-native-wrapper-test-") as directory:
            data = Path(directory)
            state = data / "state"
            native_port, public_port = free_port(), free_port()
            env = os.environ.copy()
            for key in (*PROVIDER_KEYS, "NODE_OPTIONS", "RAFTD_WRAPPER_INSTANCE"):
                env.pop(key, None)
            env.update(PORT=str(public_port), RAFTD_CHILD_PORT=str(free_port()),
                       RAFTD_DATA=str(data), RAFTD_STATE=str(state), RAFTD_REPO=str(REPO),
                       RAFTD_KEY=PUBLIC_KEY, PYTHONPATH=str(REPO / "deploy"))
            with (data / "native.log").open("w+") as native_log, (data / "wrapper.log").open("w+") as wrapper_log:
                native = subprocess.Popen(
                    ["node", "--experimental-transform-types", str(REPO / "packages/agent/src/cli.ts"),
                     "serve", "--state", str(state), "--port", str(native_port)],
                    cwd=REPO, env=env, stdout=native_log, stderr=native_log)
                wrapper = None
                try:
                    with httpx.Client(trust_env=False, timeout=5) as client:
                        def native_status():
                            return client.get(f"http://127.0.0.1:{native_port}/api/state", headers={"authorization": f"Bearer {PUBLIC_KEY}"}).status_code
                        eventually(lambda: native_status() == 200)
                        expected = (state / "raftd.port").read_text()
                        wrapper = subprocess.Popen(
                            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(public_port)],
                            cwd=REPO / "deploy", env=env, stdout=wrapper_log, stderr=wrapper_log)
                        eventually(lambda: wrapper.poll() is not None)
                        self.assertNotEqual(wrapper.returncode, 0)
                        self.assertEqual((state / "raftd.port").read_text(), expected)
                        self.assertEqual(native_status(), 200)
                        cli = subprocess.run(
                            ["node", "--experimental-transform-types", str(REPO / "packages/agent/src/cli.ts"), "list", "--state", str(state)],
                            cwd=REPO, env=env, capture_output=True, text=True, timeout=30)
                        self.assertEqual(cli.returncode, 0, cli.stderr)
                finally:
                    for proc in (wrapper, native):
                        if proc is not None and proc.poll() is None:
                            proc.terminate()
                            proc.wait(timeout=15)

    def test_health_commits_public_discovery_before_cli_three_boots(self):
        for _ in range(3):
            with Wrapper() as wrapper:
                wrapper.ready()
                self.assertEqual((wrapper.state / "raftd.port").read_text(), f"127.0.0.1:{wrapper.port}")
                self.assertEqual((wrapper.state / "raftd.internal-port").read_text(), f"127.0.0.1:{wrapper.child_port}")
                cli = wrapper.cli()
                self.assertEqual(cli.returncode, 0, cli.stderr)
                self.assertNotIn("x-raftd-instance", wrapper.request().headers)

    def test_early_cli_uses_public_discovery_while_child_still_starting(self):
        with Wrapper(delayed=True) as wrapper:
            eventually(lambda: wrapper.request("/healthz", key=None).status_code == 503)
            self.assertEqual((wrapper.state / "raftd.port").read_text(), f"127.0.0.1:{wrapper.port}")
            cli = wrapper.cli()
            self.assertEqual(cli.returncode, 0, cli.stderr)
            wrapper.ready()

    def test_auth_config_merge_restart_and_sigterm(self):
        with Wrapper() as wrapper:
            wrapper.ready()
            for key in (None, "wrong-key"):
                self.assertEqual(wrapper.request(key=key).status_code, 401)
            self.assertEqual(wrapper.request(f"/api/state?key={PUBLIC_KEY}", key=None).status_code, 200)
            self.assertEqual(wrapper.request("/", key=None).status_code, 200)
            wrong_cli = wrapper.cli("wrong-key")
            self.assertNotEqual(wrong_cli.returncode, 0)
            self.assertIn("unauthorized", wrong_cli.stderr)
            self.assertEqual(wrapper.request("/setup/env", key=None, method="POST", body={}).status_code, 401)
            response = wrapper.request("/setup/env", method="POST", body={"OPENAI_API_KEY": "new-fixture", "UNSUPPORTED": "ignored"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["saved"], ["OPENAI_API_KEY"])
            saved = (wrapper.data / ".env").read_text()
            self.assertIn("DEEPSEEK_API_KEY=legacy-fixture", saved)
            self.assertIn("OPENAI_API_KEY=new-fixture", saved)
            self.assertNotIn("UNSUPPORTED", saved)
            previous = wrapper.pid()
            response = wrapper.request("/setup/restart", method="POST", body={})
            self.assertTrue(response.json()["ok"])
            self.assertNotEqual(wrapper.pid(), previous)
            self.assertFalse(alive(previous))
            self.assertEqual(wrapper.cli().returncode, 0)

    def test_port_conflict_never_becomes_ready_or_proxies_foreign_service(self):
        with foreign_server() as port, Wrapper(child_port=port) as wrapper:
            eventually(lambda: wrapper.request("/healthz", key=None).status_code == 503)
            for _ in range(3):
                response = wrapper.request()
                self.assertEqual(response.status_code, 503)
                self.assertNotIn("foreign_fixture", response.text)
            self.assertEqual(wrapper.request("/healthz", key=None).status_code, 503)

    def test_child_death_then_port_takeover_refuses_foreign_response(self):
        with Wrapper() as wrapper:
            wrapper.ready()
            pid = wrapper.pid()
            os.kill(pid, signal.SIGKILL)
            eventually(lambda: not alive(pid))
            with foreign_server(wrapper.child_port):
                self.assertEqual(wrapper.request("/healthz", key=None).status_code, 503)
                response = wrapper.request()
                self.assertEqual(response.status_code, 503)
                self.assertNotIn("foreign_fixture", response.text)

    def test_native_serve_cannot_take_state_during_wrapper_child_crash(self):
        with Wrapper() as wrapper:
            wrapper.ready()
            expected = (wrapper.state / "raftd.port").read_text()
            previous_pid = wrapper.pid()
            os.kill(previous_pid, signal.SIGKILL)
            eventually(lambda: not alive(previous_pid))
            # Health does not spawn a replacement. The storage lock is now
            # released, while the wrapper still owns this state's manager.
            self.assertEqual(wrapper.request("/healthz", key=None).status_code, 503)
            self.assertFalse(alive(previous_pid))
            native = subprocess.run(
                ["node", "--experimental-transform-types", str(REPO / "packages/agent/src/cli.ts"),
                 "serve", "--state", str(wrapper.state), "--port", str(free_port())],
                cwd=REPO, env=wrapper.env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(native.returncode, 0)
            self.assertIn("locked", native.stderr)
            self.assertEqual((wrapper.state / "raftd.port").read_text(), expected)
            self.assertFalse(alive(previous_pid))
            self.assertEqual(wrapper.request().status_code, 200)
            self.assertNotEqual(wrapper.pid(), previous_pid)
            self.assertEqual((wrapper.state / "raftd.port").read_text(), expected)
            cli = wrapper.cli()
            self.assertEqual(cli.returncode, 0, cli.stderr)

    def test_concurrent_first_requests_after_crash_three_rounds(self):
        with Wrapper() as wrapper:
            wrapper.ready()
            for _ in range(3):
                old_pid = wrapper.pid()
                os.kill(old_pid, signal.SIGKILL)
                eventually(lambda: not alive(old_pid))
                with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
                    responses = list(pool.map(lambda _: wrapper.request(), range(12)))
                self.assertEqual([r.status_code for r in responses], [200] * 12)
                self.assertNotEqual(wrapper.pid(), old_pid)
                self.assertEqual(wrapper.cli().returncode, 0)

    def test_spawn_failure_and_early_exit_are_503(self):
        for node in ("/raftd-test/no-such-node", "/bin/false"):
            with Wrapper(node=node) as wrapper:
                eventually(lambda: wrapper.request("/healthz", key=None).status_code == 503)
                with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                    responses = list(pool.map(lambda _: wrapper.request(), range(8)))
                self.assertEqual([r.status_code for r in responses], [503] * 8)

    def test_restart_during_startup_keeps_existing_waiters(self):
        with Wrapper(delayed=True) as wrapper:
            eventually(lambda: wrapper.request("/healthz", key=None).status_code == 503)
            with concurrent.futures.ThreadPoolExecutor(max_workers=9) as pool:
                waiters = [pool.submit(wrapper.request) for _ in range(8)]
                restart = pool.submit(wrapper.request, "/setup/restart", PUBLIC_KEY, "POST", {})
                self.assertTrue(restart.result().json()["ok"])
                self.assertEqual([f.result().status_code for f in waiters], [200] * 8)
            wrapper.ready()
            self.assertEqual(wrapper.cli().returncode, 0)


class SharedStartupCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_request_does_not_cancel_shared_startup(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"RAFTD_DATA": directory, "RAFTD_STATE": directory, "RAFTD_KEY": PUBLIC_KEY}):
            spec = importlib.util.spec_from_file_location("wrapper_under_test", REPO / "deploy/app/main.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finish = asyncio.Event()
        calls = 0

        async def bring_up():
            nonlocal calls
            calls += 1
            await finish.wait()
            return True

        module._bring_up = bring_up
        first = asyncio.create_task(module._ensure_up())
        second = asyncio.create_task(module._ensure_up())
        await asyncio.sleep(0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        finish.set()
        self.assertTrue(await second)
        self.assertEqual(calls, 1)


if __name__ == "__main__":
    unittest.main()

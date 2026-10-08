"""Real Chromium regressions for the embedded console, with a local HTTP API fixture.

Install: python -m pip install playwright && python -m playwright install --with-deps chromium
Run: python packages/agent/test-browser/console.py
Optional: CHROMIUM_PATH=/usr/bin/chromium CONSOLE_ARTIFACTS=/tmp/console-evidence
The API fixture is deliberate: this suite exercises browser interaction, not model output.
Native API/auth integration is covered separately in the reliability suite.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[3]
SOURCE = Path(os.environ.get("CONSOLE_HTML_SOURCE", REPO / "packages/agent/src/consoleHtml.ts"))
KEY = "console-browser-test-key"
ARTIFACTS = Path(os.environ.get("CONSOLE_ARTIFACTS", "/tmp/raftd-console-evidence"))


def load_html():
    result = subprocess.run(
        ["node", "--input-type=module", "-e",
         "const {CONSOLE_HTML}=await import(process.argv[1]);process.stdout.write(CONSOLE_HTML)", SOURCE.as_uri()],
        check=True, capture_output=True, text=True,
    )
    return result.stdout


class Fixture:
    def __init__(self):
        self.html = load_html()
        self.requests = []
        self.feed = [
            {"id": f"entry-{i}", "role": "user" if i % 2 == 0 else "agent",
             "text": f"Message {i}: A retained history row.\n" + "Readable line of conversation.\n" * 3}
            for i in range(100)
        ]
        self.agents = [
            {"agentId": f"agent-{i}", "name": "Reader" if i == 0 else f"Agent {i}", "model": {"modelId": "fixture"}}
            for i in range(20)
        ]
        self.invalid = False
        self.delay_feed = None
        self.pause_state = None
        self.state = {
            "agents": self.agents,
            "lifecycles": [{"agentId": a["agentId"], "kind": "idle"} for a in self.agents],
            "mainInbox": [{"id": "inbox-1", "fromName": "Reader", "text": "Inbox stays stable", "at": "now"}],
            "reminders": [], "usage": {},
        }
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.handle_request()

            def do_POST(self):
                self.handle_request()

            def do_DELETE(self):
                self.handle_request()

            def handle_request(self):
                path = urlsplit(self.path).path
                size = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(size)) if size else None
                owner.requests.append({"method": self.command, "path": self.path,
                                       "auth": self.headers.get("Authorization"), "body": body})
                if path == "/":
                    data, status, content_type = owner.html.encode(), 200, "text/html; charset=utf-8"
                elif path.startswith("/api/"):
                    if owner.invalid or self.headers.get("Authorization") != "Bearer " + KEY:
                        payload, status = {"error": "Unauthorized"}, 401
                    elif path == "/api/state":
                        payload, status = json.loads(json.dumps(owner.state)), 200
                        pause = owner.pause_state
                        if pause:
                            owner.pause_state = None
                            pause[0].set()
                            pause[1].wait(timeout=5)
                    elif path.endswith("/feed"):
                        if owner.delay_feed and owner.delay_feed in path:
                            time.sleep(0.5)
                        payload, status = {"items": owner.feed}, 200
                    elif self.command == "DELETE" and path.startswith("/api/agents/"):
                        agent_id = path.rsplit("/", 1)[1]
                        owner.agents[:] = [a for a in owner.agents if a["agentId"] != agent_id]
                        payload, status = {"ok": True}, 200
                    elif self.command == "POST" and path == "/api/agents":
                        payload = {"agentId": "agent-created", "name": body["name"], "model": {"modelId": "fixture"}}
                        owner.agents.append(payload)
                        status = 201
                    elif self.command == "POST":
                        payload, status = {"ok": True, "submissionId": "fixture-submission"}, 200
                    else:
                        payload, status = {"error": "Fixture route not found"}, 404
                    data, content_type = json.dumps(payload).encode(), "application/json"
                else:
                    data, status, content_type = b"", 404, "text/plain"
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class ConsoleBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        cls.playwright = sync_playwright().start()
        options = {"headless": True, "args": ["--no-sandbox"]}
        if os.environ.get("CHROMIUM_PATH"):
            options["executable_path"] = os.environ["CHROMIUM_PATH"]
        cls.browser = cls.playwright.chromium.launch(**options)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.fixture = Fixture()
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 900})
        self.page = self.context.new_page()
        self.page.set_default_timeout(5000)
        self.errors, self.dialogs = [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.dismiss()))

    def tearDown(self):
        self.page.screenshot(path=str(ARTIFACTS / (self._testMethodName + ".png")), full_page=True)
        self.context.close()
        self.fixture.close()
        self.assertEqual(self.errors, [])

    def connect(self, query=False):
        self.page.goto(self.fixture.url + ("?" if query else "#") + "key=" + KEY)
        self.page.wait_for_selector("#agents .agent")
        self.page.locator("#agents .agent").first.click()
        self.page.wait_for_selector("#events .row")

    def test_fragment_key_is_consumed_before_authenticated_requests(self):
        self.connect()
        self.assertEqual(self.page.url, self.fixture.url + "/")
        self.assertEqual(self.dialogs, [])
        self.assertTrue(all(KEY not in r["path"] for r in self.fixture.requests))
        api_requests = [r for r in self.fixture.requests if r["path"].startswith("/api/")]
        self.assertTrue(api_requests)
        self.assertTrue(all(r["auth"] == "Bearer " + KEY for r in api_requests))
        self.assertEqual(self.page.locator("#events .row.agent .who").first.inner_text(), "Reader")

    def test_legacy_query_key_still_connects_and_is_removed(self):
        self.connect(query=True)
        self.assertEqual(self.page.url, self.fixture.url + "/")
        self.assertEqual(self.dialogs, [])

    def test_reading_history_survives_three_polls_and_changed_feed(self):
        self.connect()
        self.page.locator("#events").hover()
        self.page.mouse.wheel(0, -3500)
        self.page.wait_for_timeout(350)
        original = self.page.evaluate("""() => {
            const events = document.querySelector('#events');
            window.retainedRow = events.querySelector('[data-key="entry-60"]');
            window.retainedAgent = document.querySelector('#agents .agent');
            window.retainedInbox = document.querySelector('#inbox .feed-item');
            window.readingAnchor = [...events.children].find(node => node.getBoundingClientRect().bottom > events.getBoundingClientRect().top);
            return {top: events.scrollTop, bottom: events.scrollHeight-events.clientHeight, anchorTop:window.readingAnchor.getBoundingClientRect().top};
        }""")
        self.assertLess(original["top"], original["bottom"] - 500)
        self.page.screenshot(path=str(ARTIFACTS / "reading-before-polls.png"), full_page=True)
        initial_polls = len([r for r in self.fixture.requests if r["path"] == "/api/state"])
        self.fixture.feed[60]["text"] += "Content updated in place."
        self.fixture.feed.append({"id": "entry-new", "role": "agent", "text": "A new live answer"})
        self.page.wait_for_timeout(9500)
        metrics = self.page.evaluate("""() => ({
            top: document.querySelector('#events').scrollTop,
            sameRow: window.retainedRow === document.querySelector('[data-key="entry-60"]'),
            sameAgent: window.retainedAgent === document.querySelector('#agents .agent'),
            sameInbox: window.retainedInbox === document.querySelector('#inbox .feed-item'),
            anchorTop: window.readingAnchor.getBoundingClientRect().top,
            updated: window.retainedRow.textContent.includes('Content updated in place.')
        })""")
        polls = len([r for r in self.fixture.requests if r["path"] == "/api/state"]) - initial_polls
        self.assertGreaterEqual(polls, 3)
        # A row above the viewport grew. Preserve the visible reading position,
        # compensating scrollTop for that height change instead of jumping.
        self.assertAlmostEqual(metrics["anchorTop"], original["anchorTop"], delta=2)
        for key in ["sameRow", "sameAgent", "sameInbox", "updated"]:
            self.assertTrue(metrics[key], metrics)
        (ARTIFACTS / "reading-metrics.json").write_text(json.dumps({"before": original, "after": metrics, "polls": polls}, indent=2))
        self.page.screenshot(path=str(ARTIFACTS / "reading-after-polls.png"), full_page=True)
        # The retained sidebar element must still be usable after polling.
        self.page.locator("#agents .agent").nth(1).click()
        self.page.wait_for_function("document.querySelector('#chat-title').textContent === 'Agent 1'")

    def test_tail_window_shift_keeps_visible_anchor_and_bottom_follows(self):
        self.connect()
        self.page.locator("#events").hover()
        self.page.mouse.wheel(0, -2000)
        self.page.wait_for_timeout(350)
        before = self.page.evaluate("""() => {
            const box = document.querySelector('#events').getBoundingClientRect();
            const node = [...document.querySelector('#events').children].find(n => n.getBoundingClientRect().bottom > box.top);
            return {key:node.dataset.key, top:node.getBoundingClientRect().top};
        }""")
        self.fixture.feed[:] = self.fixture.feed[1:] + [{"id": "tail-1", "role": "agent", "text": "New tail"}]
        self.page.evaluate("refresh()")
        self.page.wait_for_selector('[data-key="tail-1"]')
        after = self.page.locator('[data-key="' + before["key"] + '"]').bounding_box()
        self.assertAlmostEqual(after["y"], before["top"], delta=2)
        self.page.evaluate("const e=document.querySelector('#events');e.scrollTop=e.scrollHeight")
        self.fixture.feed.append({"id": "tail-2", "role": "agent", "text": "More at bottom\n" * 10})
        self.page.evaluate("refresh()")
        self.page.wait_for_selector('[data-key="tail-2"]')
        gap = self.page.evaluate("const e=document.querySelector('#events');e.scrollHeight-e.clientHeight-e.scrollTop")
        self.assertLessEqual(gap, 2)

    def test_401_cancel_pauses_polling_until_explicit_login(self):
        self.page.goto(self.fixture.url)
        self.page.wait_for_selector("#auth-panel:not([hidden])")
        self.page.screenshot(path=str(ARTIFACTS / "login-required.png"), full_page=True)
        self.page.click("#auth-cancel")
        count = len(self.fixture.requests)
        self.page.wait_for_timeout(6500)
        self.assertEqual(len(self.fixture.requests), count)
        self.assertEqual(self.dialogs, [])
        self.assertTrue(self.page.locator("#auth-panel").is_hidden())
        self.page.click("#auth-open")
        self.page.fill("#auth-key", "wrong-key")
        self.page.locator("#auth-form button[type=submit]").click()
        self.page.wait_for_function("document.querySelector('#auth-error').textContent.includes('not accepted')")
        self.page.fill("#auth-key", KEY)
        self.page.locator("#auth-form button[type=submit]").click()
        self.page.wait_for_selector("#agents .agent")
        self.assertTrue(self.page.locator("#auth-panel").is_hidden())
        self.assertEqual(self.page.evaluate("localStorage.raftdKey"), KEY)

    def test_expired_key_keeps_history_and_composer(self):
        self.connect()
        self.page.fill("#msg", "Keep my unsent draft")
        self.fixture.invalid = True
        self.page.evaluate("refresh()")
        self.page.wait_for_selector("#auth-panel:not([hidden])")
        self.assertEqual(self.page.locator("#events .row").count(), 100)
        self.assertEqual(self.page.locator("#msg").input_value(), "Keep my unsent draft")
        self.assertEqual(self.dialogs, [])

    def test_create_during_old_state_request_retains_new_selection(self):
        self.connect()
        started, released = threading.Event(), threading.Event()
        self.fixture.pause_state = (started, released)
        self.page.evaluate("void refresh()")
        self.assertTrue(started.wait(timeout=3), "The old state request must be in flight")
        try:
            self.page.fill("#na-name", "Created while polling")
            with self.page.expect_response(lambda r: r.url.endswith("/api/agents") and r.request.method == "POST"):
                self.page.locator("#new-agent button").click()
        finally:
            released.set()
        self.page.wait_for_function("document.querySelector('#chat-title').textContent === 'Created while polling'")
        self.assertEqual(self.page.locator("#agents .sel .name").inner_text(), "Created while polling")

    def test_multiline_send_actions_and_workspace_delete_opt_in(self):
        self.connect()
        self.page.fill("#msg", "first line")
        self.page.locator("#msg").press("Shift+Enter")
        self.page.locator("#msg").press_sequentially("second line")
        self.assertEqual(self.page.locator("#msg").input_value(), "first line\nsecond line")
        self.page.locator("#msg").press("Enter")
        self.page.wait_for_function("document.querySelector('#msg').value === ''")
        sent = [r for r in self.fixture.requests if r["path"].endswith("/messages")]
        self.assertEqual(sent[0]["body"]["text"], "first line\nsecond line")
        for action in ["abort", "compact", "resolve"]:
            with self.page.expect_response(lambda r, action=action: r.url.endswith('/' + action)):
                self.page.click("#btn-" + action)
        # A cancelled reset is not sent to the API.
        self.page.click("#btn-reset")
        self.assertFalse(any(r["path"].endswith("/reset") for r in self.fixture.requests))
        self.page.click("#btn-del")
        self.assertFalse(self.page.locator("#delete-workspace").is_checked())
        self.page.locator("#delete-form button[type=submit]").click()
        self.page.wait_for_function("document.querySelectorAll('#agents .agent').length === 19")
        deleted = [r for r in self.fixture.requests if r["method"] == "DELETE"]
        self.assertEqual(deleted[-1]["path"], "/api/agents/agent-0")
        self.page.locator("#agents .agent").first.click()
        self.page.click("#btn-del")
        self.assertFalse(self.page.locator("#delete-workspace").is_checked())
        self.page.check("#delete-workspace")
        self.page.locator("#delete-form button[type=submit]").click()
        self.page.wait_for_function("document.querySelectorAll('#agents .agent').length === 18")
        deleted = [r for r in self.fixture.requests if r["method"] == "DELETE"]
        self.assertEqual(deleted[-1]["path"], "/api/agents/agent-1?workspace=true")

    def test_mobile_390px_and_hostile_text_are_rendered_safely(self):
        self.fixture.agents[0]["name"] = "<img src=x onerror=alert('name')>"
        self.fixture.feed.append({"id": "hostile", "role": "agent", "text": "<svg onload=alert('text')>"})
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.connect()
        self.assertEqual(self.dialogs, [])
        self.assertEqual(self.page.locator("#events svg, #agents img").count(), 0)
        dimensions = self.page.evaluate("({scroll:document.documentElement.scrollWidth,width:document.documentElement.clientWidth})")
        self.assertEqual(dimensions["scroll"], dimensions["width"])
        message = self.page.locator("#msg").bounding_box()
        self.assertGreaterEqual(message["width"], 350)
        send = self.page.locator("#composer button").bounding_box()
        self.assertLessEqual(send["x"] + send["width"], 390)
        self.assertLessEqual(send["y"] + send["height"], 844)

    def test_real_daemon_default_token_boot_create_and_restart(self):
        """No providers or scripted API: spawn the production CLI and use its UI."""
        with tempfile.TemporaryDirectory(prefix="raftd-console-native-") as temporary:
            directory = Path(temporary)
            state_dir = directory / "state"
            log_path = directory / "serve.log"
            env = {"PATH": os.environ["PATH"], "HOME": temporary, "NO_COLOR": "1"}

            def start():
                log = log_path.open("w")
                child = subprocess.Popen(
                    ["node", str(REPO / "packages/agent/src/cli.ts"),
                     "serve", "--state", str(state_dir), "--port", "0"],
                    cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT,
                )
                try:
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline:
                        output = log_path.read_text()
                        ready = next((line for line in output.splitlines() if "raftd serving — console " in line), None)
                        if ready:
                            return child, log, ready.split("console ", 1)[1].split("  state=", 1)[0]
                        if child.poll() is not None:
                            self.fail("Native server exited before readiness: " + output)
                        time.sleep(0.05)
                    self.fail("Native server startup timed out: " + log_path.read_text())
                except BaseException:
                    stop(child, log)
                    raise

            def stop(child, log):
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=5)
                log.close()

            child, log, console_url = start()
            try:
                token = (state_dir / "raftd.token").read_text().strip()
                self.assertIn("#key=" + token, console_url)
                base = console_url.split("#", 1)[0]
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    urllib.request.urlopen(base + "api/state", timeout=5)
                self.assertEqual(denied.exception.code, 401)
                denied.exception.close()
                self.page.goto(console_url)
                self.page.wait_for_function("document.querySelector('#agents').textContent.includes('No agents yet')")
                self.assertEqual(self.page.url, base)
                self.page.fill("#na-name", "Native browser agent")
                self.page.fill("#na-model", "openai/gpt-4.1-mini")
                self.page.locator("#new-agent button").click()
                self.page.wait_for_function("document.querySelector('#chat-title').textContent === 'Native browser agent'")
                self.page.wait_for_function("document.querySelector('#events').textContent.includes('No history yet')")
                self.assertEqual(self.dialogs, [])
                request = urllib.request.Request(base + "api/state", headers={"Authorization": "Bearer " + token})
                with urllib.request.urlopen(request, timeout=5) as response:
                    native_state = json.load(response)
                self.assertEqual(native_state["agents"][0]["name"], "Native browser agent")
                self.page.screenshot(path=str(ARTIFACTS / "native-daemon-created.png"), full_page=True)
            finally:
                stop(child, log)
                (ARTIFACTS / "native-daemon-first.log").write_text(log_path.read_text().replace(token if 'token' in locals() else 'unused', '<test-token>'))
            child, log, second_url = start()
            try:
                self.assertEqual((state_dir / "raftd.token").read_text().strip(), token)
                self.page.goto(second_url)
                self.page.wait_for_selector("#agents .agent")
                self.assertEqual(self.page.locator("#agents .name").first.inner_text(), "Native browser agent")
                self.assertEqual(self.dialogs, [])
            finally:
                stop(child, log)


if __name__ == "__main__":
    unittest.main(verbosity=2)

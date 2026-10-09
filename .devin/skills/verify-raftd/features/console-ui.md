# Web console

The zero-build console served on the same port as the API: token login, agent sidebar, chat view with tool-call cards, reminders panel, usage. Verifying it means a real browser session, not reading `consoleHtml.ts`.

## Sub-features

- `login-token` opens the app via the printed `/#key=` URL; 401 state shows an inline login form.
- `sidebar-agents` lists agents and switches selection without losing scroll state.
- `chat-send` sends a message from the composer; failures keep the text and show an error banner.
- `reminders-panel` shows armed/fired reminders.

## How to get to it (user POV)

- `http://127.0.0.1:4777/#key=$TOKEN` in a browser.

## Driving it with browser (CDP/computer tool)

Preconditions: serve running, at least one agent created (see chat-with-agent), Chrome on the VM.

- Open `http://127.0.0.1:4777/#key=$TOKEN` → console loads with agent sidebar. Proof: screenshot shows the app shell, not an error page.
- Without `#key=` or with a wrong one → inline login form appears and polling does not spam prompt() dialogs.
- Select the agent in the sidebar → chat view renders the same feed the API returns.
- Type in the composer and send → the user bubble appears; after the model turn the answer bubble + tool-call card (if tools ran) appears without manual refresh.
- Scroll the chat up while polling → scroll position stays (no forced scroll-to-bottom); returns to bottom when already at bottom.
- Resize to ~390px width (CDP `Emulation.setDeviceMetricsOverride`) → composer does not overflow horizontally.

## Gotchas

- The console polls every ~3s; DOM nodes can be re-rendered between a selector query and a click — re-query right before acting, or prefer CDP/Playwright locators with auto-wait.
- Thin-CLI discovery file `raftd.port` means the console's API and your curls hit the same instance — don't start a second serve against the same state.
- A wrong-token visit once wrote a stale cached token — if the UI looks "logged in" but API calls 401, clear `localStorage` and reload with `#key=`.

/** The embedded web console — one HTML file, no build step. */
export const CONSOLE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>raftd — durable agents</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --line:#30363d; --fg:#e6edf3; --mut:#8b949e; --acc:#58a6ff; --ok:#3fb950; --warn:#d29922; --bad:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; background:var(--bg); color:var(--fg); height:100vh; display:flex; flex-direction:column; }
  header { display:flex; align-items:center; gap:12px; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--panel); }
  header b { font-size:15px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--ok); }
  main { flex:1; display:flex; min-height:0; }
  #sidebar { width:240px; flex-shrink:0; border-right:1px solid var(--line); overflow-y:auto; padding:12px; }
  #sidebar h3, #feed h3 { margin:8px 0; font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--mut); }
  .agent { padding:8px 10px; border-radius:8px; cursor:pointer; margin-bottom:4px; border:1px solid transparent; }
  .agent:hover { background:var(--panel); }
  .agent.sel { background:var(--panel); border-color:var(--line); }
  .agent .name { font-weight:600; }
  .agent .meta { font-size:12px; color:var(--mut); display:flex; gap:8px; }
  .badge { font-size:11px; padding:1px 8px; border-radius:10px; border:1px solid var(--line); color:var(--mut); }
  .badge.running { color:var(--ok); border-color:var(--ok); }
  .badge.queued { color:var(--warn); border-color:var(--warn); }
  .badge.terminal, .badge.unreliable { color:var(--bad); border-color:var(--bad); }
  #content { flex:1; display:flex; min-width:0; }
  #feed { width:260px; flex-shrink:0; border-right:1px solid var(--line); overflow-y:auto; padding:12px; overflow-wrap:anywhere; }
  .feed-item { border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-bottom:8px; font-size:13px; }
  .feed-item .who { color:var(--acc); font-weight:600; margin-bottom:2px; }
  .feed-item .at { color:var(--mut); font-size:11px; }
  #err { display:none; position:fixed; top:52px; left:50%; transform:translateX(-50%); background:var(--bad); color:#fff; padding:8px 16px; border-radius:8px; font-size:13px; z-index:9; max-width:80%; }
  #chat { flex:1; display:flex; flex-direction:column; min-width:0; }
  @media (max-width: 700px) {
    main { flex-direction:column; }
    #sidebar { width:auto; border-right:none; border-bottom:1px solid var(--line); max-height:22vh; }
    #content { flex-direction:column; min-height:0; }
    #feed { width:auto; border-right:none; border-bottom:1px solid var(--line); max-height:18vh; }
    #chat { min-height:0; flex:1; }
    /* Composer wraps to two rows on phones: message input gets the full
       width, mode select + Send share the second row — nothing overflows. */
    #composer { flex-wrap:wrap; }
    #composer #msg { order:-1; flex:1 1 100%; }
    #composer select { flex:1 1 60%; min-width:0; }
    #composer button { flex:1 1 30%; }
  }
  #chat-head { padding:10px 16px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  #chat-actions { display:flex; gap:5px; flex-wrap:wrap; }
  #chat-actions button { padding:4px 8px; font-size:12px; }
  #chat-head .t { font-weight:600; }
  #events { flex:1; overflow-y:auto; overflow-anchor:none; padding:16px; font-size:13.5px; min-height:60px; }
  .row { margin-bottom:10px; max-width:78%; }
  .row .body { padding:9px 13px; border-radius:12px; white-space:pre-wrap; word-break:break-word; }
  .row.user { margin-left:auto; }
  .row.user .body { background:#1f6feb33; border:1px solid #1f6feb66; }
  .row.agent .body { background:var(--panel); border:1px solid var(--line); }
  .row.tool { max-width:100%; }
  .row.tool .body { background:transparent; border:1px dashed var(--line); padding:6px 10px; font-family:ui-monospace,Menlo,monospace; font-size:12px; color:var(--mut); }
  .row.tool .body.err { border-color:var(--bad); color:var(--bad); }
  .row .who { font-size:11px; color:var(--mut); margin-bottom:3px; }
  .row.user .who { text-align:right; }
  .tc { font-family:ui-monospace,Menlo,monospace; font-size:12px; color:var(--warn); margin-top:5px; }
  .tk { font-size:12px; color:var(--mut); font-style:italic; margin-top:5px; border-left:2px solid var(--line); padding-left:8px; }
  #composer { display:flex; gap:8px; padding:12px 16px; border-top:1px solid var(--line); }
  #composer textarea { flex:1; min-width:0; resize:vertical; max-height:160px; background:var(--bg); border:1px solid var(--line); border-radius:8px; color:var(--fg); padding:9px 12px; font:inherit; }
  #composer select { min-width:0; max-width:100%; }
  #composer select, button { background:var(--panel); border:1px solid var(--line); border-radius:8px; color:var(--fg); padding:9px 14px; font:inherit; cursor:pointer; }
  button.primary { background:var(--acc); border-color:var(--acc); color:#0d1117; font-weight:600; }
  button:hover { filter:brightness(1.15); }
  .empty { color:var(--mut); text-align:center; margin-top:80px; line-height:1.9; }
  .empty code { background:var(--panel); padding:2px 8px; border-radius:6px; }
  #new-agent { border:1px dashed var(--line); border-radius:8px; padding:10px; margin-top:8px; }
  #new-agent input { width:100%; background:var(--bg); border:1px solid var(--line); border-radius:6px; color:var(--fg); padding:7px 9px; font:inherit; margin-bottom:6px; }
  .btnrow { display:flex; gap:6px; }
  #remind { border:1px dashed var(--line); border-radius:8px; padding:10px; margin-top:10px; font-size:12px; }
  #remind input { width:100%; background:var(--bg); border:1px solid var(--line); border-radius:6px; color:var(--fg); padding:6px 8px; font:inherit; margin-bottom:6px; }
  .small { font-size:12px; color:var(--mut); }
  [hidden] { display:none !important; }
  #auth-panel { position:fixed; inset:0; z-index:20; display:flex; align-items:center; justify-content:center; background:#0009; padding:18px; }
  #auth-form, dialog { width:420px; max-width:100%; background:var(--panel); color:var(--fg); border:1px solid var(--line); border-radius:12px; padding:22px; }
  #auth-form h2, dialog h2 { margin-top:0; font-size:18px; }
  #auth-key { width:100%; margin:8px 0 12px; padding:10px; color:var(--fg); background:var(--bg); border:1px solid var(--line); border-radius:6px; }
  #auth-error { color:var(--bad); min-height:1.5em; }
  dialog::backdrop { background:#0009; }
  dialog label { display:block; margin:16px 0; }
  button.danger { color:var(--bad); }
</style>
</head>
<body>
<div id="err"></div>
<section id="auth-panel" role="dialog" aria-modal="true" aria-labelledby="auth-title" hidden>
  <form id="auth-form">
    <h2 id="auth-title">Connect to raftd</h2>
    <p>Local: open the console URL printed at startup, or read <code>raftd.token</code> in your state directory.</p>
    <p>Cloud: use your configured <code>RAFTD_KEY</code>, or read <code>$RAFTD_STATE/admin-key</code> (Docker default: <code>/data/raftd/admin-key</code>).</p>
    <label for="auth-key">Access key</label>
    <input id="auth-key" type="password" autocomplete="off" required>
    <div id="auth-error" role="status"></div>
    <div class="btnrow"><button class="primary" type="submit">Connect</button><button id="auth-cancel" type="button">Cancel</button></div>
  </form>
</section>
<dialog id="delete-dialog" aria-labelledby="delete-title">
  <form id="delete-form">
    <h2 id="delete-title">Delete agent?</h2>
    <p id="delete-name"></p>
    <p>The agent will be removed. Its workspace files are kept unless you choose to delete them.</p>
    <label><input id="delete-workspace" type="checkbox"> Permanently delete its managed workspace and files</label>
    <p class="small">Custom workspace directories are never deleted.</p>
    <div class="btnrow"><button class="danger" type="submit">Delete agent</button><button type="button" onclick="document.getElementById('delete-dialog').close()">Cancel</button></div>
  </form>
</dialog>
<header>
  <span class="dot"></span><b>raftd</b>
  <span class="small" id="usage"></span>
  <span style="flex:1"></span>
  <span class="small" id="state-dir"></span>
  <button id="auth-open" type="button" hidden>Connect</button>
</header>
<main>
  <div id="sidebar">
    <h3>Agents</h3>
    <div id="agents"></div>
    <div id="new-agent">
      <input id="na-name" placeholder="agent name">
      <input id="na-inst" placeholder="instructions (optional)">
      <input id="na-model" aria-label="Model" placeholder="model (optional: provider/model-id)">
      <div class="btnrow"><button class="primary" onclick="createAgent()" style="flex:1">+ New agent</button></div>
    </div>
  </div>
  <div id="feed">
    <h3>Operator inbox</h3>
    <div id="inbox"></div>
    <div id="remind">
      <b>Set a reminder</b><br>
      <input id="rm-agent" placeholder="agent">
      <input id="rm-when" placeholder='when: "in 30m" / "every 1h" / "at 14:30"'>
      <input id="rm-text" placeholder="text">
      <div class="btnrow"><button onclick="setReminder()" style="flex:1">Remind</button></div>
      <div id="reminders" class="small" style="margin-top:8px"></div>
    </div>
  </div>
  <div id="chat">
    <div id="chat-head">
      <span class="t" id="chat-title">Select an agent</span>
      <span class="badge" id="chat-badge"></span>
      <span class="err small" id="chat-err"></span>
      <span style="flex:1"></span>
      <div id="chat-actions">
        <button id="btn-stop" onclick="agentAction('stop')" disabled>stop</button>
        <button id="btn-start" onclick="agentAction('start')" disabled>start</button>
        <button id="btn-abort" onclick="agentAction('abort')" disabled>abort turn</button>
        <button id="btn-compact" onclick="agentAction('compact')" disabled>compact</button>
        <button id="btn-reset" onclick="agentAction('reset')" disabled>reset</button>
        <button id="btn-resolve" onclick="agentAction('resolve')" disabled>resolve</button>
        <button id="btn-del" onclick="delAgent()" disabled>delete</button>
      </div>
    </div>
    <div id="events"><div class="empty">Create or select an agent.<br>Every agent is durable: kill the process, it resumes where it left off.</div></div>
    <div id="composer">
      <select id="whenbusy"><option value="" title="wait in line behind the current turn">queue (default)</option><option value="steer" title="inject into the running turn now">interrupt the run</option><option value="followUp" title="send right after the current turn finishes">follow up next</option></select>
      <textarea id="msg" rows="2" aria-label="Message the agent" placeholder="Message the agent… (Enter to send, Shift+Enter for a new line)" onkeydown="if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();send();}"></textarea>
      <button class="primary" onclick="send()">Send</button>
    </div>
  </div>
</main>
<script>
let sel = null, state = null, renderedAgent = null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let KEY = '';
try { KEY = localStorage.raftdKey || ''; } catch {}
const initialUrl = new URL(location.href);
const fragment = new URLSearchParams(initialUrl.hash.slice(1));
const urlKey = fragment.get('key') || initialUrl.searchParams.get('key');
if (urlKey) {
  KEY = urlKey;
  try { localStorage.raftdKey = KEY; } catch {}
}
// Fragments never reach the HTTP server or Referer. Consume old query URLs too.
if (fragment.has('key') || initialUrl.searchParams.has('key')) {
  fragment.delete('key');
  initialUrl.searchParams.delete('key');
  initialUrl.hash = fragment.toString();
  history.replaceState(null, '', initialUrl.pathname + initialUrl.search + initialUrl.hash);
}
let authPaused = false, authEpoch = 0, stateRevision = 0, refreshing = false, refreshAgain = false;
function showAuth(message) {
  authPaused = true;
  $('auth-error').textContent = message || '';
  $('auth-panel').hidden = false;
  $('auth-open').hidden = false;
  $('auth-key').focus();
}
function cancelAuth() {
  $('auth-panel').hidden = true;
  $('auth-open').hidden = false;
  $('auth-open').focus();
}
$('auth-cancel').onclick = cancelAuth;
$('auth-open').onclick = () => showAuth('');
$('auth-panel').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); cancelAuth(); }
  if (event.key === 'Tab') {
    const first = $('auth-key'), last = $('auth-cancel');
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
$('auth-form').onsubmit = event => {
  event.preventDefault();
  KEY = $('auth-key').value.trim();
  if (!KEY) return;
  authEpoch++;
  authPaused = false;
  $('auth-error').textContent = 'Connecting…';
  refresh();
};
async function api(path, method, body) {
  if (authPaused) throw new Error('Connect with your access key to continue.');
  const epoch = authEpoch;
  const r = await fetch('/api/' + path, { method: method || 'GET', headers: {'content-type':'application/json', ...(KEY ? {authorization:'Bearer '+KEY} : {})}, body: body === undefined ? undefined : JSON.stringify(body) });
  if (epoch !== authEpoch) throw new Error('Connection credentials changed.');
  if (r.status === 401) {
    try { localStorage.removeItem('raftdKey'); } catch {}
    showAuth(KEY ? 'That access key was not accepted. Try again.' : 'An access key is required.');
    throw new Error('Authentication required.');
  }
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw new Error(detail.error || r.statusText);
  }
  const result = await r.json();
  if (method && method !== 'GET') stateRevision++;
  return result;
}

// Retain keyed elements, event listeners, focus, selection, and scroll positions.
// Unchanged rows are not touched; only changed content is replaced inside a row.
function reconcile(container, records, keyOf, htmlOf, classOf, onCreate, emptyText) {
  const previous = new Map(Array.from(container.children, node => [node.dataset.key, node]));
  let position = container.firstChild;
  for (const record of records) {
    const key = String(keyOf(record));
    let node = previous.get(key);
    if (!node) {
      node = document.createElement('div');
      node.dataset.key = key;
      if (onCreate) onCreate(node, record);
    }
    previous.delete(key);
    const className = classOf(record);
    if (node.className !== className) node.className = className;
    const html = htmlOf(record);
    if (node._rendered !== html) { node.innerHTML = html; node._rendered = html; }
    if (node !== position) container.insertBefore(node, position);
    position = node.nextSibling;
  }
  for (const node of previous.values()) node.remove();
  if (!records.length && emptyText) {
    const empty = document.createElement('div');
    empty.className = 'small';
    empty.textContent = emptyText;
    // The placeholder has no controls or identity-dependent behavior.
    container.replaceChildren(empty);
  }
}
function kindOf(lc) {
  const kind = lc && lc.kind;
  return /^[a-z_]+$/.test(kind || '') ? kind : 'unknown';
}
function lcBadge(lc) {
  const kind = kindOf(lc);
  return '<span class="badge ' + kind + '">' + kind + '</span>';
}
function renderState() {
  const mods = (state.usage && state.usage.models) || {};
  let tk = 0, cost = 0;
  for (const model of Object.values(mods)) { tk += model.totalTokens || 0; cost += (model.cost && model.cost.total) || 0; }
  $('usage').textContent = tk ? 'tokens: ' + (tk >= 1000 ? (tk/1000).toFixed(1) + 'k' : tk) + ' · cost: $' + cost.toFixed(4) : '';
  const agents = state.agents || [];
  const lcs = Object.fromEntries((state.lifecycles || []).map(l => [l.agentId, l]));
  if (sel && !agents.some(a => a.agentId === sel)) { sel = null; clearConversation(); }
  reconcile($('agents'), agents, a => a.agentId,
    a => '<div class="name">' + esc(a.name) + '</div><div class="meta">' + lcBadge(lcs[a.agentId]) + '<span>' + esc(a.model.modelId) + '</span></div>',
    a => 'agent' + (sel === a.agentId ? ' sel' : ''),
    (node, a) => {
      node.tabIndex = 0;
      node.setAttribute('role', 'button');
      node.onclick = () => selectAgent(a.agentId);
      node.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectAgent(a.agentId); } };
    }, 'No agents yet — create one below.');
  for (const button of $('chat-actions').querySelectorAll('button')) button.disabled = !sel;
  reconcile($('inbox'), (state.mainInbox || []).slice(-50).reverse(), m => m.id,
    m => '<div class="who">@' + esc(m.fromName) + '</div><div>' + esc(m.text) + '</div><div class="at">' + esc(m.at) + '</div>',
    () => 'feed-item', null, 'Nothing yet — agents message target "main" via send_message.');
  const names = Object.fromEntries(agents.map(a => [a.agentId, a.name]));
  reconcile($('reminders'), state.reminders || [], r => r.id,
    r => esc(names[r.agentId] || r.agentId.slice(0,12)) + ' · ' + esc(r.text.slice(0,40)) + ' · ' + esc(r.dueAt) + (r.everyMs ? ' ↻' : '') + ' <button type="button" class="danger" aria-label="Delete reminder">×</button>',
    () => 'reminder', (node, r) => node.onclick = event => { if (event.target.closest('button')) delReminder(r.id); });
  const a = agents.find(x => x.agentId === sel);
  if (a) {
    const lc = lcs[sel], kind = kindOf(lc);
    $('chat-title').textContent = a.name;
    $('chat-badge').textContent = kind;
    $('chat-badge').className = 'badge ' + kind;
    $('chat-err').textContent = (kind === 'cooldown' || kind === 'terminal') && lc.detail ? '⚠ ' + lc.detail : '';
  }
}
async function refresh() {
  if (authPaused) return;
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    const revision = stateRevision;
    const next = await api('state');
    if (revision !== stateRevision) { refreshAgain = true; return; }
    state = next;
    try { localStorage.raftdKey = KEY; } catch {}
    $('auth-panel').hidden = true;
    $('auth-open').hidden = true;
    $('auth-key').value = '';
    renderState();
    if (sel) await refreshEvents();
  } catch (e) {
    if (!authPaused) showErr(e.message || String(e));
  } finally {
    refreshing = false;
    if (refreshAgain) { refreshAgain = false; if (!authPaused) queueMicrotask(refresh); }
  }
}
function clearConversation() {
  renderedAgent = null;
  $('chat-title').textContent = 'Select an agent';
  $('chat-badge').textContent = '';
  $('chat-err').textContent = '';
  $('events').replaceChildren();
}
function selectAgent(id) {
  if (sel !== id) { clearConversation(); sel = id; }
  if (state) renderState();
  refresh();
}
async function refreshEvents() {
  const id = sel;
  const a = (state.agents || []).find(x => x.agentId === id);
  if (!a) return;
  const revision = stateRevision;
  const { items } = await api('agents/' + encodeURIComponent(id) + '/feed?tail=150');
  // A slow response for the previous selection must never replace this chat.
  if (sel !== id) return;
  if (revision !== stateRevision) { refreshAgain = true; return; }
  const events = $('events');
  const firstRender = renderedAgent !== id;
  const atBottom = events.scrollHeight - events.clientHeight - events.scrollTop <= 32;
  const oldTop = events.scrollTop;
  const anchor = Array.from(events.children).find(node => node.getBoundingClientRect().bottom > events.getBoundingClientRect().top);
  const anchorTop = anchor && anchor.getBoundingClientRect().top;
  reconcile(events, items.map((item, index) => ({...item, _key: item.id ?? ('legacy-' + index)})), e => e._key,
    e => renderItem(e, a.name), e => 'row ' + (['user', 'tool', 'agent'].includes(e.role) ? e.role : 'tool'), null, 'No history yet — say hello below.');
  renderedAgent = id;
  if (firstRender || atBottom) events.scrollTop = events.scrollHeight;
  else if (anchor && anchor.isConnected) events.scrollTop = oldTop + anchor.getBoundingClientRect().top - anchorTop;
  else events.scrollTop = oldTop;
}
function renderItem(e, agentName) {
  if (e.role === 'user') return '<div class="who">' + esc(e.from || 'you') + '</div><div class="body">' + esc(e.text) + '</div>';
  if (e.role !== 'agent') return '<div class="who">' + esc(e.name || e.role || 'tool') + '</div><div class="body' + (e.isError ? ' err' : '') + '">' + esc(e.text) + '</div>';
  let inner = '';
  if (e.thinking) inner += '<div class="tk">' + esc(e.thinking.slice(0,400)) + '</div>';
  if (e.text) inner += esc(e.text);
  for (const c of (e.toolCalls || [])) inner += '<div class="tc">→ ' + esc(c.name) + ' ' + esc(c.args) + '</div>';
  return '<div class="who">' + esc(agentName) + '</div><div class="body">' + inner + '</div>';
}
function showErr(msg) {
  const el = $('err');
  el.textContent = msg || 'unknown error';
  el.style.display = 'block';
  clearTimeout(showErr._t);
  showErr._t = setTimeout(() => { el.style.display = 'none'; }, 8000);
}
let sending = false;
async function send() {
  const text = $('msg').value.trim();
  if (!text || !sel || sending) return;
  sending = true;
  try {
    await api('agents/' + encodeURIComponent(sel) + '/messages', 'POST', { text, whenBusy: $('whenbusy').value || undefined });
    // Do not erase text typed while the send was in flight.
    if ($('msg').value.trim() === text) $('msg').value = '';
    refresh();
  } catch (e) { showErr(e.message || String(e)); }
  finally { sending = false; }
}
async function createAgent() {
  const name = $('na-name').value.trim(); if (!name) return;
  try {
    const created = await api('agents', 'POST', { name, instructions: $('na-inst').value.trim() || undefined, model: $('na-model').value.trim() || undefined });
    $('na-name').value = ''; $('na-inst').value = '';
    // The previous state snapshot cannot contain the newly created agent.
    // Select it only alongside the next snapshot, rather than clearing it as gone.
    if (created.agentId) { clearConversation(); sel = created.agentId; }
    refresh();
  } catch (e) { showErr(e.message || String(e)); }
}
async function agentAction(action) {
  if (!sel) return;
  if (action === 'reset' && !confirm('Reset this conversation? Its current context will be cleared.')) return;
  try { await api('agents/' + encodeURIComponent(sel) + '/' + action, 'POST'); refresh(); }
  catch (e) { showErr(e.message || String(e)); }
}
let deletingAgent = null;
function delAgent() {
  if (!sel) return;
  deletingAgent = sel;
  $('delete-name').textContent = ((state.agents || []).find(a => a.agentId === sel) || {}).name || sel;
  $('delete-workspace').checked = false;
  $('delete-dialog').showModal();
}
$('delete-form').onsubmit = async event => {
  event.preventDefault();
  if (!deletingAgent) return;
  const id = deletingAgent;
  try {
    await api('agents/' + encodeURIComponent(id) + ($('delete-workspace').checked ? '?workspace=true' : ''), 'DELETE');
    $('delete-dialog').close(); deletingAgent = null;
    if (sel === id) { sel = null; clearConversation(); }
    refresh();
  } catch (e) { showErr(e.message || String(e)); }
};
async function setReminder() {
  const agent = $('rm-agent').value.trim(), when = $('rm-when').value.trim(), text = $('rm-text').value.trim();
  if (!agent || !when || !text) return;
  try { await api('reminders', 'POST', {agent, when, text}); $('rm-when').value = ''; $('rm-text').value = ''; refresh(); }
  catch (e) { showErr(e.message || String(e)); }
}
async function delReminder(id) {
  try { await api('reminders/' + encodeURIComponent(id), 'DELETE'); refresh(); }
  catch (e) { showErr(e.message || String(e)); }
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;

/** The embedded web console — one HTML file, no build step. */
export const CONSOLE_HTML = `<!doctype html>
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
  #sidebar { width:260px; border-right:1px solid var(--line); overflow-y:auto; padding:12px; }
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
  #feed { width:300px; border-right:1px solid var(--line); overflow-y:auto; padding:12px; }
  .feed-item { border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-bottom:8px; font-size:13px; }
  .feed-item .who { color:var(--acc); font-weight:600; margin-bottom:2px; }
  .feed-item .at { color:var(--mut); font-size:11px; }
  #chat { flex:1; display:flex; flex-direction:column; min-width:0; }
  #chat-head { padding:10px 16px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:10px; }
  #chat-head .t { font-weight:600; }
  #events { flex:1; overflow-y:auto; padding:16px; font-family:ui-monospace, "SF Mono", Menlo, monospace; font-size:12.5px; }
  .ev { margin-bottom:6px; white-space:pre-wrap; word-break:break-word; }
  .ev .k { color:var(--mut); }
  .ev.text .v { color:var(--fg); }
  .ev.tool_call .v { color:var(--warn); }
  .ev.tool_output .v { color:#79c0ff; }
  .ev.error .v { color:var(--bad); }
  .ev.thinking .v { color:var(--mut); font-style:italic; }
  .ev.system { color:var(--warn); }
  #composer { display:flex; gap:8px; padding:12px 16px; border-top:1px solid var(--line); }
  #composer input { flex:1; background:var(--bg); border:1px solid var(--line); border-radius:8px; color:var(--fg); padding:9px 12px; font:inherit; }
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
</style>
</head>
<body>
<header>
  <span class="dot"></span><b>raftd</b>
  <span class="small" id="usage"></span>
  <span style="flex:1"></span>
  <span class="small" id="state-dir"></span>
</header>
<main>
  <div id="sidebar">
    <h3>Agents</h3>
    <div id="agents"></div>
    <div id="new-agent">
      <input id="na-name" placeholder="agent name">
      <input id="na-inst" placeholder="instructions (optional)">
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
      <span style="flex:1"></span>
      <button onclick="agentAction('stop')">stop</button>
      <button onclick="agentAction('start')">start</button>
      <button onclick="delAgent()">delete</button>
    </div>
    <div id="events"><div class="empty">Create or select an agent.<br>Every agent is durable: kill the process, it resumes where it left off.</div></div>
    <div id="composer">
      <select id="whenbusy"><option value="">deliver when free</option><option value="steer">steer (interrupt)</option><option value="followUp">follow up</option></select>
      <input id="msg" placeholder="message the agent…" onkeydown="if(event.key==='Enter')send()">
      <button class="primary" onclick="send()">Send</button>
    </div>
  </div>
</main>
<script>
let sel = null, state = null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

async function api(path, method, body) {
  const r = await fetch('/api/' + path, { method: method || 'GET', headers: {'content-type':'application/json'}, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error((await r.json()).error || r.statusText);
  return r.json();
}

function lcBadge(lc) {
  const k = (lc && lc.kind) || 'unknown';
  return '<span class="badge ' + k + '">' + k + '</span>';
}

async function refresh() {
  try { state = await api('state'); } catch (e) { return; }
  $('usage').textContent = state.usage && state.usage.total ? 'tokens: ' + JSON.stringify(state.usage.total).slice(0,80) : '';
  const lcs = Object.fromEntries((state.lifecycles||[]).map(l => [l.agentId, l]));
  $('agents').innerHTML = (state.agents||[]).map(a =>
    '<div class="agent' + (sel===a.agentId?' sel':'') + '" onclick="selectAgent(\\'' + a.agentId + '\\')">' +
    '<div class="name">' + esc(a.name) + '</div>' +
    '<div class="meta">' + lcBadge(lcs[a.agentId]) + '<span>' + esc(a.model.modelId) + '</span></div></div>').join('');
  $('inbox').innerHTML = (state.mainInbox||[]).slice(-50).reverse().map(m =>
    '<div class="feed-item"><div class="who">@' + esc(m.fromName) + '</div><div>' + esc(m.text) + '</div><div class="at">' + esc(m.at) + '</div></div>').join('') || '<div class="small">Nothing yet — agents message target "main" via send_message.</div>';
  $('reminders').innerHTML = (state.reminders||[]).map(r =>
    esc(r.agentId.slice(0,12)) + ' · ' + esc(r.text).slice(0,40) + ' · ' + esc(r.dueAt) + (r.everyMs? ' ↻':'') +
    ' <a href="#" style="color:var(--bad)" onclick="delReminder(\\'' + r.id + '\\');return false">✕</a>').join('<br>');
  if (sel) await refreshEvents();
}

async function selectAgent(id) { sel = id; await refresh(); }

async function refreshEvents() {
  const a = (state.agents||[]).find(x => x.agentId === sel);
  if (!a) { sel = null; return; }
  $('chat-title').textContent = a.name;
  const lc = (state.lifecycles||[]).find(l => l.agentId === sel);
  $('chat-badge').outerHTML = lcBadge(lc);
  const { events } = await api('agents/' + encodeURIComponent(a.agentId) + '/events?tail=120');
  $('events').innerHTML = events.map(e => renderEvent(e)).join('');
  $('events').scrollTop = $('events').scrollHeight;
}

function renderEvent(e) {
  const k = e.kind || e.type || 'event';
  let v = '';
  if (k === 'text') v = e.text;
  else if (k === 'thinking') v = e.text;
  else if (k === 'tool_call') v = '→ ' + e.name + ' ' + JSON.stringify(e.input||{}).slice(0,200);
  else if (k === 'tool_output') v = (e.isError?'✗ ':'✓ ') + String(e.text||'').slice(0,400);
  else if (k === 'error') v = e.message;
  else if (k === 'submission_settled') v = 'submission ' + e.submissionId + ' → ' + e.status;
  else if (k === 'run_start' || k === 'run_end') v = k;
  else v = JSON.stringify(e).slice(0,300);
  return '<div class="ev ' + k + '"><span class="k">' + esc(k) + '</span> <span class="v">' + esc(v) + '</span></div>';
}

async function send() {
  const text = $('msg').value.trim(); if (!text || !sel) return;
  $('msg').value = '';
  await api('agents/' + encodeURIComponent(sel) + '/messages', 'POST', { text, whenBusy: $('whenbusy').value || undefined });
  setTimeout(refresh, 800);
}
async function createAgent() {
  const name = $('na-name').value.trim(); if (!name) return;
  await api('agents', 'POST', { name, instructions: $('na-inst').value.trim() || undefined });
  $('na-name').value=''; $('na-inst').value=''; refresh();
}
async function agentAction(a) { if (!sel) return; await api('agents/' + sel + '/' + a, 'POST'); refresh(); }
async function delAgent() { if (!sel || !confirm('delete agent?')) return; await api('agents/' + sel + '?workspace=true', 'DELETE'); sel=null; refresh(); }
async function setReminder() {
  const agent=$('rm-agent').value.trim(), when=$('rm-when').value.trim(), text=$('rm-text').value.trim();
  if (!agent||!when||!text) return;
  try { await api('reminders', 'POST', {agent, when, text}); $('rm-when').value=''; $('rm-text').value=''; refresh(); }
  catch(e){ alert(e.message); }
}
async function delReminder(id){ await fetch('/api/reminders/'+id, {method:'DELETE'}); refresh(); }

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;

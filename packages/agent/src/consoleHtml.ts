/** The embedded web console — one HTML file, no build step. */
export const CONSOLE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>raftd — durable agents</title>
<style>
  /* Hand-drawn ink & watercolor theme (CC-lineart palette):
     paper #FAF9F5, ink #141413, washes sky/cactus/peach/kraft/clay/mineral. */
  :root { color-scheme: light; --bg:#FAF9F5; --card:#FFFEFA; --line:#E3DECF; --fg:#141413; --mut:#7A7263;
    --ink:#141413; --sky:#4C7FB3; --skyw:#DCE7F3; --clay:#B85C3E; --clayw:#F2DCD0;
    --min:#4A7D6C; --minw:#DAE8E2; --kraft:#B9845F; --kraftw:#EFE2D2; --plum:#635DA3;
    --wob:16px 24px 14px 26px/26px 14px 24px 16px;
    --wob2:24px 14px 26px 16px/14px 26px 16px 24px; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.55 -apple-system, "Segoe UI", system-ui, sans-serif; background:var(--bg); color:var(--fg); height:100vh; display:flex; flex-direction:column;
    background-image:radial-gradient(1200px 500px at 15% -8%, rgba(220,231,243,.55), transparent 60%), radial-gradient(900px 420px at 95% 4%, rgba(242,220,208,.5), transparent 55%); }
  ::selection { background:var(--skyw); }
  .ic { width:1.05em; height:1.05em; vertical-align:-.16em; }
  .ic.lg { width:1.5em; height:1.5em; }
  .ic.xl { width:56px; height:56px; }
  header { display:flex; align-items:center; gap:11px; padding:10px 18px; border-bottom:2px solid var(--ink); background:linear-gradient(180deg, #FFFDF7, var(--bg)); }
  header .brand { font-family:Georgia, "Songti SC", serif; font-size:18px; font-weight:700; letter-spacing:.02em; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--min); border:1.5px solid var(--ink); box-shadow:1px 1px 0 rgba(20,20,19,.2); }
  main { flex:1; display:flex; min-height:0; }
  #sidebar { width:252px; flex-shrink:0; border-right:2px solid var(--ink); overflow-y:auto; padding:14px 12px; background:rgba(255,254,250,.6); }
  #sidebar h3, #feed h3 { margin:4px 2px 10px; font:700 11.5px Georgia, "Songti SC", serif; text-transform:uppercase; letter-spacing:.14em; color:var(--ink); display:flex; align-items:center; gap:6px; }
  #sidebar h3 .ic, #feed h3 .ic { width:15px; height:15px; }
  .agent { padding:8px 10px; border-radius:var(--wob); cursor:pointer; margin-bottom:6px; border:1.5px solid transparent; display:flex; gap:9px; align-items:flex-start; transition:transform .12s ease; }
  .agent .ic { width:20px; height:20px; margin-top:2px; flex-shrink:0; }
  .agent:hover { background:var(--card); border-color:var(--line); transform:rotate(-.3deg); }
  .agent.sel { background:var(--skyw); border-color:var(--sky); box-shadow:2px 2px 0 rgba(76,127,179,.25); }
  .agent .name { font-weight:650; }
  .agent .meta { font-size:12px; color:var(--mut); display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .badge { font-size:11px; padding:1px 9px; border-radius:12px 10px 13px 9px; border:1.4px solid var(--mut); color:var(--mut); background:var(--card); }
  .badge.running { color:var(--min); border-color:var(--min); background:var(--minw); }
  .badge.queued, .badge.starting { color:var(--kraft); border-color:var(--kraft); background:var(--kraftw); }
  .badge.terminal, .badge.unreliable, .badge.cooldown { color:var(--clay); border-color:var(--clay); background:var(--clayw); }
  #content { flex:1; display:flex; min-width:0; }
  #feed { width:268px; flex-shrink:0; border-right:2px solid var(--ink); overflow-y:auto; padding:14px 12px; overflow-wrap:anywhere; background:rgba(255,254,250,.45); }
  .feed-item { border:1.5px solid var(--line); border-radius:var(--wob); padding:8px 11px; margin-bottom:9px; font-size:13px; background:var(--card); box-shadow:1px 2px 0 rgba(20,20,19,.06); }
  .feed-item .who { color:var(--sky); font-weight:650; margin-bottom:2px; }
  .feed-item .at { color:var(--mut); font-size:11px; margin-top:3px; }
  #err { display:none; position:fixed; top:58px; left:50%; transform:translateX(-50%) rotate(-.4deg); background:var(--clayw); color:var(--clay); border:1.8px solid var(--clay); padding:9px 18px; border-radius:var(--wob); font-size:13px; z-index:9; max-width:80%; box-shadow:2px 3px 0 rgba(184,92,62,.25); }
  #chat { flex:1; display:flex; flex-direction:column; min-width:0; }
  @media (max-width: 700px) {
    main { flex-direction:column; }
    #sidebar { width:auto; border-right:none; border-bottom:2px solid var(--ink); max-height:22vh; }
    #content { flex-direction:column; min-height:0; }
    #feed { width:auto; border-right:none; border-bottom:2px solid var(--ink); max-height:18vh; }
    #chat { min-height:0; flex:1; }
    #composer { flex-wrap:wrap; }
    #composer #msg { order:-1; flex:1 1 100%; }
    #composer select { flex:1 1 60%; min-width:0; }
    #composer button { flex:1 1 30%; }
  }
  #chat-head { padding:10px 16px; border-bottom:2px solid var(--ink); display:flex; align-items:center; gap:9px; flex-wrap:wrap; background:linear-gradient(180deg, rgba(255,253,247,.9), transparent); }
  #chat-actions { display:flex; gap:6px; flex-wrap:wrap; }
  #chat-actions button { padding:4px 10px; font-size:12px; }
  #chat-head .t { font:700 15.5px Georgia, "Songti SC", serif; }
  #events { flex:1; overflow-y:auto; overflow-anchor:none; padding:18px; font-size:13.5px; min-height:60px; }
  .row { margin-bottom:11px; max-width:76%; }
  .row .body { padding:9px 14px; border-radius:var(--wob); white-space:pre-wrap; word-break:break-word; }
  .row.user { margin-left:auto; }
  .row.user .body { background:var(--skyw); border:1.5px solid var(--sky); box-shadow:2px 2px 0 rgba(76,127,179,.2); }
  .row.agent .body { background:var(--card); border:1.5px solid var(--ink); box-shadow:2px 2px 0 rgba(20,20,19,.14); }
  .row.tool { max-width:100%; }
  .row.tool .body { background:transparent; border:1.5px dashed var(--mut); border-radius:12px; padding:6px 11px; font-family:ui-monospace,Menlo,monospace; font-size:12px; color:var(--mut); }
  .row.tool .body.err { border-color:var(--clay); color:var(--clay); background:var(--clayw); }
  .row .who { font:italic 11px Georgia, serif; color:var(--mut); margin-bottom:3px; }
  .row.user .who { text-align:right; }
  .tc { font-family:ui-monospace,Menlo,monospace; font-size:12px; color:var(--kraft); margin-top:5px; }
  .tk { font-size:12px; color:var(--mut); font-style:italic; margin-top:5px; border-left:2.5px solid var(--line); padding-left:8px; }
  #composer { display:flex; gap:9px; padding:12px 16px; border-top:2px solid var(--ink); background:rgba(255,253,247,.7); }
  #composer textarea { flex:1; min-width:0; resize:vertical; max-height:160px; background:var(--card); border:1.5px solid var(--ink); border-radius:var(--wob); color:var(--fg); padding:9px 13px; font:inherit; box-shadow:1px 2px 0 rgba(20,20,19,.08); }
  #composer textarea:focus { outline:none; border-color:var(--sky); box-shadow:2px 2px 0 rgba(76,127,179,.25); }
  #composer select { min-width:0; max-width:100%; }
  #composer select, button { background:var(--card); border:1.5px solid var(--ink); border-radius:12px 15px 11px 16px/16px 11px 15px 12px; color:var(--fg); padding:8px 13px; font:inherit; cursor:pointer; box-shadow:2px 2px 0 rgba(20,20,19,.12); transition:transform .12s ease, box-shadow .12s ease; }
  button:hover:not(:disabled) { transform:translate(-1px,-1px) rotate(-.4deg); box-shadow:3px 3px 0 rgba(20,20,19,.16); }
  button:active:not(:disabled) { transform:translate(1px,1px); box-shadow:1px 1px 0 rgba(20,20,19,.14); }
  button:disabled { opacity:.45; cursor:default; box-shadow:none; }
  button.primary { background:var(--ink); color:var(--bg); font-weight:600; }
  button.primary:hover:not(:disabled) { background:#26251f; }
  .empty { color:var(--mut); text-align:center; margin-top:70px; line-height:2; }
  .empty .ic.xl { display:block; margin:0 auto 10px; opacity:.85; }
  .empty code { background:var(--card); border:1px solid var(--line); padding:2px 8px; border-radius:6px; }
  #new-agent { border:1.6px dashed var(--ink); border-radius:var(--wob2); padding:11px; margin-top:10px; background:rgba(218,232,226,.35); }
  #new-agent input { width:100%; background:var(--card); border:1.4px solid var(--mut); border-radius:10px 13px 9px 14px/14px 9px 13px 10px; color:var(--fg); padding:7px 10px; font:inherit; margin-bottom:7px; }
  #new-agent input:focus { outline:none; border-color:var(--min); box-shadow:2px 2px 0 rgba(74,125,108,.2); }
  .btnrow { display:flex; gap:7px; }
  #remind { border:1.6px dashed var(--ink); border-radius:var(--wob); padding:11px; margin-top:10px; font-size:12px; background:rgba(242,220,208,.3); }
  #remind b { font-family:Georgia, serif; }
  #remind input { width:100%; background:var(--card); border:1.4px solid var(--mut); border-radius:10px 13px 9px 14px/14px 9px 13px 10px; color:var(--fg); padding:6px 9px; font:inherit; margin-bottom:7px; }
  .small { font-size:12px; color:var(--mut); }
  .reminder { display:block; margin-bottom:5px; }
  .reminder button { padding:0 7px; font-size:12px; margin-left:4px; }
  [hidden] { display:none !important; }
  #auth-panel { position:fixed; inset:0; z-index:20; display:flex; align-items:center; justify-content:center; background:rgba(20,20,19,.42); padding:18px; }
  #auth-form, dialog { width:430px; max-width:100%; background:var(--card); color:var(--fg); border:2px solid var(--ink); border-radius:var(--wob); padding:24px; box-shadow:4px 5px 0 rgba(20,20,19,.18); }
  #auth-form h2, dialog h2 { margin-top:0; font:700 19px Georgia, "Songti SC", serif; display:flex; align-items:center; gap:9px; }
  #auth-key { width:100%; margin:8px 0 12px; padding:10px; color:var(--fg); background:var(--bg); border:1.5px solid var(--ink); border-radius:10px 13px 9px 14px/14px 9px 13px 10px; }
  #auth-error { color:var(--clay); min-height:1.5em; }
  dialog::backdrop { background:rgba(20,20,19,.42); }
  dialog label { display:block; margin:16px 0; }
  button.danger { color:var(--clay); border-color:var(--clay); }
  button.danger:hover:not(:disabled) { background:var(--clayw); box-shadow:3px 3px 0 rgba(184,92,62,.25); }
  ::-webkit-scrollbar { width:10px; }
  ::-webkit-scrollbar-thumb { background:var(--line); border-radius:5px; border:2px solid var(--bg); }
  ::-webkit-scrollbar-track { background:transparent; }
</style>
</head>
<body>
<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">
<defs>
<filter id="wash" x="-8%" y="-8%" width="116%" height="116%">
<feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves="3" seed="37" result="n"/>
<feDisplacementMap in="SourceGraphic" in2="n" scale="2.6" xChannelSelector="R" yChannelSelector="G" result="d"/>
<feColorMatrix in="n" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.1 1.45" result="a"/>
<feComposite in="d" in2="a" operator="in"/>
</filter>
<filter id="ink" x="-8%" y="-8%" width="116%" height="116%">
<feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed="48" result="n"/>
<feDisplacementMap in="SourceGraphic" in2="n" scale="1.5" xChannelSelector="R" yChannelSelector="G"/>
</filter>
</defs>
<symbol id="i-raft" viewBox="0 0 64 64"><g id="layer-block" filter="url(#wash)"><g transform="translate(32 32) scale(1.0) translate(-32 -32)">
<path d="M3 30 L42 27.5 L44.5 60 L5 61.5 Z" fill="#6A9BCC"/>
<path d="M3 30 L42 27.5 L44.5 60 L5 61.5 Z" fill="none" stroke="#4C7FB3" stroke-width="1.4" stroke-opacity="0.55" stroke-linejoin="round"/>
</g></g>
<g id="layer-ink" filter="url(#ink)" fill="none" stroke="#141413" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
<path d="M14 56.5 C18 53.5 22 53.5 26 56.5 S34 59.5 38 56.5 S46 53.5 51 56.8"/>
<path d="M31.5 40 C31.8 30 31.6 19 32 8.5"/>
<path d="M32 8.5 L39.5 11 L32.2 13.6" fill="#FAF9F5"/>
<path d="M34 13 C44 19 51 27.5 54.5 36 L34 36.4 Z" fill="#FAF9F5"/>
<path d="M10.4 46.7 C9.4 44.4 10.2 41.8 12.2 40.3 C14.1 38.8 16.8 38.7 18.8 40.2 C20.8 41.7 21.6 44.3 20.7 46.7 C19.7 49.0 17.3 50.2 14.9 50.0 C12.5 49.7 10.2 48.0 9.8 45.4" fill="#FAF9F5"/>
<path d="M32.2 44.5 C32.1 47.1 30.0 48.9 27.8 49.4 C25.5 49.9 22.9 49.1 21.7 46.9 C20.5 44.7 21.2 42.1 23.0 40.4 C24.7 38.8 27.4 38.3 29.5 39.6 C31.6 40.9 32.9 43.4 32.2 45.9" fill="#FAF9F5"/>
<path d="M42.4 47.7 C41.0 49.8 38.3 50.7 35.9 49.9 C33.6 49.1 31.9 46.8 32.1 44.3 C32.2 41.7 34.0 39.6 36.5 39.1 C39.0 38.5 41.5 39.8 42.7 42.0 C43.8 44.3 43.6 47.1 41.6 48.9" fill="#FAF9F5"/>
<path d="M53.3 47.8 C51.7 49.8 49.0 50.4 46.7 49.5 C44.3 48.5 43.0 46.1 43.3 43.6 C43.6 41.1 45.6 39.2 48.0 38.9 C50.5 38.5 52.6 40.1 53.5 42.3 C54.4 44.4 54.1 47.0 52.2 48.6" fill="#FAF9F5"/>
</g></symbol>
<symbol id="i-bot" viewBox="0 0 64 64"><g id="layer-block" filter="url(#wash)"><g transform="translate(32 32) scale(1.0) translate(-32 -32)">
<path d="M8 16 L48 13.5 L51 52 L10 54.5 Z" fill="#BCD1CA"/>
<path d="M8 16 L48 13.5 L51 52 L10 54.5 Z" fill="none" stroke="#93B0A6" stroke-width="1.4" stroke-opacity="0.55" stroke-linejoin="round"/>
</g></g>
<g id="layer-ink" filter="url(#ink)" fill="none" stroke="#141413" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
<path d="M32.2 17.5 C32.4 13.8 32.1 10.2 32.6 6.5"/>
<circle cx="32.6" cy="6" r="2.2" fill="#FAF9F5"/>
<path d="M16 24 C22 21.8 42 21.6 48 23.8 L47.5 44 C41 46.3 23 46.5 16.5 44.2 Z" fill="#FAF9F5"/>
<circle cx="25.5" cy="32.5" r="3.2" fill="#FAF9F5"/>
<circle cx="39.6" cy="32.4" r="2.7" fill="#FAF9F5"/>
<path d="M26.5 39.5 C30 41.5 34.5 41.4 38 39.3"/>
<path d="M16 30.5 L11.5 29.8 C10.8 32.5 11.2 35.5 13 37 L15.8 36.4"/>
<path d="M48 29.5 C51.5 28 54.2 30.5 53.8 33.5 C53.4 36.2 50.8 37.2 48.3 36"/>
<path d="M24 48.5 L24.3 53.5 M40 48.4 L39.7 51.8"/>
<path d="M21 53.5 C27 54.3 37 54.5 43 53.8"/>
</g></symbol>
<symbol id="i-plane" viewBox="0 0 64 64"><g id="layer-block" filter="url(#wash)"><g transform="translate(32 32) scale(1.0) translate(-32 -32)">
<path d="M8 20 L46 18 L48.5 56 L10 58 Z" fill="#D97757"/>
<path d="M8 20 L46 18 L48.5 56 L10 58 Z" fill="none" stroke="#B85C3E" stroke-width="1.4" stroke-opacity="0.55" stroke-linejoin="round"/>
</g></g>
<g id="layer-ink" filter="url(#ink)" fill="none" stroke="#141413" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
<path d="M6 47 C12 51.5 18 53 24.5 50.5" stroke-dasharray="3.5 4.5"/>
<path d="M6 30 L58 8 L44 50 L32 36 Z" fill="#FAF9F5"/>
<path d="M58 8 L32 36"/>
<path d="M32 36 L30.5 47 L37.5 41.5" fill="#FAF9F5"/>
</g></symbol>
<symbol id="i-sprout" viewBox="0 0 64 64"><g id="layer-block" filter="url(#wash)"><g transform="translate(32 32) scale(1.0) translate(-32 -32)">
<path d="M9 12 L50 14 L48 50 L7 48 Z" fill="#788C5D"/>
<path d="M9 12 L50 14 L48 50 L7 48 Z" fill="none" stroke="#5D7046" stroke-width="1.4" stroke-opacity="0.55" stroke-linejoin="round"/>
</g></g>
<g id="layer-ink" filter="url(#ink)" fill="none" stroke="#141413" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
<path d="M32 40 C32 32 31 26 32 20"/>
<path d="M32 30 C24 31 17 26 16 18 C24 17 30 21 32 30 Z" fill="#FAF9F5"/>
<path d="M32 22 C36 14 44 11 51 12 C50 20 42 25 32 22 Z" fill="#FAF9F5"/>
<path d="M20 40 C28 39.6 36 39.8 44 40.2 L41 58 C35 58.6 29 58.5 23 57.8 Z" fill="#FAF9F5"/>
<path d="M17.5 40.3 C27 39.4 37 39.6 46.5 40" stroke-width="4.2"/>
</g></symbol>
<symbol id="i-inbox" viewBox="0 0 64 64"><g id="layer-block" filter="url(#wash)"><g transform="translate(32 32) scale(1.0) translate(-32 -32)">
<path d="M14 10 L54 14 L50 52 L10 49 Z" fill="#D4A27F"/>
<path d="M14 10 L54 14 L50 52 L10 49 Z" fill="none" stroke="#B9845F" stroke-width="1.4" stroke-opacity="0.55" stroke-linejoin="round"/>
</g></g>
<g id="layer-ink" filter="url(#ink)" fill="none" stroke="#141413" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
<path d="M22 20 L42 22.5 L40.5 34 L21 31.5 Z" fill="#FAF9F5"/>
<path d="M23 21.5 L31.5 28 L40.5 23"/>
<path d="M12 36.5 C20 34.8 44 34.4 52 36 L47.5 52.5 C39 54.3 25 54.2 16.5 52.8 Z" fill="#FAF9F5"/>
<path d="M12 37 C21 35.2 44 34.8 52 36.2" stroke-width="4.2"/>
<path d="M24 43 C30 44 36 44.2 42 43.4"/>
</g></symbol>
<symbol id="i-bell" viewBox="0 0 64 64"><g id="layer-block" filter="url(#wash)"><g transform="translate(32 32) scale(1.0) translate(-32 -32)">
<path d="M12 12 L50 9.5 L53 48 L15 51 Z" fill="#EBC9B7"/>
<path d="M12 12 L50 9.5 L53 48 L15 51 Z" fill="none" stroke="#D3A58D" stroke-width="1.4" stroke-opacity="0.55" stroke-linejoin="round"/>
</g></g>
<g id="layer-ink" filter="url(#ink)" fill="none" stroke="#141413" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
<path d="M31 10 C32 9 33.5 9.5 33.4 11"/>
<path d="M32.2 11.5 C24 14.5 20 23 21.5 33 L20.5 40.5 C27.5 43.2 37.5 43.4 44 40.8 L41.5 32.5 C43 22 39.5 14 32.2 11.5 Z" fill="#FAF9F5"/>
<path d="M20.5 40.5 C28 43.5 37 43.6 44.5 40.9" stroke-width="4"/>
<circle cx="32.6" cy="47.5" r="2.6" fill="#FAF9F5"/>
<path d="M50 22 C52.5 20 54.5 17.5 55.8 14.5"/>
<path d="M52.5 28.5 C55.5 27.5 58.5 26.5 60.8 24.5"/>
</g></symbol>
<symbol id="i-gauge" viewBox="0 0 64 64"><g id="layer-block" filter="url(#wash)"><g transform="translate(32 32) scale(1.0) translate(-32 -32)">
<path d="M9 20 L47 17 L50 55 L12 57 Z" fill="#629987"/>
<path d="M9 20 L47 17 L50 55 L12 57 Z" fill="none" stroke="#4A7D6C" stroke-width="1.4" stroke-opacity="0.55" stroke-linejoin="round"/>
</g></g>
<g id="layer-ink" filter="url(#ink)" fill="none" stroke="#141413" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
<path d="M14 42 C14.5 28 22 18.5 33 18 C44 17.5 52.5 27.5 52 41.5" fill="none"/>
<path d="M17.5 42 L21.5 40.8 M21 30.5 L24.5 32 M32.5 22.5 L32.8 26.5 M44 27 L41.5 30.5 M49 38 L45.5 37"/>
<path d="M33 41 L44 26.5"/>
<circle cx="33" cy="41" r="3" fill="#FAF9F5"/>
<path d="M22 49.5 C28 51 38 51.3 44 49.8 L45.5 54.5 C37 56.3 28 56.2 20.5 54.8 Z" fill="#FAF9F5"/>
</g></symbol>
<symbol id="i-trash" viewBox="0 0 64 64"><g id="layer-block" filter="url(#wash)"><g transform="translate(32 32) scale(1.0) translate(-32 -32)">
<path d="M12 14 L52 11 L55 50 L14 53 Z" fill="#D97757"/>
<path d="M12 14 L52 11 L55 50 L14 53 Z" fill="none" stroke="#B85C3E" stroke-width="1.4" stroke-opacity="0.55" stroke-linejoin="round"/>
</g></g>
<g id="layer-ink" filter="url(#ink)" fill="none" stroke="#141413" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
<path d="M20 22.5 L44.5 21.5 L42 52 C34.5 53.5 27 53.4 22.5 52.3 Z" fill="#FAF9F5"/>
<path d="M17 21.5 C26 20.2 38 19.8 47.5 20.8" stroke-width="4.4"/>
<path d="M23 16.2 C28 14.2 37 14.2 42 16 L41.6 19.8 C35 18.6 28.5 19 23.5 20.4 Z" fill="#FAF9F5"/>
<path d="M26.5 27.5 L27 44 M33.5 26.5 L33.8 47 M39.5 26.8 L39 42.5"/>
<path d="M42.5 15.2 L47 12.8"/>
</g></symbol>
<symbol id="i-play" viewBox="0 0 64 64"><g id="layer-block" filter="url(#wash)"><g transform="translate(32 32) scale(1.0) translate(-32 -32)">
<path d="M11 11 L50 14 L47 54 L8 51 Z" fill="#BCD1CA"/>
<path d="M11 11 L50 14 L47 54 L8 51 Z" fill="none" stroke="#93B0A6" stroke-width="1.4" stroke-opacity="0.55" stroke-linejoin="round"/>
</g></g>
<g id="layer-ink" filter="url(#ink)" fill="none" stroke="#141413" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
<path d="M22 15 C21.8 28 21.6 40 22.2 52" fill="none"/>
<path d="M22.3 15.2 C33 22.5 43.5 28.5 53.5 33.5" fill="none"/>
<path d="M53.2 33.3 C43 40.5 32.5 46.5 22.4 52.3" fill="none"/>
<path d="M22 14.5 L54 33.5 L22.3 52.8" fill="none"/>
<path d="M47 48 C49.5 49.5 49.8 52.5 47.8 54.3 C45.8 56 43 55.5 42.2 53.2 C41.5 51 43.3 48.8 45.5 48.7" fill="#FAF9F5"/>
</g></symbol>
<symbol id="i-stop" viewBox="0 0 64 64"><g id="layer-block" filter="url(#wash)"><g transform="translate(32 32) scale(1.0) translate(-32 -32)">
<path d="M13 10 L53 13 L50 53 L10 50 Z" fill="#D97757"/>
<path d="M13 10 L53 13 L50 53 L10 50 Z" fill="none" stroke="#B85C3E" stroke-width="1.4" stroke-opacity="0.55" stroke-linejoin="round"/>
</g></g>
<g id="layer-ink" filter="url(#ink)" fill="none" stroke="#141413" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
<path d="M24 12 L40 11.5 L51.5 22.5 L52 38.5 L40.5 49.5 L24.5 50 L13 39 L12.5 23 Z" fill="#FAF9F5"/>
<path d="M27.5 24.5 L36.8 33.8 M37 24.2 L29.5 32.6" stroke-width="4"/>
<path d="M41 26.5 L46 31.5 M22 37.5 L26.5 42"/>
<path d="M32.2 50.5 C32 54.5 32.3 58 31.8 62"/>
<path d="M26 62.5 C30 63.5 35 63.4 38.5 62.2"/>
</g></symbol>
<symbol id="i-terminal" viewBox="0 0 64 64"><g id="layer-block" filter="url(#wash)"><g transform="translate(32 32) scale(1.0) translate(-32 -32)">
<path d="M5 18 L43 15.5 L45.5 55 L7 57 Z" fill="#D97757"/>
<path d="M5 18 L43 15.5 L45.5 55 L7 57 Z" fill="none" stroke="#B85C3E" stroke-width="1.4" stroke-opacity="0.55" stroke-linejoin="round"/>
</g></g>
<g id="layer-ink" filter="url(#ink)" fill="none" stroke="#141413" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
<path d="M15 9.5 C29 8.8 44 9.2 57.5 10 L56.8 47.5 C43 48.3 28 48 14.2 47.6 Z" fill="#FAF9F5"/>
<path d="M15 18 C29 17.4 44 17.8 57.3 18.3"/>
<circle cx="20" cy="13.9" r="1.3" fill="#141413" stroke="none"/>
<circle cx="25" cy="13.9" r="1.3" fill="#141413" stroke="none"/>
<path d="M23 27 L31 32.5 L23 38"/>
<path d="M35 38.6 L46 38.2"/>
</g></symbol>
<symbol id="i-chat" viewBox="0 0 64 64"><g id="layer-block" filter="url(#wash)"><g transform="translate(32 32) scale(1.0) translate(-32 -32)">
<path d="M25 27 L60 25 L62 61 L27 62.5 Z" fill="#CBCADB"/>
<path d="M25 27 L60 25 L62 61 L27 62.5 Z" fill="none" stroke="#A4A2BF" stroke-width="1.4" stroke-opacity="0.55" stroke-linejoin="round"/>
</g></g>
<g id="layer-ink" filter="url(#ink)" fill="none" stroke="#141413" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
<path d="M30 8.5 C44 7.5 56.5 11.5 56.5 21.5 C56.5 30.5 47.5 35 38.5 35 L37 42 L31.5 34.6 C24 33 19 28 19.5 21.5 C20 13 25 9 30 8.5 Z" fill="#FAF9F5"/>
<path d="M24 26 C14 25.5 7 30 7 37.5 C7 44 12.5 48 19 48.5 L18 56.5 L25.5 49 C34 49 41.5 45 41.5 37.5 C41.5 30 34 26.3 24 26 Z" fill="#FAF9F5"/>
<circle cx="16.5" cy="38" r="1.9" fill="#141413" stroke="none"/>
<circle cx="24" cy="38" r="1.9" fill="#141413" stroke="none"/>
<circle cx="31.5" cy="38" r="1.9" fill="#141413" stroke="none"/>
</g></symbol>
</svg>
<div id="err"></div>
<section id="auth-panel" role="dialog" aria-modal="true" aria-labelledby="auth-title" hidden>
  <form id="auth-form">
    <h2 id="auth-title"><svg class="ic lg"><use href="#i-raft"/></svg>Connect to raftd</h2>
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
    <h2 id="delete-title"><svg class="ic lg"><use href="#i-trash"/></svg>Delete agent?</h2>
    <p id="delete-name"></p>
    <p>The agent will be removed. Its workspace files are kept unless you choose to delete them.</p>
    <label><input id="delete-workspace" type="checkbox"> Permanently delete its managed workspace and files</label>
    <p class="small">Custom workspace directories are never deleted.</p>
    <div class="btnrow"><button class="danger" type="submit">Delete agent</button><button type="button" onclick="document.getElementById('delete-dialog').close()">Cancel</button></div>
  </form>
</dialog>
<header>
  <svg class="ic lg"><use href="#i-raft"/></svg><span class="dot"></span><span class="brand">raftd</span>
  <span class="small" id="usage"></span>
  <span style="flex:1"></span>
  <span class="small" id="state-dir"></span>
  <button id="auth-open" type="button" hidden>Connect</button>
</header>
<main>
  <div id="sidebar">
    <h3><svg class="ic"><use href="#i-bot"/></svg>Agents</h3>
    <div id="agents"></div>
    <div id="new-agent">
      <input id="na-name" placeholder="agent name">
      <input id="na-inst" placeholder="instructions (optional)">
      <input id="na-model" aria-label="Model" placeholder="model (optional: provider/model-id)">
      <div class="btnrow"><button class="primary" onclick="createAgent()" style="flex:1"><svg class="ic"><use href="#i-sprout"/></svg> New agent</button></div>
    </div>
  </div>
  <div id="feed">
    <h3><svg class="ic"><use href="#i-inbox"/></svg>Operator inbox</h3>
    <div id="inbox"></div>
    <div id="remind">
      <b><svg class="ic"><use href="#i-bell"/></svg> Set a reminder</b><br>
      <input id="rm-agent" placeholder="agent">
      <input id="rm-when" placeholder='when: "in 30m" / "every 1h" / "at 14:30"'>
      <input id="rm-text" placeholder="text">
      <div class="btnrow"><button onclick="setReminder()" style="flex:1">Remind</button></div>
      <div id="reminders" class="small" style="margin-top:8px"></div>
    </div>
  </div>
  <div id="chat">
    <div id="chat-head">
      <svg class="ic lg" id="chat-icon" style="display:none"><use href="#i-bot"/></svg>
      <span class="t" id="chat-title">Select an agent</span>
      <span class="badge" id="chat-badge"></span>
      <span class="err small" id="chat-err"></span>
      <span style="flex:1"></span>
      <div id="chat-actions">
        <button id="btn-stop" onclick="agentAction('stop')" disabled title="stop"><svg class="ic"><use href="#i-stop"/></svg> stop</button>
        <button id="btn-start" onclick="agentAction('start')" disabled title="start"><svg class="ic"><use href="#i-play"/></svg> start</button>
        <button id="btn-abort" onclick="agentAction('abort')" disabled>abort turn</button>
        <button id="btn-compact" onclick="agentAction('compact')" disabled>compact</button>
        <button id="btn-reset" onclick="agentAction('reset')" disabled>reset</button>
        <button id="btn-resolve" onclick="agentAction('resolve')" disabled>resolve</button>
        <button id="btn-del" class="danger" onclick="delAgent()" disabled title="delete"><svg class="ic"><use href="#i-trash"/></svg></button>
      </div>
    </div>
    <div id="events"><div class="empty"><svg class="ic xl"><use href="#i-raft"/></svg>Create or select an agent.<br>Every agent is durable: kill the process, it resumes where it left off.</div></div>
    <div id="composer">
      <select id="whenbusy"><option value="" title="wait in line behind the current turn">queue (default)</option><option value="steer" title="inject into the running turn now">interrupt the run</option><option value="followUp" title="send right after the current turn finishes">follow up next</option></select>
      <textarea id="msg" rows="2" aria-label="Message the agent" placeholder="Message the agent… (Enter to send, Shift+Enter for a new line)" onkeydown="if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();send();}"></textarea>
      <button class="primary" onclick="send()"><svg class="ic"><use href="#i-plane"/></svg> Send</button>
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
    a => '<svg class="ic"><use href="#i-bot"/></svg><div><div class="name">' + esc(a.name) + '</div><div class="meta">' + lcBadge(lcs[a.agentId]) + '<span>' + esc(a.model.modelId) + '</span></div></div>',
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
    $('chat-icon').style.display = '';
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
  $('chat-icon').style.display = 'none';
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

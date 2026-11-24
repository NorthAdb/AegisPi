// The local web console frontend (Unit 5.5; spec 04 sections 2-5, 02
// section 7). One same-origin page, zero external assets, and a hard rule:
// UNTRUSTED DATA NEVER TOUCHES raw HTML sinks — every dynamic value enters
// the DOM through textContent (the HTML below is a static template; the only
// interpolation is the port number, a server-owned constant). Links are not
// rendered from data at all, so there is no href/src protocol surface.
//
// Auth: the operator pastes the bootstrap token (workspace-state/console/
// token); POST /api/session mints sessionId + csrfToken held in JS memory
// only. Tokens never appear in any URL, never in localStorage, never in a
// log line the page writes.
//
// SSE state machine (04 section 5): snapshot FIRST (records generation +
// watermark), then a Bearer-authenticated fetch-stream (EventSource cannot
// send headers, and a token in the URL is forbidden). `reset` events, HTTP
// 410, or an acl_changed revision wipe the in-memory state and re-pull the
// full snapshot.

export function consoleIndexHtml({ port }) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AegisPi Console · 127.0.0.1:${port}</title>
<style>
  :root {
    --bg:#0e1116; --panel:#161b22; --panel2:#1b2129; --line:#2b313b;
    --fg:#d7dde5; --dim:#8b949e; --ok:#3fb950; --warn:#d29922;
    --bad:#f85149; --accent:#58a6ff;
  }
  * { box-sizing: border-box; }
  body {
    margin:0; background:var(--bg); color:var(--fg);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  }
  code, pre, .mono { font-family:"Cascadia Mono",Consolas,"SFMono-Regular",monospace; }
  header {
    padding:10px 16px; border-bottom:1px solid var(--line); background:var(--panel);
    display:flex; gap:12px; align-items:center; flex-wrap:wrap;
  }
  header h1 { font-size:15px; margin:0; color:var(--accent); font-weight:600; letter-spacing:0.2px; }
  header .state { color:var(--dim); font-size:12px; }
  .kpi-bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-left:auto; }
  .kpi-pill {
    background:#0d1117; border:1px solid var(--line); color:var(--fg);
    border-radius:999px; padding:3px 10px; font-size:12px; cursor:pointer;
    font:inherit; display:inline-flex; align-items:center; gap:5px; white-space:nowrap;
  }
  .kpi-pill:hover { border-color:var(--accent); }
  .kpi-pill.warn { border-color:rgba(210,153,34,0.55); color:var(--warn); }
  .kpi-pill.bad { border-color:rgba(248,81,73,0.65); color:var(--bad); }
  .kpi-pill.ok { border-color:rgba(63,185,80,0.45); color:var(--ok); }
  nav {
    display:flex; gap:6px; padding:8px 16px 0; border-bottom:1px solid var(--line);
    background:var(--bg); flex-wrap:wrap;
  }
  nav button {
    background:none; border:1px solid var(--line); border-bottom:none;
    border-radius:6px 6px 0 0; color:var(--dim); padding:7px 14px;
    cursor:pointer; font:inherit; font-size:13px; white-space:nowrap;
  }
  nav button:hover { color:var(--fg); }
  nav button.active {
    color:var(--fg); background:var(--panel); border-color:var(--accent);
    box-shadow:inset 0 2px 0 var(--accent);
  }
  .error-banner {
    margin:10px 16px 0; padding:8px 12px; border:1px solid rgba(248,81,73,0.65);
    background:rgba(248,81,73,0.12); color:#ffb4ae; border-radius:6px;
    display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:13px;
  }
  .error-banner button {
    background:none; border:1px solid rgba(248,81,73,0.5); color:#ffb4ae;
    border-radius:4px; padding:2px 8px; cursor:pointer; font:inherit;
  }
  main { padding:14px 16px 60px; }
  .panel {
    background:var(--panel); border:1px solid var(--line); border-radius:8px;
    padding:12px 14px; margin-bottom:12px;
  }
  .panel h2 { font-size:13.5px; margin:0 0 10px; color:var(--accent); font-weight:600; }
  .table-wrap { width:100%; overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th, td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:600; white-space:nowrap; font-size:12px; background:rgba(13,17,23,0.5); }
  .pill {
    display:inline-block; padding:2px 8px; border:1px solid var(--line);
    border-radius:999px; font-size:11px; white-space:nowrap; background:#0d1117;
  }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); } .dim { color:var(--dim); }
  .pill.ok { border-color:rgba(63,185,80,0.45); }
  .pill.warn { border-color:rgba(210,153,34,0.5); }
  .pill.bad { border-color:rgba(248,81,73,0.55); }
  button.act {
    background:#21262d; color:var(--fg); border:1px solid var(--line);
    padding:5px 11px; cursor:pointer; font:inherit; font-size:12px;
    border-radius:6px; white-space:nowrap;
  }
  button.act:hover:not(:disabled) { border-color:var(--accent); background:#282f38; }
  button.act.primary { background:#1f6feb; border-color:#388bfd; color:#fff; }
  button.act.primary:hover:not(:disabled) { background:#388bfd; }
  button.act.danger { color:var(--bad); border-color:rgba(248,81,73,0.4); }
  button.act.danger:hover:not(:disabled) { border-color:var(--bad); background:rgba(248,81,73,0.1); }
  button.act:disabled { opacity:0.42; cursor:not-allowed; }
  input, textarea, select {
    background:#0d1117; color:var(--fg); border:1px solid var(--line);
    padding:6px 9px; font:inherit; font-size:13px; border-radius:6px;
  }
  input:focus, textarea:focus, select:focus { outline:none; border-color:var(--accent); }
  textarea { width:100%; min-height:72px; resize:vertical; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:6px 0; }
  .btn-group { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .bar { height:10px; background:#0d1117; border:1px solid var(--line); border-radius:5px; overflow:hidden; width:100%; }
  .bar > div { height:100%; background:var(--accent); }
  .bar.full > div { background:var(--bad); }
  .meter { margin:8px 0; }
  .meter .label { display:flex; justify-content:space-between; font-size:12px; color:var(--dim); gap:8px; flex-wrap:wrap; margin-bottom:4px; }
  pre {
    background:#0d1117; border:1px solid var(--line); border-radius:6px;
    padding:10px; overflow:auto; max-height:300px; font-size:12px;
    white-space:pre-wrap; word-break:break-word; margin:6px 0;
  }
  .kv { display:grid; grid-template-columns: max-content 1fr; gap:4px 12px; font-size:12.5px; margin-top:6px; }
  .kv .k { color:var(--dim); }
  .hidden { display:none !important; }
  .nowrap { white-space:nowrap; }
  #loginBox { max-width:520px; margin:60px auto; }
  details summary { cursor:pointer; color:var(--dim); font-size:12px; user-select:none; }
  details summary:hover { color:var(--fg); }

  /* Chat workbench layout */
  .chat-layout { display:grid; grid-template-columns:240px 1fr; gap:12px; align-items:start; }
  @media (max-width: 840px) { .chat-layout { grid-template-columns:1fr; } }
  .chat-rail { display:flex; flex-direction:column; gap:10px; }
  .thread-list { display:flex; flex-direction:column; gap:6px; max-height:360px; overflow-y:auto; }
  .thread-item {
    text-align:left; width:100%; background:#0d1117; border:1px solid var(--line);
    border-radius:6px; padding:8px 9px; color:var(--fg); cursor:pointer; font:inherit;
    display:flex; flex-direction:column; gap:3px;
  }
  .thread-item:hover { border-color:var(--accent); }
  .thread-item.active { border-color:var(--accent); background:rgba(88,166,255,0.1); }
  .thread-top { display:flex; justify-content:space-between; align-items:center; gap:6px; font-size:12px; }
  .thread-key { font-size:12px; font-weight:600; word-break:break-all; }
  .thread-sub { font-size:11px; color:var(--dim); word-break:break-all; }
  .thread-time { font-size:11px; color:var(--dim); white-space:nowrap; }
  .chat-main { display:flex; flex-direction:column; gap:10px; min-width:0; }
  .chat-header {
    display:flex; justify-content:space-between; align-items:center; gap:8px;
    flex-wrap:wrap; padding-bottom:8px; border-bottom:1px solid var(--line);
  }
  .chat-stream {
    display:flex; flex-direction:column; gap:10px; min-height:300px;
    max-height:56vh; overflow-y:auto; padding:4px 2px;
  }
  .msg-user {
    align-self:flex-end; max-width:85%; background:#1c2d42; border:1px solid #2f4d73;
    border-radius:10px 10px 2px 10px; padding:9px 12px;
  }
  .msg-assistant {
    align-self:stretch; background:var(--panel2); border:1px solid var(--line);
    border-radius:8px; padding:10px 12px;
  }
  .msg-meta { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:11.5px; color:var(--dim); margin-bottom:4px; }
  .msg-body { white-space:pre-wrap; word-break:break-word; font-size:13.5px; line-height:1.55; }
  .inline-approval {
    margin-top:8px; padding:9px 10px; background:#0d1117; border:1px solid rgba(210,153,34,0.5);
    border-radius:6px;
  }
  .composer { border-top:1px solid var(--line); padding-top:10px; display:flex; flex-direction:column; gap:8px; }
  .composer-note {
    font-size:12px; color:var(--warn); background:rgba(210,153,34,0.1);
    border:1px solid rgba(210,153,34,0.35); border-radius:6px; padding:6px 10px;
  }
  .shortcut-item {
    padding:7px 8px; background:#0d1117; border:1px solid var(--line); border-radius:6px;
    cursor:pointer; font-size:12px; text-align:left; color:var(--fg); width:100%; font:inherit;
  }
  .shortcut-item:hover { border-color:var(--accent); }

  /* Approval cards */
  .card {
    background:#0d1117; border:1px solid var(--line); border-radius:8px;
    padding:12px 14px; margin-bottom:10px;
  }
  .card-head {
    display:flex; justify-content:space-between; align-items:center; gap:10px;
    flex-wrap:wrap; padding-bottom:8px; border-bottom:1px solid var(--line);
  }
  .card-body { padding:10px 0; display:flex; flex-direction:column; gap:6px; }
  .draft-box {
    background:var(--panel); border:1px solid var(--line); border-radius:6px;
    padding:10px 12px; width:100%; max-height:260px; overflow:auto;
    white-space:pre-wrap; word-break:break-word; font-size:13px; margin:2px 0 0;
  }
  .card-footer { display:flex; gap:8px; flex-wrap:wrap; align-items:center; padding-top:8px; border-top:1px solid var(--line); }
  .edit-box {
    margin-top:10px; padding:10px; background:var(--panel); border:1px solid var(--line);
    border-radius:6px; display:flex; flex-direction:column; gap:8px;
  }
  .reply-box {
    background:#122019; border:1px solid rgba(63,185,80,0.4); border-radius:6px;
    padding:10px 12px; margin-bottom:8px; white-space:pre-wrap; word-break:break-word; font-size:13.5px;
  }
  .scope-row {
    display:grid; grid-template-columns:minmax(220px, 1fr) auto; gap:8px 12px;
    align-items:start; padding:6px 0; border-bottom:1px solid var(--line);
  }
  .scope-grants { grid-column:1 / -1; padding-left:12px; }
  .field-label { font-size:12px; color:var(--dim); display:inline-flex; align-items:center; gap:6px; }

  /* Settings tab & setup banner */
  .setup-banner {
    margin:10px 16px 0; padding:9px 12px; border:1px solid rgba(210,153,34,0.55);
    background:rgba(210,153,34,0.12); color:#f2cc60; border-radius:6px;
    display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; font-size:13px;
  }
  .settings-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:10px 14px; }
  .settings-field { display:flex; flex-direction:column; gap:4px; min-width:0; }
  .settings-field.full { grid-column:1 / -1; }
  .settings-field label {
    font-size:12px; color:var(--dim); display:flex; align-items:center; justify-content:space-between; gap:6px;
  }
  .settings-checks { display:grid; grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); gap:8px 12px; }
  .check-item {
    display:flex; align-items:center; gap:8px; padding:7px 9px; background:#0d1117;
    border:1px solid var(--line); border-radius:6px; font-size:12.5px; cursor:pointer;
  }
  .check-item:hover { border-color:var(--accent); }
  .secret-row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
  .secret-row input { flex:1; min-width:180px; }
  .notice-box {
    padding:9px 12px; border-radius:6px; font-size:12.5px; margin-bottom:12px;
    border:1px solid rgba(210,153,34,0.45); background:rgba(210,153,34,0.1); color:var(--warn);
  }
  .test-result { font-size:12px; margin-top:4px; word-break:break-word; }
</style>
</head>
<body>
<header>
  <h1>AegisPi Console</h1>
  <span class="state" id="connState">未连接</span>
  <span class="state mono" id="clockState"></span>
  <div class="kpi-bar" id="kpiBar"></div>
</header>
<div id="loginBox" class="panel">
  <h2>登录（Bootstrap Token）</h2>
  <div class="row"><input id="tokenInput" type="password" placeholder="粘贴 workspace-state/console/token" style="flex:1"></div>
  <div class="row"><button class="act primary" id="loginBtn">建立会话</button><span id="loginMsg" class="dim"></span></div>
  <p class="dim">会话与 CSRF Token 只存在于本页内存；刷新或 daemon 重启后需重新登录。Token 不进入 URL。</p>
</div>
<div id="app" class="hidden">
  <nav id="tabs">
    <button data-tab="chat" class="active">① 对话与工作台</button>
    <button data-tab="approvals">② 待办与审批卡</button>
    <button data-tab="tasks">③ 任务与故障诊断台</button>
    <button data-tab="govcost">④ 记忆、治理与成本台</button>
    <button data-tab="settings">⑤ 设置与接入</button>
  </nav>
  <div id="setupBanner" class="setup-banner hidden">
    <span>尚未完成接入配置，真实模型调用当前处于关闭状态。</span>
    <div class="btn-group">
      <button class="act primary" id="setupBannerGo" type="button">点击前往设置</button>
      <button class="act" id="setupBannerClose" type="button" aria-label="关闭提示">×</button>
    </div>
  </div>
  <div id="errorBanner" class="error-banner hidden">
    <span id="errorBannerText"></span>
    <button id="errorBannerClose" type="button">关闭</button>
  </div>
  <main>
    <section id="tab-chat">
      <div class="chat-layout">
        <aside class="chat-rail">
          <div class="panel">
            <div class="row" style="margin:0 0 8px;justify-content:space-between;">
              <h2 style="margin:0;">对话线程</h2>
              <button class="act primary" id="newChatBtn">+ 新建对话</button>
            </div>
            <div id="chatThreads" class="thread-list"></div>
          </div>
          <div class="panel">
            <h2>待处理审批</h2>
            <div id="chatPendingApprovals" class="thread-list"></div>
          </div>
        </aside>
        <div class="panel chat-main">
          <div class="chat-header">
            <div class="row" style="margin:0;">
              <span class="pill" id="chatChannelBadge">WEB</span>
              <strong id="chatThreadTitle" class="mono">web:main</strong>
              <span class="dim mono" id="chatScopeSubtitle">dm:local:owner</span>
            </div>
            <button class="act" id="chatRefreshBtn">刷新对话</button>
          </div>
          <div id="chatStream" class="chat-stream"></div>
          <div class="composer">
            <div id="chatComposerNote" class="composer-note hidden"></div>
            <div class="row" style="margin:0;">
              <span class="dim" style="font-size:12px;">快捷指令:</span>
              <button class="act" data-prefix="/status">/status</button>
              <button class="act" data-prefix="/observe ">/observe</button>
              <button class="act" data-prefix="/triage ">/triage</button>
            </div>
            <textarea id="chatInput" placeholder="输入消息或命令（Ctrl+Enter 发送）..."></textarea>
            <div class="row" style="margin:0;justify-content:space-between;">
              <span id="chatSendMsg" class="dim" style="font-size:12px;"></span>
              <button class="act primary" id="chatSendBtn">发送</button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section id="tab-approvals" class="hidden">
      <div class="panel">
        <h2>WAITING 审批卡（邮件草稿 / 日历写入 / 外部动作）</h2>
        <div id="approvalList"></div>
      </div>
      <div class="panel">
        <h2>UNKNOWN 动作人工对账（管理员 + 外部证据）</h2>
        <div id="unknownList"></div>
      </div>
    </section>

    <section id="tab-tasks" class="hidden">
      <div class="panel">
        <h2>健康 / 恢复 / 磁盘水位</h2>
        <div class="row" id="healthBar"></div>
      </div>
      <div class="panel">
        <h2>任务（按 scope 分组；Steer / 取消 / 详情 / Trace）</h2>
        <div id="taskList"></div>
      </div>
      <div class="panel" id="objViewerPanel">
        <h2>对象 / Spill 分页查看（ACL 复验，无权限统一 404）</h2>
        <div class="row">
          <label class="field-label">对象 ID: <input id="objId" class="mono" placeholder="obj:..." style="width:260px"></label>
          <label class="field-label">offset: <input id="objOffset" type="number" value="0" min="0" style="width:90px"></label>
          <label class="field-label">limit: <input id="objLimit" type="number" value="2000" min="1" max="10000" style="width:100px"></label>
          <button class="act" id="objLoad">读取</button>
        </div>
        <div id="objReplyBox" class="reply-box hidden"></div>
        <pre id="objView" class="hidden"></pre>
        <div class="dim" id="objMeta"></div>
      </div>
      <div class="panel" id="taskTracePanel">
        <h2>任务链路 Trace（脱敏时间线）</h2>
        <div id="taskTraceMeta" class="dim" style="font-size:12.5px;">点击任意任务的 Trace 按钮查看执行时间线。</div>
        <div id="taskTraceWarn" class="composer-note hidden" style="margin-top:6px;"></div>
        <pre id="taskTraceBody" class="hidden"></pre>
      </div>
    </section>

    <section id="tab-govcost" class="hidden">
      <div class="panel">
        <h2>记忆（candidate / active / conflicted）与扫描隔离告警</h2>
        <div id="memoryList"></div>
      </div>
      <div class="panel">
        <h2>Dreaming 建议与冲突治理</h2>
        <div id="suggestionList"></div>
      </div>
      <div class="panel">
        <h2>Routine（Observe / Auto；auto 永不免除外部写审批）</h2>
        <div id="routineList"></div>
      </div>
      <div class="panel">
        <h2>Scope ACL 授权 / 撤权</h2>
        <div id="grantList"></div>
        <div class="row" style="margin-top:10px;">
          <input id="grantScope" class="mono" placeholder="scp:..." style="width:260px">
          <input id="grantPrincipal" class="mono" placeholder="prn:..." style="width:240px">
          <select id="grantPerm"><option>read</option><option>request</option><option>approve</option><option>admin</option></select>
          <button class="act" id="grantAdd">授权</button>
        </div>
      </div>
      <div class="panel">
        <h2>账户水位（动态限额）</h2>
        <div id="budgetMeters"></div>
      </div>
      <div class="panel">
        <h2>分用途归因（router / worker / summary / classify）</h2>
        <div id="purposeTable"></div>
        <p class="dim">未测项显式标注"未测"，无账单标注"待结算/上界"，零虚构百分比。</p>
      </div>
      <div class="panel">
        <h2>按任务 ID 查询 Trace（脱敏时间线）</h2>
        <div class="row"><input id="traceTaskId" class="mono" placeholder="task id" style="width:280px"><button class="act" id="traceLoad">查看</button></div>
        <pre id="traceView" class="hidden"></pre>
      </div>
    </section>

    <section id="tab-settings" class="hidden"></section>
  </main>
</div>
<script>
"use strict";
var PORT = ${port};
var session = null;          // {sessionId, csrfToken, expiresAt} — memory only
var state = {
  generation: 0,
  watermark: 0,
  approvals: [],
  unknowns: [],
  tasks: [],
  memories: [],
  suggestions: [],
  routines: [],
  budget: null,
  health: null,
  chat: { activeScopeId: null, activeThreadKey: "web:main", threads: [], messages: [] },
  selectedScopeId: null,
  selectedThreadKey: "web:main",
  draftCustomThread: false,
  localControlOutcomes: {},
  approvalDetails: {},
  settings: null,
  setupBannerDismissed: false,
  settingsDirty: false,
  settingsClearSecrets: {},
  settingsTestResults: {},
};
var streamAbort = null;
var streamController = { lastEventId: null, closed: false };
var streamErrors = 0;
var streamTimer = null;
var chatPollTimer = null;
var chatPollCount = 0;

function $(id) { return document.getElementById(id); }
function el(tag, props, children) {
  var n = document.createElement(tag);
  if (props) for (var k in props) {
    if (k === "text") n.textContent = String(props[k]);
    else if (k === "class") n.className = props[k];
    else if (k === "click") n.addEventListener("click", props[k]);
    else if (k === "disabled") n.disabled = Boolean(props[k]);
    else n.setAttribute(k, props[k]);
  }
  if (children) children.forEach(function (c) { if (c) n.appendChild(c); });
  return n;
}
function fmtTime(ms) { if (!ms) return "-"; var d = new Date(Number(ms)); return d.toLocaleString("sv-SE"); }
function fmtUsd(u) { return "\$" + (Number(u || 0) / 1000000).toFixed(4); }
function shortHash(h) { return typeof h === "string" && h.length > 12 ? h.slice(0, 12) + "…" : (h || "—"); }
function isTerminalTask(s) { return s === "SUCCEEDED" || s === "FAILED" || s === "CANCELLED" || s === "DEAD"; }
function statusPillClass(s) {
  if (s === "SUCCEEDED" || s === "CONSUMED" || s === "active" || s === "open") return "ok";
  if (s === "FAILED" || s === "DEAD" || s === "CANCELLED" || s === "UNKNOWN" || s === "conflicted") return "bad";
  if (s === "WAITING" || s === "WAITING_APPROVAL" || s === "WAITING_EFFECT" || s === "QUEUED" || s === "RUNNING" || s === "RETRY_WAIT" || s === "candidate") return "warn";
  return "dim";
}
function channelLabel(ch) {
  var c = String(ch || "").toLowerCase();
  if (c === "console") return "WEB";
  if (c === "telegram") return "TG";
  if (c === "mail") return "MAIL";
  return c ? c.toUpperCase() : "WEB";
}

function showError(msg) {
  $("errorBannerText").textContent = msg;
  $("errorBanner").classList.remove("hidden");
}
function clearError() {
  $("errorBanner").classList.add("hidden");
  $("errorBannerText").textContent = "";
}
$("errorBannerClose").addEventListener("click", clearError);

async function api(method, path, body) {
  var headers = {};
  if (session) headers["authorization"] = "Bearer " + session.sessionId;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    if (session) headers["x-csrf-token"] = session.csrfToken;
  }
  try {
    var res = await fetch(path, { method: method, headers: headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (res.status === 401) {
      session = null;
      stopBackgroundLoops();
      $("loginMsg").textContent = "会话已失效，请重新建立会话";
      requireSession();
    } else if (res.status >= 500) {
      showError("服务端错误 HTTP " + res.status + " (" + method + " " + path + "): " + ((data && data.message) || "Server Error"));
    }
    return { status: res.status, data: data };
  } catch (err) {
    showError("网络请求失败 (" + method + " " + path + "): " + (err && err.message ? err.message : "Failed to fetch"));
    return { status: 0, data: null, error: err };
  }
}

// ---------------------------------------------------------------- login
$("loginBtn").addEventListener("click", async function () {
  var token = $("tokenInput").value.trim();
  if (!token) { $("loginMsg").textContent = "需要 bootstrap token"; return; }
  $("loginMsg").textContent = "正在登录…";
  try {
    var r = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json", "authorization": "Bearer " + token }, body: JSON.stringify({ token: token }) });
    if (r.status !== 200) {
      var d = null; try { d = await r.json(); } catch (e) {}
      $("loginMsg").textContent = "登录失败: " + (d && d.message ? d.message : r.status);
      return;
    }
    var d = await r.json();
    session = { sessionId: d.sessionId, csrfToken: d.csrfToken, expiresAt: d.expiresAt };
    $("loginMsg").textContent = "";
    clearError();
    $("loginBox").classList.add("hidden");
    $("app").classList.remove("hidden");
    streamErrors = 0;
    startStream(true);
    refreshAll();
  } catch (err) {
    $("loginMsg").textContent = "连接失败: " + (err && err.message ? err.message : "Failed to fetch");
  }
});
$("tokenInput").addEventListener("keydown", function (e) { if (e.key === "Enter") $("loginBtn").click(); });

function stopBackgroundLoops() {
  streamController.closed = true;
  if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
  if (streamAbort) { streamAbort.abort(); streamAbort = null; }
  if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
}

function requireSession() {
  if (!session) {
    stopBackgroundLoops();
    $("loginBox").classList.remove("hidden");
    $("app").classList.add("hidden");
    return false;
  }
  if (session.expiresAt <= Date.now()) {
    session = null;
    stopBackgroundLoops();
    $("loginMsg").textContent = "会话已过期，请重新建立会话";
    $("loginBox").classList.remove("hidden");
    $("app").classList.add("hidden");
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- tabs
function switchTab(tabName) {
  document.querySelectorAll("#tabs button").forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-tab") === tabName);
  });
  ["chat", "approvals", "tasks", "govcost", "settings"].forEach(function (t) {
    document.getElementById("tab-" + t).classList.toggle("hidden", t !== tabName);
  });
  if (tabName === "settings") {
    loadSettings(false);
  }
}
document.getElementById("tabs").addEventListener("click", function (e) {
  if (e.target.tagName !== "BUTTON") return;
  switchTab(e.target.getAttribute("data-tab"));
});
$("setupBannerGo").addEventListener("click", function () { switchTab("settings"); });
$("setupBannerClose").addEventListener("click", function () {
  state.setupBannerDismissed = true;
  renderSetupBanner();
});

// ---------------------------------------------------------------- SSE
async function startStream(fresh) {
  if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
  if (!requireSession()) { setConn("会话已过期", "warn"); return; }
  if (streamAbort) streamAbort.abort();
  streamAbort = new AbortController();
  streamController.closed = false;
  var headers = { "authorization": "Bearer " + session.sessionId, "accept": "text/event-stream" };
  if (!fresh && streamController.lastEventId) headers["last-event-id"] = streamController.lastEventId;
  try {
    var res = await fetch("/api/events/stream", { headers: headers, signal: streamAbort.signal });
    if (res.status === 401) {
      session = null;
      requireSession();
      setConn("未授权", "warn");
      return;
    }
    if (res.status === 410) { await resync(); return; }
    if (res.status !== 200) {
      streamErrors += 1;
      setConn("SSE " + res.status, streamErrors >= 2 ? "bad" : "warn");
      if (!streamController.closed && requireSession()) {
        streamTimer = setTimeout(function () { startStream(false); }, 2000);
      }
      return;
    }
    streamErrors = 0;
    setConn("实时同步中", "ok");
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = "";
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      var frames = buf.split("\\n\\n");
      buf = frames.pop();
      for (var i = 0; i < frames.length; i++) handleSseFrame(frames[i]);
    }
    if (!streamController.closed && requireSession()) {
      streamTimer = setTimeout(function () { startStream(false); }, 2000);
    }
  } catch (e) {
    if (e.name === "AbortError") return;
    streamErrors += 1;
    setConn(streamErrors >= 2 ? "SSE 连接异常，重连中" : "SSE 重连中", streamErrors >= 2 ? "bad" : "warn");
    if (!streamController.closed && requireSession()) {
      streamTimer = setTimeout(function () { startStream(false); }, 2000);
    }
  }
}
function handleSseFrame(frame) {
  var lines = frame.split("\\n");
  var ev = null, dataLines = [], id = null;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf("event: ") === 0) ev = lines[i].slice(7).trim();
    else if (lines[i].indexOf("data: ") === 0) dataLines.push(lines[i].slice(6));
    else if (lines[i].indexOf("id: ") === 0) id = lines[i].slice(4).trim();
  }
  if (!ev) return;
  if (id) streamController.lastEventId = id;
  var payload = {};
  try { payload = JSON.parse(dataLines.join("\\n")); } catch (e) {}
  if (ev === "reset" || ev === "acl_changed") { resync(); return; }
  refreshAll();
}
async function resync() {
  state.generation = 0;
  state.watermark = 0;
  state.approvals = [];
  state.unknowns = [];
  state.tasks = [];
  state.memories = [];
  state.suggestions = [];
  state.routines = [];
  state.budget = null;
  state.health = null;
  state.approvalDetails = {};
  state.settings = null;
  state.settingsDirty = false;
  state.settingsClearSecrets = {};
  state.settingsTestResults = {};
  streamController.lastEventId = null;
  setConn("已重置，重新拉取快照", "warn");
  startStream(true);
  refreshAll();
}
function setConn(text, cls) { var s = $("connState"); s.textContent = text; s.className = "state pill " + cls; }

// ---------------------------------------------------------------- refresh
async function fetchChat() {
  var qs = [];
  if (state.selectedScopeId) qs.push("scopeId=" + encodeURIComponent(state.selectedScopeId));
  if (state.selectedThreadKey) qs.push("threadKey=" + encodeURIComponent(state.selectedThreadKey));
  var path = "/api/chat" + (qs.length ? "?" + qs.join("&") : "");
  var r = await api("GET", path);
  if (r.status === 200 && r.data) {
    state.chat = r.data;
    if (!state.draftCustomThread) {
      state.selectedScopeId = r.data.activeScopeId || null;
      state.selectedThreadKey = r.data.activeThreadKey || "web:main";
    }
  }
  return r;
}

async function refreshAll() {
  if (!requireSession()) return;
  var results = await Promise.all([
    api("GET", "/api/snapshot"),
    api("GET", "/api/health"),
    api("GET", "/api/recovery"),
    api("GET", "/api/approvals"),
    api("GET", "/api/effects-unknown"),
    api("GET", "/api/tasks"),
    api("GET", "/api/memory"),
    api("GET", "/api/routines"),
    api("GET", "/api/budget"),
    fetchChat(),
    api("GET", "/api/settings"),
  ]);
  var snap = results[0], health = results[1], recovery = results[2], appr = results[3];
  var unkn = results[4], tasks = results[5], mem = results[6], routines = results[7], budget = results[8], settingsRes = results[10];

  var hadFatal = results.some(function (r) { return r.status === 0 || r.status >= 500; });
  if (!hadFatal) clearError();

  if (snap.status === 200 && snap.data) {
    state.generation = snap.data.generation;
    state.watermark = snap.data.watermark;
    $("clockState").textContent = "generation " + snap.data.generation + " · watermark " + snap.data.watermark;
  }
  state.health = { health: health.data, recovery: recovery.data };
  state.approvals = (appr.data && appr.data.approvals) ? appr.data.approvals.filter(function (a) { return a.state === "WAITING"; }) : [];
  state.unknowns = (unkn.data && unkn.data.effects) ? unkn.data.effects : [];
  state.tasks = (tasks.data && tasks.data.tasks) ? tasks.data.tasks : [];
  state.memories = (mem.data && mem.data.memories) || [];
  state.suggestions = (mem.data && mem.data.suggestions) || [];
  state.routines = (routines.data && routines.data.routines) || [];
  state.budget = budget.data;

  renderKpis();
  renderChat();
  renderHealth();
  renderApprovals();
  renderUnknowns();
  renderTasks();
  renderMemory();
  renderSuggestions();
  renderRoutines();
  renderGrants();
  renderBudget();
  if (settingsRes && settingsRes.status === 200 && settingsRes.data) {
    state.settings = settingsRes.data;
    renderSetupBanner();
    if (!state.settingsDirty) renderSettings();
  }
}

function renderKpis() {
  var bar = $("kpiBar"); bar.textContent = "";
  var waitCount = state.approvals.length;
  var unknCount = state.unknowns.length;
  var runningCount = state.tasks.filter(function (t) {
    return t.state === "QUEUED" || t.state === "RETRY_WAIT" || t.state === "RUNNING";
  }).length;
  var dayAcc = null;
  if (state.budget && Array.isArray(state.budget.accounts)) {
    dayAcc = state.budget.accounts.find(function (a) { return String(a.id).indexOf("day") >= 0; }) || state.budget.accounts[0] || null;
  }
  var daySpentText = dayAcc ? fmtUsd(dayAcc.spent_microusd) : fmtUsd(0);

  bar.appendChild(el("button", {
    class: "kpi-pill" + (waitCount > 0 ? " warn" : ""),
    text: "待审 " + waitCount,
    click: function () { switchTab("approvals"); },
  }));
  bar.appendChild(el("button", {
    class: "kpi-pill" + (unknCount > 0 ? " bad" : ""),
    text: "UNKNOWN " + unknCount,
    click: function () {
      switchTab("approvals");
      var u = $("unknownList"); if (u) u.scrollIntoView({ behavior: "smooth", block: "start" });
    },
  }));
  bar.appendChild(el("button", {
    class: "kpi-pill" + (runningCount > 0 ? " ok" : ""),
    text: "运行中 " + runningCount,
    click: function () { switchTab("tasks"); },
  }));
  bar.appendChild(el("button", {
    class: "kpi-pill",
    text: "今日已用 " + daySpentText,
    click: function () { switchTab("govcost"); },
  }));
}

// ---------------------------------------------------------------- Tab 1: Chat
function findActiveThreadMeta() {
  var threads = (state.chat && state.chat.threads) || [];
  var sId = state.selectedScopeId || (state.chat && state.chat.activeScopeId);
  var tKey = state.selectedThreadKey || (state.chat && state.chat.activeThreadKey) || "web:main";
  return threads.find(function (t) { return t.scopeId === sId && t.threadKey === tKey; }) || null;
}

function isForeignThread(meta) {
  if (!meta) return false;
  return meta.domainKey && meta.domainKey !== "dm:local:owner";
}

function renderChat() {
  var threadsHost = $("chatThreads");
  var pendingHost = $("chatPendingApprovals");
  var streamHost = $("chatStream");
  threadsHost.textContent = "";
  pendingHost.textContent = "";
  streamHost.textContent = "";

  var threads = (state.chat && state.chat.threads) || [];
  var activeScopeId = state.selectedScopeId || (state.chat && state.chat.activeScopeId);
  var activeThreadKey = state.selectedThreadKey || (state.chat && state.chat.activeThreadKey) || "web:main";

  var hasCurrentInList = threads.some(function (t) { return t.threadKey === activeThreadKey && (!activeScopeId || t.scopeId === activeScopeId); });
  if (!hasCurrentInList && activeThreadKey) {
    threads = [{
      scopeId: activeScopeId || "",
      threadKey: activeThreadKey,
      domainKey: "dm:local:owner",
      channel: "console",
      lastAt: Date.now(),
      msgCount: 0,
      isNew: true,
    }].concat(threads);
  }

  if (threads.length === 0) {
    threadsHost.appendChild(el("div", { class: "dim", text: "暂无对话记录" }));
  } else {
    threads.forEach(function (th) {
      var isAct = th.threadKey === activeThreadKey && (!activeScopeId || !th.scopeId || th.scopeId === activeScopeId);
      var btn = el("button", {
        class: "thread-item" + (isAct ? " active" : ""),
        click: async function () {
          state.draftCustomThread = false;
          state.selectedScopeId = th.scopeId || null;
          state.selectedThreadKey = th.threadKey;
          await fetchChat();
          renderChat();
        },
      });
      var top = el("div", { class: "thread-top" }, [
        el("span", { class: "pill", text: th.isNew ? "NEW" : channelLabel(th.channel) }),
        el("span", { class: "dim", text: String(th.msgCount || 0) + " 条" }),
      ]);
      btn.appendChild(top);
      btn.appendChild(el("div", { class: "thread-key mono", text: th.threadKey }));
      if (th.domainKey) {
        btn.appendChild(el("div", { class: "thread-sub mono", text: th.domainKey }));
      }
      if (th.lastAt) {
        btn.appendChild(el("div", { class: "thread-time mono", text: fmtTime(th.lastAt) }));
      }
      threadsHost.appendChild(btn);
    });
  }

  // Pending approvals shortcut
  if (state.approvals.length === 0) {
    pendingHost.appendChild(el("div", { class: "dim", text: "无待处理审批" }));
  } else {
    state.approvals.slice(0, 6).forEach(function (a) {
      var item = el("button", {
        class: "shortcut-item",
        click: function () { switchTab("approvals"); },
      });
      item.appendChild(el("div", { class: "row", style: "margin:0 0 2px;justify-content:space-between;" }, [
        el("span", { class: "pill warn", text: a.operation || "action" }),
        el("span", { class: "dim", text: fmtTime(a.expires_at) }),
      ]));
      item.appendChild(el("div", { class: "dim mono", style: "font-size:11px;word-break:break-all;", text: a.subject || a.targetResource || a.id }));
      pendingHost.appendChild(item);
    });
  }

  // Header & Composer note
  var meta = findActiveThreadMeta();
  $("chatChannelBadge").textContent = channelLabel(meta ? meta.channel : "console");
  $("chatThreadTitle").textContent = activeThreadKey;
  $("chatScopeSubtitle").textContent = (meta && meta.domainKey) ? meta.domainKey : "dm:local:owner";
  var note = $("chatComposerNote");
  if (isForeignThread(meta)) {
    note.textContent = "当前正在查看 " + channelLabel(meta.channel) + " 线程 (" + meta.domainKey + ")；发送消息将切回本地工作台对话 (dm:local:owner · web:main)。";
    note.classList.remove("hidden");
  } else {
    note.classList.add("hidden");
    note.textContent = "";
  }

  // Messages
  var messages = (state.chat && state.chat.messages) || [];
  var localNotes = state.localControlOutcomes[activeThreadKey] || [];
  if (messages.length === 0 && localNotes.length === 0) {
    streamHost.appendChild(el("div", { class: "dim", style: "padding:24px 0;text-align:center;", text: "暂无消息，输入内容或使用下方快捷指令开始。" }));
    return;
  }

  messages.forEach(function (m) {
    var userWrap = el("div", { class: "msg-user" });
    userWrap.appendChild(el("div", { class: "msg-meta" }, [
      el("span", { class: "pill", text: m.source || "user" }),
      el("span", { text: fmtTime(m.receivedAt) }),
      el("span", { class: "mono", text: m.inboxId || "" }),
    ]));
    userWrap.appendChild(el("div", { class: "msg-body", text: m.userText || "(空内容)" }));
    streamHost.appendChild(userWrap);

    if (m.taskId || m.replyText || m.approval || m.inboxState) {
      var asst = el("div", { class: "msg-assistant" });
      var metaRow = el("div", { class: "msg-meta" });
      if (m.taskId) metaRow.appendChild(el("span", { class: "mono", text: m.taskId }));
      if (m.taskState) metaRow.appendChild(el("span", { class: "pill " + statusPillClass(m.taskState), text: m.taskState }));
      else if (m.inboxState) metaRow.appendChild(el("span", { class: "pill dim", text: "INBOX " + m.inboxState }));
      if (m.resultClass) metaRow.appendChild(el("span", { class: "pill", text: m.resultClass }));
      asst.appendChild(metaRow);

      if (m.replyText) {
        asst.appendChild(el("div", { class: "msg-body", text: m.replyText }));
      } else if (m.taskState === "FAILED" || m.taskState === "DEAD") {
        asst.appendChild(el("div", { class: "msg-body bad", text: "任务执行失败（" + m.taskState + "），请点击 Trace 查看诊断详情。" }));
      } else if (m.taskState === "QUEUED" || m.taskState === "RUNNING" || m.taskState === "RETRY_WAIT") {
        asst.appendChild(el("div", { class: "msg-body dim", text: "任务正在处理中（" + m.taskState + "）…" }));
      } else if (m.taskState === "WAITING_APPROVAL") {
        asst.appendChild(el("div", { class: "msg-body warn", text: "等待人工审批后继续执行。" }));
      } else if (m.taskState === "SUCCEEDED") {
        asst.appendChild(el("div", { class: "msg-body dim", text: "任务已完成（无文本回复或需在详情中查看）。" }));
      }

      if (m.approval) {
        var ap = m.approval;
        var card = el("div", { class: "inline-approval" });
        card.appendChild(el("div", { class: "row", style: "margin:0 0 6px;justify-content:space-between;" }, [
          el("div", { class: "btn-group" }, [
            el("span", { class: "pill " + statusPillClass(ap.state), text: ap.state }),
            el("span", { class: "pill", text: ap.operation || "action" }),
          ]),
          el("span", { class: "dim", style: "font-size:11.5px;", text: "到期 " + fmtTime(ap.expiresAt) }),
        ]));
        if (ap.targetResource) card.appendChild(el("div", { class: "dim", style: "font-size:12px;", text: "目标: " + ap.targetResource }));
        if (ap.subject) card.appendChild(el("div", { style: "font-size:12.5px;font-weight:600;margin-top:2px;", text: "主题: " + ap.subject }));
        if (ap.bodyPreview) card.appendChild(el("pre", { text: ap.bodyPreview }));
        var apActs = el("div", { class: "btn-group", style: "margin-top:6px;" });
        if (ap.state === "WAITING") {
          apActs.appendChild(el("button", { class: "act primary", text: "批准", click: function () { decideApprovalById(ap.id, "approve"); } }));
          apActs.appendChild(el("button", { class: "act danger", text: "拒绝", click: function () { decideApprovalById(ap.id, "reject"); } }));
        }
        apActs.appendChild(el("button", { class: "act", text: "去审批台", click: function () { switchTab("approvals"); } }));
        card.appendChild(apActs);
        asst.appendChild(card);
      }

      if (m.taskId) {
        var acts = el("div", { class: "btn-group", style: "margin-top:8px;" });
        acts.appendChild(el("button", { class: "act", text: "详情/对象", click: function () { openTaskResultFromAnywhere(m.taskId); } }));
        acts.appendChild(el("button", { class: "act", text: "Trace", click: function () { openTaskTraceInTab3(m.taskId); } }));
        asst.appendChild(acts);
      }
      streamHost.appendChild(asst);
    }
  });

  localNotes.forEach(function (noteItem) {
    var uBox = el("div", { class: "msg-user" });
    uBox.appendChild(el("div", { class: "msg-meta" }, [el("span", { class: "pill", text: "control" }), el("span", { text: fmtTime(noteItem.at) })]));
    uBox.appendChild(el("div", { class: "msg-body", text: noteItem.commandText }));
    streamHost.appendChild(uBox);

    var aBox = el("div", { class: "msg-assistant" });
    aBox.appendChild(el("div", { class: "msg-meta" }, [el("span", { class: "pill ok", text: "控制指令已执行" })]));
    aBox.appendChild(el("pre", { text: JSON.stringify(noteItem.outcome, null, 2) }));
    streamHost.appendChild(aBox);
  });

  streamHost.scrollTop = streamHost.scrollHeight;
}

function scheduleChatPoll() {
  if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
  chatPollCount = 0;
  chatPollTimer = setInterval(async function () {
    if (!requireSession()) return;
    chatPollCount += 1;
    await refreshAll();
    var msgs = (state.chat && state.chat.messages) || [];
    var hasActive = msgs.some(function (m) {
      return m.taskState === "QUEUED" || m.taskState === "RUNNING" || m.taskState === "RETRY_WAIT";
    });
    if (!hasActive || chatPollCount >= 30) {
      clearInterval(chatPollTimer);
      chatPollTimer = null;
    }
  }, 2000);
}

$("newChatBtn").addEventListener("click", async function () {
  var key = "web:" + new Date().toISOString().replace(/[^0-9]/g, "").slice(8, 14);
  state.draftCustomThread = true;
  state.selectedScopeId = null;
  state.selectedThreadKey = key;
  await fetchChat();
  renderChat();
  $("chatInput").focus();
});

$("chatRefreshBtn").addEventListener("click", async function () {
  await fetchChat();
  renderChat();
});

document.querySelectorAll("#tab-chat button[data-prefix]").forEach(function (btn) {
  btn.addEventListener("click", function () {
    var p = btn.getAttribute("data-prefix");
    var inp = $("chatInput");
    inp.value = p;
    inp.focus();
  });
});

async function sendChatMessage() {
  if (!requireSession()) return;
  var inp = $("chatInput");
  var msg = inp.value.trim();
  if (!msg) return;
  var meta = findActiveThreadMeta();
  var targetThread = isForeignThread(meta) ? "web:main" : (state.selectedThreadKey || "web:main");
  if (isForeignThread(meta)) {
    state.selectedScopeId = null;
    state.selectedThreadKey = "web:main";
  }
  state.draftCustomThread = false;
  $("chatSendBtn").disabled = true;
  $("chatSendMsg").textContent = "发送中…";
  var r = await api("POST", "/api/chat", { message: msg, threadKey: targetThread });
  $("chatSendBtn").disabled = false;
  if (r.status === 200 && r.data && r.data.code === "control_executed") {
    inp.value = "";
    $("chatSendMsg").textContent = "指令已执行";
    if (!state.localControlOutcomes[targetThread]) state.localControlOutcomes[targetThread] = [];
    state.localControlOutcomes[targetThread].push({ at: Date.now(), commandText: msg, outcome: r.data.outcome });
    state.selectedScopeId = r.data.scopeId || null;
    state.selectedThreadKey = targetThread;
    await refreshAll();
  } else if (r.status === 202) {
    inp.value = "";
    $("chatSendMsg").textContent = "已入队 (" + (r.data && r.data.inboxId ? r.data.inboxId : "ok") + ")";
    state.selectedScopeId = (r.data && r.data.scopeId) || null;
    state.selectedThreadKey = targetThread;
    await refreshAll();
    scheduleChatPoll();
  } else {
    $("chatSendMsg").textContent = "发送失败: " + ((r.data && r.data.message) || r.status);
  }
}
$("chatSendBtn").addEventListener("click", sendChatMessage);
$("chatInput").addEventListener("keydown", function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    sendChatMessage();
  }
});

// ---------------------------------------------------------------- Shared actions
async function decideApprovalById(approvalId, decision, feedbackEl) {
  var card = await api("GET", "/api/approvals/" + encodeURIComponent(approvalId));
  var dm = card.data && card.data.decisionMaterials;
  if (!dm || !dm.nonce) {
    var msg = "取不到决策材料（仅 designated approver 的活会话可见）；请重新登录或改用编辑重签";
    if (feedbackEl) { feedbackEl.className = "bad editmsg"; feedbackEl.textContent = msg; }
    else showError(msg);
    return;
  }
  var r = await api("POST", "/api/approvals/" + encodeURIComponent(approvalId) + "/decide", {
    decision: decision, actionHash: dm.actionHash, nonce: dm.nonce,
  });
  if (r.status !== 200) {
    var errText = (r.data && (r.data.reason || r.data.message)) || ("HTTP " + r.status);
    if (feedbackEl) { feedbackEl.className = "bad editmsg"; feedbackEl.textContent = errText; }
    else showError("审批操作失败: " + errText);
  }
  await refreshAll();
}

async function openTaskResultFromAnywhere(taskId) {
  switchTab("tasks");
  var found = state.tasks.find(function (t) { return t.id === taskId; });
  var objId = found && found.result_object_id;
  if (!objId) {
    var detail = await api("GET", "/api/tasks/" + encodeURIComponent(taskId));
    objId = detail.data && detail.data.task && detail.data.task.result_object_id;
  }
  if (objId) {
    $("objId").value = objId;
    $("objOffset").value = "0";
    await loadObjectViewer(true);
  } else {
    await loadTaskTracePanel(taskId, true);
  }
}

async function openTaskTraceInTab3(taskId) {
  switchTab("tasks");
  await loadTaskTracePanel(taskId, true);
}

// ---------------------------------------------------------------- Tab 2: Approvals (Cards)
function renderHealth() {
  var host = $("healthBar"); host.textContent = "";
  if (!state.health) return;
  var h = state.health.health || {}, rc = state.health.recovery || {};
  host.appendChild(el("span", { class: "pill " + (h.mode === "open" ? "ok" : "warn"), text: "mode=" + (h.mode || "?") }));
  host.appendChild(el("span", { class: "pill", text: "node=" + (h.node || "?") }));
  host.appendChild(el("span", { class: "pill " + (rc.failedStep ? "bad" : "ok"), text: "recovery failedStep=" + (rc.failedStep || "无") }));
  host.appendChild(el("span", { class: "pill", text: "actions=" + ((rc.actions && rc.actions.length) || 0) }));
}

function renderApprovals() {
  var host = $("approvalList"); host.textContent = "";
  if (state.approvals.length === 0) {
    host.appendChild(el("p", { class: "dim", text: "无 WAITING 审批卡。" }));
    return;
  }
  state.approvals.forEach(function (a) {
    var cardEl = el("div", { class: "card" });
    var hashText = a.actionHashShort || shortHash(a.action_hash);

    // Top row
    var head = el("div", { class: "card-head" }, [
      el("div", { class: "btn-group" }, [
        el("span", { class: "pill warn", text: a.operation || "action" }),
        el("span", { class: "mono", style: "font-size:12px;", text: (a.scope_id || "") + " / " + (a.task_id || "") }),
      ]),
      el("div", { class: "btn-group" }, [
        el("span", { class: "dim", style: "font-size:12px;", text: "到期 " + fmtTime(a.expires_at) }),
        el("span", { class: "pill mono", text: hashText }),
      ]),
    ]);
    cardEl.appendChild(head);

    // Body (always visible immediately)
    var bodyDiv = el("div", { class: "card-body" });
    var targetLine = el("div", { style: "font-size:13px;" });
    targetLine.appendChild(el("span", { class: "dim", text: "收件人/目标: " }));
    var targetVal = el("span", { class: "mono", text: a.targetResource || "—" });
    targetLine.appendChild(targetVal);
    bodyDiv.appendChild(targetLine);

    var subjLine = el("div", { style: "font-size:13px;" });
    subjLine.appendChild(el("span", { class: "dim", text: "主题: " }));
    var subjVal = el("strong", { text: a.subject || "—" });
    subjLine.appendChild(subjVal);
    bodyDiv.appendChild(subjLine);

    bodyDiv.appendChild(el("div", { class: "dim", style: "font-size:12px;", text: "草稿正文:" }));
    var draftPre = el("pre", { class: "draft-box", text: a.bodyPreview || "加载完整草稿中…" });
    bodyDiv.appendChild(draftPre);

    // Collapsible technical metadata
    var kv = el("div", { class: "kv" });
    var details = el("details", null, [el("summary", { text: "完整 ID 与校验元数据" }), kv]);
    bodyDiv.appendChild(details);
    cardEl.appendChild(bodyDiv);

    // Edit form
    var editBox = el("div", { class: "edit-box hidden" });
    var subjInput = el("input", { placeholder: "subject" });
    var bodyInput = el("textarea", { placeholder: "正文" });
    var editMsg = el("span", { class: "editmsg dim", text: "" });
    function prefillEdit(extra) {
      if (!subjInput.value && extra.subject !== undefined && extra.subject !== null) subjInput.value = String(extra.subject);
      if (!bodyInput.value && extra.bodyText !== undefined && extra.bodyText !== null) bodyInput.value = String(extra.bodyText);
    }
    var doEdit = el("button", { class: "act primary", text: "提交编辑重签", click: async function () {
      var card = await api("GET", "/api/approvals/" + encodeURIComponent(a.id));
      var action = (card.data && card.data.action) || {};
      var extra = action.extra || {};
      var intent = Object.assign({}, extra, {
        subject: subjInput.value || extra.subject,
        bodyText: bodyInput.value || extra.bodyText,
      });
      var r = await api("POST", "/api/approvals/" + encodeURIComponent(a.id) + "/revise", {
        intent: intent,
        expiresAt: Date.now() + 4 * 3600 * 1000,
      });
      Array.prototype.forEach.call(document.querySelectorAll(".editmsg"), function (n) { n.textContent = ""; });
      editMsg.className = (r.status === 200 ? "ok" : "bad") + " editmsg";
      editMsg.textContent = r.status === 200
        ? "已换新卡 " + ((r.data && r.data.newApprovalId) || "")
        : ("编辑失败: " + ((r.data && r.data.message) || r.status));
      if (r.status === 200) refreshAll();
    } });
    editBox.appendChild(el("label", { class: "dim", style: "font-size:12px;", text: "主题 (subject)" }));
    editBox.appendChild(subjInput);
    editBox.appendChild(el("label", { class: "dim", style: "font-size:12px;", text: "正文 (bodyText)" }));
    editBox.appendChild(bodyInput);
    editBox.appendChild(el("div", { class: "row", style: "margin:0;" }, [doEdit, editMsg]));

    // Footer buttons
    var footerMsg = el("span", { class: "editmsg dim", text: "" });
    var approveBtn = el("button", { class: "act primary", text: "批准此动作", click: function () {
      decideApprovalById(a.id, "approve", footerMsg);
    } });
    var editBtn = el("button", { class: "act", text: "编辑草稿并重签", click: function () {
      editBox.classList.toggle("hidden");
    } });
    var rejectBtn = el("button", { class: "act danger", text: "拒绝", click: function () {
      decideApprovalById(a.id, "reject", footerMsg);
    } });
    cardEl.appendChild(el("div", { class: "card-footer" }, [approveBtn, editBtn, rejectBtn, footerMsg]));
    cardEl.appendChild(editBox);
    host.appendChild(cardEl);

    function applyCardDetail(cardData) {
      if (!cardData) return;
      var act = cardData.action || {};
      var extra = act.extra || {};
      targetVal.textContent = act.targetResource || a.targetResource || "—";
      subjVal.textContent = (extra.subject !== undefined && extra.subject !== null && String(extra.subject).length > 0)
        ? String(extra.subject)
        : (a.subject || "—");
      var fullBody = extra.bodyText !== undefined && extra.bodyText !== null
        ? String(extra.bodyText)
        : (extra.body !== undefined && extra.body !== null
            ? String(extra.body)
            : (extra.description !== undefined && extra.description !== null
                ? String(extra.description)
                : (extra.text !== undefined && extra.text !== null ? String(extra.text) : (a.bodyPreview || "(无正文)"))));
      draftPre.textContent = fullBody;
      prefillEdit(extra);

      kv.textContent = "";
      [
        ["approvalId", a.id],
        ["sendingIdentity", act.sendingIdentity || a.sendingIdentity || "—"],
        ["evidenceManifestHash", act.evidenceManifestHash || "—"],
        ["contentHash", act.contentHash || "—"],
        ["attachmentHash", act.attachmentHash || "—"],
        ["expectedHead", act.expectedHead || "—"],
      ].forEach(function (pair) {
        kv.appendChild(el("div", { class: "k mono", text: pair[0] }));
        kv.appendChild(el("div", { class: "mono", style: "word-break:break-all;", text: String(pair[1]) }));
      });
    }

    if (state.approvalDetails[a.id]) {
      applyCardDetail(state.approvalDetails[a.id]);
    } else {
      api("GET", "/api/approvals/" + encodeURIComponent(a.id)).then(function (card) {
        if (card.status === 200 && card.data) {
          state.approvalDetails[a.id] = card.data;
          applyCardDetail(card.data);
        }
      });
    }
  });
}

function renderUnknowns() {
  var host = $("unknownList"); host.textContent = "";
  if (state.unknowns.length === 0) { host.appendChild(el("p", { class: "dim", text: "无 UNKNOWN 动作。" })); return; }
  state.unknowns.forEach(function (u) {
    var box = el("div", { class: "card" });
    box.appendChild(el("div", { class: "row", style: "margin:0 0 6px;justify-content:space-between;" }, [
      el("span", { class: "mono", text: u.id + " (" + u.operation + ")" }),
      el("span", { class: "pill bad", text: "retry=" + u.retry_mode }),
    ]));
    var row = el("div", { class: "row", style: "margin:0;" });
    var input = el("input", { placeholder: "externalEvidenceRef（发件箱回执等）", style: "flex:1;min-width:220px;" });
    var sel = el("select");
    ["CONFIRMED_SUCCESS", "CONFIRMED_NOT_SENT", "REMAINS_UNKNOWN"].forEach(function (o) { sel.appendChild(el("option", { text: o })); });
    var msg = el("span", { class: "dim", style: "font-size:12px;", text: "" });
    var btn = el("button", { class: "act", text: "对账", click: async function () {
      if (!input.value.trim()) { msg.className = "bad"; msg.textContent = "需要 externalEvidenceRef"; return; }
      var r = await api("POST", "/api/effects/" + encodeURIComponent(u.id) + "/reconcile", { resolution: sel.value, externalEvidenceRef: input.value.trim() });
      if (r.status !== 200) {
        msg.className = "bad";
        msg.textContent = (r.data && r.data.message) || ("HTTP " + r.status);
        return;
      }
      refreshAll();
    } });
    row.appendChild(input); row.appendChild(sel); row.appendChild(btn); row.appendChild(msg);
    box.appendChild(row);
    host.appendChild(box);
  });
}

// ---------------------------------------------------------------- Tab 3: Tasks & Diagnostics
function renderTasks() {
  var host = $("taskList"); host.textContent = "";
  var byScope = {};
  state.tasks.forEach(function (t) { (byScope[t.scope_id] = byScope[t.scope_id] || []).push(t); });
  Object.keys(byScope).sort().forEach(function (scope) {
    var panel = el("div", { class: "panel" });
    panel.appendChild(el("h2", { class: "mono", text: scope }));
    var wrap = el("div", { class: "table-wrap" });
    var t = el("table");
    var thead = el("thead", null, [
      el("tr", null, [
        el("th", { text: "任务 ID" }),
        el("th", { text: "状态" }),
        el("th", { text: "结论" }),
        el("th", { text: "Fence" }),
        el("th", { text: "更新时间" }),
        el("th", { text: "操作" }),
      ]),
    ]);
    t.appendChild(thead);
    var tbody = el("tbody");
    byScope[scope].forEach(function (task) {
      var terminal = isTerminalTask(task.state);
      var edit = el("div", { class: "hidden row", style: "margin-top:6px;" });
      var msg = el("input", { placeholder: "Steer 消息", style: "flex:1;min-width:160px;" });
      var steerStatus = el("span", { class: "dim", style: "font-size:12px;", text: "" });
      var send = el("button", { class: "act primary", text: "发送 Steer", click: async function () {
        var r = await api("POST", "/api/tasks/" + encodeURIComponent(task.id) + "/steer", { message: msg.value, expectedRevision: task.updated_at });
        steerStatus.className = r.status === 202 ? "ok" : "bad";
        steerStatus.textContent = r.status === 202 ? "已入队" : ("失败: " + ((r.data && r.data.message) || r.status));
      } });
      edit.appendChild(msg); edit.appendChild(send); edit.appendChild(steerStatus);

      var steer = el("button", { class: "act", text: "Steer", disabled: terminal, click: function () { edit.classList.toggle("hidden"); } });
      var cancel = el("button", { class: "act danger", text: "取消", disabled: terminal, click: async function () {
        if (!confirm("取消该任务（同 scope epoch 栅栏）？")) return;
        var r = await api("POST", "/api/tasks/" + encodeURIComponent(task.id) + "/cancel", { reason: "console cancel", expectedRevision: task.updated_at });
        if (r.status !== 200) showError("取消失败: " + ((r.data && r.data.message) || r.status));
        refreshAll();
      } });
      var btnGroup = el("div", { class: "btn-group" }, [steer, cancel]);
      if (task.result_object_id) {
        btnGroup.appendChild(el("button", { class: "act", text: "查看结果", click: function () {
          $("objId").value = task.result_object_id;
          $("objOffset").value = "0";
          loadObjectViewer(true);
        } }));
      }
      btnGroup.appendChild(el("button", { class: "act", text: "Trace", click: function () {
        loadTaskTracePanel(task.id, true);
      } }));

      var opsCell = el("td", null, [btnGroup]);
      if (!terminal) opsCell.appendChild(edit);

      tbody.appendChild(el("tr", null, [
        el("td", { class: "mono", text: task.id }),
        el("td", null, [el("span", { class: "pill " + statusPillClass(task.state), text: task.state })]),
        el("td", { text: String(task.result_class || "-") }),
        el("td", { class: "mono nowrap", text: "fence " + task.fence }),
        el("td", { class: "nowrap", text: fmtTime(task.updated_at) }),
        opsCell,
      ]));
    });
    t.appendChild(tbody);
    wrap.appendChild(t);
    panel.appendChild(wrap);
    host.appendChild(panel);
  });
  if (state.tasks.length === 0) host.appendChild(el("p", { class: "dim", text: "无任务。" }));
}

async function loadObjectViewer(scrollIntoView) {
  var id = $("objId").value.trim();
  if (!id) return;
  var off = Number($("objOffset").value || 0);
  var lim = Number($("objLimit").value || 2000);
  var r = await api("GET", "/api/objects/" + encodeURIComponent(id) + "?offset=" + off + "&limit=" + lim);
  var view = $("objView");
  var replyBox = $("objReplyBox");
  view.classList.remove("hidden");
  replyBox.classList.add("hidden");
  replyBox.textContent = "";
  if (r.status !== 200) {
    view.textContent = (r.data && r.data.message) || ("HTTP " + r.status);
    $("objMeta").textContent = "";
  } else {
    var content = r.data.content || "(空)";
    view.textContent = content;
    $("objMeta").textContent = "kind=" + r.data.kind + " status=" + r.data.status + " totalBytes=" + r.data.totalBytes + (r.data.truncated ? " （已截断，可继续 offset）" : "");
    try {
      var parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        var readable = typeof parsed.reply === "string" && parsed.reply.trim()
          ? parsed.reply
          : (typeof parsed.advisorySummary === "string" && parsed.advisorySummary.trim() ? parsed.advisorySummary : null);
        if (readable) {
          replyBox.textContent = readable;
          replyBox.classList.remove("hidden");
        }
      }
    } catch (e) {}
  }
  if (scrollIntoView) {
    $("objViewerPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}
$("objLoad").addEventListener("click", function () { loadObjectViewer(false); });

function formatTraceTimeline(d) {
  var lines = ["task=" + d.taskId + " state=" + d.taskState + " result=" + (d.resultClass || "-")];
  (d.timeline || []).forEach(function (t) {
    lines.push(fmtTime(t.at) + "  " + t.stage + "  " + t.ref + "  " + JSON.stringify(t.detail));
  });
  if (d.computedButUnconfirmed) {
    lines.push("⚠ Task SUCCEEDED 但 Effect UNKNOWN：计算已完成，通知/动作尚未确认（" + d.unconfirmedEffects.join(",") + "）");
  }
  return lines.join("\\n");
}

async function loadTaskTracePanel(taskId, scrollIntoView) {
  if (!taskId) return;
  $("traceTaskId").value = taskId;
  var r = await api("GET", "/api/tasks/" + encodeURIComponent(taskId) + "/trace");
  var meta = $("taskTraceMeta");
  var warn = $("taskTraceWarn");
  var body = $("taskTraceBody");
  body.classList.remove("hidden");
  warn.classList.add("hidden");
  warn.textContent = "";
  if (r.status !== 200 || !r.data) {
    meta.textContent = "加载失败";
    body.textContent = (r.data && r.data.message) || ("HTTP " + r.status);
  } else {
    meta.textContent = "task=" + r.data.taskId + " · state=" + r.data.taskState + " · result=" + (r.data.resultClass || "-");
    if (r.data.computedButUnconfirmed) {
      warn.textContent = r.data.note || ("Task SUCCEEDED 但 Effect UNKNOWN：" + (r.data.unconfirmedEffects || []).join(", "));
      warn.classList.remove("hidden");
    }
    body.textContent = formatTraceTimeline(r.data);
  }
  if (scrollIntoView) {
    $("taskTracePanel").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// ---------------------------------------------------------------- Tab 4: Memory, Governance & Cost
function renderMemory() {
  var host = $("memoryList"); host.textContent = "";
  if (state.memories.length === 0) { host.appendChild(el("p", { class: "dim", text: "无可见记忆条目。" })); return; }
  var wrap = el("div", { class: "table-wrap" });
  var t = el("table");
  t.appendChild(el("thead", null, [
    el("tr", null, [
      el("th", { text: "ID" }),
      el("th", { text: "状态" }),
      el("th", { text: "Fact Key" }),
      el("th", { text: "内容摘要" }),
      el("th", { text: "隔离告警" }),
      el("th", { text: "操作" }),
    ]),
  ]));
  var tbody = el("tbody");
  state.memories.forEach(function (m) {
    var btns = el("div", { class: "btn-group" });
    if (m.status === "candidate" && !m.neverActivatable) btns.appendChild(el("button", { class: "act primary", text: "激活", click: function () { memoryDecide(m, "activate"); } }));
    if (m.status === "candidate" || m.status === "conflicted") btns.appendChild(el("button", { class: "act", text: "拒绝", click: function () { memoryDecide(m, "reject"); } }));
    btns.appendChild(el("button", { class: "act danger", text: "遗忘", click: function () { memoryDecide(m, "forget"); } }));
    tbody.appendChild(el("tr", null, [
      el("td", { class: "mono", text: m.id }),
      el("td", null, [el("span", { class: "pill " + statusPillClass(m.status), text: m.status })]),
      el("td", { class: "mono", text: m.factKey || "-" }),
      el("td", { text: (m.factText || "").slice(0, 120) }),
      el("td", { class: m.quarantinedReasons.length ? "warn" : "dim", text: m.quarantinedReasons.length ? m.quarantinedReasons.join(",") : "-" }),
      el("td", null, [btns]),
    ]));
  });
  t.appendChild(tbody);
  wrap.appendChild(t);
  host.appendChild(wrap);
}
async function memoryDecide(m, decision) {
  if (decision === "forget" && !confirm("遗忘将两阶段清除并追加墓碑清单，继续？")) return;
  var r = await api("POST", "/api/memory/" + encodeURIComponent(m.id) + "/decide", { decision: decision, expectedRevision: m.revision });
  if (r.status !== 200) showError("记忆操作失败: " + ((r.data && r.data.message) || r.status));
  refreshAll();
}

function renderSuggestions() {
  var host = $("suggestionList"); host.textContent = "";
  if (state.suggestions.length === 0) { host.appendChild(el("p", { class: "dim", text: "无 Dreaming 建议/告警。" })); return; }
  state.suggestions.forEach(function (s) {
    host.appendChild(el("div", { class: "row", text: s.id + " · " + s.type + " · " + fmtTime(s.observedAt) }));
  });
}

function renderRoutines() {
  var host = $("routineList"); host.textContent = "";
  if (state.routines.length === 0) { host.appendChild(el("p", { class: "dim", text: "无已注册 Routine。" })); return; }
  state.routines.forEach(function (r) {
    var row = el("div", { class: "row" });
    row.appendChild(el("span", { class: "mono", text: r.id + " · mode=" + r.mode + " · policy=" + (r.policyVersion || "-") }));
    var target = el("select");
    ["observe", "auto"].forEach(function (o) { target.appendChild(el("option", { text: o })); });
    target.value = r.mode;
    var ref = el("input", { placeholder: "reviewReportRef（转 auto 必填）", style: "width:220px" });
    row.appendChild(target); row.appendChild(ref);
    row.appendChild(el("button", { class: "act", text: "切换", click: async function () {
      var body = { mode: target.value, expectedRevision: r.revision, policyVersion: r.policyVersion };
      if (ref.value.trim()) body.reviewReportRef = ref.value.trim();
      var res = await api("POST", "/api/routines/" + encodeURIComponent(r.id) + "/mode", body);
      if (res.status !== 200) showError("Routine 切换失败: " + ((res.data && res.data.message) || res.status));
      refreshAll();
    } }));
    host.appendChild(row);
  });
}

function renderGrants() {
  var host = $("grantList");
  if (host.dataset.loaded !== "1") { host.dataset.loaded = "1"; loadGrants(); }
}
async function loadGrants() {
  var host = $("grantList");
  var scopes = await api("GET", "/api/scopes");
  host.textContent = "";
  (scopes.data && scopes.data.scopes || []).slice(0, 20).forEach(function (s) {
    var row = el("div", { class: "scope-row" });
    var info = el("div", { class: "mono", style: "font-size:12.5px;word-break:break-all;", text: s.id + (s.domain_key ? " (" + s.domain_key + ")" : "") });
    var grantsBox = el("div", { class: "scope-grants hidden" });
    var btn = el("button", { class: "act", text: "查看授权", click: async function () {
      if (!grantsBox.classList.contains("hidden") && grantsBox.dataset.loaded === "1") {
        grantsBox.classList.add("hidden");
        return;
      }
      var g = await api("GET", "/api/scopes/" + encodeURIComponent(s.id) + "/grants");
      grantsBox.textContent = "";
      grantsBox.dataset.loaded = "1";
      grantsBox.classList.remove("hidden");
      var list = (g.data && g.data.grants) || [];
      if (list.length === 0) {
        grantsBox.appendChild(el("span", { class: "dim", text: "无授权记录" }));
        return;
      }
      list.forEach(function (gr) {
        var line = gr.principal_id + ":" + gr.permission + (gr.revoked_at ? " (revoked)" : " live");
        var ln = el("div", { class: "row" });
        ln.appendChild(el("span", { class: "mono", style: "font-size:12px;", text: line }));
        if (!gr.revoked_at) ln.appendChild(el("button", { class: "act danger", text: "撤权", click: async function () {
          var r = await api("POST", "/api/grants/revoke", { scopeId: s.id, principalId: gr.principal_id, permission: gr.permission, reason: "console revoke" });
          if (r.status !== 200) showError("撤权失败: " + ((r.data && r.data.message) || r.status));
          loadGrants();
        } }));
        grantsBox.appendChild(ln);
      });
    } });
    row.appendChild(info);
    row.appendChild(btn);
    row.appendChild(grantsBox);
    host.appendChild(row);
  });
}
$("grantAdd").addEventListener("click", async function () {
  var r = await api("POST", "/api/grants", { scopeId: $("grantScope").value.trim(), principalId: $("grantPrincipal").value.trim(), permission: $("grantPerm").value });
  if (r.status !== 200) showError("授权失败: " + ((r.data && r.data.message) || r.status));
  loadGrants();
});

function meter(label, spent, held, limit, note) {
  var wrap = el("div", { class: "meter" });
  var top = el("div", { class: "label" });
  top.appendChild(el("span", { class: "mono", text: label }));
  top.appendChild(el("span", { class: "mono", text: fmtUsd(spent) + " spent + " + fmtUsd(held) + " held / 上限 " + fmtUsd(limit) + (note ? " · " + note : "") }));
  wrap.appendChild(top);
  var bar = el("div", { class: "bar" + (limit > 0 && (spent + held) >= limit ? " full" : "") });
  var fill = el("div");
  fill.style.width = (limit > 0 ? Math.min(100, ((spent + held) / limit) * 100) : 0) + "%";
  bar.appendChild(fill);
  wrap.appendChild(bar);
  return wrap;
}
function renderBudget() {
  var host = $("budgetMeters"); host.textContent = "";
  if (!state.budget) return;
  (state.budget.accounts || []).forEach(function (a) {
    var isDay = String(a.id).indexOf("day") >= 0;
    var capLabel = (isDay ? "全局日 · 上限 " : "单任务 · 上限 ") + fmtUsd(a.limit_microusd);
    host.appendChild(meter(a.id + "（" + capLabel + "）", a.spent_microusd, a.held_microusd, a.limit_microusd, a.frozen ? "已冻结" : ""));
  });
  var wrap = el("div", { class: "table-wrap" });
  var tbl = el("table");
  tbl.appendChild(el("thead", null, [
    el("tr", null, [
      el("th", { text: "purpose" }),
      el("th", { text: "spent" }),
      el("th", { text: "held" }),
      el("th", { text: "charged_bound" }),
      el("th", { text: "请求数" }),
      el("th", { text: "cache 读写 tokens" }),
    ]),
  ]));
  var tbody = el("tbody");
  (state.budget.byPurpose || []).forEach(function (p) {
    tbody.appendChild(el("tr", null, [
      el("td", { class: "mono", text: p.purpose }),
      el("td", { class: "mono", text: fmtUsd(p.spentMicrousd) }),
      el("td", { class: "mono", text: fmtUsd(p.heldMicrousd) }),
      el("td", { class: "mono", text: fmtUsd(p.chargedBoundMicrousd) }),
      el("td", { class: "mono", text: String(p.requestCount) }),
      el("td", { class: "dim", text: "未测" }),
    ]));
  });
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  $("purposeTable").textContent = "";
  $("purposeTable").appendChild(wrap);
}

$("traceLoad").addEventListener("click", async function () {
  var id = $("traceTaskId").value.trim();
  if (!id) return;
  var r = await api("GET", "/api/tasks/" + encodeURIComponent(id) + "/trace");
  var v = $("traceView");
  v.classList.remove("hidden");
  if (r.status !== 200 || !r.data) { v.textContent = (r.data && r.data.message) || ("HTTP " + r.status); return; }
  v.textContent = formatTraceTimeline(r.data);
});

// ---------------------------------------------------------------- Tab 5: Settings & Onboarding
var settingsRefs = null;
var SECRET_KEY_LIST = [
  "DEEPSEEK_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "AEGISPI_REAL_TG_PROXY",
  "MAIL_USER",
  "MAIL_APP_PASSWORD",
  "AEGISPI_BACKUP_MANIFEST_KEY",
];

function renderSetupBanner() {
  var banner = $("setupBanner");
  if (!banner) return;
  var allowReal = Boolean(state.settings && state.settings.config && state.settings.config.model && state.settings.config.model.allowRealModelCalls === true);
  var shouldShow = Boolean(state.settings && !allowReal && !state.setupBannerDismissed);
  banner.classList.toggle("hidden", !shouldShow);
}

async function loadSettings(forceRender) {
  if (!requireSession()) return;
  var r = await api("GET", "/api/settings");
  if (r.status === 200 && r.data) {
    state.settings = r.data;
    if (forceRender) {
      state.settingsDirty = false;
      state.settingsClearSecrets = {};
    }
    renderSetupBanner();
    if (forceRender || !state.settingsDirty) {
      renderSettings();
    }
  } else if (r.data && r.data.message) {
    var host = $("tab-settings");
    if (host && !state.settings) {
      host.textContent = "";
      host.appendChild(el("div", { class: "notice-box", text: "读取配置失败: " + r.data.message }));
    }
  }
}

function parseListInput(raw) {
  return String(raw || "")
    .split(/[,\\r\\n]+/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

function parseOptionalIntField(raw, label, min, max) {
  var trimmed = String(raw || "").trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^-?\\d+$/.test(trimmed)) return { ok: false, message: label + " 必须为整数或留空" };
  var n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    return { ok: false, message: label + " 必须为 " + min + " .. " + max + " 的整数" };
  }
  return { ok: true, value: n };
}

function parseRequiredIntField(raw, label, min, max, fallback) {
  var trimmed = String(raw || "").trim();
  if (trimmed === "") return { ok: true, value: fallback };
  if (!/^-?\\d+$/.test(trimmed)) return { ok: false, message: label + " 必须为整数" };
  var n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    return { ok: false, message: label + " 必须为 " + min + " .. " + max + " 的整数" };
  }
  return { ok: true, value: n };
}

function markSettingsDirty() {
  state.settingsDirty = true;
}

function makeField(labelText, control, opts) {
  var o = opts || {};
  var wrap = el("div", { class: "settings-field" + (o.full ? " full" : "") });
  var lbl = el("label");
  lbl.appendChild(el("span", { text: labelText }));
  if (o.badge) lbl.appendChild(o.badge);
  wrap.appendChild(lbl);
  wrap.appendChild(control);
  if (o.hint) wrap.appendChild(el("div", { class: "dim", style: "font-size:11.5px;", text: o.hint }));
  return wrap;
}

function makeTextInput(value, placeholder, opts) {
  var o = opts || {};
  var inp = el("input", {
    type: o.type || "text",
    placeholder: placeholder || "",
    class: o.mono ? "mono" : "",
  });
  if (o.autocomplete) inp.setAttribute("autocomplete", o.autocomplete);
  inp.value = value === null || value === undefined ? "" : String(value);
  inp.addEventListener("input", markSettingsDirty);
  return inp;
}

function makeSecretControl(secretKey, labelText, opts) {
  var o = opts || {};
  var meta = (state.settings && state.settings.secrets && state.settings.secrets[secretKey]) || {};
  var configured = Boolean(meta.configured);
  var badge = el("span", { class: "pill" });
  var inp = el("input", {
    type: o.type || "password",
    autocomplete: o.type === "text" ? "off" : "new-password",
    placeholder: o.placeholder || "已配置时留空保持不变",
    class: "mono",
  });
  var clearBtn = el("button", { type: "button", class: "act danger" });

  function syncSecretUi() {
    var pendingClear = Boolean(state.settingsClearSecrets[secretKey]);
    if (pendingClear) {
      badge.className = "pill warn";
      badge.textContent = "待保存清空";
      clearBtn.className = "act";
      clearBtn.textContent = "撤销清空";
    } else if (configured) {
      badge.className = "pill ok";
      badge.textContent = "已配置";
      clearBtn.className = "act danger";
      clearBtn.textContent = "清空该密钥";
    } else {
      badge.className = "pill dim";
      badge.textContent = "未配置";
      clearBtn.className = "act danger";
      clearBtn.textContent = "清空该密钥";
    }
    clearBtn.disabled = !state.settings || !state.settings.writable;
  }

  inp.addEventListener("input", function () {
    markSettingsDirty();
    if (inp.value.trim().length > 0 && state.settingsClearSecrets[secretKey]) {
      delete state.settingsClearSecrets[secretKey];
    }
    syncSecretUi();
  });
  clearBtn.addEventListener("click", function () {
    markSettingsDirty();
    if (state.settingsClearSecrets[secretKey]) {
      delete state.settingsClearSecrets[secretKey];
    } else {
      inp.value = "";
      state.settingsClearSecrets[secretKey] = true;
    }
    syncSecretUi();
  });

  var row = el("div", { class: "secret-row" }, [inp]);
  if (o.extraBtn) row.appendChild(o.extraBtn(inp, syncSecretUi));
  row.appendChild(clearBtn);
  syncSecretUi();

  return {
    input: inp,
    sync: syncSecretUi,
    node: makeField(labelText, row, { badge: badge, full: Boolean(o.full), hint: o.hint }),
  };
}

function renderTestResultNode(res) {
  var node = el("div", { class: "test-result" });
  if (!res) return node;
  if (res.pending) {
    node.className = "test-result dim";
    node.textContent = "正在测试连通性…";
    return node;
  }
  if (res.ok) {
    node.className = "test-result ok";
    var detail = "连通成功";
    if (res.latencyMs !== undefined) detail += " (" + res.latencyMs + " ms)";
    if (res.modelCount !== undefined && res.modelCount !== null) detail += " · 模型数 " + res.modelCount;
    if (res.botUsername) detail += " · @" + res.botUsername;
    if (res.host) detail += " · " + res.host + ":" + res.port + (res.folder ? " (" + res.folder + ")" : "");
    node.textContent = detail;
    return node;
  }
  node.className = "test-result bad";
  node.textContent = "连通失败" + (res.error ? " [" + res.error + "]" : "") + ": " + (res.message || "未知错误");
  return node;
}

async function runConnectivityTest(target, hostEl, btnEl) {
  if (!requireSession()) return;
  btnEl.disabled = true;
  state.settingsTestResults[target] = { pending: true };
  hostEl.textContent = "";
  hostEl.appendChild(renderTestResultNode(state.settingsTestResults[target]));
  var r = await api("POST", "/api/settings/test", { target: target });
  btnEl.disabled = false;
  if (r.status === 200 && r.data) {
    state.settingsTestResults[target] = r.data;
  } else {
    state.settingsTestResults[target] = {
      ok: false,
      error: (r.data && r.data.code) || ("HTTP_" + r.status),
      message: (r.data && r.data.message) || ("HTTP " + r.status),
    };
  }
  hostEl.textContent = "";
  hostEl.appendChild(renderTestResultNode(state.settingsTestResults[target]));
}

function renderSettings() {
  var host = $("tab-settings");
  if (!host) return;
  host.textContent = "";

  if (!state.settings) {
    host.appendChild(el("div", { class: "panel" }, [
      el("h2", { text: "设置与接入" }),
      el("div", { class: "dim", text: "正在加载配置…" }),
    ]));
    return;
  }

  var s = state.settings;
  var cfg = s.config || {};
  var model = cfg.model || {};
  var priceCatalog = model.priceCatalog || {};
  var tg = cfg.telegram || {};
  var mail = cfg.mail || {};
  var policy = cfg.policy || {};
  var adapters = cfg.adapters || {};
  var cal = cfg.calendar || {};
  var writable = Boolean(s.writable);

  if (!writable) {
    host.appendChild(el("div", { class: "notice-box", text: "当前 daemon 未通过 --config 指定可写配置文件（处于 fail-closed 的 defaults.json 只读模式），“保存并热生效”已禁用。" }));
  }

  var refs = { switches: {}, model: {}, telegram: {}, mail: {}, adapters: {}, secrets: {}, briefingTimeOfDay: null };

  // A. 快速总开关
  var switchSpecs = [
    ["model.allowRealModelCalls", "允许真实模型调用 (model.allowRealModelCalls)", Boolean(model.allowRealModelCalls)],
    ["telegram.allowRealPull", "允许 Telegram 拉取入站 (telegram.allowRealPull)", Boolean(tg.allowRealPull)],
    ["telegram.allowRealSend", "允许 Telegram 真实发送 (telegram.allowRealSend)", Boolean(tg.allowRealSend)],
    ["telegram.autoReplyOnTask", "任务完成自动回复 Telegram (telegram.autoReplyOnTask)", Boolean(tg.autoReplyOnTask)],
    ["mail.allowRealMailRead", "允许真实读取邮件 (mail.allowRealMailRead)", Boolean(mail.allowRealMailRead)],
    ["mail.allowRealMailSend", "允许真实发送邮件 (mail.allowRealMailSend)", Boolean(mail.allowRealMailSend)],
    ["mail.autoDraftReplies", "邮件自动生成回复草稿 (mail.autoDraftReplies)", Boolean(mail.autoDraftReplies)],
    ["policy.allowRealExternalWrites", "允许真实外部写入 (policy.allowRealExternalWrites)", Boolean(policy.allowRealExternalWrites)],
  ];
  var checksWrap = el("div", { class: "settings-checks" });
  switchSpecs.forEach(function (spec) {
    var cb = el("input", { type: "checkbox" });
    cb.checked = spec[2];
    cb.addEventListener("change", markSettingsDirty);
    refs.switches[spec[0]] = cb;
    var item = el("label", { class: "check-item" }, [cb, el("span", { text: spec[1] })]);
    checksWrap.appendChild(item);
  });
  host.appendChild(el("div", { class: "panel" }, [
    el("h2", { text: "A. 快速总开关" }),
    checksWrap,
  ]));

  // B. 模型接入 (Model)
  refs.model.baseUrl = makeTextInput(model.baseUrl, "https://api.deepseek.com", { mono: true });
  refs.model.modelId = makeTextInput(model.modelId, "deepseek-flash", { mono: true });
  var thinkingSel = el("select");
  var thinkingOpts = ["low", "high", "max", "minimal", "medium"];
  if (model.thinkingLevel && thinkingOpts.indexOf(model.thinkingLevel) === -1) thinkingOpts.unshift(model.thinkingLevel);
  thinkingOpts.forEach(function (opt) { thinkingSel.appendChild(el("option", { value: opt, text: opt })); });
  thinkingSel.value = model.thinkingLevel || "high";
  thinkingSel.addEventListener("change", markSettingsDirty);
  refs.model.thinkingLevel = thinkingSel;
  refs.model.maxInputBytes = makeTextInput(model.maxInputBytes, "65536 (留空为 null)", { type: "number", mono: true });
  refs.model.maxOutputTokens = makeTextInput(model.maxOutputTokens, "2048 (留空为 null)", { type: "number", mono: true });
  refs.model.inputPerMTokMicrousd = makeTextInput(priceCatalog.inputPerMTokMicrousd, "留空为 null", { type: "number", mono: true });
  refs.model.outputPerMTokMicrousd = makeTextInput(priceCatalog.outputPerMTokMicrousd, "留空为 null", { type: "number", mono: true });
  refs.model.cacheReadPerMTokMicrousd = makeTextInput(priceCatalog.cacheReadPerMTokMicrousd, "留空为 null", { type: "number", mono: true });
  refs.model.cacheWritePerMTokMicrousd = makeTextInput(priceCatalog.cacheWritePerMTokMicrousd, "留空为 null", { type: "number", mono: true });
  refs.secrets.DEEPSEEK_API_KEY = makeSecretControl("DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY（仅写入 .env，不明文回显）", { full: true });

  var modelGrid = el("div", { class: "settings-grid" }, [
    makeField("model.baseUrl（SDK 根地址，不含 /chat/completions）", refs.model.baseUrl),
    makeField("model.modelId", refs.model.modelId),
    makeField("model.thinkingLevel", refs.model.thinkingLevel),
    makeField("model.maxInputBytes (1..131072)", refs.model.maxInputBytes),
    makeField("model.maxOutputTokens (1..1000000)", refs.model.maxOutputTokens),
    makeField("priceCatalog.inputPerMTokMicrousd (microUSD/1M)", refs.model.inputPerMTokMicrousd),
    makeField("priceCatalog.outputPerMTokMicrousd (microUSD/1M)", refs.model.outputPerMTokMicrousd),
    makeField("priceCatalog.cacheReadPerMTokMicrousd (microUSD/1M)", refs.model.cacheReadPerMTokMicrousd),
    makeField("priceCatalog.cacheWritePerMTokMicrousd (microUSD/1M)", refs.model.cacheWritePerMTokMicrousd),
    refs.secrets.DEEPSEEK_API_KEY.node,
  ]);
  var modelTestResultHost = el("div");
  if (state.settingsTestResults.model) modelTestResultHost.appendChild(renderTestResultNode(state.settingsTestResults.model));
  var modelTestBtn = el("button", { type: "button", class: "act", text: "测试模型连通性", click: function () {
    runConnectivityTest("model", modelTestResultHost, modelTestBtn);
  } });
  host.appendChild(el("div", { class: "panel" }, [
    el("h2", { text: "B. 模型接入 (Model)" }),
    modelGrid,
    el("div", { class: "row", style: "margin-top:10px;" }, [
      modelTestBtn,
      el("span", { class: "dim", style: "font-size:12px;", text: "测试使用已保存配置，修改后请先保存并热生效" }),
    ]),
    modelTestResultHost,
  ]));

  // C. Telegram 接入
  refs.telegram.apiBase = makeTextInput(tg.apiBase, "https://api.telegram.org", { mono: true });
  refs.telegram.allowedChatIds = makeTextInput((tg.allowedChatIds || []).join(", "), "例如 123456789, -1001234567890", { mono: true });
  refs.telegram.ownerDestination = makeTextInput(tg.ownerDestination, "dm:telegram:<chatId>", { mono: true });
  var autoOwnerHint = el("span", { class: "dim", style: "font-size:11.5px;", text: "" });
  var autoOwnerBtn = el("button", { type: "button", class: "act", text: "按首个 Chat ID 自动生成", click: function () {
    var ids = parseListInput(refs.telegram.allowedChatIds.value);
    if (ids.length === 0) {
      autoOwnerHint.className = "bad";
      autoOwnerHint.textContent = "请先填写 allowedChatIds";
      return;
    }
    refs.telegram.ownerDestination.value = "dm:telegram:" + ids[0];
    autoOwnerHint.className = "ok";
    autoOwnerHint.textContent = "已生成 " + refs.telegram.ownerDestination.value;
    markSettingsDirty();
  } });
  var ownerDestWrap = el("div", { class: "secret-row" }, [refs.telegram.ownerDestination, autoOwnerBtn, autoOwnerHint]);
  refs.secrets.AEGISPI_REAL_TG_PROXY = makeSecretControl("AEGISPI_REAL_TG_PROXY", "AEGISPI_REAL_TG_PROXY（代理地址，留空保持不变）", {
    type: "text",
    placeholder: "http://127.0.0.1:7890（已配置时留空保持不变）",
    full: true,
  });
  refs.secrets.TELEGRAM_BOT_TOKEN = makeSecretControl("TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN（Bot Token，留空保持不变）", { full: true });

  var tgTestResultHost = el("div");
  if (state.settingsTestResults.telegram) tgTestResultHost.appendChild(renderTestResultNode(state.settingsTestResults.telegram));
  var tgTestBtn = el("button", { type: "button", class: "act", text: "测试 Telegram 连通性", click: function () {
    runConnectivityTest("telegram", tgTestResultHost, tgTestBtn);
  } });
  host.appendChild(el("div", { class: "panel" }, [
    el("h2", { text: "C. Telegram 接入" }),
    el("div", { class: "settings-grid" }, [
      makeField("telegram.apiBase", refs.telegram.apiBase),
      makeField("telegram.allowedChatIds（逗号或换行分隔整数 ID）", refs.telegram.allowedChatIds),
      makeField("telegram.ownerDestination", ownerDestWrap, { full: true }),
      refs.secrets.AEGISPI_REAL_TG_PROXY.node,
      refs.secrets.TELEGRAM_BOT_TOKEN.node,
    ]),
    el("div", { class: "row", style: "margin-top:10px;" }, [
      tgTestBtn,
      el("span", { class: "dim", style: "font-size:12px;", text: "测试使用已保存配置，修改后请先保存并热生效" }),
    ]),
    tgTestResultHost,
  ]));

  // D. 邮件与晨报 (Mail & Briefing)
  refs.mail.imapHost = makeTextInput(mail.imapHost, "imap.example.com", { mono: true });
  refs.mail.imapPort = makeTextInput(mail.imapPort ?? 993, "993", { type: "number", mono: true });
  refs.mail.smtpHost = makeTextInput(mail.smtpHost, "smtp.example.com", { mono: true });
  refs.mail.smtpPort = makeTextInput(mail.smtpPort ?? 465, "465", { type: "number", mono: true });
  refs.secrets.MAIL_USER = makeSecretControl("MAIL_USER", "MAIL_USER（邮箱地址，服务端不回显，留空保持不变）", {
    type: "text",
    placeholder: "you@example.com（已配置时留空保持不变）",
  });
  refs.secrets.MAIL_APP_PASSWORD = makeSecretControl("MAIL_APP_PASSWORD", "MAIL_APP_PASSWORD（应用专用密码，留空保持不变）");
  refs.mail.allowedSenders = makeTextInput((mail.allowedSenders || []).join(", "), "alice@example.com", { mono: true });
  refs.mail.allowedRecipients = makeTextInput((mail.allowedRecipients || []).join(", "), "bob@example.com", { mono: true });
  refs.adapters.fixedSendingIdentity = makeTextInput(adapters.fixedSendingIdentity, "aegispi@local", { mono: true });
  refs.adapters.allowedRecipients = makeTextInput((adapters.allowedRecipients || []).join(", "), "carol@example.com, dm:telegram:123", { mono: true });
  refs.briefingTimeOfDay = makeTextInput(s.briefingTimeOfDay || "", "HH:MM 如 08:30（留空关闭晨报）", { mono: true });

  var qh = cal.quietHours || null;
  var qhText = qh ? (qh.start + " ~ " + qh.end + " (" + qh.timezone + ")") : "未配置";
  var qhView = el("input", { type: "text", class: "mono", readonly: "readonly", value: qhText });
  qhView.readOnly = true;

  var mailTestResultHost = el("div");
  if (state.settingsTestResults.mail) mailTestResultHost.appendChild(renderTestResultNode(state.settingsTestResults.mail));
  var mailTestBtn = el("button", { type: "button", class: "act", text: "测试 IMAP 连通性", click: function () {
    runConnectivityTest("mail", mailTestResultHost, mailTestBtn);
  } });
  host.appendChild(el("div", { class: "panel" }, [
    el("h2", { text: "D. 邮件与晨报 (Mail & Briefing)" }),
    el("div", { class: "settings-grid" }, [
      makeField("mail.imapHost", refs.mail.imapHost),
      makeField("mail.imapPort (1..65535)", refs.mail.imapPort),
      makeField("mail.smtpHost", refs.mail.smtpHost),
      makeField("mail.smtpPort (1..65535)", refs.mail.smtpPort),
      refs.secrets.MAIL_USER.node,
      refs.secrets.MAIL_APP_PASSWORD.node,
      makeField("mail.allowedSenders（逗号或换行分隔）", refs.mail.allowedSenders),
      makeField("mail.allowedRecipients（逗号或换行分隔）", refs.mail.allowedRecipients),
      makeField("adapters.fixedSendingIdentity", refs.adapters.fixedSendingIdentity),
      makeField("adapters.allowedRecipients（逗号或换行分隔）", refs.adapters.allowedRecipients),
      makeField("briefingTimeOfDay（晨报时间 HH:MM）", refs.briefingTimeOfDay),
      makeField("静默时段 calendar.quietHours（只读）", qhView, {
        hint: "quietHours 归属 calendar 段；当前 /api/settings 仅允许修改 model/telegram/mail/policy/adapters。",
      }),
    ]),
    el("div", { class: "row", style: "margin-top:10px;" }, [
      mailTestBtn,
      el("span", { class: "dim", style: "font-size:12px;", text: "测试使用已保存配置，修改后请先保存并热生效" }),
    ]),
    mailTestResultHost,
  ]));

  // E. 备份密钥与运行状态
  refs.secrets.AEGISPI_BACKUP_MANIFEST_KEY = makeSecretControl("AEGISPI_BACKUP_MANIFEST_KEY", "AEGISPI_BACKUP_MANIFEST_KEY（64 位十六进制密钥）", {
    full: true,
    extraBtn: function (inp, syncFn) {
      return el("button", { type: "button", class: "act", text: "本地生成 64 位密钥", click: function () {
        var bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        var hex = "";
        for (var i = 0; i < bytes.length; i++) {
          var h = bytes[i].toString(16);
          hex += h.length < 2 ? "0" + h : h;
        }
        inp.value = hex;
        delete state.settingsClearSecrets.AEGISPI_BACKUP_MANIFEST_KEY;
        markSettingsDirty();
        syncFn();
      } });
    },
  });

  var slotsWrap = el("div", { class: "btn-group" });
  var slots = Array.isArray(s.credentialSlots) ? s.credentialSlots : [];
  if (slots.length === 0) {
    slotsWrap.appendChild(el("span", { class: "dim", text: "暂无已注册凭据槽位" }));
  } else {
    slots.forEach(function (sl) {
      var isRevoked = sl.revoked_at !== null && sl.revoked_at !== undefined;
      var cls = isRevoked ? "bad" : (sl.registered_at ? "ok" : "dim");
      var statusText = isRevoked ? "已吊销" : (sl.registered_at ? "已注册" : "未注册");
      slotsWrap.appendChild(el("span", {
        class: "pill mono " + cls,
        text: sl.slot + " (" + (sl.env_name || "-") + ") · " + statusText,
      }));
    });
  }

  var imgWrap = el("div", { class: "btn-group" });
  var imgStatus = s.imageStatus || {};
  ["agent", "execution", "acquisition"].forEach(function (role) {
    var st = imgStatus[role];
    var ok = Boolean(st && st.configured);
    var label = role + ": " + (ok ? ("已配置 (" + st.image + ")") : "未配置");
    imgWrap.appendChild(el("span", { class: "pill mono " + (ok ? "ok" : "dim"), text: label }));
  });

  host.appendChild(el("div", { class: "panel" }, [
    el("h2", { text: "E. 备份密钥与运行状态" }),
    el("div", { class: "settings-grid" }, [
      refs.secrets.AEGISPI_BACKUP_MANIFEST_KEY.node,
      makeField("credentialSlots（凭据槽位状态，只读）", slotsWrap, { full: true }),
      makeField("imageStatus（容器镜像状态，只读）", imgWrap, { full: true }),
    ]),
  ]));

  // F. 操作栏
  var saveMsg = el("span", { class: "dim", style: "font-size:12.5px;", text: "" });
  var saveBtn = el("button", { type: "button", class: "act primary", text: "保存并热生效", disabled: !writable });
  var reloadBtn = el("button", { type: "button", class: "act", text: "重新加载", click: function () {
    loadSettings(true);
  } });
  saveBtn.addEventListener("click", function () {
    saveSettings(saveMsg, saveBtn);
  });
  host.appendChild(el("div", { class: "panel" }, [
    el("h2", { text: "F. 操作栏" }),
    el("div", { class: "row", style: "margin:0;" }, [saveBtn, reloadBtn, saveMsg]),
  ]));

  refs.saveMsg = saveMsg;
  settingsRefs = refs;
}

async function saveSettings(statusEl, saveBtn) {
  if (!requireSession() || !settingsRefs || !state.settings || !state.settings.writable) return;
  statusEl.className = "dim";
  statusEl.textContent = "";

  var r = settingsRefs;
  var maxIn = parseOptionalIntField(r.model.maxInputBytes.value, "model.maxInputBytes", 1, 131072);
  if (!maxIn.ok) { statusEl.className = "bad"; statusEl.textContent = maxIn.message; return; }
  var maxOut = parseOptionalIntField(r.model.maxOutputTokens.value, "model.maxOutputTokens", 1, 1000000);
  if (!maxOut.ok) { statusEl.className = "bad"; statusEl.textContent = maxOut.message; return; }

  var pIn = parseOptionalIntField(r.model.inputPerMTokMicrousd.value, "priceCatalog.inputPerMTokMicrousd", 0, Number.MAX_SAFE_INTEGER);
  if (!pIn.ok) { statusEl.className = "bad"; statusEl.textContent = pIn.message; return; }
  var pOut = parseOptionalIntField(r.model.outputPerMTokMicrousd.value, "priceCatalog.outputPerMTokMicrousd", 0, Number.MAX_SAFE_INTEGER);
  if (!pOut.ok) { statusEl.className = "bad"; statusEl.textContent = pOut.message; return; }
  var pCR = parseOptionalIntField(r.model.cacheReadPerMTokMicrousd.value, "priceCatalog.cacheReadPerMTokMicrousd", 0, Number.MAX_SAFE_INTEGER);
  if (!pCR.ok) { statusEl.className = "bad"; statusEl.textContent = pCR.message; return; }
  var pCW = parseOptionalIntField(r.model.cacheWritePerMTokMicrousd.value, "priceCatalog.cacheWritePerMTokMicrousd", 0, Number.MAX_SAFE_INTEGER);
  if (!pCW.ok) { statusEl.className = "bad"; statusEl.textContent = pCW.message; return; }

  var imapPort = parseRequiredIntField(r.mail.imapPort.value, "mail.imapPort", 1, 65535, 993);
  if (!imapPort.ok) { statusEl.className = "bad"; statusEl.textContent = imapPort.message; return; }
  var smtpPort = parseRequiredIntField(r.mail.smtpPort.value, "mail.smtpPort", 1, 65535, 465);
  if (!smtpPort.ok) { statusEl.className = "bad"; statusEl.textContent = smtpPort.message; return; }

  var briefingRaw = r.briefingTimeOfDay.value.trim();
  if (briefingRaw !== "" && !/^(?:[01]\\d|2[0-3]):[0-5]\\d$/.test(briefingRaw)) {
    statusEl.className = "bad";
    statusEl.textContent = "briefingTimeOfDay 必须为 HH:MM (24小时制) 或留空关闭";
    return;
  }

  var secrets = {};
  var clearSecrets = [];
  SECRET_KEY_LIST.forEach(function (key) {
    var ctrl = r.secrets[key];
    var rawVal = ctrl ? ctrl.input.value : "";
    if (state.settingsClearSecrets[key]) {
      clearSecrets.push(key);
    } else if (rawVal.trim().length > 0) {
      secrets[key] = rawVal.trim();
    }
  });
  if (secrets.MAIL_USER && !/^[^@\\s]+@[^@\\s]+$/.test(secrets.MAIL_USER.toLowerCase())) {
    statusEl.className = "bad";
    statusEl.textContent = "MAIL_USER 必须为有效邮箱地址";
    return;
  }

  var baseUrlVal = r.model.baseUrl.value.trim();
  var tgApiBaseVal = r.telegram.apiBase.value.trim();
  var tgOwnerVal = r.telegram.ownerDestination.value.trim();
  var imapHostVal = r.mail.imapHost.value.trim();
  var smtpHostVal = r.mail.smtpHost.value.trim();
  var fixedIdVal = r.adapters.fixedSendingIdentity.value.trim();

  var payload = {
    configPatch: {
      model: {
        allowRealModelCalls: Boolean(r.switches["model.allowRealModelCalls"].checked),
        baseUrl: baseUrlVal === "" ? null : baseUrlVal,
        modelId: r.model.modelId.value.trim(),
        thinkingLevel: r.model.thinkingLevel.value,
        maxInputBytes: maxIn.value,
        maxOutputTokens: maxOut.value,
        priceCatalog: {
          inputPerMTokMicrousd: pIn.value,
          outputPerMTokMicrousd: pOut.value,
          cacheReadPerMTokMicrousd: pCR.value,
          cacheWritePerMTokMicrousd: pCW.value,
        },
      },
      telegram: {
        allowRealPull: Boolean(r.switches["telegram.allowRealPull"].checked),
        allowRealSend: Boolean(r.switches["telegram.allowRealSend"].checked),
        autoReplyOnTask: Boolean(r.switches["telegram.autoReplyOnTask"].checked),
        apiBase: tgApiBaseVal === "" ? null : tgApiBaseVal,
        allowedChatIds: parseListInput(r.telegram.allowedChatIds.value),
        ownerDestination: tgOwnerVal === "" ? null : tgOwnerVal,
      },
      mail: {
        allowRealMailRead: Boolean(r.switches["mail.allowRealMailRead"].checked),
        allowRealMailSend: Boolean(r.switches["mail.allowRealMailSend"].checked),
        autoDraftReplies: Boolean(r.switches["mail.autoDraftReplies"].checked),
        imapHost: imapHostVal === "" ? null : imapHostVal,
        imapPort: imapPort.value,
        smtpHost: smtpHostVal === "" ? null : smtpHostVal,
        smtpPort: smtpPort.value,
        allowedSenders: parseListInput(r.mail.allowedSenders.value),
        allowedRecipients: parseListInput(r.mail.allowedRecipients.value),
      },
      policy: {
        allowRealExternalWrites: Boolean(r.switches["policy.allowRealExternalWrites"].checked),
      },
      adapters: {
        fixedSendingIdentity: fixedIdVal || (state.settings.config && state.settings.config.adapters && state.settings.config.adapters.fixedSendingIdentity) || "aegispi@local",
        allowedRecipients: parseListInput(r.adapters.allowedRecipients.value),
      },
    },
    secrets: secrets,
    clearSecrets: clearSecrets,
    briefingTimeOfDay: briefingRaw,
  };

  saveBtn.disabled = true;
  statusEl.className = "dim";
  statusEl.textContent = "正在保存并热生效…";
  var res = await api("POST", "/api/settings", payload);
  saveBtn.disabled = !state.settings.writable;

  if (res.status === 200 && res.data) {
    state.settings = res.data;
    state.settingsDirty = false;
    state.settingsClearSecrets = {};
    renderSetupBanner();
    renderSettings();
    if (settingsRefs && settingsRefs.saveMsg) {
      settingsRefs.saveMsg.className = "ok";
      settingsRefs.saveMsg.textContent = "已保存并热生效";
    }
  } else {
    statusEl.className = "bad";
    statusEl.textContent = "保存失败: " + ((res.data && res.data.message) || ("HTTP " + res.status));
  }
}

setInterval(function () {
  if (!session) return;
  if (session.expiresAt <= Date.now()) { session = null; requireSession(); }
}, 15000);
</script>
</body>
</html>`;
}

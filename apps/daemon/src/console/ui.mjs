// The local web console frontend (Unit 5.5; spec 04 sections 2-5, 02
// section 7). One same-origin page, zero external assets, and a hard rule:
// UNTRUSTED DATA NEVER TOUCHES innerHTML — every dynamic value enters the
// DOM through textContent (the HTML below is a static template; the only
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
  :root { --bg:#0e1116; --panel:#161b22; --line:#2b313b; --fg:#d7dde5; --dim:#8b949e; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --accent:#58a6ff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 "Cascadia Mono",Consolas,monospace; }
  header { padding:10px 16px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
  header h1 { font-size:15px; margin:0; color:var(--accent); }
  header .state { color:var(--dim); font-size:12px; }
  nav { display:flex; gap:4px; padding:8px 16px 0; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  nav button { background:none; border:1px solid var(--line); border-bottom:none; color:var(--dim); padding:6px 14px; cursor:pointer; font:inherit; }
  nav button.active { color:var(--fg); background:var(--panel); border-color:var(--accent); }
  main { padding:14px 16px 60px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:10px 12px; margin-bottom:12px; }
  .panel h2 { font-size:13px; margin:0 0 8px; color:var(--accent); font-weight:normal; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th, td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:normal; }
  .pill { display:inline-block; padding:1px 8px; border:1px solid var(--line); border-radius:10px; font-size:11px; }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); } .dim { color:var(--dim); }
  button.act { background:#21262d; color:var(--fg); border:1px solid var(--line); padding:4px 10px; cursor:pointer; font:inherit; font-size:12px; border-radius:4px; }
  button.act:hover { border-color:var(--accent); }
  button.act.danger { color:var(--bad); }
  input, textarea, select { background:#0d1117; color:var(--fg); border:1px solid var(--line); padding:4px 8px; font:inherit; font-size:12.5px; border-radius:4px; }
  textarea { width:100%; min-height:64px; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:6px 0; }
  .bar { height:10px; background:#0d1117; border:1px solid var(--line); border-radius:5px; overflow:hidden; width:100%; }
  .bar > div { height:100%; background:var(--accent); }
  .bar.full > div { background:var(--bad); }
  .meter { margin:6px 0; }
  .meter .label { display:flex; justify-content:space-between; font-size:12px; color:var(--dim); }
  pre { background:#0d1117; border:1px solid var(--line); padding:8px; overflow:auto; max-height:280px; font-size:12px; white-space:pre-wrap; word-break:break-all; }
  .kv { display:grid; grid-template-columns: max-content 1fr; gap:2px 12px; font-size:12.5px; }
  .kv .k { color:var(--dim); }
  .hidden { display:none; }
  #loginBox { max-width:520px; margin:60px auto; }
  details summary { cursor:pointer; color:var(--dim); }
</style>
</head>
<body>
<header>
  <h1>AegisPi Console</h1>
  <span class="state" id="connState">未连接</span>
  <span class="state" id="clockState"></span>
  <span class="dim">同源本地台 · 零外链</span>
</header>
<div id="loginBox" class="panel">
  <h2>登录（Bootstrap Token）</h2>
  <div class="row"><input id="tokenInput" type="password" placeholder="粘贴 workspace-state/console/token" style="flex:1"></div>
  <div class="row"><button class="act" id="loginBtn">建立会话</button><span id="loginMsg" class="dim"></span></div>
  <p class="dim">会话与 CSRF Token 只存在于本页内存；刷新或 daemon 重启后需重新登录。Token 不进入 URL。</p>
</div>
<main id="app" class="hidden">
<nav id="tabs">
  <button data-tab="approvals" class="active">① 待办与审批台</button>
  <button data-tab="tasks">② 任务与故障诊断台</button>
  <button data-tab="memory">③ 记忆与治理台</button>
  <button data-tab="cost">④ 链路与分用途成本台</button>
</nav>
<section id="tab-approvals">
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
    <h2>任务（按 scope 分组；Steer / 取消 / 详情）</h2>
    <div id="taskList"></div>
  </div>
  <div class="panel">
    <h2>对象 / Spill 分页查看（ACL 复验，无权限统一 404）</h2>
    <div class="row"><input id="objId" placeholder="obj:..." style="flex:1"><input id="objOffset" type="number" value="0" min="0" style="width:90px" title="offset"><input id="objLimit" type="number" value="2000" min="1" max="10000" style="width:110px" title="limit"><button class="act" id="objLoad">读取</button></div>
    <pre id="objView" class="hidden"></pre>
    <div class="dim" id="objMeta"></div>
  </div>
</section>
<section id="tab-memory" class="hidden">
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
    <div class="row"><input id="grantScope" placeholder="scp:..." style="width:280px"><input id="grantPrincipal" placeholder="prn:..." style="width:280px"><select id="grantPerm"><option>read</option><option>request</option><option>approve</option><option>admin</option></select><button class="act" id="grantAdd">授权</button></div>
  </div>
</section>
<section id="tab-cost" class="hidden">
  <div class="panel">
    <h2>账户水位（单任务 \$0.80 / 全局日 \$5.00）</h2>
    <div id="budgetMeters"></div>
  </div>
  <div class="panel">
    <h2>分用途归因（router / worker / summary / classify）</h2>
    <div id="purposeTable"></div>
    <p class="dim">未测项显式标注"未测"，无账单标注"待结算/上界"，零虚构百分比。</p>
  </div>
  <div class="panel">
    <h2>任务链路 Trace（脱敏时间线）</h2>
    <div class="row"><input id="traceTaskId" placeholder="task id" style="width:280px"><button class="act" id="traceLoad">查看</button></div>
    <pre id="traceView" class="hidden"></pre>
  </div>
</section>
</main>
<script>
"use strict";
var PORT = ${port};
var session = null;          // {sessionId, csrfToken, expiresAt} — memory only
var state = { generation: 0, watermark: 0, approvals: [], unknowns: [], tasks: [], memories: [], suggestions: [], routines: [], budget: null, health: null };
var streamAbort = null;
var streamController = { lastEventId: null, closed: false };

function $(id) { return document.getElementById(id); }
function el(tag, props, children) {
  var n = document.createElement(tag);
  if (props) for (var k in props) {
    if (k === "text") n.textContent = String(props[k]);
    else if (k === "class") n.className = props[k];
    else if (k === "click") n.addEventListener("click", props[k]);
    else n.setAttribute(k, props[k]);
  }
  if (children) children.forEach(function (c) { if (c) n.appendChild(c); });
  return n;
}
function fmtTime(ms) { if (!ms) return "-"; var d = new Date(Number(ms)); return d.toLocaleString("sv-SE"); }
function fmtUsd(u) { return "$" + (Number(u || 0) / 1000000).toFixed(4); }
function shortHash(h) { return typeof h === "string" && h.length > 12 ? h.slice(0, 12) + "…" : h; }

async function api(method, path, body) {
  var headers = {};
  if (session) headers["authorization"] = "Bearer " + session.sessionId;
  if (body !== undefined) { headers["content-type"] = "application/json"; headers["x-csrf-token"] = session.csrfToken; }
  var res = await fetch(path, { method: method, headers: headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  var data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data: data };
}

// ---------------------------------------------------------------- login
$("loginBtn").addEventListener("click", async function () {
  var token = $("tokenInput").value.trim();
  if (!token) { $("loginMsg").textContent = "需要 bootstrap token"; return; }
  var r = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json", "authorization": "Bearer " + token }, body: JSON.stringify({ token: token }) });
  if (r.status !== 200) {
    var d = null; try { d = await r.json(); } catch (e) {}
    $("loginMsg").textContent = "登录失败: " + (d && d.message ? d.message : r.status);
    return;
  }
  var d = await r.json();
  session = { sessionId: d.sessionId, csrfToken: d.csrfToken, expiresAt: d.expiresAt };
  $("loginBox").classList.add("hidden");
  $("app").classList.remove("hidden");
  startStream(true);
  refreshAll();
});
$("tokenInput").addEventListener("keydown", function (e) { if (e.key === "Enter") $("loginBtn").click(); });
function requireSession() {
  if (!session) { $("loginBox").classList.remove("hidden"); $("app").classList.add("hidden"); return false; }
  if (session.expiresAt <= Date.now()) { session = null; return requireSession(); }
  return true;
}

// ---------------------------------------------------------------- tabs
document.getElementById("tabs").addEventListener("click", function (e) {
  if (e.target.tagName !== "BUTTON") return;
  document.querySelectorAll("#tabs button").forEach(function (b) { b.classList.toggle("active", b === e.target); });
  ["approvals", "tasks", "memory", "cost"].forEach(function (t) {
    document.getElementById("tab-" + t).classList.toggle("hidden", t !== e.target.getAttribute("data-tab"));
  });
});

// ---------------------------------------------------------------- SSE
async function startStream(fresh) {
  if (!requireSession()) return;
  if (streamAbort) streamAbort.abort();
  streamAbort = new AbortController();
  streamController.closed = false;
  var headers = { "authorization": "Bearer " + session.sessionId, "accept": "text/event-stream" };
  if (!fresh && streamController.lastEventId) headers["last-event-id"] = streamController.lastEventId;
  try {
    var res = await fetch("/api/events/stream", { headers: headers, signal: streamAbort.signal });
    if (res.status === 410) { await resync(); return; }
    if (res.status !== 200) { setConn("SSE " + res.status, "bad"); return; }
    setConn("SSE 已连接", "ok");
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
    if (!streamController.closed) { setConn("SSE 断开，2s 后重连", "warn"); setTimeout(function () { startStream(false); }, 2000); }
  } catch (e) {
    if (e.name === "AbortError") return;
    setConn("SSE 错误，2s 后重连", "warn");
    setTimeout(function () { startStream(false); }, 2000);
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
  if (ev === "reset") { resync(); return; }
  if (ev === "acl_changed") { resync(); return; }
  // Any business event refreshes the visible panels (small local daemon:
  // full refresh per event keeps the client honest, no incremental cache).
  refreshAll();
}
async function resync() {
  // 04 §5: reset / 410 / revocation -> wipe client state, re-pull snapshot.
  state = { generation: 0, watermark: 0, approvals: [], unknowns: [], tasks: [], memories: [], suggestions: [], routines: [], budget: null, health: null };
  streamController.lastEventId = null;
  setConn("已重置，重新拉取快照", "warn");
  startStream(true);
  refreshAll();
}
function setConn(text, cls) { var s = $("connState"); s.textContent = text; s.className = "state " + cls; }

// ---------------------------------------------------------------- refresh
async function refreshAll() {
  if (!requireSession()) return;
  var snap = await api("GET", "/api/snapshot");
  if (snap.status === 200 && snap.data) {
    state.generation = snap.data.generation;
    state.watermark = snap.data.watermark;
    $("clockState").textContent = "generation " + snap.data.generation + " · watermark " + snap.data.watermark;
  }
  var health = await api("GET", "/api/health");
  var recovery = await api("GET", "/api/recovery");
  state.health = { health: health.data, recovery: recovery.data };
  var appr = await api("GET", "/api/approvals");
  state.approvals = (appr.data && appr.data.approvals) ? appr.data.approvals.filter(function (a) { return a.state === "WAITING"; }) : [];
  var unkn = await api("GET", "/api/effects-unknown");
  state.unknowns = (unkn.data && unkn.data.effects) ? unkn.data.effects : [];
  var tasks = await api("GET", "/api/tasks");
  state.tasks = (tasks.data && tasks.data.tasks) ? tasks.data.tasks : [];
  var mem = await api("GET", "/api/memory");
  state.memories = (mem.data && mem.data.memories) || [];
  state.suggestions = (mem.data && mem.data.suggestions) || [];
  var routines = await api("GET", "/api/routines");
  state.routines = (routines.data && routines.data.routines) || [];
  var budget = await api("GET", "/api/budget");
  state.budget = budget.data;
  renderHealth(); renderApprovals(); renderUnknowns(); renderTasks(); renderMemory(); renderSuggestions(); renderRoutines(); renderGrants(); renderBudget();
}

// ---------------------------------------------------------------- render
function renderHealth() {
  var host = $("healthBar"); host.textContent = "";
  if (!state.health) return;
  var h = state.health.health || {}, rc = state.health.recovery || {};
  host.appendChild(el("span", { text: "mode=" + (h.mode || "?") }));
  host.appendChild(el("span", { text: "node=" + (h.node || "?") }));
  host.appendChild(el("span", { text: "recovery failedStep=" + (rc.failedStep || "无") }));
  host.appendChild(el("span", { text: "actions=" + ((rc.actions && rc.actions.length) || 0) }));
}
function renderApprovals() {
  var host = $("approvalList"); host.textContent = "";
  if (state.approvals.length === 0) { host.appendChild(el("p", { class: "dim", text: "无 WAITING 审批卡。" })); return; }
  var t = el("table");
  var head = el("tr", null, [el("th", { text: "卡" }), el("th", { text: "scope / 任务" }), el("th", { text: "动作" }), el("th", { text: "action_hash" }), el("th", { text: "到期" }), el("th", { text: "操作" })]);
  t.appendChild(head);
  state.approvals.forEach(function (a) {
    var edit = el("div", { class: "hidden row" });
    var subj = el("input", { placeholder: "subject", style: "flex:1" });
    var body = el("textarea", { placeholder: "正文" });
    edit.appendChild(subj); edit.appendChild(body);
    function prefillEdit(extra) {
      if (!subj.value && extra.subject !== undefined && extra.subject !== null) subj.value = String(extra.subject);
      if (!body.value && extra.bodyText !== undefined && extra.bodyText !== null) body.value = String(extra.bodyText);
    }
    // F-11 (D-99): the preview card is MOUNTED in the first cell (under the
    // approval id) and fills from GET /api/approvals/:id on first expand —
    // the card fields (target resource, evidence manifest, ETag) were
    // designed to show here, not dead code.
    var info = el("div", { class: "kv" });
    var detail = el("details", null, [el("summary", { text: "展开预览" }), info]);
    detail.addEventListener("toggle", async function () {
      if (!detail.open || info.dataset.loaded) return;
      var card = await api("GET", "/api/approvals/" + encodeURIComponent(a.id));
      var act = (card.data && card.data.action) || {};
      var extra = act.extra || {};
      prefillEdit(extra);
      var rows = [
        ["动作", act.operation || ""],
        ["目标资源", act.targetResource || ""],
        ["发送身份", act.sendingIdentity || ""],
        ["证据 manifest", shortHash(act.evidenceManifestHash || "")],
        ["内容 hash", shortHash(act.contentHash || "")],
        ["附件 hash", shortHash(act.attachmentHash || "")],
        ["expected_head (ETag)", act.expectedHead || "—"],
      ];
      if (extra.subject !== undefined && extra.subject !== null && String(extra.subject).length > 0) {
        rows.push(["邮件主题", String(extra.subject)]);
      }
      info.textContent = "";
      rows.forEach(function (r) {
        var line = el("div", { class: "row" });
        line.appendChild(el("span", { class: "dim", text: r[0] + ": " }));
        line.appendChild(el("span", { text: String(r[1]) }));
        info.appendChild(line);
      });
      if (extra.bodyText !== undefined && extra.bodyText !== null && String(extra.bodyText).length > 0) {
        info.appendChild(el("div", { class: "dim", text: "草稿正文:" }));
        info.appendChild(el("pre", { text: String(extra.bodyText) }));
      }
      info.dataset.loaded = "1";
    });
    var doEdit = el("button", { class: "act", text: "提交编辑重签", click: async function () {
      var card = await api("GET", "/api/approvals/" + encodeURIComponent(a.id));
      var action = (card.data && card.data.action) || {};
      var intent = Object.assign({}, action.extra || {}, { subject: subj.value || action.extra.subject, bodyText: body.value || action.extra.bodyText });
      var r = await api("POST", "/api/approvals/" + encodeURIComponent(a.id) + "/revise", { intent: intent, expiresAt: Date.now() + 4 * 3600 * 1000 });
      $("tab-approvals").querySelector(".editmsg") && Array.prototype.forEach.call(document.querySelectorAll(".editmsg"), function (n) { n.textContent = ""; });
      var msg = el("span", { class: (r.status === 200 ? "ok" : "bad") + " editmsg", text: r.status === 200 ? "已换新卡 " + (r.data.newApprovalId || "") : ("编辑失败: " + (r.data && r.data.message)) });
      edit.appendChild(msg);
      refreshAll();
    } });
    edit.appendChild(doEdit);
    var showEdit = el("button", { class: "act", text: "编辑草稿并重新生成审批", click: async function () {
      edit.classList.toggle("hidden");
      if (!edit.classList.contains("hidden") && (!subj.value || !body.value) && !edit.dataset.prefilled) {
        var card = await api("GET", "/api/approvals/" + encodeURIComponent(a.id));
        var extra = (card.data && card.data.action && card.data.action.extra) || {};
        prefillEdit(extra);
        edit.dataset.prefilled = "1";
      }
    } });
    var approve = el("button", { class: "act", text: "批准此动作", click: async function () {
      var card = await api("GET", "/api/approvals/" + encodeURIComponent(a.id));
      var dm = card.data && card.data.decisionMaterials;
      if (!dm || !dm.nonce) { alert("取不到决策材料（仅 designated approver 的活会话可见）；请重新登录或改用编辑重签"); return; }
      var r = await api("POST", "/api/approvals/" + encodeURIComponent(a.id) + "/decide", { decision: "approve", actionHash: dm.actionHash, nonce: dm.nonce });
      if (r.status !== 200) alert((r.data && r.data.reason) || (r.data && r.data.message) || r.status);
      refreshAll();
    } });
    var reject = el("button", { class: "act danger", text: "拒绝", click: async function () {
      var card = await api("GET", "/api/approvals/" + encodeURIComponent(a.id));
      var dm = card.data && card.data.decisionMaterials;
      if (!dm || !dm.nonce) { alert("取不到决策材料（仅 designated approver 的活会话可见）"); return; }
      var r = await api("POST", "/api/approvals/" + encodeURIComponent(a.id) + "/decide", { decision: "reject", actionHash: dm.actionHash, nonce: dm.nonce });
      if (r.status !== 200) alert((r.data && r.data.reason) || (r.data && r.data.message) || r.status);
      refreshAll();
    } });
    var idCell = el("td");
    idCell.appendChild(el("span", { text: a.id }));
    idCell.appendChild(detail);
    t.appendChild(el("tr", null, [
      idCell,
      el("td", { text: (a.scope_id || "") + " / " + (a.task_id || "") }),
      el("td", { text: a.operation || "" }),
      el("td", { text: shortHash(a.action_hash) }),
      el("td", { text: fmtTime(a.expires_at) }),
      el("td", null, [approve, showEdit, reject, edit]),
    ]));
  });
  host.appendChild(t);
}
function renderUnknowns() {
  var host = $("unknownList"); host.textContent = "";
  if (state.unknowns.length === 0) { host.appendChild(el("p", { class: "dim", text: "无 UNKNOWN 动作。" })); return; }
  state.unknowns.forEach(function (u) {
    var row = el("div", { class: "row" });
    row.appendChild(el("span", { text: u.id + " (" + u.operation + ") retry=" + u.retry_mode }));
    var input = el("input", { placeholder: "externalEvidenceRef（发件箱回执等）", style: "width:280px" });
    var sel = el("select");
    ["CONFIRMED_SUCCESS", "CONFIRMED_NOT_SENT", "REMAINS_UNKNOWN"].forEach(function (o) { var op = el("option", { text: o }); sel.appendChild(op); });
    var btn = el("button", { class: "act", text: "对账", click: async function () {
      if (!input.value.trim()) { alert("需要 externalEvidenceRef"); return; }
      var r = await api("POST", "/api/effects/" + encodeURIComponent(u.id) + "/reconcile", { resolution: sel.value, externalEvidenceRef: input.value.trim() });
      if (r.status !== 200) alert((r.data && r.data.message) || r.status);
      refreshAll();
    } });
    row.appendChild(input); row.appendChild(sel); row.appendChild(btn);
    host.appendChild(row);
  });
}
function renderTasks() {
  var host = $("taskList"); host.textContent = "";
  var byScope = {};
  state.tasks.forEach(function (t) { (byScope[t.scope_id] = byScope[t.scope_id] || []).push(t); });
  Object.keys(byScope).sort().forEach(function (scope) {
    var panel = el("div", { class: "panel" });
    panel.appendChild(el("h2", { text: scope }));
    var t = el("table");
    byScope[scope].forEach(function (task) {
      var edit = el("div", { class: "hidden row" });
      var msg = el("input", { placeholder: "Steer 消息", style: "flex:1" });
      var send = el("button", { class: "act", text: "Steer", click: async function () {
        var r = await api("POST", "/api/tasks/" + encodeURIComponent(task.id) + "/steer", { message: msg.value, expectedRevision: task.updated_at });
        var s = el("span", { class: r.status === 202 ? "ok" : "bad", text: r.status === 202 ? "已入队" : ("失败: " + (r.data && r.data.message)) });
        edit.appendChild(s);
      } });
      edit.appendChild(msg); edit.appendChild(send);
      var cancel = el("button", { class: "act danger", text: "取消任务", click: async function () {
        if (!confirm("取消该任务（同 scope epoch 栅栏）？")) return;
        var r = await api("POST", "/api/tasks/" + encodeURIComponent(task.id) + "/cancel", { reason: "console cancel", expectedRevision: task.updated_at });
        if (r.status !== 200) alert((r.data && r.data.message) || r.status);
        refreshAll();
      } });
      var steer = el("button", { class: "act", text: "Steer", click: function () { edit.classList.toggle("hidden"); } });
      var actions = [steer, cancel];
      if (task.result_object_id) {
        actions.push(el("button", { class: "act", text: "查看结果", click: function () {
          $("objId").value = task.result_object_id;
          $("objOffset").value = "0";
          $("objLoad").click();
        } }));
      }
      actions.push(edit);
      t.appendChild(el("tr", null, [
        el("td", { text: task.id }),
        el("td", { text: task.state }),
        el("td", { text: String(task.result_class || "-") }),
        el("td", { text: "fence " + task.fence }),
        el("td", { text: fmtTime(task.updated_at) }),
        el("td", null, actions),
      ]));
    });
    panel.appendChild(t);
    host.appendChild(panel);
  });
  if (state.tasks.length === 0) host.appendChild(el("p", { class: "dim", text: "无任务。" }));
}
$("objLoad").addEventListener("click", async function () {
  var id = $("objId").value.trim();
  if (!id) return;
  var off = Number($("objOffset").value || 0);
  var lim = Number($("objLimit").value || 2000);
  var r = await api("GET", "/api/objects/" + encodeURIComponent(id) + "?offset=" + off + "&limit=" + lim);
  var view = $("objView");
  view.classList.remove("hidden");
  if (r.status !== 200) { view.textContent = (r.data && r.data.message) || ("HTTP " + r.status); $("objMeta").textContent = ""; return; }
  view.textContent = r.data.content || "(空)";
  $("objMeta").textContent = "kind=" + r.data.kind + " status=" + r.data.status + " totalBytes=" + r.data.totalBytes + (r.data.truncated ? " （已截断，可继续 offset）" : "");
});
function renderMemory() {
  var host = $("memoryList"); host.textContent = "";
  if (state.memories.length === 0) { host.appendChild(el("p", { class: "dim", text: "无可见记忆条目。" })); return; }
  var t = el("table");
  state.memories.forEach(function (m) {
    var ops = el("td", null, []);
    if (m.status === "candidate" && !m.neverActivatable) ops.appendChild(el("button", { class: "act", text: "激活", click: function () { memoryDecide(m, "activate"); } }));
    if (m.status === "candidate" || m.status === "conflicted") ops.appendChild(el("button", { class: "act", text: "拒绝", click: function () { memoryDecide(m, "reject"); } }));
    ops.appendChild(el("button", { class: "act danger", text: "遗忘", click: function () { memoryDecide(m, "forget"); } }));
    t.appendChild(el("tr", null, [
      el("td", { text: m.id }),
      el("td", { text: m.status }),
      el("td", { text: m.factKey || "-" }),
      el("td", { text: (m.factText || "").slice(0, 120) }),
      el("td", { text: m.quarantinedReasons.length ? m.quarantinedReasons.join(",") : "-" }),
      ops,
    ]));
  });
  host.appendChild(t);
}
async function memoryDecide(m, decision) {
  if (decision === "forget" && !confirm("遗忘将两阶段清除并追加墓碑清单，继续？")) return;
  var r = await api("POST", "/api/memory/" + encodeURIComponent(m.id) + "/decide", { decision: decision, expectedRevision: m.revision });
  if (r.status !== 200) alert((r.data && r.data.message) || r.status);
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
    row.appendChild(el("span", { text: r.id + " · mode=" + r.mode + " · policy=" + (r.policyVersion || "-") }));
    var target = el("select");
    ["observe", "auto"].forEach(function (o) { var op = el("option", { text: o }); target.appendChild(op); });
    target.value = r.mode;
    var ref = el("input", { placeholder: "reviewReportRef（转 auto 必填）", style: "width:220px" });
    row.appendChild(target); row.appendChild(ref);
    row.appendChild(el("button", { class: "act", text: "切换", click: async function () {
      var body = { mode: target.value, expectedRevision: r.revision, policyVersion: r.policyVersion };
      if (ref.value.trim()) body.reviewReportRef = ref.value.trim();
      var res = await api("POST", "/api/routines/" + encodeURIComponent(r.id) + "/mode", body);
      if (res.status !== 200) alert((res.data && res.data.message) || res.status);
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
    var row = el("div", { class: "row" });
    row.appendChild(el("span", { text: s.id }));
    var label = el("span", { class: "dim", text: "" });
    row.appendChild(label);
    row.appendChild(el("button", { class: "act", text: "查看授权", click: async function () {
      var g = await api("GET", "/api/scopes/" + encodeURIComponent(s.id) + "/grants");
      label.textContent = "";
      (g.data && g.data.grants || []).forEach(function (gr) {
        var line = gr.principal_id + ":" + gr.permission + (gr.revoked_at ? " (revoked)" : " live");
        var ln = el("div", { class: "row" });
        ln.appendChild(el("span", { text: line }));
        if (!gr.revoked_at) ln.appendChild(el("button", { class: "act danger", text: "撤权", click: async function () {
          var r = await api("POST", "/api/grants/revoke", { scopeId: s.id, principalId: gr.principal_id, permission: gr.permission, reason: "console revoke" });
          if (r.status !== 200) alert((r.data && r.data.message) || r.status);
          loadGrants();
        } }));
        label.appendChild(ln);
      });
    } }));
    host.appendChild(row);
  });
}
$("grantAdd").addEventListener("click", async function () {
  var r = await api("POST", "/api/grants", { scopeId: $("grantScope").value.trim(), principalId: $("grantPrincipal").value.trim(), permission: $("grantPerm").value });
  if (r.status !== 200) alert((r.data && r.data.message) || r.status);
  loadGrants();
});
function meter(label, spent, held, limit, note) {
  var wrap = el("div", { class: "meter" });
  var top = el("div", { class: "label" });
  top.appendChild(el("span", { text: label }));
  top.appendChild(el("span", { text: fmtUsd(spent) + " spent + " + fmtUsd(held) + " held / 上限 " + fmtUsd(limit) + (note ? " · " + note : "") }));
  wrap.appendChild(top);
  var bar = el("div", { class: "bar" + (spent + held >= limit ? " full" : "") });
  var fill = el("div");
  fill.style.width = Math.min(100, ((spent + held) / limit) * 100) + "%";
  bar.appendChild(fill);
  wrap.appendChild(bar);
  return wrap;
}
function renderBudget() {
  var host = $("budgetMeters"); host.textContent = "";
  if (!state.budget) return;
  (state.budget.accounts || []).forEach(function (a) {
    var isDay = String(a.id).indexOf("day") >= 0;
    host.appendChild(meter(a.id + (isDay ? "（全局日 $5.00）" : "（单任务 $0.80）"), a.spent_microusd, a.held_microusd, a.limit_microusd, a.frozen ? "已冻结" : ""));
  });
  var tbl = el("table");
  var head = el("tr", null, [el("th", { text: "purpose" }), el("th", { text: "spent" }), el("th", { text: "held" }), el("th", { text: "charged_bound" }), el("th", { text: "请求数" }), el("th", { text: "cache 读写 tokens" })]);
  tbl.appendChild(head);
  (state.budget.byPurpose || []).forEach(function (p) {
    tbl.appendChild(el("tr", null, [
      el("td", { text: p.purpose }),
      el("td", { text: fmtUsd(p.spentMicrousd) }),
      el("td", { text: p.heldMicrousd > 0 ? fmtUsd(p.heldMicrousd) : "0" }),
      el("td", { text: p.chargedBoundMicrousd > 0 ? fmtUsd(p.chargedBoundMicrousd) : "0" }),
      el("td", { text: String(p.requestCount) }),
      el("td", { text: "未测" }),
    ]));
  });
  $("purposeTable").textContent = "";
  $("purposeTable").appendChild(tbl);
}
$("traceLoad").addEventListener("click", async function () {
  var id = $("traceTaskId").value.trim();
  if (!id) return;
  var r = await api("GET", "/api/tasks/" + encodeURIComponent(id) + "/trace");
  var v = $("traceView");
  v.classList.remove("hidden");
  if (r.status !== 200) { v.textContent = (r.data && r.data.message) || ("HTTP " + r.status); return; }
  var lines = ["task=" + r.data.taskId + " state=" + r.data.taskState + " result=" + r.data.resultClass];
  (r.data.timeline || []).forEach(function (t) { lines.push(fmtTime(t.at) + "  " + t.stage + "  " + t.ref + "  " + JSON.stringify(t.detail)); });
  if (r.data.computedButUnconfirmed) lines.push("⚠ Task SUCCEEDED 但 Effect UNKNOWN：计算已完成，通知/动作尚未确认（" + r.data.unconfirmedEffects.join(",") + "）");
  v.textContent = lines.join("\\n");
});
setInterval(function () {
  if (!session) return;
  if (session.expiresAt <= Date.now()) { session = null; requireSession(); }
}, 15000);
</script>
</body>
</html>`;
}

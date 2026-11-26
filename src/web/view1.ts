export function renderMinimalView1Html(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AegisPi v2 · 视图① 会话与治理状态</title>
  <style>
    :root { --bg:#f5f7f9; --card:#ffffff; --ink:#152536; --muted:#52657a; --line:#d4dce3; --ok:#156d4f; --warn:#a85d00; --err:#b42318; --info:#1d5c8a; }
    * { box-sizing: border-box; }
    body { margin:0; font: 14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--ink); }
    header { background:#152536; color:#fff; padding:12px 20px; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
    header h1 { margin:0; font-size:16px; }
    main { max-width:1160px; margin:16px auto; padding:0 16px 40px; display:grid; gap:14px; }
    .panel { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px 16px; }
    .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; border:1px solid var(--line); }
    .badge.ok { color:var(--ok); border-color:var(--ok); background:#ecfdf3; }
    .badge.warn { color:var(--warn); border-color:var(--warn); background:#fff6e5; }
    .badge.err { color:var(--err); border-color:var(--err); background:#fef3f2; }
    .badge.info { color:var(--info); border-color:var(--info); background:#eef6fc; }
    textarea, input, select { font:inherit; border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
    button { font:inherit; padding:6px 12px; border-radius:6px; border:1px solid #152536; background:#152536; color:#fff; cursor:pointer; }
    button.secondary { background:#fff; color:#152536; }
    button:disabled { opacity:0.45; cursor:not-allowed; }
    pre { margin:6px 0 0; padding:8px; background:#f8fafc; border:1px solid var(--line); border-radius:6px; white-space:pre-wrap; word-break:break-word; font-family:Consolas,monospace; font-size:12px; }
    .item { border-top:1px solid var(--line); padding-top:10px; margin-top:10px; }
    .muted { color:var(--muted); font-size:12px; }
    details summary { cursor:pointer; font-weight:600; }
    .partial-box { background:#fff8e6; border:1px dashed #d99b00; border-radius:6px; padding:8px; margin-top:8px; }
  </style>
</head>
<body>
  <header>
    <h1>AegisPi v2 · 视图① 对话与治理状态</h1>
    <div id="health-bar" class="muted" style="color:#d8e3ee">加载中...</div>
  </header>
  <main>
    <section id="login-panel" class="panel">
      <strong>本机控制台登录</strong>
      <div class="row" style="margin-top:8px">
        <input id="token-input" type="password" placeholder="输入 AEGISPI_CONSOLE_TOKEN" style="min-width:260px" />
        <button id="login-btn" type="button">登录</button>
        <span id="login-status" class="muted"></span>
      </div>
    </section>

    <section id="workspace-panel" class="panel" style="display:none">
      <div class="row" style="justify-content:space-between">
        <div class="row">
          <label for="conv-select"><strong>当前会话</strong></label>
          <select id="conv-select"></select>
          <button id="new-conv-btn" class="secondary" type="button">新建会话</button>
          <button id="refresh-btn" class="secondary" type="button">刷新权威快照</button>
        </div>
        <button id="logout-btn" class="secondary" type="button">注销</button>
      </div>
      <div id="meta-line" class="muted" style="margin-top:8px"></div>
      <div id="sse-status" class="muted" style="margin-top:4px">SSE: 未连接</div>
    </section>

    <section id="chat-panel" class="panel" style="display:none">
      <strong>对话命令（幂等 chatKey 提交）</strong>
      <div class="row" style="margin-top:8px; align-items:flex-start">
        <textarea id="chat-input" rows="2" placeholder="输入任务指令..." style="flex:1; min-width:300px"></textarea>
        <button id="chat-send-btn" type="button">发送指令</button>
      </div>
      <div id="chat-status" class="muted" style="margin-top:6px"></div>
      <div id="chat-commands-list"></div>
    </section>

    <section id="sources-panel" class="panel" style="display:none">
      <strong>来源与权限继承（记忆 / 邮件 / 仓库 / 文件）</strong>
      <div id="sources-list"></div>
    </section>

    <section id="files-panel" class="panel" style="display:none">
      <strong>受管工作区文件导入</strong>
      <div id="files-list"></div>
    </section>

    <section id="workers-panel" class="panel" style="display:none">
      <strong>Router / Worker 步骤与预算归属</strong>
      <div id="workers-list"></div>
    </section>

    <section id="denials-panel" class="panel" style="display:none">
      <strong>预算与出站拒绝记录</strong>
      <div id="denials-list"></div>
    </section>

    <section id="approvals-panel" class="panel" style="display:none">
      <strong>内联草稿、审批与外发效果</strong>
      <div id="approvals-list"></div>
    </section>

    <section id="budget-panel" class="panel" style="display:none">
      <strong>预算账户与预留流水（整数 microUSD）</strong>
      <div id="budget-list"></div>
    </section>

    <section id="messages-panel" class="panel" style="display:none">
      <strong>会话轨迹（不可信文本按纯文本渲染）</strong>
      <div id="live-partial-box" class="partial-box" style="display:none"></div>
      <div id="messages-list"></div>
    </section>
  </main>

  <script>
    const state = {
      conversationId: null,
      runtimeEpoch: null,
      activeRuntimeEpoch: null,
      snapshot: null,
      streamInstanceId: null,
      lastSeq: 0,
      resyncCount: 0,
      duplicateIgnoredCount: 0,
      eventSource: null,
      selectionGeneration: 0,
      dirtyByProposal: {},
      pendingChat: { key: null, content: null, convId: null },
      sseFramesReceived: 0,
      livePartialText: null
    };
    window.__aegisView1State = state;

    const AUTH_PANELS = [
      'workspace-panel',
      'chat-panel',
      'sources-panel',
      'files-panel',
      'workers-panel',
      'denials-panel',
      'approvals-panel',
      'budget-panel',
      'messages-panel'
    ];

    function clearEl(el) {
      while (el.firstChild) el.removeChild(el.firstChild);
    }

    function textEl(tag, text, cls) {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      el.textContent = String(text ?? '');
      return el;
    }

    function badgeClass(statusLabel) {
      if (statusLabel === '远端已确认' || statusLabel === '已受理' || statusLabel === 'INSTALLED' || statusLabel === 'done') return 'badge ok';
      if (statusLabel === '结果待核对' || statusLabel === '受理待核对' || statusLabel === '未提交，待核对' || statusLabel === '待审批' || statusLabel === 'CONFLICT_SAVED') return 'badge warn';
      if (statusLabel === '已拒绝' || statusLabel === '已过期' || statusLabel === '发送失败' || statusLabel === 'REJECTED' || statusLabel === 'error') return 'badge err';
      return 'badge info';
    }

    function parseCursor(raw) {
      if (!raw || typeof raw !== 'string') return null;
      const idx = raw.lastIndexOf(':');
      if (idx <= 0) return null;
      const seq = Number(raw.slice(idx + 1));
      if (!Number.isInteger(seq) || seq < 0) return null;
      return { streamInstanceId: raw.slice(0, idx), seq };
    }

    function updateSseStatus(label) {
      const el = document.getElementById('sse-status');
      el.textContent = 'SSE: ' + label +
        ' | stream=' + (state.streamInstanceId || '-') +
        ' | seq=' + state.lastSeq +
        ' | resyncs=' + state.resyncCount +
        ' | dupIgnored=' + state.duplicateIgnoredCount;
    }

    function closeSse() {
      if (state.eventSource) {
        try { state.eventSource.close(); } catch {}
        state.eventSource = null;
      }
      updateSseStatus('已断开');
    }

    function clearAllSessionViews() {
      ['chat-commands-list','sources-list','files-list','workers-list','denials-list','approvals-list','budget-list','messages-list'].forEach(id => {
        clearEl(document.getElementById(id));
      });
      const pb = document.getElementById('live-partial-box');
      pb.style.display = 'none';
      pb.textContent = '';
      state.livePartialText = null;
    }

    async function api(path, opts) {
      const res = await fetch(path, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...(opts && opts.headers ? opts.headers : {}) },
        ...(opts || {})
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, ok: res.ok, body };
    }

    async function loadHealth() {
      const r = await api('/api/health', { method: 'GET' });
      const bar = document.getElementById('health-bar');
      if (r.ok) {
        state.activeRuntimeEpoch = r.body.runtimeEpoch;
        bar.textContent = 'health=' + r.body.health + ' | epoch=' + r.body.runtimeEpoch;
      } else {
        bar.textContent = 'health error (' + r.status + ')';
      }
    }

    async function loadConversations() {
      const r = await api('/api/conversations', { method: 'GET' });
      if (r.status === 401) {
        closeSse();
        clearAllSessionViews();
        document.getElementById('login-panel').style.display = 'block';
        AUTH_PANELS.forEach(id => { document.getElementById(id).style.display = 'none'; });
        return;
      }
      document.getElementById('login-panel').style.display = 'none';
      AUTH_PANELS.forEach(id => { document.getElementById(id).style.display = 'block'; });
      state.activeRuntimeEpoch = r.body.activeRuntimeEpoch || state.activeRuntimeEpoch;
      const sel = document.getElementById('conv-select');
      clearEl(sel);
      const list = r.body.conversations || [];
      const qp = new URLSearchParams(location.search).get('conversationId');
      if (!state.conversationId) {
        state.conversationId = qp || (list[0] ? String(list[0].conversationId) : null);
      }
      for (const c of list) {
        const opt = document.createElement('option');
        opt.value = String(c.conversationId) + '|' + String(c.runtimeEpoch);
        opt.textContent = '会话 #' + c.conversationId + ' (' + c.scopeId + (c.isActiveEpoch ? '' : ' · 历史代际') + ')';
        if (String(c.conversationId) === String(state.conversationId) && (!state.runtimeEpoch || c.runtimeEpoch === state.runtimeEpoch)) {
          opt.selected = true;
          state.runtimeEpoch = c.runtimeEpoch;
        }
        sel.appendChild(opt);
      }
      if (state.conversationId) {
        await selectAndSubscribe(state.conversationId, state.runtimeEpoch);
      }
    }

    async function selectAndSubscribe(convId, epoch) {
      const gen = ++state.selectionGeneration;
      closeSse();
      clearAllSessionViews();
      state.conversationId = String(convId);
      state.runtimeEpoch = epoch || state.activeRuntimeEpoch;
      state.streamInstanceId = null;
      state.lastSeq = 0;

      const q = state.runtimeEpoch ? ('?epoch=' + encodeURIComponent(state.runtimeEpoch)) : '';
      const r = await api('/api/conversations/' + encodeURIComponent(convId) + '/snapshot' + q, { method: 'GET' });
      // Drop late response if user switched conversations or logged out!
      if (gen !== state.selectionGeneration) return;
      if (r.status === 401) {
        await loadConversations();
        return;
      }
      if (!r.ok) return;
      applyAuthoritativeSnapshot(r.body, gen);
      openSse(convId, r.body.runtimeEpoch, r.body.cursor, gen);
    }

    function applyAuthoritativeSnapshot(snap, gen) {
      if (gen !== state.selectionGeneration) return;
      if (String(snap.conversationId) !== String(state.conversationId)) return;
      state.snapshot = snap;
      state.runtimeEpoch = snap.runtimeEpoch;
      state.streamInstanceId = snap.streamInstanceId || state.streamInstanceId;
      if (typeof snap.seq === 'number') {
        state.lastSeq = snap.seq;
      }
      // Authoritative snapshot ALWAYS replaces stale partial!
      const pb = document.getElementById('live-partial-box');
      if (snap.livePartial && snap.livePartial.text) {
        state.livePartialText = snap.livePartial.text;
        pb.style.display = 'block';
        pb.textContent = '流式生成中: ' + snap.livePartial.text;
      } else {
        state.livePartialText = null;
        pb.style.display = 'none';
        pb.textContent = '';
      }
      renderSnapshot(snap);
      updateSseStatus('已同步');
    }

    function openSse(convId, epoch, cursor, gen) {
      closeSse();
      if (gen !== state.selectionGeneration) return;
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      if (epoch) params.set('epoch', epoch);
      const url = '/api/conversations/' + encodeURIComponent(convId) + '/events?' + params.toString();
      const es = new EventSource(url, { withCredentials: true });
      state.eventSource = es;
      updateSseStatus('已订阅');

      const handleDataFrame = (ev) => {
        if (gen !== state.selectionGeneration) { es.close(); return; }
        state.sseFramesReceived++;
        const parsedId = parseCursor(ev.lastEventId);
        if (parsedId) {
          if (state.streamInstanceId && parsedId.streamInstanceId !== state.streamInstanceId) {
            state.resyncCount++;
            void selectAndSubscribe(convId, epoch);
            return;
          }
          if (parsedId.seq <= state.lastSeq) {
            state.duplicateIgnoredCount++;
            updateSseStatus('已忽略重复帧');
            return;
          }
          if (state.lastSeq > 0 && parsedId.seq > state.lastSeq + 1) {
            state.resyncCount++;
            updateSseStatus('检测到断号，重取快照');
            void selectAndSubscribe(convId, epoch);
            return;
          }
          state.lastSeq = parsedId.seq;
        }
        try {
          const parsed = JSON.parse(ev.data);
          const snap = parsed.snapshot ? parsed.snapshot : parsed;
          if (snap && snap.conversationId) {
            applyAuthoritativeSnapshot(snap, gen);
          }
        } catch {}
      };

      es.addEventListener('snapshot', handleDataFrame);
      es.addEventListener('delta', handleDataFrame);
      es.addEventListener('partial', (ev) => {
        if (gen !== state.selectionGeneration) { es.close(); return; }
        state.sseFramesReceived++;
        try {
          const parsed = JSON.parse(ev.data);
          const txt = parsed.text || (parsed.detail && parsed.detail.text) || '';
          const pb = document.getElementById('live-partial-box');
          state.livePartialText = txt;
          pb.style.display = 'block';
          pb.textContent = '流式片段: ' + txt;
        } catch {}
      });
      es.addEventListener('resync', () => {
        if (gen !== state.selectionGeneration) { es.close(); return; }
        state.resyncCount++;
        es.close();
        updateSseStatus('收到 resync，重新鉴权取快照');
        void selectAndSubscribe(convId, epoch);
      });
      es.onerror = () => {
        if (gen !== state.selectionGeneration) return;
        updateSseStatus('连接中断');
      };
    }

    function renderSnapshot(snap) {
      document.getElementById('meta-line').textContent =
        'conversationId=' + snap.conversationId +
        ' | runtimeEpoch=' + snap.runtimeEpoch +
        ' | cursor=' + (snap.cursor || '-') +
        ' | seq=' + (snap.seq || snap.snapshotVersion);

      // Chat commands (V04)
      const cList = document.getElementById('chat-commands-list');
      clearEl(cList);
      for (const cmd of (snap.chatCommands || [])) {
        const row = document.createElement('div');
        row.className = 'item';
        row.setAttribute('data-chat-key', cmd.chatKey);
        row.setAttribute('data-chat-status', cmd.status);
        const top = document.createElement('div');
        top.className = 'row';
        top.appendChild(textEl('span', cmd.uiStatusLabel, badgeClass(cmd.uiStatusLabel)));
        top.appendChild(textEl('span', 'chatKey=' + cmd.chatKey + ' | submissionId=' + (cmd.submissionId ?? '-'), 'muted'));
        row.appendChild(top);
        row.appendChild(textEl('div', cmd.contentPreview));
        cList.appendChild(row);
      }

      // Sources (V01/V02 expandable)
      const sList = document.getElementById('sources-list');
      clearEl(sList);
      if (!snap.sources || snap.sources.length === 0) {
        sList.appendChild(textEl('div', '无已记录来源', 'muted'));
      } else {
        for (const s of snap.sources) {
          const det = document.createElement('details');
          det.className = 'item';
          det.setAttribute('data-source-type', s.sourceType);
          det.setAttribute('data-source-id', s.sourceId);
          const sum = document.createElement('summary');
          sum.textContent = '[' + s.sourceType + '] ' + s.title + ' (' + s.versionRef + ')';
          det.appendChild(sum);
          det.appendChild(textEl('pre', JSON.stringify({
            sourceId: s.sourceId,
            versionRef: s.versionRef,
            contentDigest: s.contentDigest,
            parentSourceIds: s.parentSourceIds,
            metadata: s.metadata
          }, null, 2)));
          sList.appendChild(det);
        }
      }

      // Managed File Imports (V01/V03)
      const fList = document.getElementById('files-list');
      clearEl(fList);
      if (!snap.fileImports || snap.fileImports.length === 0) {
        fList.appendChild(textEl('div', '无受管文件导入记录', 'muted'));
      } else {
        for (const f of snap.fileImports) {
          const row = document.createElement('div');
          row.className = 'item';
          row.setAttribute('data-import-path', f.targetRelPath);
          row.setAttribute('data-import-state', f.state);
          const top = document.createElement('div');
          top.className = 'row';
          top.appendChild(textEl('strong', f.targetRelPath));
          top.appendChild(textEl('span', f.state, badgeClass(f.state)));
          top.appendChild(textEl('span', 'installs=' + f.installCount + ' | sha256=' + String(f.artifactSha256 || '').slice(0, 16), 'muted'));
          row.appendChild(top);
          if (f.conflictRelPath) {
            row.appendChild(textEl('div', '冲突候选文件: ' + f.conflictRelPath, 'muted'));
          }
          if (f.reason) {
            row.appendChild(textEl('div', '说明: ' + f.reason, 'muted'));
          }
          fList.appendChild(row);
        }
      }

      // Workers & Step Attribution (V01)
      const wList = document.getElementById('workers-list');
      clearEl(wList);
      const workers = snap.workerTasks || [];
      const reservations = snap.budgetReservations || [];
      if (workers.length === 0 && reservations.length === 0) {
        wList.appendChild(textEl('div', '无步骤记录', 'muted'));
      } else {
        for (const w of workers) {
          const row = document.createElement('div');
          row.className = 'item';
          row.setAttribute('data-worker-conv', w.workerConversationId);
          row.appendChild(textEl('span', 'worker #' + w.workerConversationId + ' (' + w.slotName + ') · ' + w.status, badgeClass(w.status)));
          row.appendChild(textEl('div', 'ownerTaskId=' + w.ownerTaskId + (w.summary ? ' | ' + w.summary : ''), 'muted'));
          wList.appendChild(row);
        }
        for (const r of reservations) {
          const row = document.createElement('div');
          row.className = 'item';
          row.setAttribute('data-reservation-purpose', r.purpose);
          row.appendChild(textEl('span', r.purpose + ' · ' + r.state, 'badge info'));
          row.appendChild(textEl('span', ' task=' + r.owner_task_id + ' | upper=' + r.upper_mu + 'mu | actual=' + (r.actual_mu ?? '-') + 'mu', 'muted'));
          wList.appendChild(row);
        }
      }

      // Budget denials
      const dList = document.getElementById('denials-list');
      clearEl(dList);
      if (!snap.budgetDenials || snap.budgetDenials.length === 0) {
        dList.appendChild(textEl('div', '无拒绝记录', 'muted'));
      } else {
        for (const d of snap.budgetDenials) {
          const row = document.createElement('div');
          row.className = 'item';
          row.setAttribute('data-denial-code', d.code);
          row.appendChild(textEl('span', d.code + ' · ' + d.purpose, 'badge err'));
          row.appendChild(textEl('div', d.message, ''));
          dList.appendChild(row);
        }
      }

      // Proposals / Approvals / Effects (V06)
      const aList = document.getElementById('approvals-list');
      clearEl(aList);
      if (!snap.proposals || snap.proposals.length === 0) {
        aList.appendChild(textEl('div', '无待审批或外发记录', 'muted'));
      } else {
        for (const p of snap.proposals) {
          const card = document.createElement('div');
          card.className = 'item';
          card.setAttribute('data-proposal-id', p.proposalId);
          card.setAttribute('data-approval-id', p.approvalId);
          card.setAttribute('data-approval-state', p.approvalState);
          card.setAttribute('data-effect-id', p.effect ? p.effect.effectId : '');
          card.setAttribute('data-effect-state', p.effect ? p.effect.state : '');

          const top = document.createElement('div');
          top.className = 'row';
          top.appendChild(textEl('strong', p.toolName + ' -> ' + p.target));
          top.appendChild(textEl('span', p.uiStatusLabel, badgeClass(p.uiStatusLabel)));
          top.appendChild(textEl('span', 'rev=' + p.revision + ' hash=' + p.actionHash.slice(0, 12), 'muted'));
          card.appendChild(top);

          if (p.effect) {
            card.appendChild(textEl('div', 'effectId=' + p.effect.effectId + ' | state=' + p.effect.state + (p.effect.receiptRef ? ' | receipt=' + p.effect.receiptRef : '') + (p.effect.reason ? ' | reason=' + p.effect.reason : ''), 'muted'));
          }

          const isPendingActive = p.approvalState === 'PENDING' && !p.expired;
          const payload = (p.snapshot && p.snapshot.payload) ? p.snapshot.payload : {};
          const bodyBox = document.createElement('textarea');
          bodyBox.rows = 3;
          bodyBox.style.width = '100%';
          bodyBox.style.marginTop = '6px';
          bodyBox.value = String(payload.body || '');
          bodyBox.disabled = !isPendingActive;
          card.appendChild(bodyBox);

          const cardMsg = textEl('div', '', 'muted');
          const actions = document.createElement('div');
          actions.className = 'row';
          actions.style.marginTop = '8px';

          const saveBtn = textEl('button', '保存新版本', 'secondary');
          saveBtn.type = 'button';
          saveBtn.setAttribute('data-action', 'save-draft');
          saveBtn.disabled = !isPendingActive;

          const approveBtn = textEl('button', '批准当前版本', '');
          approveBtn.type = 'button';
          approveBtn.setAttribute('data-action', 'approve');
          approveBtn.disabled = !isPendingActive || Boolean(state.dirtyByProposal[p.proposalId]);

          const rejectBtn = textEl('button', '拒绝', 'secondary');
          rejectBtn.type = 'button';
          rejectBtn.setAttribute('data-action', 'reject');
          rejectBtn.disabled = !isPendingActive;

          bodyBox.addEventListener('input', () => {
            state.dirtyByProposal[p.proposalId] = true;
            approveBtn.disabled = true;
          });

          saveBtn.addEventListener('click', async () => {
            const nextPayload = { ...payload, body: bodyBox.value };
            const res = await api('/api/proposals/' + encodeURIComponent(p.proposalId) + '/draft', {
              method: 'POST',
              body: JSON.stringify({
                conversationId: snap.conversationId,
                expectedHeadRev: p.revision,
                payload: nextPayload
              })
            });
            if (res.ok) {
              state.dirtyByProposal[p.proposalId] = false;
              cardMsg.textContent = '已保存新版本 rev=' + (res.body.revision ? res.body.revision.revision : '');
              await selectAndSubscribe(snap.conversationId, snap.runtimeEpoch);
            } else {
              cardMsg.textContent = '保存失败 (' + res.status + '): ' + (res.body.code || res.body.error || '');
            }
          });

          approveBtn.addEventListener('click', async () => {
            if (state.dirtyByProposal[p.proposalId]) return;
            const ch = await api('/api/approvals/' + encodeURIComponent(p.approvalId) + '/challenge', {
              method: 'POST',
              body: JSON.stringify({ conversationId: snap.conversationId })
            });
            if (!ch.ok || !ch.body || !ch.body.nonce) {
              cardMsg.textContent = '获取挑战失败 (' + ch.status + '): ' + (ch.body.code || '');
              await selectAndSubscribe(snap.conversationId, snap.runtimeEpoch);
              return;
            }
            const dec = await api('/api/approvals/decide', {
              method: 'POST',
              body: JSON.stringify({
                approvalId: p.approvalId,
                conversationId: snap.conversationId,
                decision: 'APPROVE',
                expectedRevision: ch.body.revision,
                expectedActionHash: ch.body.actionHash,
                nonce: ch.body.nonce,
                decisionKey: 'ui-' + p.approvalId + '-r' + p.revision
              })
            });
            cardMsg.textContent = dec.ok ? '已提交批准' : ('决定被拒 (' + dec.status + '): ' + (dec.body.code || ''));
            await selectAndSubscribe(snap.conversationId, snap.runtimeEpoch);
          });

          rejectBtn.addEventListener('click', async () => {
            const ch = await api('/api/approvals/' + encodeURIComponent(p.approvalId) + '/challenge', {
              method: 'POST',
              body: JSON.stringify({ conversationId: snap.conversationId })
            });
            if (!ch.ok || !ch.body || !ch.body.nonce) {
              cardMsg.textContent = '获取挑战失败 (' + ch.status + ')';
              await selectAndSubscribe(snap.conversationId, snap.runtimeEpoch);
              return;
            }
            const dec = await api('/api/approvals/decide', {
              method: 'POST',
              body: JSON.stringify({
                approvalId: p.approvalId,
                conversationId: snap.conversationId,
                decision: 'REJECT',
                expectedRevision: ch.body.revision,
                expectedActionHash: ch.body.actionHash,
                nonce: ch.body.nonce,
                decisionKey: 'ui-rej-' + p.approvalId + '-r' + p.revision
              })
            });
            cardMsg.textContent = dec.ok ? '已提交拒绝' : ('决定被拒 (' + dec.status + '): ' + (dec.body.code || ''));
            await selectAndSubscribe(snap.conversationId, snap.runtimeEpoch);
          });

          actions.appendChild(saveBtn);
          actions.appendChild(approveBtn);
          actions.appendChild(rejectBtn);
          card.appendChild(actions);
          card.appendChild(cardMsg);
          aList.appendChild(card);
        }
      }

      // Budget accounts & reservations
      const bList = document.getElementById('budget-list');
      clearEl(bList);
      bList.appendChild(textEl('pre', JSON.stringify({ accounts: snap.budgetAccounts, reservations: snap.budgetReservations }, null, 2)));

      // Messages (strictly untrusted plain text via textContent!)
      const mList = document.getElementById('messages-list');
      clearEl(mList);
      for (const m of (snap.messages || [])) {
        const div = document.createElement('div');
        div.className = 'item';
        div.setAttribute('data-msg-role', m.role);
        div.appendChild(textEl('strong', m.role));
        div.appendChild(textEl('pre', typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2)));
        mList.appendChild(div);
      }
    }

    document.getElementById('login-btn').addEventListener('click', async () => {
      const token = document.getElementById('token-input').value;
      const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ token }) });
      if (r.ok) {
        document.getElementById('login-status').textContent = '登录成功';
        await loadConversations();
      } else {
        document.getElementById('login-status').textContent = '登录失败 (' + r.status + ')';
      }
    });

    document.getElementById('logout-btn').addEventListener('click', async () => {
      closeSse();
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
      state.conversationId = null;
      state.runtimeEpoch = null;
      clearAllSessionViews();
      await loadConversations();
    });

    document.getElementById('new-conv-btn').addEventListener('click', async () => {
      const r = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ slotName: 'router' }) });
      if (r.ok) {
        state.conversationId = String(r.body.conversationId);
        state.runtimeEpoch = r.body.runtimeEpoch;
        await loadConversations();
      }
    });

    document.getElementById('refresh-btn').addEventListener('click', async () => {
      if (state.conversationId) await selectAndSubscribe(state.conversationId, state.runtimeEpoch);
    });

    document.getElementById('conv-select').addEventListener('change', async (e) => {
      const [cid, ep] = String(e.target.value).split('|');
      state.pendingChat = { key: null, content: null, convId: null };
      await selectAndSubscribe(cid, ep);
    });

    document.getElementById('chat-send-btn').addEventListener('click', async () => {
      const inputEl = document.getElementById('chat-input');
      const statusEl = document.getElementById('chat-status');
      const content = inputEl.value.trim();
      if (!content || !state.conversationId) return;
      // Preserve same chatKey on retry / double-click for identical (convId, content)
      if (
        !state.pendingChat.key ||
        state.pendingChat.content !== content ||
        state.pendingChat.convId !== state.conversationId
      ) {
        state.pendingChat = {
          key: 'ui-chat-' + Date.now() + '-' + Math.random().toString(16).slice(2, 10),
          content,
          convId: state.conversationId
        };
      }
      const chatKey = state.pendingChat.key;
      const r = await api('/api/conversations/' + encodeURIComponent(state.conversationId) + '/chat', {
        method: 'POST',
        body: JSON.stringify({
          content,
          chatKey,
          runtimeEpoch: state.runtimeEpoch || state.activeRuntimeEpoch
        })
      });
      if (r.ok) {
        statusEl.textContent = (r.body.uiStatusLabel || '已受理') + ' | chatKey=' + chatKey + ' | submissionId=' + (r.body.submissionId ?? '-');
        if (r.body.status === 'ADMITTED') {
          inputEl.value = '';
          state.pendingChat = { key: null, content: null, convId: null };
        }
      } else {
        statusEl.textContent = '提交失败 (' + r.status + '): ' + (r.body.code || r.body.error || '');
      }
    });

    loadHealth().then(loadConversations);
  </script>
</body>
</html>`;
}

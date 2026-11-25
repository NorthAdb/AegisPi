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
    header { background:#152536; color:#fff; padding:12px 20px; display:flex; justify-content:space-between; align-items:center; }
    header h1 { margin:0; font-size:16px; }
    main { max-width:1100px; margin:16px auto; padding:0 16px 40px; display:grid; gap:16px; }
    .panel { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px 16px; }
    .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; border:1px solid var(--line); }
    .badge.ok { color:var(--ok); border-color:var(--ok); background:#ecfdf3; }
    .badge.warn { color:var(--warn); border-color:var(--warn); background:#fff6e5; }
    .badge.err { color:var(--err); border-color:var(--err); background:#fef3f2; }
    .badge.info { color:var(--info); border-color:var(--info); background:#eef6fc; }
    textarea, input { font:inherit; border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
    button { font:inherit; padding:6px 12px; border-radius:6px; border:1px solid #152536; background:#152536; color:#fff; cursor:pointer; }
    button.secondary { background:#fff; color:#152536; }
    button:disabled { opacity:0.45; cursor:not-allowed; }
    pre { margin:6px 0 0; padding:8px; background:#f8fafc; border:1px solid var(--line); border-radius:6px; white-space:pre-wrap; word-break:break-word; font-family:Consolas,monospace; font-size:12px; }
    .item { border-top:1px solid var(--line); padding-top:10px; margin-top:10px; }
    .muted { color:var(--muted); font-size:12px; }
  </style>
</head>
<body>
  <header>
    <h1>AegisPi v2 · 视图① 对话与治理状态</h1>
    <div id="health-bar" class="muted">加载中...</div>
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
          <button id="refresh-btn" class="secondary" type="button">刷新权威快照</button>
        </div>
        <button id="logout-btn" class="secondary" type="button">注销</button>
      </div>
      <div id="meta-line" class="muted" style="margin-top:8px"></div>
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
      <div id="messages-list"></div>
    </section>
  </main>

  <script>
    const state = { conversationId: null, snapshot: null, dirtyByProposal: {} };

    function clearEl(el) {
      while (el.firstChild) el.removeChild(el.firstChild);
    }

    function textEl(tag, text, cls) {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      el.textContent = text;
      return el;
    }

    function badgeClass(statusLabel) {
      if (statusLabel === '远端已确认') return 'badge ok';
      if (statusLabel === '结果待核对' || statusLabel === '未提交，待核对' || statusLabel === '待审批') return 'badge warn';
      if (statusLabel === '已拒绝' || statusLabel === '已过期' || statusLabel === '发送失败') return 'badge err';
      return 'badge info';
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
        bar.textContent = 'health=' + r.body.health + ' | epoch=' + r.body.runtimeEpoch;
      } else {
        bar.textContent = 'health error (' + r.status + ')';
      }
    }

    async function loadConversations() {
      const r = await api('/api/conversations', { method: 'GET' });
      if (r.status === 401) {
        document.getElementById('login-panel').style.display = 'block';
        ['workspace-panel','denials-panel','approvals-panel','budget-panel','messages-panel'].forEach(id => {
          document.getElementById(id).style.display = 'none';
        });
        return;
      }
      document.getElementById('login-panel').style.display = 'none';
      ['workspace-panel','denials-panel','approvals-panel','budget-panel','messages-panel'].forEach(id => {
        document.getElementById(id).style.display = 'block';
      });
      const sel = document.getElementById('conv-select');
      clearEl(sel);
      const list = r.body.conversations || [];
      const qp = new URLSearchParams(location.search).get('conversationId');
      if (!state.conversationId) {
        state.conversationId = qp || (list[0] ? String(list[0].conversationId) : null);
      }
      for (const c of list) {
        const opt = document.createElement('option');
        opt.value = String(c.conversationId);
        opt.textContent = '会话 #' + c.conversationId + ' (' + c.scopeId + ')';
        if (String(c.conversationId) === String(state.conversationId)) opt.selected = true;
        sel.appendChild(opt);
      }
      if (state.conversationId) {
        await loadSnapshot(state.conversationId);
      }
    }

    async function loadSnapshot(convId) {
      const r = await api('/api/conversations/' + encodeURIComponent(convId) + '/snapshot', { method: 'GET' });
      if (!r.ok) return;
      state.snapshot = r.body;
      renderSnapshot(r.body);
    }

    function renderSnapshot(snap) {
      document.getElementById('meta-line').textContent =
        'conversationId=' + snap.conversationId + ' | runtimeEpoch=' + snap.runtimeEpoch + ' | snapshotVersion=' + snap.snapshotVersion;

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

      // Proposals / Approvals / Effects
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

          const payload = (p.snapshot && p.snapshot.payload) ? p.snapshot.payload : {};
          const bodyBox = document.createElement('textarea');
          bodyBox.rows = 3;
          bodyBox.style.width = '100%';
          bodyBox.style.marginTop = '6px';
          bodyBox.value = String(payload.body || '');
          bodyBox.disabled = p.approvalState !== 'PENDING';
          card.appendChild(bodyBox);

          const actions = document.createElement('div');
          actions.className = 'row';
          actions.style.marginTop = '8px';

          const saveBtn = textEl('button', '保存新版本', 'secondary');
          saveBtn.type = 'button';
          saveBtn.disabled = p.approvalState !== 'PENDING';

          const approveBtn = textEl('button', '批准当前版本', '');
          approveBtn.type = 'button';
          approveBtn.disabled = p.approvalState !== 'PENDING' || Boolean(state.dirtyByProposal[p.proposalId]);

          const rejectBtn = textEl('button', '拒绝', 'secondary');
          rejectBtn.type = 'button';
          rejectBtn.disabled = p.approvalState !== 'PENDING';

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
              await loadSnapshot(snap.conversationId);
            }
          });

          approveBtn.addEventListener('click', async () => {
            if (state.dirtyByProposal[p.proposalId]) return;
            const ch = await api('/api/approvals/' + encodeURIComponent(p.approvalId) + '/challenge', {
              method: 'POST',
              body: JSON.stringify({ conversationId: snap.conversationId })
            });
            if (!ch.ok || !ch.body || !ch.body.nonce) {
              await loadSnapshot(snap.conversationId);
              return;
            }
            await api('/api/approvals/decide', {
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
            await loadSnapshot(snap.conversationId);
          });

          rejectBtn.addEventListener('click', async () => {
            const ch = await api('/api/approvals/' + encodeURIComponent(p.approvalId) + '/challenge', {
              method: 'POST',
              body: JSON.stringify({ conversationId: snap.conversationId })
            });
            if (!ch.ok || !ch.body || !ch.body.nonce) {
              await loadSnapshot(snap.conversationId);
              return;
            }
            await api('/api/approvals/decide', {
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
            await loadSnapshot(snap.conversationId);
          });

          actions.appendChild(saveBtn);
          actions.appendChild(approveBtn);
          actions.appendChild(rejectBtn);
          card.appendChild(actions);
          aList.appendChild(card);
        }
      }

      // Budget accounts & reservations
      const bList = document.getElementById('budget-list');
      clearEl(bList);
      bList.appendChild(textEl('pre', JSON.stringify({ accounts: snap.budgetAccounts, reservations: snap.budgetReservations }, null, 2)));

      // Messages
      const mList = document.getElementById('messages-list');
      clearEl(mList);
      for (const m of (snap.messages || [])) {
        const div = document.createElement('div');
        div.className = 'item';
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
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
      state.conversationId = null;
      await loadConversations();
    });

    document.getElementById('refresh-btn').addEventListener('click', async () => {
      if (state.conversationId) await loadSnapshot(state.conversationId);
    });

    document.getElementById('conv-select').addEventListener('change', async (e) => {
      state.conversationId = e.target.value;
      await loadSnapshot(state.conversationId);
    });

    loadHealth().then(loadConversations);
  </script>
</body>
</html>`;
}

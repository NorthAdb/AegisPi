import React, { useEffect, useState } from "react";
import {
  api,
  type ConnectorsStatus,
  type McpPinsResponse,
  type RoutineItem,
  type RoutinePreview,
  type SkillBodyDetail,
  type SkillIndexItem,
} from "../client/api";

interface WorkspaceViewProps {
  onToast: (msg: string) => void;
  onJumpToConversation?: (conversationId: string) => void;
}

export const WorkspaceView: React.FC<WorkspaceViewProps> = ({ onToast, onJumpToConversation }) => {
  const [connectors, setConnectors] = useState<ConnectorsStatus | null>(null);
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);
  const [testing, setTesting] = useState(false);

  const [pins, setPins] = useState<McpPinsResponse>({ servers: [], tools: [] });
  const [skillsHash, setSkillsHash] = useState("");
  const [skills, setSkills] = useState<SkillIndexItem[]>([]);
  const [openedSkill, setOpenedSkill] = useState<SkillBodyDetail | null>(null);

  const [routines, setRoutines] = useState<RoutineItem[]>([]);
  const [routineInput, setRoutineInput] = useState("");
  const [routinePreview, setRoutinePreview] = useState<RoutinePreview | null>(null);
  const [rememberRule, setRememberRule] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadAll = async () => {
    const [cRes, pRes, sRes, rRes] = await Promise.all([
      api.getConnectorsStatus(),
      api.getMcpPins(),
      api.listSkills(),
      api.listRoutines(),
    ]);
    if (cRes.data.ok) setConnectors(cRes.data.status);
    if (pRes.data.ok) setPins({ servers: pRes.data.servers, tools: pRes.data.tools });
    if (sRes.data.ok) {
      setSkillsHash(sRes.data.skillSetHash);
      setSkills(sRes.data.skills);
    }
    if (rRes.data.ok) setRoutines(rRes.data.routines);
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const handleTestConnectivity = async (target: "gmail" | "github_mcp" | "all") => {
    setTesting(true);
    try {
      const res = await api.testConnectors(target);
      setTestResult(res.data);
      onToast("连通性测试已完成");
      await loadAll();
    } finally {
      setTesting(false);
    }
  };

  const handlePreviewRoutine = async () => {
    if (!routineInput.trim()) return;
    setBusy(true);
    try {
      const res = await api.previewRoutine(routineInput.trim());
      if (res.data.ok && res.data.preview) {
        setRoutinePreview(res.data.preview);
      } else {
        onToast(`解析失败: ${res.data.error ?? "error"}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmRoutine = async () => {
    if (!routinePreview) return;
    setBusy(true);
    try {
      const res = await api.createRoutine({
        name: routinePreview.name,
        prompt: routinePreview.prompt,
        timezone: routinePreview.timezone,
        scheduleSpec: routinePreview.scheduleSpec,
        skipCondition: routinePreview.skipCondition,
        nextRunUtcMs: routinePreview.nextRunUtcMs,
        confirmed: true,
        rememberRule,
      });
      if (res.data.ok) {
        onToast(`例程已创建 (${res.data.routineId})`);
        setRoutinePreview(null);
        setRoutineInput("");
        setRememberRule(false);
        await loadAll();
      } else {
        onToast(`创建受阻: ${res.data.error ?? res.data.code}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleOpenSkill = async (skillId: string) => {
    const res = await api.getSkillBody(skillId);
    if (res.data.ok) {
      setOpenedSkill(res.data);
    } else {
      onToast(`无法披露技能正文: ${res.data.error ?? "denied"}`);
    }
  };

  return (
    <section
      data-view-panel="workspace"
      className="flex-1 min-h-0 overflow-y-auto custom-scroll p-4 md:p-8"
    >
      <div className="max-w-5xl mx-auto space-y-8">
        <div>
          <h2 className="text-lg font-bold text-slate-900">能力与自动化中心（连接器 · MCP Pin · Skills · 例程）</h2>
          <p className="text-xs text-slate-500 mt-1">
            凭据、模型与代理参数仅在本机文件维护并重启生效。下方展示只读运行状态、连通性探测、Pin 核准/撤权与例程治理。
          </p>
        </div>

        {/* 1. Read-Only Connectors & Connectivity Test */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-800">连接配置只读状态与连通性测试</h3>
            <button
              type="button"
              data-action="test-all-connectors"
              disabled={testing}
              onClick={() => void handleTestConnectivity("all")}
              className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium disabled:opacity-40"
            >
              {testing ? "探测中..." : "测试连通性"}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Gmail Host Adapter */}
            <div data-connector-card="gmail" className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-sm text-slate-900">Gmail 宿主适配器</div>
                <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-700 border border-slate-200">
                  Host Adapter（非 MCP）
                </span>
              </div>
              <div className="text-xs text-slate-600 space-y-1">
                <div>读取范围：{connectors?.gmail.readScope ?? "-"}</div>
                <div>发送策略：{connectors?.gmail.writePolicy ?? "-"}</div>
                <div className="font-mono text-[11px] text-slate-500">
                  IMAP: {connectors?.gmail.imapHost ?? "未配置"} ({connectors?.gmail.imapMode ?? "-"}) · SMTP:{" "}
                  {connectors?.gmail.smtpHost ?? "-"} ({connectors?.gmail.smtpTlsMode ?? "none"})
                </div>
              </div>
              <button
                type="button"
                data-action="test-gmail"
                disabled={testing}
                onClick={() => void handleTestConnectivity("gmail")}
                className="text-xs px-2.5 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
              >
                测试 Gmail 连通性
              </button>
            </div>

            {/* GitHub MCP */}
            <div data-connector-card="github-mcp" className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-sm text-slate-900">GitHub MCP 连接器</div>
                <span
                  className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                    connectors?.githubMcp.connected
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : "bg-slate-100 text-slate-600 border-slate-200"
                  }`}
                >
                  {connectors?.githubMcp.connected ? "已连接 · Pin 生效" : "未连接"}
                </span>
              </div>
              <div className="text-xs text-slate-600 space-y-1">
                <div>
                  运行模式：{connectors?.githubMcp.readOnlyMode ? "纯只读 (readOnlyMode=1)" : "受控读写 (按正向白名单)"}
                  {connectors?.githubMcp.admissionPaused ? " · 准入已暂停" : ""}
                </div>
                <div className="font-mono text-[11px] text-slate-500">
                  Server: {connectors?.githubMcp.serverId ?? "-"} · Binary SHA-256:{" "}
                  {connectors?.githubMcp.binarySha256Prefix ?? "-"}
                </div>
                <div>写白名单条目：{connectors?.githubMcp.writeAllowlistCount ?? 0} 条</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-action="test-github-mcp"
                  disabled={testing}
                  onClick={() => void handleTestConnectivity("github_mcp")}
                  className="text-xs px-2.5 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
                >
                  测试 GitHub MCP
                </button>
                <button
                  type="button"
                  data-action="recheck-mcp-pins"
                  onClick={async () => {
                    const r = await api.recheckMcpPins();
                    onToast(r.data.ok ? "已完成 MCP Pin 重检" : `重检失败: ${r.data.error}`);
                    await loadAll();
                  }}
                  className="text-xs px-2.5 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
                >
                  重检工具指纹 (C4)
                </button>
              </div>
            </div>
          </div>

          {testResult && (
            <pre
              data-connectivity-result
              className="text-xs font-mono bg-slate-900 text-emerald-300 rounded-xl p-3 overflow-x-auto"
            >
              {JSON.stringify(testResult, null, 2)}
            </pre>
          )}
        </div>

        {/* 2. MCP Tool Pins Table */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-800">MCP 工具指纹 Pin 准入表 (C4)</h3>
          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
            {pins.tools.length === 0 ? (
              <div className="p-4 text-xs text-slate-400">暂无已登记 MCP 工具指纹</div>
            ) : (
              pins.tools.map((t) => (
                <div
                  key={`${t.serverId}:${t.toolName}`}
                  data-mcp-pin={`${t.serverId}:${t.toolName}`}
                  data-pin-state={t.state}
                  className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-semibold text-slate-900">
                        {t.serverId} / {t.toolName}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                          t.state === "APPROVED"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : t.state === "QUARANTINED"
                              ? "bg-amber-50 text-amber-800 border-amber-300"
                              : "bg-rose-50 text-rose-700 border-rose-200"
                        }`}
                      >
                        {t.state}
                      </span>
                      {t.drifted && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-900 border border-amber-300">
                          定义已漂移 · 需审阅新指纹
                        </span>
                      )}
                    </div>
                    <div className="text-slate-500">{t.description || "(无描述)"}</div>
                    <div className="font-mono text-[10px] text-slate-500 break-all">
                      observed_sha256: {t.observedSchemaSha256}
                      {t.drifted ? ` (pinned: ${t.pinnedSchemaSha256.slice(0, 16)})` : ""}
                      {t.reason ? ` · ${t.reason}` : ""}
                    </div>
                    <details className="pt-1">
                      <summary className="cursor-pointer text-[11px] font-medium text-blue-700 hover:underline">
                        审阅完整规范化工具定义 (canonical_def_json)
                      </summary>
                      <pre
                        data-mcp-pin-canonical-def={`${t.serverId}:${t.toolName}`}
                        className="mt-1.5 p-2 rounded-lg bg-slate-50 border border-slate-200 font-mono text-[10px] text-slate-700 overflow-x-auto whitespace-pre-wrap break-all"
                      >
                        {t.canonicalDefJson}
                      </pre>
                    </details>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {t.state !== "APPROVED" && (
                      <button
                        type="button"
                        data-action="approve-mcp-pin"
                        onClick={async () => {
                          const r = await api.approveMcpPin(t.serverId, t.toolName, {
                            expectedSchemaSha256: t.observedSchemaSha256,
                            expectedCanonicalDefJson: t.canonicalDefJson,
                          });
                          onToast(r.data.ok ? `已按审阅指纹核准 ${t.toolName}` : `核准失败: ${r.data.error ?? r.data.code}`);
                          await loadAll();
                        }}
                        className="px-2.5 py-1 rounded-md bg-emerald-700 text-white text-xs"
                      >
                        按审阅指纹核准
                      </button>
                    )}
                    {t.state !== "REVOKED" && (
                      <button
                        type="button"
                        data-action="revoke-mcp-pin"
                        onClick={async () => {
                          const r = await api.revokeMcpPin(t.serverId, t.toolName);
                          onToast(r.data.ok ? `已撤销 ${t.toolName}` : `撤销失败: ${r.data.error}`);
                          await loadAll();
                        }}
                        className="px-2.5 py-1 rounded-md border border-rose-300 bg-rose-50 text-rose-700 text-xs"
                      >
                        撤销执行资格
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 3. Skills 3-Level Progressive Disclosure */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-800">Skills（三级渐进披露）</h3>
            <span className="font-mono text-[11px] text-slate-500">
              skill_set_hash: {skillsHash ? skillsHash.slice(0, 16) : "-"}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {skills.map((s) => (
              <div
                key={s.skillId}
                data-skill-card={s.skillId}
                className="bg-white border border-slate-200 rounded-xl p-4 space-y-2 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-900">
                    {s.name} (v{s.version})
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                      s.state === "ACTIVE"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-rose-50 text-rose-700 border-rose-200"
                    }`}
                  >
                    {s.state}
                  </span>
                </div>
                <div className="text-slate-600">{s.summary}</div>
                <div className="text-[11px] text-slate-400">
                  L1 索引注入 · L3 审阅脚本数: {s.scriptCount} · 可用版本: {s.versions.map((v) => `v${v}`).join(", ")}
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    data-action="inspect-skill"
                    disabled={s.state !== "ACTIVE"}
                    onClick={() => void handleOpenSkill(s.skillId)}
                    className="px-2.5 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 disabled:opacity-40"
                  >
                    按需披露 L2/L3
                  </button>
                  {s.state === "ACTIVE" ? (
                    <button
                      type="button"
                      data-action="revoke-skill"
                      onClick={async () => {
                        await api.revokeSkill(s.skillId);
                        setOpenedSkill(null);
                        onToast(`已立即撤销技能 ${s.skillId}`);
                        await loadAll();
                      }}
                      className="px-2.5 py-1 rounded-md border border-rose-300 bg-rose-50 text-rose-700"
                    >
                      撤销技能
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={async () => {
                        await api.activateSkillVersion(s.skillId, s.version);
                        onToast(`已重新启用 ${s.skillId} v${s.version}`);
                        await loadAll();
                      }}
                      className="px-2.5 py-1 rounded-md bg-slate-900 text-white"
                    >
                      重新启用
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {openedSkill && (
            <div data-skill-disclosure-panel className="bg-white border border-blue-200 rounded-xl p-4 space-y-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-900">
                  L2 按需披露：{openedSkill.name} v{openedSkill.version} (sha: {openedSkill.bodySha256.slice(0, 12)})
                </span>
                <button
                  type="button"
                  onClick={() => setOpenedSkill(null)}
                  className="text-slate-500 hover:text-slate-800"
                >
                  关闭
                </button>
              </div>
              <pre className="whitespace-pre-wrap bg-slate-50 border border-slate-200 rounded-lg p-3 font-sans leading-relaxed">
                {openedSkill.body}
              </pre>
              {openedSkill.scripts.length > 0 && (
                <div className="space-y-1.5">
                  <div className="font-semibold text-slate-700">L3 人工审阅脚本引用（无网沙箱独立授权执行）</div>
                  {openedSkill.scripts.map((sc) => (
                    <div key={sc.scriptId} className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 font-mono text-[11px]">
                      <div className="font-semibold text-slate-800">
                        {sc.name} ({sc.runtime}) · 审阅人: {sc.reviewedBy}
                      </div>
                      <div className="text-slate-500">sha256: {sc.scriptSha256}</div>
                      <div className="font-sans text-slate-600 mt-0.5">{sc.description}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 4. Natural Language Routines */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-800">自然语言例程与 30 秒幂等轮询 (Routines)</h3>
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                data-routine-input
                value={routineInput}
                onChange={(e) => setRoutineInput(e.target.value)}
                placeholder="例如：每周五 17:00 汇总本周邮件与仓库进度生成周报草稿，周末跳过"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-slate-900 focus:outline-none"
              />
              <button
                type="button"
                data-action="preview-routine"
                disabled={busy || !routineInput.trim()}
                onClick={() => void handlePreviewRoutine()}
                className="px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium shrink-0 disabled:opacity-40"
              >
                生成确认预览
              </button>
            </div>

            {routinePreview && (
              <div data-routine-preview className="p-3.5 rounded-xl bg-amber-50 border border-amber-300 space-y-2 text-xs">
                <div className="font-bold text-amber-900">例程预览（Tier 1 确认后启用）</div>
                <div>名称：{routinePreview.name}</div>
                <div>时区：{routinePreview.timezone} · 类型：{routinePreview.scheduleKind}</div>
                <div>下次运行：{routinePreview.nextRunLocalText}</div>
                <div>跳过条件：{routinePreview.skipCondition?.label ?? "无"}</div>
                <div>权限与范围：{routinePreview.scopeSummary}</div>
                <div>
                  规则状态：
                  {routinePreview.matchedRuleId
                    ? `命中已记住规则 (${routinePreview.matchedRuleId})`
                    : "需人工确认（未命中规则或规则已撤销）"}
                </div>
                <label className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    data-checkbox="remember-routine-rule"
                    checked={rememberRule}
                    onChange={(e) => setRememberRule(e.target.checked)}
                  />
                  <span>记住 Tier 1 例程创建规则（30 天有效，可在视图③随时撤销）</span>
                </label>
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    data-action="confirm-routine"
                    disabled={busy}
                    onClick={() => void handleConfirmRoutine()}
                    className="px-3.5 py-1.5 rounded-lg bg-slate-900 text-white font-medium"
                  >
                    确认并启用例程
                  </button>
                  <button
                    type="button"
                    onClick={() => setRoutinePreview(null)}
                    className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2.5">
            {routines.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-4 text-xs text-slate-400">
                暂无已启用例程
              </div>
            ) : (
              routines.map((r) => (
                <div
                  key={r.routineId}
                  data-routine-card={r.routineId}
                  className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900">{r.name}</span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                          r.enabled
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : "bg-slate-100 text-slate-600 border-slate-200"
                        }`}
                      >
                        {r.enabled ? "运行中" : "已暂停"}
                      </span>
                      {r.lastStatus && (
                        <span className="font-mono text-[10px] text-slate-500">最近状态: {r.lastStatus}</span>
                      )}
                    </div>
                    <div className="text-slate-600">
                      下次运行：{r.nextRunLocalText ?? "无（一次性或已暂停）"} · 时区：{r.timezone}
                    </div>
                    {r.lastResultSummary && <div className="text-slate-500">最近结果：{r.lastResultSummary}</div>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {r.lastConversationId && onJumpToConversation && (
                      <button
                        type="button"
                        data-action="open-routine-result"
                        onClick={() => onJumpToConversation(r.lastConversationId!)}
                        className="px-2.5 py-1.5 rounded-lg border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-700"
                      >
                        打开结果会话 #{r.lastConversationId}
                      </button>
                    )}
                    {r.enabled ? (
                      <button
                        type="button"
                        data-action="pause-routine"
                        onClick={async () => {
                          await api.pauseRoutine(r.routineId);
                          onToast("已暂停例程");
                          await loadAll();
                        }}
                        className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
                      >
                        暂停
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-action="resume-routine"
                        onClick={async () => {
                          const res = await api.resumeRoutine(r.routineId, true);
                          onToast(res.data.ok ? "已确认并恢复例程" : `恢复受阻: ${res.data.error}`);
                          await loadAll();
                        }}
                        className="px-3 py-1.5 rounded-lg bg-slate-900 text-white"
                      >
                        确认恢复
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
};

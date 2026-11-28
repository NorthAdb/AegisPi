import React, { useEffect, useState } from "react";
import { api, type ProposalView, type RuleItem } from "../client/api";
import { InlineApprovalCard } from "../components/InlineApprovalCard";

interface ApprovalsViewProps {
  onJumpToConversation: (conversationId: string) => void;
  onGlobalRefresh: () => Promise<void>;
  onToast: (msg: string) => void;
}

export const ApprovalsView: React.FC<ApprovalsViewProps> = ({
  onJumpToConversation,
  onGlobalRefresh,
  onToast,
}) => {
  const [approvals, setApprovals] = useState<ProposalView[]>([]);
  const [rules, setRules] = useState<RuleItem[]>([]);
  const [history, setHistory] = useState(false);
  const pending = approvals.filter((item) => item.approvalState === "PENDING" && !item.expired);
  const displayed = history ? approvals.filter((item) => item.approvalState !== "PENDING" || item.expired) : pending;

  const loadAll = async () => {
    const [aRes, rRes] = await Promise.all([api.listApprovals(), api.listRules()]);
    if (aRes.data.ok) setApprovals(aRes.data.approvals);
    if (rRes.data.ok) setRules(rRes.data.rules);
  };

  useEffect(() => {
    void loadAll();
  }, []);

  return (
    <section
      data-view-panel="approvals"
      className="flex-1 min-h-0 overflow-y-auto custom-scroll p-4 md:p-8"
    >
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h2 className="text-lg font-bold text-slate-900">审批与规则</h2>
        </div>

        <details className="text-xs">
          <summary className="mb-2 cursor-pointer text-slate-700">哪些操作需要审批？</summary>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="bg-white border border-slate-200 rounded-xl p-4 border-t-4 border-t-emerald-600 space-y-1">
            <div className="font-bold text-emerald-700">Tier 0 · 自动放行与正向清单直通</div>
            <div className="text-slate-600 leading-relaxed">
              已授权只读；以及命中宿主正向清单（repo ID、操作、ref、path）的 NorthAdb/* 自有公开仓低风险写，由宿主自动签发并走两次 CAS，免弹审批卡。
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 border-t-4 border-t-blue-600 space-y-1">
            <div className="font-bold text-blue-700">Tier 1 · 首次确认 / 记住规则</div>
            <div className="text-slate-600 leading-relaxed">
              本地受管写、草稿与例程创建启用。支持记住有作用域、有期限且可随时撤销的规则；撤销后页面与聊天均须重新确认。
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 border-t-4 border-t-amber-600 space-y-1">
            <div className="font-bold text-amber-700">Tier 2 · 逐次强校验审批</div>
            <div className="text-slate-600 leading-relaxed">
              Gmail 发信逐次批准；外仓写入与高危写（受保护分支、工作流、发布、强推、删除）排除出 Tier 0，未入写入白名单默认拒绝。
            </div>
          </div>
          </div>
        </details>

        {/* Approvals Queue */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex flex-wrap gap-2">
              <button type="button" aria-pressed={!history} onClick={() => setHistory(false)}
                className={`rounded-md px-2 py-1 text-xs ${!history ? "bg-slate-900 text-white" : "border border-slate-300"}`}>
                待处理 ({pending.length})
              </button>
              <button type="button" aria-pressed={history} onClick={() => setHistory(true)}
                className={`rounded-md px-2 py-1 text-xs ${history ? "bg-slate-900 text-white" : "border border-slate-300"}`}>
                历史 ({approvals.length - pending.length})
              </button>
            </div>
            <button
              type="button"
              onClick={() => void loadAll()}
              className="text-xs px-2.5 py-1 rounded-md border border-slate-300 bg-white text-slate-700"
            >
              刷新队列
            </button>
          </div>
          {displayed.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-4 text-xs text-slate-400">
              {history ? "暂无审批历史" : "没有待处理的审批"}
            </div>
          ) : (
            <div className="space-y-3">
              {displayed.map((p) => (
                <InlineApprovalCard
                  key={`${p.proposalId}:r${p.revision}`}
                  proposal={p}
                  showJumpButton
                  onJumpToConversation={onJumpToConversation}
                  onUpdated={async () => {
                    await loadAll();
                    await onGlobalRefresh();
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Remembered Tier 1 Rules */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-800">已记住的 Tier 1 作用域规则 ({rules.length})</h3>
          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
            {rules.length === 0 ? (
              <div className="p-4 text-xs text-slate-400">暂无有效记住规则</div>
            ) : (
              rules.map((r) => (
                <div
                  key={r.ruleId}
                  data-rule-row={r.ruleId}
                  className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                >
                  <div className="space-y-0.5">
                    <div className="font-semibold text-slate-900">
                      {r.toolName} · {r.targetPattern}
                    </div>
                    <div className="text-slate-600">{r.actionSummary || "Tier 1 自动放行规则"}</div>
                    <div className="font-mono text-[10px] text-slate-400">
                      scope: {r.scopeId} · 到期: {new Date(r.expiresAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    data-action="revoke-rule"
                    onClick={async () => {
                      const res = await api.revokeRule(r.ruleId);
                      onToast(res.data.ok ? "规则已撤销，下次操作须重新确认" : `撤销失败: ${res.data.error}`);
                      await loadAll();
                    }}
                    className="px-3 py-1.5 rounded-lg border border-rose-300 bg-rose-50 text-rose-700 font-medium shrink-0"
                  >
                    撤销规则
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
};

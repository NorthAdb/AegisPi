import React, { useEffect, useState } from "react";
import { api, formatMicroUsd, type BudgetSummary, type MemoryModelContext, type MemoryResponse } from "../client/api";

interface MemoryViewProps {
  onToast: (msg: string) => void;
}

export const MemoryView: React.FC<MemoryViewProps> = ({ onToast }) => {
  const [memory, setMemory] = useState<MemoryResponse | null>(null);
  const [budget, setBudget] = useState<BudgetSummary | null>(null);
  const [query, setQuery] = useState("");
  const [lastForgetReceipt, setLastForgetReceipt] = useState<string | null>(null);
  const [modelContext, setModelContext] = useState<MemoryModelContext | null>(null);
  const [savingDisclosure, setSavingDisclosure] = useState(false);

  const loadModelContext = async () => {
    const { data } = await api.getMemoryModelContext();
    setModelContext(data);
  };

  const loadAll = async (q?: string) => {
    const [mRes, bRes] = await Promise.all([api.getMemory(q), api.getBudgetSummary()]);
    if (mRes.data.ok) setMemory(mRes.data);
    if (bRes.data.ok) setBudget(bRes.data);
  };

  useEffect(() => {
    void loadAll().catch(() => onToast("无法读取记忆与成本，请稍后重试。"));
    void loadModelContext().catch(() => onToast("无法读取记忆送模授权。"));
  }, []);

  const day = budget?.dayAccount;
  const usedMu = day ? day.chargedMu + day.heldMu : 0;
  const pct = day && day.limitMu > 0 ? Math.min(100, Math.round((usedMu / day.limitMu) * 100)) : 0;

  return (
    <section
      data-view-panel="memory"
      className="flex-1 min-h-0 overflow-y-auto custom-scroll p-4 md:p-8"
    >
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h2 className="text-lg font-bold text-slate-900">记忆管理与治理成本账本</h2>
          <p className="text-xs text-slate-500 mt-1">
            遗忘状态由治理库墓碑与 FTS 实际清理回执驱动；成本全部来自整数 microUSD 预算账本（不含假浮点数）。
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left 2 cols: L0 + L1/L2 Memory + Tombstones */}
          <div className="lg:col-span-2 space-y-5">
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-800">
                  L0 冻结快照（域：{memory?.l0Snapshot.domain ?? "default"} · {memory?.l0Snapshot.noteCount ?? 0} 条）
                </span>
                <span className="font-mono text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                  sha: {memory?.l0Snapshot.snapshotDigest.slice(0, 12) ?? "-"}
                </span>
              </div>
              <pre className="text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg p-3 text-slate-700 whitespace-pre-wrap leading-relaxed">
                {memory?.l0Snapshot.renderedText || "(当前域无 L0 冻结快照)"}
              </pre>
              {modelContext?.available && modelContext.notes.length > 0 && (
                <div className="space-y-2 text-xs">
                  <p className="break-words text-slate-600">
                    自动记忆 · {modelContext.modelId} · {modelContext.baseUrl}
                  </p>
                  {modelContext.notes.map((note) => (
                    <div key={note.noteId} className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2">
                      <span>{note.title} · {note.authorized ? "已授权" : "未授权，聊天时跳过"}</span>
                      {note.confirmation && (!note.authorized || note.managedGrant) && (
                        <button type="button" data-memory-disclosure={note.noteId} disabled={savingDisclosure}
                          className="rounded-md border border-slate-300 px-2.5 py-1.5 font-medium disabled:opacity-50"
                          onClick={async () => {
                            const authorize = !note.authorized;
                            if (authorize && !window.confirm(
                              `允许对话将「${note.title}」的当前版本发送给 ${modelContext.provider} / ${modelContext.modelId}（${modelContext.baseUrl}）？`,
                            )) return;
                            setSavingDisclosure(true);
                            try {
                              const { data } = await api.changeMemoryModelDisclosure(note.noteId, authorize, note.confirmation!);
                              await loadModelContext();
                              onToast(data.ok ? (authorize ? "已授权发送此版本。" : "已撤销此版本的送模授权。") : "记忆或模型已变化，请复核后重试。");
                            } catch {
                              onToast("无法更新授权，请检查本机连接后重试。");
                            } finally {
                              setSavingDisclosure(false);
                            }
                          }}>
                          {note.managedGrant ? "撤销送模授权" : "授权发送给模型"}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-800">L1 / L2 记忆笔记（FTS5 检索）</span>
                <div className="flex gap-2">
                  <input
                    type="text"
                    data-memory-search
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void loadAll(query);
                    }}
                    placeholder="按关键词检索记忆..."
                    className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs focus:border-slate-900 focus:outline-none w-full sm:w-52"
                  />
                  <button
                    type="button"
                    data-action="search-memory"
                    onClick={() => void loadAll(query)}
                    className="px-3 py-1 rounded-lg bg-slate-900 text-white text-xs"
                  >
                    检索
                  </button>
                </div>
              </div>

              {lastForgetReceipt && (
                <div
                  data-forget-receipt
                  className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-mono"
                >
                  已写入墓碑并清理 FTS：{lastForgetReceipt}
                </div>
              )}

              <div className="space-y-2.5">
                {(memory?.notes ?? []).length === 0 ? (
                  <div className="text-xs text-slate-400">暂无匹配记忆笔记</div>
                ) : (
                  memory!.notes.map((n) => (
                    <div
                      key={n.noteId}
                      data-memory-note={n.noteId}
                      className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-semibold text-slate-900">
                          [{n.tier}] {n.title}
                        </div>
                        <button
                          type="button"
                          data-action="forget-memory"
                          onClick={async () => {
                            const res = await api.forgetMemory(n.noteId);
                            if (res.data.ok) {
                              setLastForgetReceipt(`${res.data.receipt} (ftsCleaned=${String(res.data.ftsCleaned)})`);
                              onToast("已写入墓碑并清理索引");
                              await loadAll(query);
                              await loadModelContext();
                            } else {
                              onToast(`遗忘失败: ${res.data.error}`);
                            }
                          }}
                          className="px-2.5 py-1 rounded-md border border-rose-300 bg-rose-50 text-rose-700 text-[11px]"
                        >
                          遗忘 (Tombstone)
                        </button>
                      </div>
                      <pre className="whitespace-pre-wrap font-sans text-slate-700 m-0">{n.body}</pre>
                      <div className="font-mono text-[10px] text-slate-400">
                        id: {n.noteId} · domain: {n.domain} · v{n.version} · sha: {n.contentDigest.slice(0, 12)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Tombstone Receipts */}
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
              <div className="text-xs font-bold text-slate-800">遗忘墓碑与清理回执 ({memory?.tombstones.length ?? 0})</div>
              {(memory?.tombstones ?? []).length === 0 ? (
                <div className="text-xs text-slate-400">暂无墓碑记录</div>
              ) : (
                <div className="space-y-1.5">
                  {memory!.tombstones.map((t) => (
                    <div
                      key={t.noteId}
                      data-tombstone-row={t.noteId}
                      className="p-2 rounded-lg bg-slate-50 border border-slate-200 font-mono text-[11px] flex flex-wrap justify-between gap-2"
                    >
                      <span>
                        {t.title} ({t.noteId})
                      </span>
                      <span className={t.ftsCleaned ? "text-emerald-700" : "text-amber-700"}>
                        FTS 清理：{t.ftsCleaned ? "已确认清除" : "待清理"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right Col: Governance Budget Ledger */}
          <div className="space-y-5">
            <div data-budget-ledger className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 text-xs">
              <div className="font-bold text-slate-800">
                当日预算账本 ({budget?.chargeDay ?? "-"} · {budget?.zone ?? "Asia/Hong_Kong"})
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-slate-500">已结算 + 冻结 / 日限额</span>
                  <span className="font-mono font-semibold text-slate-900">
                    {formatMicroUsd(usedMu)} / {formatMicroUsd(day?.limitMu ?? 5_000_000)}
                  </span>
                </div>
                <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-600 rounded-full" style={{ width: `${pct}%` }} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 font-mono">
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                  <div className="font-sans text-[11px] text-slate-500">已结算 (SETTLED)</div>
                  <div data-budget-settled className="font-bold text-slate-900 mt-0.5">
                    {formatMicroUsd(budget?.totals.settledMu ?? 0)}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                  <div className="font-sans text-[11px] text-slate-500">冻结中 (HELD)</div>
                  <div className="font-bold text-amber-700 mt-0.5">
                    {formatMicroUsd(day?.heldMu ?? 0)}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                  <div className="font-sans text-[11px] text-slate-500">保守计费 (BOUND)</div>
                  <div className="font-bold text-rose-700 mt-0.5">
                    {formatMicroUsd(budget?.totals.chargedBoundMu ?? 0)} ({budget?.totals.chargedBoundCount ?? 0})
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                  <div className="font-sans text-[11px] text-slate-500">可用余额</div>
                  <div className="font-bold text-emerald-700 mt-0.5">
                    {formatMicroUsd(day?.availableMu ?? 0)}
                  </div>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-100 space-y-1.5">
                <div className="font-semibold text-slate-700">任务级账户 ({budget?.taskAccounts.length ?? 0})</div>
                {(budget?.taskAccounts ?? []).slice(0, 6).map((a) => (
                  <div key={a.accountId} className="font-mono text-[11px] text-slate-600 flex justify-between gap-2">
                    <span className="truncate">{a.accountId.replace("acct:task:", "")}</span>
                    <span>
                      {formatMicroUsd(a.chargedMu)} / {formatMicroUsd(a.limitMu)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2 text-xs">
              <div className="font-bold text-slate-800">最近预留与结算流水 ({budget?.reservations.length ?? 0})</div>
              <div className="space-y-1.5 max-h-64 overflow-y-auto custom-scroll">
                {(budget?.reservations ?? []).length === 0 ? (
                  <div className="text-slate-400">暂无模型调用预留</div>
                ) : (
                  budget!.reservations.slice(0, 20).map((r) => (
                    <div key={r.requestId} className="p-2 rounded bg-slate-50 border border-slate-100 font-mono text-[11px]">
                      <div className="flex justify-between">
                        <span className="font-semibold">{r.purpose}</span>
                        <span>{r.state}</span>
                      </div>
                      <div className="text-slate-500">
                        upper {formatMicroUsd(r.upperMu)} · actual {r.actualMu !== null ? formatMicroUsd(r.actualMu) : "-"}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

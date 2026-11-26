import React, { useEffect, useRef, useState } from "react";
import {
  api,
  extractPlainMessageText,
  formatMicroUsd,
  type ConversationItem,
  type ConversationSnapshot,
} from "../client/api";
import { InlineApprovalCard, statusBadgeTone } from "../components/InlineApprovalCard";

interface ChatViewProps {
  principalId: string;
  activeRuntimeEpoch: string;
  conversations: ConversationItem[];
  selectedConversationId: string | null;
  onSelectConversation: (convId: string) => void;
  onCreateConversation: () => Promise<void>;
  onGlobalRefresh: () => Promise<void>;
}

export const ChatView: React.FC<ChatViewProps> = ({
  principalId,
  activeRuntimeEpoch,
  conversations,
  selectedConversationId,
  onSelectConversation,
  onCreateConversation,
  onGlobalRefresh,
}) => {
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [sseStatus, setSseStatus] = useState("未连接");
  const [streamCursor, setStreamCursor] = useState<string>("");
  const [chatInput, setChatInput] = useState("");
  const [chatFeedback, setChatFeedback] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Responsive narrow-screen drawers (<1024px)
  const [mobileThreadsOpen, setMobileThreadsOpen] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [desktopInspectorOpen, setDesktopInspectorOpen] = useState(true);

  const selectionGenRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const lastSeqRef = useRef(0);
  const streamInstanceRef = useRef<string | null>(null);
  const partialHistoryRef = useRef<string[]>([]);

  const closeStream = () => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  };

  const loadSnapshotAndStream = async (convId: string, epoch: string) => {
    const myGen = ++selectionGenRef.current;
    closeStream();
    // Immediately clear old cards and stale partials on conversation switch
    setSnapshot(null);
    setChatFeedback(null);
    setSseStatus("加载快照...");
    lastSeqRef.current = 0;
    streamInstanceRef.current = null;
    partialHistoryRef.current = [];

    const snapRes = await api.getSnapshot(convId, epoch);
    if (selectionGenRef.current !== myGen) return;
    if (snapRes.status !== 200 || !snapRes.data?.conversationId) {
      setSseStatus(`快照不可用 (${snapRes.status})`);
      return;
    }

    const snap = snapRes.data;
    setSnapshot(snap);
    streamInstanceRef.current = snap.streamInstanceId ?? null;
    lastSeqRef.current = snap.seq ?? 0;
    setStreamCursor(snap.cursor ?? "");

    const openSse = (cursorParam: string) => {
      if (selectionGenRef.current !== myGen) return;
      closeStream();
      const qs = new URLSearchParams();
      if (epoch) qs.set("epoch", epoch);
      if (cursorParam) qs.set("cursor", cursorParam);
      const es = new EventSource(`/api/conversations/${encodeURIComponent(convId)}/events?${qs.toString()}`);
      esRef.current = es;
      setSseStatus("SSE 已连接");

      const handleUpdateEvent = (ev: MessageEvent) => {
        if (selectionGenRef.current !== myGen) return;
        try {
          const parsed = JSON.parse(ev.data) as { snapshot?: ConversationSnapshot };
          const incoming = parsed.snapshot;
          if (!incoming) return;
          const incSeq = incoming.seq ?? 0;
          const incStream = incoming.streamInstanceId ?? null;
          if (streamInstanceRef.current && incStream && incStream !== streamInstanceRef.current) {
            // Stream instance rotated -> resync authoritative snapshot
            void loadSnapshotAndStream(convId, epoch);
            return;
          }
          if (incSeq > 0 && lastSeqRef.current > 0 && incSeq > lastSeqRef.current + 1) {
            // Sequence gap -> resync authoritative snapshot and replace stale partial
            void loadSnapshotAndStream(convId, epoch);
            return;
          }
          if (incSeq > 0 && incSeq <= lastSeqRef.current) {
            return;
          }
          lastSeqRef.current = incSeq;
          streamInstanceRef.current = incStream;
          setStreamCursor(incoming.cursor ?? "");
          if (incoming.livePartial?.text) {
            const prev = partialHistoryRef.current[partialHistoryRef.current.length - 1];
            if (prev !== incoming.livePartial.text) {
              partialHistoryRef.current.push(incoming.livePartial.text);
            }
          }
          setSnapshot(incoming);
        } catch {
          // ignore malformed frame
        }
      };

      es.addEventListener("snapshot", handleUpdateEvent);
      es.addEventListener("delta", handleUpdateEvent);
      es.addEventListener("partial", handleUpdateEvent);
      es.addEventListener("resync", () => {
        if (selectionGenRef.current !== myGen) return;
        setSseStatus("SSE 重同步中...");
        void loadSnapshotAndStream(convId, epoch);
      });
      es.onerror = () => {
        if (selectionGenRef.current !== myGen) return;
        setSseStatus("SSE 断线重连中...");
      };
    };

    openSse(snap.cursor ?? "");
  };

  useEffect(() => {
    if (!selectedConversationId) {
      closeStream();
      setSnapshot(null);
      return;
    }
    const conv = conversations.find((c) => c.conversationId === selectedConversationId);
    const epoch = conv?.runtimeEpoch ?? activeRuntimeEpoch;
    void loadSnapshotAndStream(selectedConversationId, epoch);
    return () => {
      closeStream();
    };
  }, [selectedConversationId, activeRuntimeEpoch]);

  const handleSend = async () => {
    const content = chatInput.trim();
    if (!content || !selectedConversationId || sending) return;
    const epoch = snapshot?.runtimeEpoch ?? activeRuntimeEpoch;
    setSending(true);
    setChatFeedback(null);
    const storageKey = `aegispi:v2:chat:${principalId}:${epoch}:${selectedConversationId}`;
    let chatKey = "";
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        const p = JSON.parse(saved) as { key?: string; content?: string };
        if (p.key && p.content === content) chatKey = p.key;
      }
    } catch {
      // ignore
    }
    if (!chatKey) {
      chatKey = `ui2-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      try {
        sessionStorage.setItem(storageKey, JSON.stringify({ key: chatKey, content }));
      } catch {
        // ignore
      }
    }
    try {
      const res = await api.sendChat(selectedConversationId, {
        content,
        chatKey,
        runtimeEpoch: epoch,
      });
      if (res.data.ok) {
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          // ignore
        }
        setChatInput("");
        setChatFeedback(`${res.data.uiStatusLabel ?? "已受理"} (${chatKey})`);
        await onGlobalRefresh();
      } else {
        setChatFeedback(`提交失败 (${res.status}): ${res.data.message ?? res.data.code ?? "error"}`);
      }
    } finally {
      setSending(false);
    }
  };

  const renderThreadListContent = (onPicked?: () => void) => (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-slate-100 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-600">工作区会话</span>
        <button
          type="button"
          data-action="new-conversation"
          onClick={() => {
            void onCreateConversation().then(() => onPicked?.());
          }}
          className="text-xs px-2.5 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-800 transition"
        >
          + 新对话
        </button>
      </div>
      <div data-thread-list className="flex-1 overflow-y-auto custom-scroll p-2 space-y-1">
        {conversations.length === 0 && (
          <div className="p-3 text-xs text-slate-400 text-center">暂无会话，点击上方新建</div>
        )}
        {conversations.map((c) => {
          const active = c.conversationId === selectedConversationId;
          return (
            <button
              key={`${c.runtimeEpoch}:${c.conversationId}`}
              type="button"
              data-conversation-item={c.conversationId}
              onClick={() => {
                onSelectConversation(c.conversationId);
                onPicked?.();
              }}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs transition ${
                active
                  ? "bg-slate-900 text-white font-semibold"
                  : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="truncate">会话 #{c.conversationId}</span>
                {!c.isActiveEpoch && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">旧代际</span>
                )}
              </div>
              <div className={`text-[10px] font-mono mt-0.5 truncate ${active ? "text-slate-300" : "text-slate-400"}`}>
                {c.scopeId}
              </div>
            </button>
          );
        })}
      </div>
      <div className="p-3 border-t border-slate-200 bg-slate-50/90">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold text-slate-600">后台 Worker 队列</span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
            {snapshot?.workerTasks.length ?? 0} 项
          </span>
        </div>
        <div className="space-y-1.5 max-h-36 overflow-y-auto custom-scroll">
          {(snapshot?.workerTasks ?? []).length === 0 ? (
            <div className="text-[11px] text-slate-400">当前无后台 Worker</div>
          ) : (
            snapshot!.workerTasks.map((w) => (
              <div key={w.workerConversationId} className="p-2 rounded-lg bg-white border border-slate-200 text-[11px]">
                <div className="flex items-center justify-between">
                  <span className="font-mono font-semibold text-slate-800">Worker #{w.workerConversationId}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] border ${statusBadgeTone(w.status)}`}>
                    {w.status}
                  </span>
                </div>
                {w.summary && <div className="text-slate-500 mt-1 line-clamp-2">{w.summary}</div>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );

  const renderInspectorContent = () => (
    <div className="flex flex-col h-full">
      <div className="h-12 px-4 border-b border-slate-200 flex items-center justify-between shrink-0">
        <span className="text-xs font-semibold text-slate-800">Pi Durable 检查点与轨迹</span>
        <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-slate-100 text-slate-600">commit(tx)</span>
      </div>
      <div data-inspector-body className="flex-1 overflow-y-auto custom-scroll p-4 space-y-4 text-xs">
        <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
          <div className="flex justify-between">
            <span className="text-slate-500">宿主状态</span>
            <span className="font-mono font-semibold text-emerald-700">{snapshot?.health ?? "-"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">SSE 游标</span>
            <span className="font-mono text-[11px] text-slate-700 truncate max-w-[150px]">{streamCursor || "-"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">连接状态</span>
            <span className="text-slate-800">{sseStatus}</span>
          </div>
          {snapshot?.streamMetrics && (
            <>
              <div className="flex justify-between">
                <span className="text-slate-500">首 Token 延迟</span>
                <span data-metric-first-token className="font-mono font-semibold text-blue-700">
                  {snapshot.streamMetrics.firstTokenMs !== null ? `${snapshot.streamMetrics.firstTokenMs} ms` : "-"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">生成总耗时</span>
                <span className="font-mono text-slate-800">{snapshot.streamMetrics.totalMs} ms</span>
              </div>
            </>
          )}
        </div>

        <div>
          <div className="font-semibold text-slate-700 mb-2">来源与权限继承 ({snapshot?.sources.length ?? 0})</div>
          <div className="space-y-1.5">
            {(snapshot?.sources ?? []).length === 0 ? (
              <div className="text-slate-400">暂无来源记录</div>
            ) : (
              snapshot!.sources.map((s) => (
                <details
                  key={s.recordId}
                  data-source-type={s.sourceType}
                  className="bg-slate-50 border border-slate-200 rounded-lg p-2"
                >
                  <summary className="cursor-pointer font-medium text-slate-800">
                    [{s.sourceType}] {s.title}
                  </summary>
                  <div className="mt-1.5 font-mono text-[10px] text-slate-600 space-y-0.5 break-all">
                    <div>id: {s.sourceId}</div>
                    <div>ref: {s.versionRef}</div>
                    <div>sha: {s.contentDigest.slice(0, 16)}</div>
                  </div>
                </details>
              ))
            )}
          </div>
        </div>

        <div>
          <div className="font-semibold text-slate-700 mb-2">受管文件导入 ({snapshot?.fileImports.length ?? 0})</div>
          <div className="space-y-1.5">
            {(snapshot?.fileImports ?? []).length === 0 ? (
              <div className="text-slate-400">暂无工作区文件导入</div>
            ) : (
              snapshot!.fileImports.map((f) => (
                <div key={f.importId} className="p-2 rounded-lg bg-slate-50 border border-slate-200 space-y-0.5">
                  <div className="flex justify-between gap-2">
                    <span className="font-mono font-semibold text-slate-800 truncate">{f.targetRelPath}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] border ${statusBadgeTone(f.state)}`}>
                      {f.state}
                    </span>
                  </div>
                  <div className="font-mono text-[10px] text-slate-500">sha: {f.artifactSha256.slice(0, 16)}</div>
                </div>
              ))
            )}
          </div>
        </div>

        <div>
          <div className="font-semibold text-slate-700 mb-2">会话预算流水 ({snapshot?.budgetReservations.length ?? 0})</div>
          <div className="space-y-1.5">
            {(snapshot?.budgetReservations ?? []).length === 0 ? (
              <div className="text-slate-400">暂无预留记录</div>
            ) : (
              snapshot!.budgetReservations.map((r) => (
                <div key={r.request_id} className="p-2 rounded-lg bg-slate-50 border border-slate-200 font-mono text-[11px]">
                  <div className="flex justify-between">
                    <span className="font-semibold text-slate-800">{r.purpose}</span>
                    <span className="text-slate-600">{r.state}</span>
                  </div>
                  <div className="text-slate-500">
                    上界 {formatMicroUsd(r.upper_mu)} · 实扣 {r.actual_mu !== null ? formatMicroUsd(r.actual_mu) : "-"}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <section data-view-panel="chat" className="flex-1 min-h-0 flex w-full relative">
      {/* Desktop Left Rail */}
      <aside className="hidden lg:flex w-64 shrink-0 bg-white border-r border-slate-200 flex-col">
        {renderThreadListContent()}
      </aside>

      {/* Narrow-screen Thread Drawer */}
      {mobileThreadsOpen && (
        <div
          data-mobile-drawer="threads"
          className="fixed inset-0 z-40 lg:hidden flex"
          role="dialog"
          aria-label="会话列表抽屉"
        >
          <div className="w-72 max-w-[85vw] bg-white shadow-xl border-r border-slate-200 h-full flex flex-col">
            <div className="p-2 border-b border-slate-200 flex justify-end">
              <button
                type="button"
                data-close-drawer="threads"
                onClick={() => setMobileThreadsOpen(false)}
                className="text-xs px-2.5 py-1 rounded border border-slate-300 text-slate-700"
              >
                关闭会话列表
              </button>
            </div>
            <div className="flex-1 min-h-0">{renderThreadListContent(() => setMobileThreadsOpen(false))}</div>
          </div>
          <button
            type="button"
            aria-label="关闭遮罩"
            className="flex-1 bg-slate-900/40"
            onClick={() => setMobileThreadsOpen(false)}
          />
        </div>
      )}

      {/* Center Stream */}
      <div className="flex-1 min-w-0 flex flex-col bg-slate-50">
        <div className="min-h-12 py-2 bg-white border-b border-slate-200 px-3 md:px-4 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              data-open-drawer="threads"
              onClick={() => setMobileThreadsOpen(true)}
              className="lg:hidden text-xs px-2.5 py-1 rounded-md border border-slate-300 bg-white text-slate-800 font-medium"
            >
              会话列表
            </button>
            <h1 className="text-sm font-semibold text-slate-900 truncate">
              {selectedConversationId ? `会话 #${selectedConversationId}` : "未选择会话"}
            </h1>
            {snapshot?.proposals.some((p) => p.approvalState === "PENDING" && !p.expired) && (
              <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 text-amber-800 border border-amber-200">
                等待审批挂起 (Park)
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              data-action="refresh-snapshot"
              onClick={() => {
                if (selectedConversationId) {
                  void loadSnapshotAndStream(selectedConversationId, snapshot?.runtimeEpoch ?? activeRuntimeEpoch);
                }
              }}
              className="text-xs px-2.5 py-1 rounded-md border border-slate-200 bg-white hover:bg-slate-50 text-slate-700"
            >
              刷新快照
            </button>
            <button
              type="button"
              data-open-drawer="inspector"
              onClick={() => {
                if (window.innerWidth < 1280) {
                  setMobileInspectorOpen(true);
                } else {
                  setDesktopInspectorOpen((v) => !v);
                }
              }}
              className="text-xs px-2.5 py-1 rounded-md border border-slate-200 bg-white hover:bg-slate-50 text-slate-700"
            >
              轨迹检查器
            </button>
          </div>
        </div>

        {/* Stream Body */}
        <div
          data-chat-stream
          className="flex-1 overflow-y-auto custom-scroll p-3 md:p-6 space-y-4 max-w-4xl w-full mx-auto"
        >
          {!selectedConversationId && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 text-center space-y-3">
              <div className="text-sm font-semibold text-slate-800">开始一次零信任可恢复对话</div>
              <p className="text-xs text-slate-500">
                新建会话后，所有模型发送经过宿主预算门，所有外发与写入经过两次 CAS 与唯一提交器。
              </p>
              <button
                type="button"
                onClick={() => void onCreateConversation()}
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-medium"
              >
                + 新建会话
              </button>
            </div>
          )}

          {snapshot?.budgetDenials && snapshot.budgetDenials.length > 0 && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 space-y-1">
              <div className="text-xs font-bold text-rose-800">预算与出站拒绝记录</div>
              {snapshot.budgetDenials.map((d) => (
                <div key={d.seq} className="text-xs text-rose-700 font-mono">
                  [{d.code}] {d.message}
                </div>
              ))}
            </div>
          )}

          {(snapshot?.messages ?? []).map((msg, idx) => (
            <div
              key={idx}
              data-message-role={msg.role}
              className={`rounded-xl p-3.5 text-sm border ${
                msg.role === "user"
                  ? "bg-slate-900 text-white border-slate-900 ml-6 md:ml-16"
                  : msg.role === "toolResult"
                    ? "bg-slate-100 text-slate-700 border-slate-200 font-mono text-xs"
                    : "bg-white text-slate-900 border-slate-200 mr-4 md:mr-12"
              }`}
            >
              <div className="text-[10px] uppercase tracking-wide opacity-60 mb-1">{msg.role}</div>
              <pre className="whitespace-pre-wrap break-words font-sans text-xs md:text-sm leading-relaxed m-0">
                {extractPlainMessageText(msg.content)}
              </pre>
            </div>
          ))}

          {/* Live Progressive Streaming Partial */}
          {snapshot?.livePartial?.text && (
            <div
              data-live-partial
              className="rounded-xl p-3.5 bg-amber-50 border border-dashed border-amber-400 text-slate-900 mr-4 md:mr-12"
            >
              <div className="flex items-center gap-2 text-[11px] font-semibold text-amber-800 mb-1">
                <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                <span>实时流式生成中（重连后以权威快照为准）</span>
              </div>
              <pre data-live-partial-text className="whitespace-pre-wrap break-words font-sans text-xs md:text-sm m-0">
                {snapshot.livePartial.text}
              </pre>
            </div>
          )}

          {/* Active Running Tools */}
          {snapshot?.activeTools && snapshot.activeTools.length > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-1">
              <div className="text-xs font-semibold text-blue-800">进行中的工具步骤</div>
              {snapshot.activeTools.map((t) => (
                <div key={t.callId} className="text-xs font-mono text-blue-700">
                  {t.name} ({t.status})
                </div>
              ))}
            </div>
          )}

          {/* Inline Approval Cards */}
          {(snapshot?.proposals ?? []).map((p) => (
            <InlineApprovalCard
              key={`${p.proposalId}:r${p.revision}`}
              proposal={p}
              onUpdated={async () => {
                if (selectedConversationId) {
                  await loadSnapshotAndStream(selectedConversationId, snapshot?.runtimeEpoch ?? activeRuntimeEpoch);
                }
                await onGlobalRefresh();
              }}
            />
          ))}
        </div>

        {/* Composer */}
        <div className="shrink-0 bg-white border-t border-slate-200 p-3 md:px-6">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-end gap-2">
              <textarea
                data-chat-input
                rows={2}
                disabled={!selectedConversationId || sending}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="输入指令（Enter 发送，Shift+Enter 换行）..."
                className="flex-1 resize-none rounded-xl border border-slate-300 bg-slate-50 focus:bg-white focus:border-slate-900 focus:outline-none px-3 py-2 text-sm text-slate-900"
              />
              <button
                type="button"
                data-action="send-chat"
                disabled={!selectedConversationId || !chatInput.trim() || sending}
                onClick={() => void handleSend()}
                className="h-11 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium shrink-0 disabled:opacity-40"
              >
                发送
              </button>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
              <span>{chatFeedback ?? "所有不可信模型与工具输出均按纯文本渲染，禁用活动 HTML"}</span>
              <span>凭据仅驻留宿主内存，永不进入模型上下文或数据库</span>
            </div>
          </div>
        </div>
      </div>

      {/* Desktop Right Inspector */}
      {desktopInspectorOpen && (
        <aside className="hidden xl:flex w-80 shrink-0 bg-white border-l border-slate-200 flex-col">
          {renderInspectorContent()}
        </aside>
      )}

      {/* Narrow-screen Inspector Drawer */}
      {mobileInspectorOpen && (
        <div
          data-mobile-drawer="inspector"
          className="fixed inset-0 z-40 xl:hidden flex justify-end"
          role="dialog"
          aria-label="轨迹检查器抽屉"
        >
          <button
            type="button"
            aria-label="关闭检查器遮罩"
            className="flex-1 bg-slate-900/40"
            onClick={() => setMobileInspectorOpen(false)}
          />
          <div className="w-80 max-w-[90vw] bg-white shadow-xl border-l border-slate-200 h-full flex flex-col">
            <div className="p-2 border-b border-slate-200 flex justify-end">
              <button
                type="button"
                data-close-drawer="inspector"
                onClick={() => setMobileInspectorOpen(false)}
                className="text-xs px-2.5 py-1 rounded border border-slate-300 text-slate-700"
              >
                关闭检查器
              </button>
            </div>
            <div className="flex-1 min-h-0">{renderInspectorContent()}</div>
          </div>
        </div>
      )}
    </section>
  );
};

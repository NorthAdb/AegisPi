import React, { useEffect, useState } from "react";
import { api, formatMicroUsd, type ConversationItem } from "./client/api";
import { ApprovalsView } from "./views/ApprovalsView";
import { ChatView } from "./views/ChatView";
import { MemoryView } from "./views/MemoryView";
import { WorkspaceView } from "./views/WorkspaceView";

type ViewId = "chat" | "workspace" | "approvals" | "memory";

export const App: React.FC = () => {
  const [principalId, setPrincipalId] = useState<string | null>(null);
  const [activeRuntimeEpoch, setActiveRuntimeEpoch] = useState<string>("");
  const [authChecked, setAuthChecked] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);

  const [activeView, setActiveView] = useState<ViewId>("chat");
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [todayChargedMu, setTodayChargedMu] = useState(0);
  const [todayLimitMu, setTodayLimitMu] = useState(5_000_000);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((cur) => (cur === msg ? null : cur));
    }, 3500);
  };

  const refreshGlobalData = async () => {
    const [cRes, aRes, bRes] = await Promise.all([
      api.listConversations(),
      api.listApprovals(),
      api.getBudgetSummary(),
    ]);
    if (cRes.status === 200 && cRes.data.conversations) {
      setConversations(cRes.data.conversations);
      setActiveRuntimeEpoch(cRes.data.activeRuntimeEpoch);
      setSelectedConversationId((prev) => {
        if (prev && cRes.data.conversations.some((x) => x.conversationId === prev)) return prev;
        return cRes.data.conversations[cRes.data.conversations.length - 1]?.conversationId ?? null;
      });
    }
    if (aRes.status === 200 && aRes.data.ok) {
      setPendingApprovalCount(
        aRes.data.approvals.filter((p) => p.approvalState === "PENDING" && !p.expired).length,
      );
    }
    if (bRes.status === 200 && bRes.data.ok) {
      setTodayChargedMu(bRes.data.dayAccount.chargedMu + bRes.data.dayAccount.heldMu);
      setTodayLimitMu(bRes.data.dayAccount.limitMu);
    }
  };

  useEffect(() => {
    void (async () => {
      const me = await api.me();
      if (me.status === 200 && me.data.ok && me.data.principalId) {
        setPrincipalId(me.data.principalId);
        setActiveRuntimeEpoch(me.data.activeRuntimeEpoch ?? "");
        await refreshGlobalData();
      }
      setAuthChecked(true);
    })();
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    const res = await api.login(tokenInput);
    if (res.status === 200 && res.data.ok && res.data.principalId) {
      setPrincipalId(res.data.principalId);
      setTokenInput("");
      await refreshGlobalData();
    } else {
      setLoginError(`登录失败 (${res.status}): ${res.data.error ?? "invalid_credentials"}`);
    }
  };

  const handleLogout = async () => {
    await api.logout();
    setPrincipalId(null);
    setConversations([]);
    setSelectedConversationId(null);
  };

  const handleCreateConversation = async () => {
    const res = await api.createConversation("router");
    if (res.data.ok && res.data.conversationId) {
      await refreshGlobalData();
      setSelectedConversationId(res.data.conversationId);
      setActiveView("chat");
    }
  };

  if (!authChecked) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50 text-xs text-slate-500">
        正在校验本机治理会话...
      </div>
    );
  }

  if (!principalId) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50 p-4">
        <form
          onSubmit={(e) => void handleLogin(e)}
          className="w-full max-w-sm bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4"
        >
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-slate-900 text-white flex items-center justify-center font-bold text-sm">
              Aπ
            </div>
            <div>
              <div className="font-bold text-sm text-slate-900">AegisPi Web v2</div>
              <div className="text-[11px] text-slate-500">零信任可恢复单机控制台</div>
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="stage2-token-input" className="block text-xs font-medium text-slate-700">
              控制台口令 (AEGISPI_CONSOLE_TOKEN)
            </label>
            <input
              id="stage2-token-input"
              data-login-token
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="输入本机控制台口令"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
            />
          </div>
          {loginError && <div className="text-xs text-rose-600">{loginError}</div>}
          <button
            type="submit"
            data-action="login"
            className="w-full py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium"
          >
            登录控制台
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-slate-50 text-slate-900">
      {/* Top Shell */}
      <header className="shrink-0 min-h-14 py-1.5 bg-white border-b border-slate-200 px-3 md:px-4 flex flex-wrap items-center justify-between gap-2 z-20">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-slate-900 text-white flex items-center justify-center font-bold text-sm shrink-0">
            Aπ
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-slate-900 truncate">AegisPi Web v2</span>
              <span className="hidden sm:inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                SQLite WAL · {principalId}
              </span>
            </div>
          </div>
        </div>

        {/* 4 View Switcher */}
        <nav className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg overflow-x-auto max-w-full" aria-label="四视图切换">
          {(
            [
              { id: "chat", label: "1. 对话与轨迹" },
              { id: "workspace", label: "2. MCP·Skills·例程" },
              { id: "approvals", label: "3. 审批与规则" },
              { id: "memory", label: "4. 记忆与成本" },
            ] as const
          ).map((tab) => {
            const active = activeView === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                data-nav-view={tab.id}
                onClick={() => {
                  setActiveView(tab.id);
                  void refreshGlobalData();
                }}
                className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition whitespace-nowrap flex items-center gap-1.5 ${
                  active ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                <span>{tab.label}</span>
                {tab.id === "approvals" && pendingApprovalCount > 0 && (
                  <span
                    data-nav-approval-badge
                    className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-white"
                  >
                    {pendingApprovalCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Right Quick Status */}
        <div className="flex items-center gap-2 shrink-0 text-xs">
          <div className="hidden md:block font-mono text-slate-600 bg-slate-100 px-2.5 py-1 rounded-full">
            今日 <span className="font-semibold text-slate-900">{formatMicroUsd(todayChargedMu)}</span> /{" "}
            {formatMicroUsd(todayLimitMu)}
          </div>
          <button
            type="button"
            data-action="logout"
            onClick={() => void handleLogout()}
            className="px-2.5 py-1 rounded-md border border-slate-200 bg-white hover:bg-slate-50 text-slate-700"
          >
            注销
          </button>
        </div>
      </header>

      {toast && (
        <div
          data-toast
          className="fixed bottom-4 right-4 z-50 max-w-sm bg-slate-900 text-white text-xs px-4 py-2.5 rounded-lg shadow-lg border border-slate-700"
        >
          {toast}
        </div>
      )}

      {/* Main Viewport */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {activeView === "chat" && (
          <ChatView
            principalId={principalId}
            activeRuntimeEpoch={activeRuntimeEpoch}
            conversations={conversations}
            selectedConversationId={selectedConversationId}
            onSelectConversation={(id) => setSelectedConversationId(id)}
            onCreateConversation={handleCreateConversation}
            onGlobalRefresh={refreshGlobalData}
          />
        )}
        {activeView === "workspace" && (
          <WorkspaceView
            onToast={showToast}
            onJumpToConversation={(convId) => {
              setSelectedConversationId(convId);
              setActiveView("chat");
            }}
          />
        )}
        {activeView === "approvals" && (
          <ApprovalsView
            onJumpToConversation={(convId) => {
              setSelectedConversationId(convId);
              setActiveView("chat");
            }}
            onGlobalRefresh={refreshGlobalData}
            onToast={showToast}
          />
        )}
        {activeView === "memory" && <MemoryView onToast={showToast} />}
      </div>
    </div>
  );
};

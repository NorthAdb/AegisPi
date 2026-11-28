import React, { useCallback, useEffect, useState } from "react";
import { api, formatMicroUsd, type ConversationItem } from "./client/api";
import { ApprovalsView } from "./views/ApprovalsView";
import { ChatView } from "./views/ChatView";
import { MemoryView } from "./views/MemoryView";
import { SettingsPanel } from "./views/SettingsPanel";
import { WorkspaceView } from "./views/WorkspaceView";

type ViewId = "chat" | "workspace" | "approvals" | "memory";
const views = [
  { id: "chat", label: "对话" },
  { id: "workspace", label: "工作台" },
  { id: "approvals", label: "审批" },
  { id: "memory", label: "记忆与成本" },
] as const;

function readNavigation(principalId: string): { view?: ViewId; conversationId?: string } {
  try {
    return JSON.parse(sessionStorage.getItem(`aegispi:v2:navigation:${principalId}`) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export const App: React.FC = () => {
  const [principalId, setPrincipalId] = useState<string | null>(null);
  const [activeRuntimeEpoch, setActiveRuntimeEpoch] = useState<string>("");
  const [authChecked, setAuthChecked] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [canManageSettings, setCanManageSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"models" | "connectors" | null>(null);

  const [activeView, setActiveView] = useState<ViewId>("chat");
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
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

  const refreshGlobalData = useCallback(async (restoreFor?: string) => {
    const [cRes, aRes, bRes] = await Promise.all([
      api.listConversations(),
      api.listApprovals(),
      api.getBudgetSummary(),
    ]);
    if (cRes.status === 200 && cRes.data.conversations) {
      setConversations(cRes.data.conversations);
      setActiveRuntimeEpoch(cRes.data.activeRuntimeEpoch);
      setSelectedConversationId((prev) => {
        const wanted = restoreFor ? readNavigation(restoreFor).conversationId : prev;
        if (wanted && cRes.data.conversations.some((x) => x.conversationId === wanted)) return wanted;
        return cRes.data.conversations.filter((item) => !item.scopeId.startsWith("scope:model-test:")).at(-1)?.conversationId ?? null;
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
  }, []);

  const restoreNavigation = (owner: string) => {
    const { view } = readNavigation(owner);
    setActiveView(views.find((item) => item.id === view)?.id ?? "chat");
  };

  const rememberNavigation = (view: ViewId, conversationId: string | null) => {
    if (!principalId) return;
    try {
      sessionStorage.setItem(`aegispi:v2:navigation:${principalId}`, JSON.stringify({ view, conversationId }));
    } catch {}
  };

  const changeView = (view: ViewId) => {
    setActiveView(view);
    rememberNavigation(view, selectedConversationId);
    void refreshGlobalData().catch(() => showToast("连接未恢复，稍后可重试。"));
  };

  const openConversation = (id: string) => {
    setSelectedConversationId(id);
    setActiveView("chat");
    rememberNavigation("chat", id);
  };

  useEffect(() => {
    void (async () => {
      try {
        const me = await api.me();
        if (me.status !== 200 || !me.data.ok || !me.data.principalId) return;
        setPrincipalId(me.data.principalId);
        setCanManageSettings(Boolean(me.data.canManageSettings));
        setActiveRuntimeEpoch(me.data.activeRuntimeEpoch ?? "");
        restoreNavigation(me.data.principalId);
        await refreshGlobalData(me.data.principalId);
      } catch {
        setLoginError("无法连接本机控制台，请确认服务已启动后重试。");
      } finally {
        setAuthChecked(true);
      }
    })();
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    try {
      const res = await api.login(tokenInput);
      if (res.status !== 200 || !res.data.ok || !res.data.principalId) {
        setLoginError(res.status === 429 ? "尝试过于频繁，请稍后再试。" : "口令错误，请核对本机控制台口令。");
        return;
      }
      setPrincipalId(res.data.principalId);
      setCanManageSettings(Boolean(res.data.canManageSettings));
      setTokenInput("");
      restoreNavigation(res.data.principalId);
      await refreshGlobalData(res.data.principalId);
    } catch {
      setLoginError("无法连接本机控制台，请稍后重试。");
    }
  };

  const handleLogout = async () => {
    try {
      const result = await api.logout();
      if (!result.data.ok) throw new Error("logout");
    } catch {
      showToast("未能注销，请在连接恢复后重试。");
      return;
    }
    setPrincipalId(null);
    setCanManageSettings(false);
    setSettingsSection(null);
    setConversations([]);
    setSelectedConversationId(null);
    setDrafts({});
  };

  const handleCreateConversation = async (draft?: string) => {
    try {
      const res = await api.createConversation("router");
      if (res.data.ok && res.data.conversationId) {
        const id = res.data.conversationId;
        if (draft) setDrafts((current) => ({ ...current, [`${res.data.runtimeEpoch}:${id}`]: draft }));
        openConversation(id);
        await refreshGlobalData();
      } else if (res.status === 409 && canManageSettings) {
        setSettingsSection("models");
      } else {
        showToast(res.status === 409 ? "请联系设备所有者配置模型。" : "无法新建对话，请稍后重试。");
      }
    } catch {
      showToast("无法连接本机，创建结果请在会话列表中确认。");
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
              本机控制台口令
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
            <p className="text-xs text-slate-500">使用启动控制台时设置的口令，或向设备所有者获取。</p>
          </div>
          {loginError && <div role="alert" className="text-xs text-rose-600">{loginError}</div>}
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

  const draftKey = `${conversations.find((item) => item.conversationId === selectedConversationId)?.runtimeEpoch ?? activeRuntimeEpoch}:${selectedConversationId}`;
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
        <nav className="order-last flex w-full items-center gap-1 rounded-lg bg-slate-100 p-1 sm:order-none sm:w-auto" aria-label="四视图切换">
          {views.map((tab) => {
            const active = activeView === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                data-nav-view={tab.id}
                aria-current={active ? "page" : undefined}
                onClick={() => changeView(tab.id)}
                className={`flex min-h-10 flex-1 items-center justify-center gap-1 rounded-md px-1 py-1.5 text-xs font-medium transition whitespace-nowrap sm:min-h-7 sm:flex-none sm:px-2.5 ${
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
          {canManageSettings && (
            <button
              type="button"
              data-action="open-settings"
              onClick={() => setSettingsSection("models")}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-slate-700 hover:border-slate-400 hover:bg-slate-50"
            >
              <span aria-hidden="true" className="text-sm leading-none">⚙</span>
              <span>设置</span>
            </button>
          )}
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
            key={draftKey}
            principalId={principalId}
            activeRuntimeEpoch={activeRuntimeEpoch}
            conversations={conversations}
            selectedConversationId={selectedConversationId}
            draft={drafts[draftKey] ?? ""}
            onDraftChange={(content, expected) => setDrafts((current) => {
              if (expected !== undefined && (current[draftKey] ?? "") !== expected) return current;
              if (content) return { ...current, [draftKey]: content };
              const remaining = { ...current };
              delete remaining[draftKey];
              return remaining;
            })}
            onSelectConversation={openConversation}
            onCreateConversation={handleCreateConversation}
            onOpenMemory={() => changeView("memory")}
            onOpenConnectors={canManageSettings ? () => setSettingsSection("connectors") : undefined}
            onGlobalRefresh={refreshGlobalData}
          />
        )}
        {activeView === "workspace" && (
          <WorkspaceView
            onToast={showToast}
            onJumpToConversation={openConversation}
          />
        )}
        {activeView === "approvals" && (
          <ApprovalsView
            onJumpToConversation={openConversation}
            onGlobalRefresh={refreshGlobalData}
            onToast={showToast}
          />
        )}
        {activeView === "memory" && <MemoryView onToast={showToast} />}
      </div>
      {settingsSection && (
        <SettingsPanel initialSection={settingsSection} onClose={() => setSettingsSection(null)} dayLimitMu={todayLimitMu}
          onOpenConversation={(id) => {
            setSettingsSection(null);
            openConversation(id);
            void refreshGlobalData();
          }}
          onOpenPins={() => { setSettingsSection(null); changeView("workspace"); }}
        />
      )}
    </div>
  );
};

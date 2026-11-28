import { useEffect, useRef, useState } from "react";
import {
  api, extractPlainMessageText, formatMicroUsd, type ConnectorsStatus, type OperatorDisclosure, type OperatorPreferences, type OperatorSettingsResponse,
} from "../client/api";
import { AccountConnectionForm } from "./AccountConnectionForm";

const action = "rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50";
const primary = "rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40";
const field = "w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-cyan-700 focus:outline-none";
const card = "rounded-xl border border-slate-200 bg-white p-4";
const detail = "rounded-lg bg-slate-50 px-3 py-2.5";

type Section = "models" | "connectors";
type Connector = "gmail" | "github_mcp";
type Probe = { ok?: boolean; tlsVerified?: boolean };

function Credential({ configured, synthetic }: { configured?: boolean; synthetic?: boolean }) {
  return (
    <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${configured || synthetic ? "bg-teal-50 text-teal-800" : "bg-slate-100 text-slate-600"}`}>
      {synthetic ? "本地替身" : configured ? "凭据已配置" : "凭据未配置"}
    </span>
  );
}

export function SettingsPanel({ onClose, dayLimitMu, onOpenConversation, onOpenPins, initialSection = "models" }: {
  onClose: () => void;
  dayLimitMu: number;
  onOpenConversation: (id: string) => void;
  onOpenPins: () => void;
  initialSection?: Section;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<Section>(initialSection);
  const [connector, setConnector] = useState<Connector | null>(null);
  const [state, setState] = useState<OperatorSettingsResponse | null>(null);
  const [connections, setConnections] = useState<ConnectorsStatus | null>(null);
  const [limits, setLimits] = useState({ router: "", worker: "" });
  const [models, setModels] = useState({ router: "", worker: "" });
  const [mailbox, setMailbox] = useState("");
  const [githubWrites, setGithubWrites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState("");
  const [notice, setNotice] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [modelTest, setModelTest] = useState<{ message: string; id?: string } | null>(null);
  const modelTestAbort = useRef<AbortController | null>(null);
  const [disclosure, setDisclosure] = useState<OperatorDisclosure | null>(null);
  const [confirmDisclosure, setConfirmDisclosure] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
    return () => modelTestAbort.current?.abort();
  }, []);
  useEffect(() => {
    let alive = true;
    void Promise.all([api.getOperatorSettings(), api.getConnectorsStatus()]).then(([info, status]) => {
      if (!alive) return;
      if (!info.data.settings || !status.data.ok) {
        setIssue("无法加载设置，请关闭后重试。");
        return;
      }
      const { saved } = info.data.settings;
      setState(info.data);
      setConnections(status.data.status);
      setLimits({ router: String(saved.routerMaxTokens), worker: String(saved.workerMaxTokens) });
      setModels({ router: saved.routerModelId, worker: saved.workerModelId });
      setMailbox(saved.gmailMailbox ?? "");
      setGithubWrites(saved.githubWritesEnabled);
    }).catch(() => { if (alive) setIssue("无法连接到本机宿主。"); });
    return () => { alive = false; };
  }, []);

  const settings = state?.settings;
  const credentials = state?.credentials;
  const accounts = state?.connections;
  const pending = settings?.pendingRestart || accounts?.pendingRestart;
  const disclosureKind = connector === "github_mcp" ? "github" : connector;

  useEffect(() => {
    setDisclosure(null);
    setConfirmDisclosure(false);
    if (!disclosureKind) return;
    let alive = true;
    void api.getOperatorDisclosure(disclosureKind).then(({ data }) => {
      if (alive) setDisclosure(data);
    }).catch(() => { if (alive) setDisclosure(null); });
    return () => { alive = false; };
  }, [disclosureKind]);

  async function updateDisclosure() {
    if (!disclosureKind || !disclosure?.confirmation) return;
    setBusy(true);
    setIssue("");
    try {
      const { data } = await api.updateOperatorDisclosure(disclosureKind, !disclosure.granted, disclosure.confirmation);
      if (!data.ok) throw new Error("authorization_failed");
      setDisclosure({ ...disclosure, granted: data.granted });
      setConfirmDisclosure(false);
    } catch {
      setIssue("授权未变更。请重新打开设置，核对当前读取范围与模型地址。");
    } finally {
      setBusy(false);
    }
  }

  async function saveConnection(fields: Record<string, unknown>) {
    setBusy(true);
    setIssue("");
    setNotice("");
    try {
      const { data } = await api.saveOperatorConnection(fields);
      if (!data.ok) {
        setIssue(data.error === "github_binary_unavailable" ? "无法准备或校验官方 GitHub MCP 程序，请检查网络后重试。" :
          "无法保存接入配置。请检查凭据、授权和读取范围。");
        return false;
      }
      setState(data);
      setNotice("已保存。点击「应用配置」后测试连接。");
      return true;
    } catch {
      setIssue("无法连接到本机宿主。");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setIssue("");
    setNotice("正在重启宿主并连接到控制台…");
    try {
      const { data } = await api.applyOperatorSettings();
      if (!data.ok) throw new Error("apply_failed");
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const response = await api.getOperatorSettings().catch(() => null);
        if (response?.data.ok && !response.data.settings?.pendingRestart && !response.data.connections?.pendingRestart) {
          window.location.reload();
          return;
        }
      }
      setIssue("尚未重新连接。配置已保存，请刷新页面确认状态。");
    } catch {
      setIssue("应用请求未完成，请重试。");
    } finally {
      setNotice("");
      setBusy(false);
    }
  }

  async function verifyRead(target: Connector) {
    setTesting(true);
    setTestResult("");
    try {
      if (target === "gmail") {
        const { data } = await api.testOperatorGmailRead();
        setTestResult(data.ok && data.seenUnchanged ? "只读检查通过，已读标记保持原样。" :
          data.code === "mailbox_empty" ? "文件夹为空。放入一封测试邮件后重试。" :
            data.code === "seen_changed" ? "已读标记在检查期间发生变化，请重试。" : "读取失败，请核对账号、应用专用密码和文件夹。");
      } else {
        const { data } = await api.testOperatorGithubRead();
        setTestResult(data.ok ? "已读取授权分支中的指定文件。" : "读取失败，请检查工具核准状态、PAT 权限、分支和文件路径。");
      }
    } catch {
      setTestResult("读取检查未完成，请重试。");
    } finally {
      setTesting(false);
    }
  }

  async function verifyModel() {
    const controller = new AbortController();
    modelTestAbort.current = controller;
    setTesting(true);
    setIssue("");
    setModelTest({ message: "正在用合成内容测试普通对话（Router）…" });
    try {
      const { data } = await api.testOperatorModel();
      if (!data.ok || !data.conversationId) {
        setModelTest({ message: "无法启动模型测试，请检查当前配置。" });
        return;
      }
      const id = data.conversationId;
      for (let attempt = 0; attempt < 40 && !controller.signal.aborted; attempt++) {
        const { data: snapshot } = await api.getSnapshot(id);
        if (controller.signal.aborted) return;
        const denial = snapshot.budgetDenials?.at(-1);
        if (denial) {
          const budget = denial.code.includes("budget");
          setModelTest({ id, message: budget ? "可用预算不足，未发送测试请求。" : "本机拦截了测试请求。请查看测试详情。" });
          return;
        }
        const settled = snapshot.budgetReservations?.filter((item) => item.state === "SETTLED") ?? [];
        const reply = snapshot.messages?.some((message) => message.role === "assistant" && !message.failed && extractPlainMessageText(message.content).trim());
        if (reply && settled.length) {
          const actual = settled.reduce((total, item) => total + (item.actual_mu ?? 0), 0);
          setModelTest({ id, message: `普通对话连接成功 · 本次结算 $${(actual / 1_000_000).toFixed(6)}` });
          return;
        }
        if (snapshot.messages?.some((message) => message.failed) &&
          !snapshot.budgetReservations?.some((item) => item.state === "HELD")) {
          setModelTest({ id, message: "模型未返回有效回复。请核对 API 地址与凭据，或查看测试详情。" });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (!controller.signal.aborted) setModelTest({ id, message: "测试暂未完成，可打开详情查看最终状态。" });
    } catch {
      if (!controller.signal.aborted) setModelTest({ message: "无法连接本机控制台，请稍后重试。" });
    } finally {
      if (!controller.signal.aborted) setTesting(false);
    }
  }

  async function save(patch: Partial<OperatorPreferences>) {
    setBusy(true);
    setIssue("");
    setNotice("");
    try {
      const { data } = await api.updateOperatorSettings(patch);
      if (!data.settings) {
        setIssue(data.error === "invalid_settings" ? "请检查输入值是否在宿主支持的范围内。" : "保存失败，请重试。");
        return;
      }
      setState(data);
      setNotice(data.settings.pendingRestart ? "已保存。宿主重启后生效。" : "已保存，与当前运行配置一致。");
    } catch {
      setIssue("无法连接到本机宿主。");
    } finally {
      setBusy(false);
    }
  }

  async function probe(target: Connector) {
    setTesting(true);
    setTestResult("");
    try {
      const { data } = await api.testConnectors(target);
      if (target === "gmail") {
        const result = data["gmail"] as { imap?: Probe; smtp?: Probe } | undefined;
        const label = (step?: Probe) => step?.ok ? (step.tlsVerified ? "连通，TLS 已验证" : "连通") : "未连通";
        setTestResult(`IMAP ${label(result?.imap)}；SMTP ${label(result?.smtp)}`);
      } else {
        const result = data["githubMcp"] as { ok?: boolean; approvedTools?: string[] } | undefined;
        setTestResult(result?.ok ? `可读取工具清单，已核准 ${result.approvedTools?.length ?? 0} 项。` : "无法读取 GitHub MCP 工具清单。");
      }
    } catch {
      setTestResult("连通性测试未完成，请稍后重试。");
    } finally {
      setTesting(false);
    }
  }

  const routerChanged = Number(limits.router) !== settings?.saved.routerMaxTokens;
  const workerChanged = Number(limits.worker) !== settings?.saved.workerMaxTokens;
  const routerModelChanged = models.router !== settings?.saved.routerModelId;
  const workerModelChanged = models.worker !== settings?.saved.workerModelId;
  const github = connections?.githubMcp;
  const gmail = connections?.gmail;
  const githubLabel = github?.admissionPaused ? "工具准入暂停" :
    github?.connected ? (accounts?.active.github ? "账号已接入" : "设备已连接 MCP") : credentials?.github ? "未连接" : "待配置";
  const gmailLabel = accounts?.active.gmail ? "账号已接入" : gmail?.configured ? "设备已配置" : "待配置";

  return (
    <dialog
      ref={dialog} aria-labelledby="settings-title" data-settings-dialog
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      className="m-auto h-[min(680px,calc(100dvh-24px))] w-[calc(100%-24px)] max-w-[860px] overflow-hidden rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-900/45"
    >
      <div className="flex h-full flex-col">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-slate-950 px-5 py-4 text-white sm:px-6">
          <h2 id="settings-title" className="text-base font-semibold">设置</h2>
          <button type="button" aria-label="关闭设置" onClick={onClose} className="rounded-md px-2 py-1 text-xl leading-none text-slate-300 hover:bg-white/10 hover:text-white">×</button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav aria-label="设置分类" className="flex shrink-0 gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3 sm:w-36 sm:flex-col sm:border-b-0 sm:border-r sm:px-3 sm:py-5">
            {([["models", "模型"], ["connectors", "连接器"]] as const).map(([id, label]) => (
              <button key={id} type="button" data-settings-section={id} aria-pressed={section === id}
                onClick={() => { setSection(id); setTestResult(""); setNotice(""); }}
                className={`rounded-lg px-3 py-2 text-left text-sm font-medium ${section === id ? "bg-cyan-100 text-cyan-950" : "text-slate-600 hover:bg-slate-200"}`}>
                {label}
              </button>
            ))}
          </nav>
          <main className="custom-scroll min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            {pending && <div data-settings-restart className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <span>有修改已保存，应用时宿主会短暂重启。</span>
              <button type="button" data-action="apply-settings" className={primary} disabled={busy || testing} onClick={() => void apply()}>应用配置</button>
            </div>}
            {issue && <p role="alert" className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">{issue}</p>}
            {notice && <p role="status" className="mb-4 rounded-lg bg-teal-50 px-3 py-2 text-xs text-teal-800">{notice}</p>}
            {!settings || !connections ? (!issue && <p role="status" className="text-sm text-slate-500">正在读取本机设置…</p>) : section === "models" ? (
              <div className="space-y-4">
              {accounts?.available && <AccountConnectionForm kind="model" saved={accounts.saved} busy={busy} onSave={saveConnection} />}
              {accounts?.active.model && <button type="button" className={action} disabled={busy || testing} onClick={() => void verifyModel()}>测试模型连接（计入预算）</button>}
              {modelTest && <div role="status" className="space-y-2 rounded-lg bg-slate-50 p-3 text-xs">
                <p>{modelTest.message}</p>
                {modelTest.id && <button type="button" className="font-semibold underline"
                  onClick={() => onOpenConversation(modelTest.id!)}>查看测试详情</button>}
              </div>}
              {settings.modelChoices.length > 0 && <form className="space-y-4" onSubmit={(event) => {
                event.preventDefault();
                void save({
                  ...(routerChanged ? { routerMaxTokens: Number(limits.router) } : {}),
                  ...(workerChanged ? { workerMaxTokens: Number(limits.worker) } : {}),
                  ...(routerModelChanged ? { routerModelId: models.router } : {}),
                  ...(workerModelChanged ? { workerModelId: models.worker } : {}),
                });
              }}>
                <div>
                  <h3 className="text-lg font-semibold">模型</h3>
                  <p className="mt-1 text-xs text-slate-600">为两个角色设置输出上限。新对话使用所选模型，已有对话按原模型继续。</p>
                </div>
                {(["router", "worker"] as const).map((role) => {
                  const model = connections.models.find((slot) => slot.slotName === role);
                  const active = role === "router" ? settings.active.routerMaxTokens : settings.active.workerMaxTokens;
                  return (
                    <section key={role} className={card}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div><h4 className="text-sm font-semibold">{role === "router" ? "Router · 对话" : "Worker · 后台"}</h4>
                          <p className="mt-1 break-all font-mono text-xs text-slate-600">{model?.modelId ?? "未配置"} · {model?.provider ?? "—"}</p></div>
                        <Credential configured={credentials?.[role]} synthetic={model?.provider === "fake-local"} />
                      </div>
                      <dl className="my-3 grid gap-2 text-xs sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                        <div className={detail}><dt className="text-slate-500">API 地址</dt><dd className="mt-1 break-all font-mono">{model?.baseUrl ?? "—"}</dd></div>
                        <div className={detail}><dt className="text-slate-500">价格版本</dt><dd className="mt-1 break-all font-mono">{model?.priceVersion ?? "—"}</dd></div>
                      </dl>
                      {settings.modelChoices.length > 1 && (
                        <label className="mb-3 block text-xs font-medium text-slate-700">
                          模型
                          <select data-setting={`${role}-model`} className={`${field} mt-1.5`} value={models[role]}
                            onChange={(event) => setModels({ ...models, [role]: event.target.value })}>
                            {settings.modelChoices.map((id) => <option key={id} value={id}>{id}</option>)}
                          </select>
                        </label>
                      )}
                      <label className="block text-xs font-medium text-slate-700" htmlFor={`settings-${role}-max`}>输出上限（token）</label>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <input id={`settings-${role}-max`} data-setting={`${role}-max`} className={`${field} max-w-36`} type="number" min={1} max={settings.outputLimits[role]} step={1} required
                          value={limits[role]} onChange={(event) => setLimits({ ...limits, [role]: event.target.value })} />
                        <span className="text-xs text-slate-500">当前 {active.toLocaleString()} · 上限 {settings.outputLimits[role].toLocaleString()}</span>
                      </div>
                    </section>
                  );
                })}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3">
                  <span className="text-xs text-slate-600">每日预算上限 <strong>{formatMicroUsd(dayLimitMu)}</strong></span>
                  <button type="submit" data-action="save-model-settings" disabled={busy || !(routerChanged || workerChanged || routerModelChanged || workerModelChanged)} className={primary}>{busy ? "保存中…" : "保存模型设置"}</button>
                </div>
              </form>}
              </div>
            ) : (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">连接器</h3>
                {!connector ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    {([["gmail", "Gmail", "@", "读取邮件与审批发送", gmailLabel],
                      ["github_mcp", "GitHub", "GH", "读取仓库与受控写入", githubLabel]] as const).map(([id, title, icon, purpose, status]) => (
                      <button key={id} type="button" data-settings-connector={id} onClick={() => { setConnector(id); setTestResult(""); setNotice(""); }}
                        className={`${card} flex items-center gap-3 text-left transition hover:border-cyan-500 hover:bg-cyan-50/40`}>
                        <span aria-hidden="true" className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg text-sm font-bold ${id === "gmail" ? "bg-rose-100 text-rose-800" : "bg-slate-900 text-white"}`}>{icon}</span>
                        <span className="min-w-0 flex-1"><strong className="block text-sm">{title}</strong><span className="mt-0.5 block text-xs text-slate-600">{purpose}</span></span>
                        <span className="text-right text-xs text-teal-800">{status}<span aria-hidden="true" className="ml-1">›</span></span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    <button type="button" data-action="back-to-connectors" onClick={() => { setConnector(null); setTestResult(""); setNotice(""); }} className={action}>← 所有连接器</button>
                    {accounts?.available && <AccountConnectionForm key={connector} kind={connector === "gmail" ? "gmail" : "github"}
                      saved={accounts.saved} busy={busy} onSave={saveConnection} />}
                    <section className={`${card} space-y-4`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="text-base font-semibold">{connector === "gmail" ? "Gmail · 宿主适配器" : "GitHub · MCP"}</h4>
                        <button type="button" data-action="test-settings-connector" disabled={testing} onClick={() => void probe(connector)} className={action}>{testing ? "测试中…" : "测试当前连接"}</button>
                      </div>
                      {connector === "gmail" ? (
                        accounts?.active.gmail ? <p className="break-words text-xs text-slate-600">网页账号 · {accounts.active.gmail.email} · 只读 {accounts.active.gmail.mailbox}</p>
                          : gmail?.configured && <p className="text-xs text-slate-600">使用设备预设连接。可在上方连接自己的 Gmail。</p>
                      ) : (
                        accounts?.active.github ? <p className="break-words text-xs text-slate-600">网页账号 · 只读 {accounts.active.github.repoId} / {accounts.active.github.ref} / {accounts.active.github.filePath}</p>
                          : github?.connected && <p className="text-xs text-slate-600">使用设备预设的 MCP。可在上方接入自己的仓库。</p>
                      )}
                      {connector === "gmail" && accounts?.active.gmail && <button type="button" className={action} disabled={busy || testing} onClick={() => void verifyRead(connector)}>验证 Gmail 只读与已读标记</button>}
                      {connector === "github_mcp" && accounts?.active.github && <div className="flex flex-wrap gap-2">
                        <button type="button" className={action} onClick={onOpenPins}>查看 MCP 工具核准</button>
                        <button type="button" className={action} disabled={busy || testing} onClick={() => void verifyRead(connector)}>验证授权文件读取</button>
                      </div>}
                      {testResult && <p data-settings-probe role="status" className="rounded-lg bg-slate-100 p-3 text-xs text-slate-800">{testResult}</p>}
                      {connector === "gmail" ? (
                        <>
                          <div className="grid gap-2 text-xs sm:grid-cols-2">
                            <div className={detail}><strong>IMAP · 只读</strong><p className="my-2 break-words text-slate-600">{gmail?.imapHost ?? "未配置"}</p><Credential configured={credentials?.gmailImap} /></div>
                            <div className={detail}><strong>SMTP · 逐次审批</strong><p className="my-2 break-words text-slate-600">{gmail?.smtpHost ?? "未配置"} · {gmail?.smtpTlsMode ?? "—"}</p><Credential configured={credentials?.gmailSmtp} /></div>
                          </div>
                          {settings.gmailMailboxes.length > 0 && (
                            <div className="space-y-2">
                              <label htmlFor="settings-gmail-mailbox" className="text-xs font-medium">默认读取邮箱文件夹</label>
                              <select id="settings-gmail-mailbox" data-setting="gmail-mailbox" className={field} value={mailbox} onChange={(event) => setMailbox(event.target.value)}>
                                {settings.gmailMailboxes.map((name) => <option key={name} value={name}>{name}</option>)}
                              </select>
                              <p className="text-xs text-slate-600">当前读取 {settings.active.gmailMailbox ?? "—"}。实际读取仍使用宿主授权。</p>
                              <button type="button" disabled={busy || !mailbox || mailbox === settings.saved.gmailMailbox} onClick={() => void save({ gmailMailbox: mailbox })} className={primary}>保存邮箱设置</button>
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <div className={`${detail} flex flex-wrap items-center justify-between gap-2 text-xs`}><span>{githubLabel} · {github?.serverId ?? "未配置服务"}</span><Credential configured={credentials?.github} /></div>
                          <p className="text-xs text-slate-600">当前写入 {settings.active.githubWritesEnabled ? "按宿主白名单开放" : "关闭"}，允许目标 {github?.writeAllowlistCount ?? 0} 项。</p>
                          {github?.writeAllowlistSummary.map((entry, index) => (
                            <div key={`${entry.repoId}-${index}`} className={`${detail} break-words text-xs`}><strong>{entry.repoId}</strong><p className="mt-1 text-slate-600">{entry.operations.join("、")} · {entry.allowedRefs.join("、")} · {entry.allowedPaths.join("、")}</p></div>
                          ))}
                          {settings.githubWritesAvailable && (
                            <div className="space-y-3">
                              <label className="flex items-center gap-2 text-xs font-medium"><input type="checkbox" data-setting="github-writes" checked={githubWrites} onChange={(event) => setGithubWrites(event.target.checked)} />允许宿主已配置的仓库写入</label>
                              <button type="button" disabled={busy || githubWrites === settings.saved.githubWritesEnabled} onClick={() => void save({ githubWritesEnabled: githubWrites })} className={primary}>保存 GitHub 设置</button>
                            </div>
                          )}
                        </>
                      )}
                      {disclosure?.available ? <div className={`${detail} space-y-2 text-xs`}>
                        <h5 className="font-semibold">将所选范围内的内容发送给模型</h5>
                        <p className="break-all">{disclosure.modelId} · {disclosure.baseUrl}</p>
                        {disclosure.granted ? <p>已授权</p> :
                          <label className="flex items-start gap-2">
                            <input type="checkbox" checked={confirmDisclosure} onChange={(event) => setConfirmDisclosure(event.target.checked)} />
                            我同意将这里授权读取的内容发给上述模型。
                          </label>}
                        <button type="button" className={action} disabled={busy || (!disclosure.granted && !confirmDisclosure)} onClick={() => void updateDisclosure()}>
                          {disclosure.granted ? "撤销送模授权" : "授权送模"}
                        </button>
                      </div> : <p className="text-xs text-slate-600">读取授权只适用于所选范围。把来源内容发送给模型需要独立授权。</p>}
                    </section>
                  </>
                )}
              </div>
            )}
          </main>
        </div>
      </div>
    </dialog>
  );
}

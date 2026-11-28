import { useEffect, useState } from "react";
import { api, type CatalogProvider, type OperatorSettingsResponse } from "../client/api";

type ConnectionKind = "model" | "gmail" | "github";
type Saved = NonNullable<OperatorSettingsResponse["connections"]>["saved"];

const field = "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm";
const label = "block text-xs font-medium text-slate-700";
const title = { model: "模型 API", gmail: "Gmail", github: "GitHub" };

export function AccountConnectionForm({ kind, saved, busy, onSave }: {
  kind: ConnectionKind;
  saved: Saved;
  busy: boolean;
  onSave: (fields: Record<string, unknown>) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [provider, setProvider] = useState(saved.model?.provider ?? "deepseek");
  const [model, setModel] = useState(saved.model?.modelId ?? "deepseek-flash");
  const [url, setUrl] = useState(saved.model?.baseUrl ?? "https://api.deepseek.com");
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  useEffect(() => {
    if (kind !== "model" || !editing) return;
    let alive = true;
    void api.getOperatorModelCatalog().then(({ status, data }) => {
      if (alive && status === 200 && data.providers?.length) setProviders(data.providers);
      else if (alive) setCatalogFailed(true);
    }).catch(() => { if (alive) setCatalogFailed(true); });
    return () => { alive = false; };
  }, [kind, editing]);

  const entry = saved[kind];
  const choices = providers.find((item) => item.id === provider)?.models ?? [];
  const selected = choices.find((item) => item.id === model);
  const endpointVerified = selected?.verifiedEndpoints.includes(url.trim().replace(/\/+$/, "")) ?? false;
  const providerChoices = showCatalog ? providers : providers.filter((item) => item.models.some((m) => m.verifiedEndpoints.length));
  const modelChoices = showCatalog ? choices : choices.filter((item) => item.verifiedEndpoints.length);
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold">{title[kind]}</h4>
          {entry && <p className="mt-1 break-all text-xs text-slate-600">
            {kind === "model" ? `${saved.model?.provider} / ${saved.model?.modelId}` :
              kind === "gmail" ? `${saved.gmail?.email} · ${saved.gmail?.mailbox}` :
                `${saved.github?.repoId} · ${saved.github?.ref} · ${saved.github?.filePath}`}
          </p>}
        </div>
        <button type="button" data-edit-connection={kind} disabled={busy}
          onClick={() => { setEditing(!editing); setCatalogFailed(false); }}
          className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium">
          {editing ? "取消" : entry ? "替换凭据与配置" : kind === "model" ? "配置模型" : "连接账号"}
        </button>
      </div>
      {editing && <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const values = Object.fromEntries(new FormData(form));
        const secret = form.elements.namedItem("secret") as HTMLInputElement;
        secret.value = "";
        void onSave({ ...values, kind, authorize: values.authorize === "on" }).then((ok) => {
          if (ok) setEditing(false);
        });
      }}>
        {kind === "model" && <>
          {catalogFailed && <p role="alert" className="text-xs text-rose-800">无法读取模型目录。</p>}
          {providers.length > 0 && <label className="flex items-center gap-2 text-xs text-slate-700">
            <input type="checkbox" checked={showCatalog} onChange={(event) => {
              setShowCatalog(event.target.checked);
              if (!event.target.checked && !selected?.verifiedEndpoints.length) {
                const available = providers.find((item) => item.models.some((m) => m.verifiedEndpoints.length));
                const verified = available?.models.find((m) => m.verifiedEndpoints.length);
                setProvider(available?.id ?? "");
                setModel(verified?.id ?? "");
                setUrl(verified?.verifiedEndpoints[0] ?? "");
              }
            }} /> 查看 SDK 目录（含暂不可启用的模型）
          </label>}
          <label className={label}>供应商
            <select name="provider" className={field} value={provider} disabled={!providers.length} onChange={(event) => {
              const id = event.target.value;
              const models = providers.find((item) => item.id === id)?.models ?? [];
              const first = models.find((item) => item.verifiedEndpoints.length > 0) ?? models[0];
              setProvider(id);
              setModel(first?.id ?? "");
              setUrl(first?.verifiedEndpoints[0] ?? "");
            }}>
              {providerChoices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className={label}>Router 和 Worker 共用模型
            <select name="modelId" className={field} value={model} disabled={!choices.length} onChange={(event) => {
              setModel(event.target.value);
              setUrl(choices.find((item) => item.id === event.target.value)?.verifiedEndpoints[0] ?? "");
            }}>
              {modelChoices.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.verifiedEndpoints.length ? "已核验" : "仅 SDK 目录"}</option>)}
            </select>
          </label>
          <label className={label}>API 地址
            <input name="baseUrl" type="url" className={field} value={url} maxLength={256} required onChange={(event) => setUrl(event.target.value)} />
          </label>
          {selected && <p className="text-xs text-slate-600">
            {selected.api} · {selected.verifiedEndpoints.length ? `已核验地址 ${selected.verifiedEndpoints.join("、")}` : "此模型尚未核验计费上界。"}
          </p>}
        </>}
        {kind === "gmail" && <>
          <label className={label}>Google 账号邮箱<input type="email" name="email" className={field} defaultValue={saved.gmail?.email} required maxLength={254} /></label>
          <label className={label}>准许读取的 IMAP 文件夹<input name="mailbox" className={field} defaultValue={saved.gmail?.mailbox ?? "INBOX"} required maxLength={128} /></label>
          <p className="text-xs text-slate-600">使用 Google 应用专用密码。读取使用只读 IMAP，配置应用后可验证已读标记。</p>
        </>}
        {kind === "github" && <>
          <label className={label}>指定仓库<input name="repoId" className={field} defaultValue={saved.github?.repoId} placeholder="owner/repository" required maxLength={140} /></label>
          <label className={label}>分支<input name="branch" className={field} defaultValue={saved.github?.ref.replace(/^refs\/heads\//, "") ?? "main"} required maxLength={180} /></label>
          <label className={label}>准许读取的文件路径<input name="filePath" className={field} defaultValue={saved.github?.filePath} placeholder="README.md" required maxLength={400} /></label>
          <p className="text-xs text-slate-600">使用仅限此仓库、Contents 只读的细粒度 PAT。首次保存会准备官方本地 MCP，应用后审核工具定义。</p>
        </>}
        <label className={label}>{kind === "model" ? "API Key" : kind === "gmail" ? "应用专用密码" : "细粒度 PAT"}
          <input type="password" name="secret" className={field} autoComplete="new-password" spellCheck={false} maxLength={2048} required disabled={kind === "model" && !endpointVerified} />
        </label>
        <label className="flex items-start gap-2 text-xs text-slate-700">
          <input type="checkbox" name="authorize" required />
          {kind === "model" ? "授权向上述 API 地址发送对话请求，费用受宿主预算限制。" :
            kind === "gmail" ? "授权读取这个 Gmail 账号中指定的文件夹。" : "授权读取指定仓库、分支和文件。"}
        </label>
        <button type="submit" disabled={busy || (kind === "model" && !endpointVerified)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">
          {busy ? "保存中…" : "保存接入配置"}
        </button>
      </form>}
    </section>
  );
}

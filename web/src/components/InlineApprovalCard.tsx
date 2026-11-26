import React, { useState } from "react";
import { api, type ProposalView } from "../client/api";

export function statusBadgeTone(label: string): string {
  if (label === "远端已确认" || label === "已受理" || label === "INSTALLED" || label === "done") {
    return "bg-emerald-50 text-emerald-700 border-emerald-200";
  }
  if (
    label === "结果待核对" ||
    label === "未提交，待核对" ||
    label === "待审批" ||
    label === "受理待核对" ||
    label === "CONFLICT_SAVED"
  ) {
    return "bg-amber-50 text-amber-800 border-amber-300";
  }
  if (label === "已拒绝" || label === "已过期" || label === "发送失败" || label === "error") {
    return "bg-rose-50 text-rose-700 border-rose-200";
  }
  return "bg-blue-50 text-blue-700 border-blue-200";
}

interface InlineApprovalCardProps {
  proposal: ProposalView;
  onUpdated: () => Promise<void> | void;
  onJumpToConversation?: (conversationId: string) => void;
  showJumpButton?: boolean;
}

export const InlineApprovalCard: React.FC<InlineApprovalCardProps> = ({
  proposal,
  onUpdated,
  onJumpToConversation,
  showJumpButton,
}) => {
  const payload = (proposal.snapshot?.["payload"] as Record<string, unknown> | undefined) ?? {};
  const isEmail = proposal.toolName === "send_email";
  const initialSubject = String(payload["subject"] ?? "");
  const initialBody = String(payload["body"] ?? "");
  const initialTo = Array.isArray(payload["to"]) ? (payload["to"] as unknown[]).map(String).join(", ") : "";

  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [trackedRevision, setTrackedRevision] = useState(proposal.revision);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [reconcileEvidence, setReconcileEvidence] = useState("");
  const [decisionKey] = useState(
    () => `dk-${proposal.approvalId}-r${proposal.revision}-${Math.random().toString(16).slice(2, 8)}`,
  );

  // Sync clean state if host advanced revision externally (never overwrite unsaved dirty draft!)
  if (proposal.revision !== trackedRevision && !dirty) {
    setTrackedRevision(proposal.revision);
    setSubject(initialSubject);
    setBody(initialBody);
  }

  const isPending = proposal.approvalState === "PENDING" && !proposal.expired;
  const canApprove = isPending && !dirty && !busy && !proposal.draftRedacted && proposal.hasChallenge;

  const handleSaveDraft = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const nextPayload = {
        ...payload,
        ...(isEmail ? { subject, body } : { body }),
      };
      const res = await api.saveDraft(proposal.proposalId, {
        conversationId: proposal.conversationId,
        expectedHeadRev: proposal.revision,
        target: proposal.target,
        payload: nextPayload,
      });
      if (!res.data.ok) {
        setFeedback(`保存失败 (${res.status}): ${res.data.message ?? res.data.code ?? "error"}`);
      } else {
        setDirty(false);
        setTrackedRevision(res.data.revision?.revision ?? proposal.revision + 1);
        setFeedback(`已保存新草稿版本 rev=${res.data.revision?.revision ?? "?"}`);
        await onUpdated();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDecide = async (choice: "APPROVE" | "REJECT") => {
    if (choice === "APPROVE" && dirty) {
      setFeedback("草稿有未保存修改，请先点击保存草稿再批准");
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const chal = await api.fetchApprovalChallenge(proposal.approvalId, proposal.conversationId);
      if (!chal.data.ok || !chal.data.nonce) {
        setFeedback(`获取单次校验码失败 (${chal.status}): ${chal.data.message ?? chal.data.code ?? "denied"}`);
        await onUpdated();
        return;
      }
      const res = await api.decideApproval({
        approvalId: proposal.approvalId,
        conversationId: proposal.conversationId,
        decision: choice,
        expectedRevision: proposal.revision,
        expectedActionHash: proposal.actionHash,
        nonce: chal.data.nonce,
        decisionKey: `${decisionKey}-${choice.toLowerCase()}-r${proposal.revision}`,
      });
      if (!res.data.ok) {
        setFeedback(`决定被拒绝 (${res.status}): ${res.data.message ?? res.data.code ?? "conflict"}`);
      } else {
        setFeedback(
          choice === "APPROVE"
            ? `决定已受理 (${res.data.approvalState})，等待唯一提交器执行`
            : `已拒绝 (${res.data.approvalState})`,
        );
      }
      await onUpdated();
    } finally {
      setBusy(false);
    }
  };

  const handleReconcile = async (conclusion: "CONFIRMED_SUCCEEDED" | "CONFIRMED_NOT_SENT") => {
    if (!proposal.effect?.effectId || !reconcileEvidence.trim()) {
      setFeedback("请填写人工核对依据后再提交");
      return;
    }
    setBusy(true);
    try {
      const res = await api.reconcileEffect(proposal.effect.effectId, {
        conclusion,
        evidenceRef: reconcileEvidence.trim(),
      });
      setFeedback(res.data.ok ? "人工核对已记录" : `核对失败: ${res.data.message ?? res.data.code}`);
      await onUpdated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-approval-card={proposal.approvalId}
      data-proposal-id={proposal.proposalId}
      data-approval-state={proposal.approvalState}
      data-effect-state={proposal.effect?.state ?? ""}
      className="bg-white border border-amber-300 rounded-xl p-4 shadow-sm space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="text-xs font-bold text-slate-900">
            {proposal.toolName === "send_email"
              ? "外发邮件审批卡 (Tier 2)"
              : proposal.toolName === "github_write_file"
                ? `GitHub 写入 (${proposal.autoIssuedTier0 ? "Tier 0 宿主直通" : "Tier 2"})`
                : `操作审批 (${proposal.toolName})`}
          </span>
          <span
            data-ui-status-label
            className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border ${statusBadgeTone(proposal.uiStatusLabel)}`}
          >
            {proposal.uiStatusLabel}
          </span>
          <span className="font-mono text-[10px] text-slate-500">
            rev {proposal.revision} · hash {proposal.actionHash.slice(0, 12)}
          </span>
        </div>
        {showJumpButton && onJumpToConversation && (
          <button
            type="button"
            data-action="jump-conversation"
            onClick={() => onJumpToConversation(proposal.conversationId)}
            className="text-xs px-2.5 py-1 rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700"
          >
            跳回会话 #{proposal.conversationId}
          </button>
        )}
      </div>

      <div className="text-xs text-slate-600 space-y-1">
        <div>
          <span className="font-semibold text-slate-700">目标：</span>
          <span className="font-mono break-all">{proposal.target}</span>
        </div>
        {isEmail && initialTo && (
          <div>
            <span className="font-semibold text-slate-700">收件人：</span>
            <span>{initialTo}</span>
          </div>
        )}
      </div>

      {proposal.draftRedacted ? (
        <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700">
          来源读取权限已撤销，草稿正文已脱敏并禁止批准。
        </div>
      ) : isEmail ? (
        <div className="space-y-2">
          <div>
            <label className="block text-[11px] font-medium text-slate-500 mb-1">邮件主题</label>
            <input
              type="text"
              data-field="draft-subject"
              disabled={!isPending || busy}
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                setDirty(true);
              }}
              className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs bg-slate-50 focus:bg-white focus:border-slate-900 focus:outline-none disabled:opacity-60"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-500 mb-1">纯文本正文</label>
            <textarea
              rows={4}
              data-field="draft-body"
              disabled={!isPending || busy}
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setDirty(true);
              }}
              className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs bg-slate-50 focus:bg-white focus:border-slate-900 focus:outline-none disabled:opacity-60"
            />
          </div>
        </div>
      ) : (
        <pre className="text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg p-2.5 whitespace-pre-wrap break-all">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}

      {dirty && isPending && (
        <div data-dirty-warning className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
          草稿存在未保存修改。保存以生成新的 revision、actionHash 与 nonce 后方可批准。
        </div>
      )}

      {isPending && !proposal.draftRedacted && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {isEmail && (
            <button
              type="button"
              data-action="save-draft"
              disabled={!dirty || busy}
              onClick={() => void handleSaveDraft()}
              className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-medium disabled:opacity-40"
            >
              保存草稿
            </button>
          )}
          <button
            type="button"
            data-action="approve"
            disabled={!canApprove}
            onClick={() => void handleDecide("APPROVE")}
            className="px-3.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium disabled:opacity-40"
          >
            批准并续跑
          </button>
          <button
            type="button"
            data-action="reject"
            disabled={busy}
            onClick={() => void handleDecide("REJECT")}
            className="px-3 py-1.5 rounded-lg border border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-medium disabled:opacity-40"
          >
            拒绝
          </button>
        </div>
      )}

      {proposal.effect && (
        <div className="text-[11px] font-mono text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-2 space-y-0.5">
          <div>
            effectId: {proposal.effect.effectId} · state: {proposal.effect.state}
          </div>
          {proposal.effect.receiptRef && <div>receipt: {proposal.effect.receiptRef}</div>}
          {proposal.effect.reason && <div>reason: {proposal.effect.reason}</div>}
        </div>
      )}

      {proposal.effect?.state === "UNKNOWN" && (
        <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 space-y-2">
          <div className="text-xs font-semibold text-amber-900">
            远端提交结果待核对（禁止自动重发），请人工核查后记录结论：
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              placeholder="输入核对依据，如收件箱 Message-ID 或远端日志..."
              value={reconcileEvidence}
              onChange={(e) => setReconcileEvidence(e.target.value)}
              className="flex-1 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleReconcile("CONFIRMED_SUCCEEDED")}
              className="px-2.5 py-1 rounded-lg bg-emerald-700 text-white text-xs font-medium"
            >
              确认已送达
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleReconcile("CONFIRMED_NOT_SENT")}
              className="px-2.5 py-1 rounded-lg bg-slate-700 text-white text-xs font-medium"
            >
              确认未发出
            </button>
          </div>
        </div>
      )}

      {feedback && <div className="text-xs text-slate-700 font-medium">{feedback}</div>}
    </div>
  );
};

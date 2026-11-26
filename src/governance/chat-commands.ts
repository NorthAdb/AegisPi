import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, mintId, sha256Hex } from "./canonical.ts";
import { withImmediateTx, writeAuditEvent } from "./db.ts";

export type ChatCommandStatus = "REGISTERED" | "ADMITTED" | "PENDING_RECONCILE" | "FAILED";

export interface ChatCommandRow {
  command_id: string;
  principal_id: string;
  runtime_epoch: string;
  conversation_id: string;
  chat_key: string;
  content_digest: string;
  content_preview: string;
  pi_request_id: string;
  submission_id: number | null;
  status: ChatCommandStatus;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

export function chatCommandUiStatusLabel(status: ChatCommandStatus): string {
  switch (status) {
    case "ADMITTED":
      return "已受理";
    case "REGISTERED":
      return "登记中";
    case "PENDING_RECONCILE":
      return "受理待核对";
    case "FAILED":
      return "受理失败";
  }
}

export function computeChatContentDigest(content: string): string {
  return sha256Hex(canonicalJson({ content }));
}

export function deriveStablePiRequestId(params: {
  principalId: string;
  runtimeEpoch: string;
  conversationId: string;
  chatKey: string;
}): string {
  const hash = sha256Hex(
    canonicalJson({
      principalId: params.principalId,
      runtimeEpoch: params.runtimeEpoch,
      conversationId: params.conversationId,
      chatKey: params.chatKey,
    }),
  );
  return `chatreq:${hash.slice(0, 32)}`;
}

export type RegisterChatCommandResult =
  | { action: "proceed_admit"; created: boolean; command: ChatCommandRow }
  | { action: "already_admitted"; command: ChatCommandRow }
  | { action: "pending_reconcile"; command: ChatCommandRow }
  | { action: "conflict"; command: ChatCommandRow };

export function registerOrLookupChatCommand(
  db: DatabaseSync,
  params: {
    principalId: string;
    runtimeEpoch: string;
    conversationId: string;
    chatKey: string;
    content: string;
    now: number;
  },
): RegisterChatCommandResult {
  const contentDigest = computeChatContentDigest(params.content);
  const contentPreview = params.content.slice(0, 120);
  const piRequestId = deriveStablePiRequestId({
    principalId: params.principalId,
    runtimeEpoch: params.runtimeEpoch,
    conversationId: params.conversationId,
    chatKey: params.chatKey,
  });

  return withImmediateTx(db, () => {
    const existing = db
      .prepare(
        `SELECT * FROM chat_commands
          WHERE principal_id = ?
            AND runtime_epoch = ?
            AND conversation_id = ?
            AND chat_key = ?`,
      )
      .get(
        params.principalId,
        params.runtimeEpoch,
        params.conversationId,
        params.chatKey,
      ) as ChatCommandRow | undefined;

    if (existing) {
      if (existing.content_digest !== contentDigest) {
        writeAuditEvent(db, {
          entityType: "chat_command",
          entityId: existing.command_id,
          eventKey: `conflict:${existing.command_id}:${contentDigest.slice(0, 12)}:${params.now}`,
          eventType: "chat_command_conflict",
          occurredAt: params.now,
          details: {
            principalId: params.principalId,
            runtimeEpoch: params.runtimeEpoch,
            conversationId: params.conversationId,
            chatKey: params.chatKey,
            existingDigest: existing.content_digest,
            incomingDigest: contentDigest,
          },
        });
        return { action: "conflict", command: existing };
      }
      if (existing.status === "ADMITTED") {
        return { action: "already_admitted", command: existing };
      }
      if (existing.status === "PENDING_RECONCILE") {
        return { action: "pending_reconcile", command: existing };
      }
      return { action: "proceed_admit", created: false, command: existing };
    }

    const commandId = mintId("cmd");
    db.prepare(
      `INSERT INTO chat_commands(
         command_id, principal_id, runtime_epoch, conversation_id, chat_key,
         content_digest, content_preview, pi_request_id, submission_id,
         status, reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'REGISTERED', NULL, ?, ?)`,
    ).run(
      commandId,
      params.principalId,
      params.runtimeEpoch,
      params.conversationId,
      params.chatKey,
      contentDigest,
      contentPreview,
      piRequestId,
      params.now,
      params.now,
    );

    writeAuditEvent(db, {
      entityType: "chat_command",
      entityId: commandId,
      eventKey: `register:${commandId}`,
      eventType: "chat_command_registered",
      occurredAt: params.now,
      details: {
        principalId: params.principalId,
        runtimeEpoch: params.runtimeEpoch,
        conversationId: params.conversationId,
        chatKey: params.chatKey,
        contentDigest,
        piRequestId,
      },
    });

    const createdRow = db
      .prepare("SELECT * FROM chat_commands WHERE command_id = ?")
      .get(commandId) as unknown as ChatCommandRow;

    return { action: "proceed_admit", created: true, command: createdRow };
  });
}

export function recordChatCommandAdmitted(
  db: DatabaseSync,
  params: {
    commandId: string;
    submissionId: number;
    reconciled?: boolean;
    now: number;
  },
): ChatCommandRow {
  return withImmediateTx(db, () => {
    db.prepare(
      `UPDATE chat_commands
          SET status = 'ADMITTED',
              submission_id = ?,
              reason = ?,
              updated_at = ?
        WHERE command_id = ?
          AND status IN ('REGISTERED', 'PENDING_RECONCILE')`,
    ).run(
      params.submissionId,
      params.reconciled ? "reconciled_from_pi" : null,
      params.now,
      params.commandId,
    );

    writeAuditEvent(db, {
      entityType: "chat_command",
      entityId: params.commandId,
      eventKey: `admitted:${params.commandId}:${params.submissionId}`,
      eventType: params.reconciled ? "chat_command_reconciled_admitted" : "chat_command_admitted",
      occurredAt: params.now,
      details: {
        submissionId: params.submissionId,
        reconciled: Boolean(params.reconciled),
      },
    });

    return db
      .prepare("SELECT * FROM chat_commands WHERE command_id = ?")
      .get(params.commandId) as unknown as ChatCommandRow;
  });
}

export function markChatCommandPendingReconcile(
  db: DatabaseSync,
  params: {
    commandId: string;
    reason: string;
    now: number;
  },
): ChatCommandRow {
  return withImmediateTx(db, () => {
    db.prepare(
      `UPDATE chat_commands
          SET status = 'PENDING_RECONCILE',
              reason = ?,
              updated_at = ?
        WHERE command_id = ?
          AND status IN ('REGISTERED', 'PENDING_RECONCILE')`,
    ).run(params.reason, params.now, params.commandId);

    writeAuditEvent(db, {
      entityType: "chat_command",
      entityId: params.commandId,
      eventKey: `pending_reconcile:${params.commandId}:${params.reason}`,
      eventType: "chat_command_pending_reconcile",
      occurredAt: params.now,
      details: { reason: params.reason },
    });

    return db
      .prepare("SELECT * FROM chat_commands WHERE command_id = ?")
      .get(params.commandId) as unknown as ChatCommandRow;
  });
}

export function listUnreconciledChatCommands(
  db: DatabaseSync,
  runtimeEpoch: string,
): ChatCommandRow[] {
  return db
    .prepare(
      `SELECT * FROM chat_commands
        WHERE runtime_epoch = ?
          AND status IN ('REGISTERED', 'PENDING_RECONCILE')
        ORDER BY created_at ASC`,
    )
    .all(runtimeEpoch) as unknown as ChatCommandRow[];
}

export function listChatCommandsForConversation(
  db: DatabaseSync,
  runtimeEpoch: string,
  conversationId: string,
): ChatCommandRow[] {
  return db
    .prepare(
      `SELECT * FROM chat_commands
        WHERE runtime_epoch = ?
          AND conversation_id = ?
        ORDER BY created_at ASC`,
    )
    .all(runtimeEpoch, conversationId) as unknown as ChatCommandRow[];
}

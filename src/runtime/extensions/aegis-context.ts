import type { DatabaseSync } from "node:sqlite";
import {
  CompactionTask,
  defineExtension,
  GenerationTask,
  hook,
  section,
  type Extension,
} from "@earendil-works/pi-durable";
import { freezeDomainL0Snapshot } from "../../capabilities/memory/store.ts";
import { getOrLockConversationSkillSet } from "../../capabilities/skills/store.ts";
import { writeAuditEvent } from "../../governance/db.ts";
import {
  checkConversationModelDisclosure,
  recordConversationSource,
} from "../../governance/policy.ts";

export const AEGIS_CONTEXT_EXTENSION_NAME = "aegis-context";

export interface AegisContextExtensionOptions {
  govDb: DatabaseSync;
  getRuntimeEpoch: () => string;
  resolveConversationAuth: (conversationId: string) => {
    principalId: string;
    scopeId: string;
    domain: string;
  };
  resolveModelDestinationForConversation: (conversationId: string) => {
    provider: string;
    modelId: string;
    baseUrl: string;
    slotName: string;
  } | null;
  skillsEnabled?: boolean;
  now?: () => number;
}

export function createAegisContextExtension(options: AegisContextExtensionOptions): Extension {
  const nowFn = options.now ?? (() => Date.now());
  // W2-S2: Freeze L0 strictly per active run while re-checking live source_read_grants on EVERY prompt build
  // so revoking a domain read grant immediately excludes L0 across runs, delegations, compactions, and retries!
  const l0Section = section("aegis-l0", (input) => {
    const convId = String(input.conversationId);
    const runtimeEpoch = options.getRuntimeEpoch();
    const auth = options.resolveConversationAuth(convId);
    const snap = freezeDomainL0Snapshot(options.govDb, {
      principalId: auth.principalId,
      scopeId: auth.scopeId,
      domain: auth.domain,
      now: nowFn(),
    });
    for (const note of snap.notes) {
      recordConversationSource(options.govDb, {
        runtimeEpoch,
        conversationId: convId,
        principalId: auth.principalId,
        sourceType: "memory",
        sourceId: `memory:${note.noteId}`,
        versionRef: `v${note.version}`,
        title: note.title,
        contentDigest: note.contentDigest,
        metadata: { tier: "L0", domain: auth.domain },
        now: nowFn(),
      });
    }
    return snap.renderedText.length > 0 ? snap.renderedText : undefined;
  });

  const skillsSection = section("aegis-skills", (input) => {
    if (!options.skillsEnabled) return undefined;
    const convId = String(input.conversationId);
    const locked = getOrLockConversationSkillSet(options.govDb, {
      runtimeEpoch: options.getRuntimeEpoch(),
      conversationId: convId,
      now: nowFn(),
    });
    return locked.renderedL1Index.length > 0 ? locked.renderedL1Index : undefined;
  });

  return defineExtension({
    name: AEGIS_CONTEXT_EXTENSION_NAME,
    sections: [l0Section, skillsSection],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api) => {
          const convId = String(api.conversationId);
          const dest = options.resolveModelDestinationForConversation(convId);
          if (!dest) return undefined;
          const auth = options.resolveConversationAuth(convId);
          const check = checkConversationModelDisclosure(options.govDb, {
            runtimeEpoch: options.getRuntimeEpoch(),
            conversationId: convId,
            principalId: auth.principalId,
            scopeId: auth.scopeId,
            provider: dest.provider,
            modelId: dest.modelId,
            baseUrl: dest.baseUrl,
            slotName: dest.slotName,
          });
          if (!check.ok) {
            writeAuditEvent(options.govDb, {
              entityType: "disclosure_denial",
              entityId: `${convId}:${api.taskId}`,
              eventKey: `before_req:${convId}:${api.taskId}:${nowFn()}`,
              eventType: "model_disclosure_denied",
              occurredAt: nowFn(),
              details: {
                stage: "beforeRequest",
                conversationId: convId,
                blockedSource: check.blockedSource,
                reason: check.reason,
              },
            });
            // Strip prior messages at hook level as defense-in-depth; Models egress will hard-block the send!
            return { messages: [] };
          }
          return { messages };
        },
      }),
      hook(CompactionTask, {
        beforeCompact: async (_compaction, api) => {
          const convId = String(api.conversationId);
          const dest = options.resolveModelDestinationForConversation(convId);
          if (!dest) return undefined;
          const auth = options.resolveConversationAuth(convId);
          const check = checkConversationModelDisclosure(options.govDb, {
            runtimeEpoch: options.getRuntimeEpoch(),
            conversationId: convId,
            principalId: auth.principalId,
            scopeId: auth.scopeId,
            provider: dest.provider,
            modelId: dest.modelId,
            baseUrl: dest.baseUrl,
            slotName: "compaction",
          });
          if (!check.ok) {
            writeAuditEvent(options.govDb, {
              entityType: "disclosure_denial",
              entityId: `${convId}:${api.taskId}`,
              eventKey: `before_compact:${convId}:${api.taskId}:${nowFn()}`,
              eventType: "model_disclosure_denied",
              occurredAt: nowFn(),
              details: {
                stage: "beforeCompact",
                conversationId: convId,
                blockedSource: check.blockedSource,
                reason: check.reason,
              },
            });
            return { decline: true };
          }
          return undefined;
        },
      }),
    ],
  });
}

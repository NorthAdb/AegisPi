import { readFileSync } from "node:fs";
import path from "node:path";
import { atomicOperatorWrite } from "./operator-credentials.ts";

export interface OperatorPreferences {
  routerModelId: string;
  workerModelId: string;
  routerMaxTokens: number;
  workerMaxTokens: number;
  gmailMailbox: string | null;
  githubWritesEnabled: boolean;
}

interface OperatorSettingsPolicy {
  defaults: OperatorPreferences;
  modelChoices: string[];
  outputLimits: { router: number; worker: number };
  gmailMailboxes: string[];
  githubWritesAvailable: boolean;
}

function validLimit(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= limit;
}

export function openOperatorSettings(dataDir: string, policy: OperatorSettingsPolicy) {
  const file = path.join(dataDir, "operator-settings.json");
  let stored: Partial<OperatorPreferences> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid_operator_settings");
    }
    stored = parsed as Partial<OperatorPreferences>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("Could not load operator-settings.json");
    }
  }

  const { defaults, modelChoices, outputLimits, gmailMailboxes, githubWritesAvailable } = policy;
  const active: OperatorPreferences = {
    routerModelId: stored.routerModelId && modelChoices.includes(stored.routerModelId) ? stored.routerModelId : defaults.routerModelId,
    workerModelId: stored.workerModelId && modelChoices.includes(stored.workerModelId) ? stored.workerModelId : defaults.workerModelId,
    routerMaxTokens: validLimit(stored.routerMaxTokens, outputLimits.router) ? stored.routerMaxTokens : defaults.routerMaxTokens,
    workerMaxTokens: validLimit(stored.workerMaxTokens, outputLimits.worker) ? stored.workerMaxTokens : defaults.workerMaxTokens,
    gmailMailbox: stored.gmailMailbox && gmailMailboxes.includes(stored.gmailMailbox) ? stored.gmailMailbox : defaults.gmailMailbox,
    githubWritesEnabled: githubWritesAvailable && (stored.githubWritesEnabled ?? defaults.githubWritesEnabled) === true,
  };
  let saved = active;

  const get = () => ({
    active,
    saved,
    pendingRestart: JSON.stringify(saved) !== JSON.stringify(active),
    modelChoices,
    outputLimits,
    gmailMailboxes,
    githubWritesAvailable,
  });

  function update(input: unknown): boolean {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const patch = input as Record<string, unknown>;
    const keys = Object.keys(patch);
    if (keys.length === 0 || keys.some((key) => !Object.hasOwn(active, key))) return false;
    if ("routerModelId" in patch && (typeof patch.routerModelId !== "string" || !modelChoices.includes(patch.routerModelId))) return false;
    if ("workerModelId" in patch && (typeof patch.workerModelId !== "string" || !modelChoices.includes(patch.workerModelId))) return false;
    if ("routerMaxTokens" in patch && !validLimit(patch.routerMaxTokens, outputLimits.router)) return false;
    if ("workerMaxTokens" in patch && !validLimit(patch.workerMaxTokens, outputLimits.worker)) return false;
    if ("gmailMailbox" in patch && (typeof patch.gmailMailbox !== "string" || !gmailMailboxes.includes(patch.gmailMailbox))) return false;
    if ("githubWritesEnabled" in patch && (typeof patch.githubWritesEnabled !== "boolean" || (patch.githubWritesEnabled && !githubWritesAvailable))) return false;

    const next = { ...saved, ...patch } as OperatorPreferences;
    atomicOperatorWrite(file, JSON.stringify(next, null, 2) + "\n");
    saved = next;
    return true;
  }

  return { get, update };
}

import type { DatabaseSync } from "node:sqlite";
import { mintId } from "../../governance/canonical.ts";
import { withImmediateTx, writeAuditEvent } from "../../governance/db.ts";
import { createRememberedRule, matchRememberedRule } from "../../governance/rules.ts";

export type RoutineScheduleKind = "once" | "daily" | "weekly";

export interface RoutineScheduleSpec {
  kind: RoutineScheduleKind;
  /** For daily/weekly: 0-23 */
  hour?: number;
  /** For daily/weekly: 0-59 */
  minute?: number;
  /** For weekly: 0 (Sun) - 6 (Sat) */
  dayOfWeek?: number;
  /** For once: explicit UTC ms instant */
  onceAtUtcMs?: number;
}

export interface RoutineSkipCondition {
  kind: "weekend" | "weekday";
  label: string;
}

export interface RoutinePreview {
  name: string;
  prompt: string;
  timezone: string;
  scheduleKind: RoutineScheduleKind;
  scheduleSpec: RoutineScheduleSpec;
  skipCondition: RoutineSkipCondition | null;
  nextRunUtcMs: number;
  nextRunLocalText: string;
  scopeSummary: string;
  requiresConfirmation: boolean;
  matchedRuleId: string | null;
}

export interface RoutineRow {
  routine_id: string;
  principal_id: string;
  scope_id: string;
  name: string;
  prompt: string;
  timezone: string;
  schedule_kind: RoutineScheduleKind;
  schedule_json: string;
  skip_condition_json: string | null;
  enabled: number;
  next_run_utc_ms: number | null;
  last_run_utc_ms: number | null;
  last_status: string | null;
  last_result_summary: string | null;
  created_at: number;
  updated_at: number;
}

export interface RoutineTriggerRow {
  trigger_id: string;
  routine_id: string;
  scheduled_instant_utc: number;
  correlation_key: string;
  conversation_id: string | null;
  pi_request_id: string | null;
  submission_id: number | null;
  state: "REGISTERED" | "ADMITTED" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "PENDING_RECONCILE";
  reason: string | null;
  created_at: number;
  updated_at: number;
}

const WEEKDAY_MAP: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

function getZonedParts(utcMs: number, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(utcMs));
  const getNum = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const wdRaw = (parts.find((p) => p.type === "weekday")?.value ?? "Mon").toLowerCase();
  const wdMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const rawHour = getNum("hour");
  return {
    year: getNum("year"),
    month: getNum("month"),
    day: getNum("day"),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: getNum("minute"),
    second: getNum("second"),
    weekday: wdMap[wdRaw] ?? 1,
  };
}

/**
 * Converts a local wall-clock date+time in an IANA timezone to a deterministic UTC timestamp (ms).
 * Iteratively refines offset so DST transitions converge cleanly without external timezone libraries.
 */
export function zonedWallClockToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = getZonedParts(guess, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
    const targetUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const diff = targetUtc - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

export function formatUtcInTimezone(utcMs: number, timeZone: string): string {
  const p = getZonedParts(utcMs, timeZone);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (${timeZone})`;
}

export function computeNextRunUtcMs(
  spec: RoutineScheduleSpec,
  timeZone: string,
  afterUtcMs: number,
): number | null {
  if (spec.kind === "once") {
    const t = spec.onceAtUtcMs ?? afterUtcMs + 60_000;
    return t > afterUtcMs ? t : null;
  }

  const hour = Math.max(0, Math.min(23, spec.hour ?? 9));
  const minute = Math.max(0, Math.min(59, spec.minute ?? 0));
  const nowParts = getZonedParts(afterUtcMs, timeZone);

  if (spec.kind === "daily") {
    for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
      const probe = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + dayOffset, 12, 0, 0));
      const candidate = zonedWallClockToUtcMs(
        probe.getUTCFullYear(),
        probe.getUTCMonth() + 1,
        probe.getUTCDate(),
        hour,
        minute,
        timeZone,
      );
      if (candidate > afterUtcMs) return candidate;
    }
    return afterUtcMs + 24 * 60 * 60 * 1000;
  }

  // Weekly
  const targetDow = Math.max(0, Math.min(6, spec.dayOfWeek ?? 5));
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const probe = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + dayOffset, 12, 0, 0));
    const candidate = zonedWallClockToUtcMs(
      probe.getUTCFullYear(),
      probe.getUTCMonth() + 1,
      probe.getUTCDate(),
      hour,
      minute,
      timeZone,
    );
    if (candidate <= afterUtcMs) continue;
    const candParts = getZonedParts(candidate, timeZone);
    if (candParts.weekday === targetDow) {
      return candidate;
    }
  }
  return afterUtcMs + 7 * 24 * 60 * 60 * 1000;
}

/**
 * When a host was down across multiple missed periods, collapses all missed periods to ONLY the most recent
 * due instant (<= now) and computes the next future run (> now).
 */
export function collapseMissedInstantsToLatest(
  spec: RoutineScheduleSpec,
  timeZone: string,
  scheduledDueUtcMs: number,
  nowMs: number,
): { latestDueUtcMs: number; nextFutureUtcMs: number | null } {
  if (spec.kind === "once") {
    return { latestDueUtcMs: scheduledDueUtcMs, nextFutureUtcMs: null };
  }
  let latest = scheduledDueUtcMs;
  let guard = 0;
  while (guard < 400) {
    guard++;
    const next = computeNextRunUtcMs(spec, timeZone, latest);
    if (next === null) {
      return { latestDueUtcMs: latest, nextFutureUtcMs: null };
    }
    if (next > nowMs) {
      return { latestDueUtcMs: latest, nextFutureUtcMs: next };
    }
    latest = next;
  }
  return { latestDueUtcMs: latest, nextFutureUtcMs: computeNextRunUtcMs(spec, timeZone, nowMs) };
}

export function evaluateSkipCondition(
  skipCondition: RoutineSkipCondition | null,
  instantUtcMs: number,
  timeZone: string,
): { shouldSkip: boolean; reason?: string } {
  if (!skipCondition) return { shouldSkip: false };
  const parts = getZonedParts(instantUtcMs, timeZone);
  const isWeekend = parts.weekday === 0 || parts.weekday === 6;
  if (skipCondition.kind === "weekend" && isWeekend) {
    return { shouldSkip: true, reason: `Skipped by condition: ${skipCondition.label}` };
  }
  if (skipCondition.kind === "weekday" && !isWeekend) {
    return { shouldSkip: true, reason: `Skipped by condition: ${skipCondition.label}` };
  }
  return { shouldSkip: false };
}

/**
 * Parses Chinese or English natural language into a confirmable Stage 2 Routine preview.
 */
export function parseNaturalLanguageRoutine(
  db: DatabaseSync,
  params: {
    text: string;
    principalId: string;
    scopeId: string;
    timezone?: string;
    now: number;
  },
): RoutinePreview {
  const raw = params.text.trim();
  const timezone = params.timezone ?? "Asia/Hong_Kong";

  // Extract time HH:MM
  const timeMatch = /(\d{1,2})\s*[:：点时]\s*(\d{1,2})?/.exec(raw);
  let hour = timeMatch ? Number(timeMatch[1]) : 9;
  let minute = timeMatch && timeMatch[2] ? Number(timeMatch[2]) : 0;
  if (/(下午|晚上|傍晚|pm)/i.test(raw) && hour < 12) {
    hour += 12;
  }
  hour = Math.max(0, Math.min(23, hour));
  minute = Math.max(0, Math.min(59, minute));

  // Detect skip condition
  let skipCondition: RoutineSkipCondition | null = null;
  if (/(周末跳过|如果周末跳过|跳过周末|skip\s+(?:on\s+)?weekends?)/i.test(raw)) {
    skipCondition = { kind: "weekend", label: "周末跳过" };
  } else if (/(工作日跳过|跳过工作日|skip\s+(?:on\s+)?weekdays?)/i.test(raw)) {
    skipCondition = { kind: "weekday", label: "工作日跳过" };
  }

  let scheduleSpec: RoutineScheduleSpec;
  let scheduleLabel: string;

  // Weekly detection
  const zhWeekly = /每(?:周|星期)([一二三四五六日天])/.exec(raw);
  const enWeekly = /every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)/i.exec(raw);
  const explicitDate = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  const relativeMin = /(?:in\s+(\d+)\s*(?:min|minute|minutes|m)\b|(\d+)\s*分钟后)/i.exec(raw);

  if (zhWeekly || enWeekly) {
    const dowKey = (zhWeekly?.[1] ?? enWeekly?.[1] ?? "五").toLowerCase();
    const dayOfWeek = WEEKDAY_MAP[dowKey] ?? 5;
    scheduleSpec = { kind: "weekly", dayOfWeek, hour, minute };
    scheduleLabel = `每周 (dow=${dayOfWeek}) ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  } else if (/(每天|每日|daily|every\s+day)/i.test(raw)) {
    scheduleSpec = { kind: "daily", hour, minute };
    scheduleLabel = `每日 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  } else if (explicitDate) {
    const onceUtc = zonedWallClockToUtcMs(
      Number(explicitDate[1]),
      Number(explicitDate[2]),
      Number(explicitDate[3]),
      hour,
      minute,
      timezone,
    );
    scheduleSpec = { kind: "once", onceAtUtcMs: Math.max(onceUtc, params.now + 60_000) };
    scheduleLabel = `一次性 ${explicitDate[0]} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  } else if (relativeMin) {
    const mins = Math.max(1, Number(relativeMin[1] ?? relativeMin[2] ?? "5"));
    scheduleSpec = { kind: "once", onceAtUtcMs: params.now + mins * 60_000 };
    scheduleLabel = `一次性 (${mins} 分钟后)`;
  } else {
    // Default to once in 10 minutes or next daily occurrence if "周报" mentioned
    if (/周报/.test(raw)) {
      scheduleSpec = { kind: "weekly", dayOfWeek: 5, hour: timeMatch ? hour : 17, minute };
      scheduleLabel = `每周五 ${String(scheduleSpec.hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    } else {
      scheduleSpec = { kind: "once", onceAtUtcMs: params.now + 10 * 60_000 };
      scheduleLabel = "一次性 (10 分钟后)";
    }
  }

  const nextRunUtcMs = computeNextRunUtcMs(scheduleSpec, timezone, params.now) ?? params.now + 60_000;
  const matchedRule = matchRememberedRule(db, {
    principalId: params.principalId,
    scopeId: params.scopeId,
    toolName: "routine_create",
    target: `routine:${scheduleSpec.kind}`,
    now: params.now,
  });

  const cleanName = raw.length > 44 ? raw.slice(0, 44) + "..." : raw || "未命名例程";
  return {
    name: cleanName,
    prompt: raw,
    timezone,
    scheduleKind: scheduleSpec.kind,
    scheduleSpec,
    skipCondition,
    nextRunUtcMs,
    nextRunLocalText: formatUtcInTimezone(nextRunUtcMs, timezone),
    scopeSummary: `${params.scopeId} · ${scheduleLabel}${skipCondition ? ` · ${skipCondition.label}` : ""} · 执行仍受实时权限与预算约束`,
    requiresConfirmation: !matchedRule,
    matchedRuleId: matchedRule?.rule_id ?? null,
  };
}

export function createRoutineWithGovernance(
  db: DatabaseSync,
  params: {
    principalId: string;
    scopeId: string;
    name: string;
    prompt: string;
    timezone: string;
    scheduleSpec: RoutineScheduleSpec;
    skipCondition?: RoutineSkipCondition | null;
    nextRunUtcMs?: number;
    confirmed?: boolean;
    rememberRule?: boolean;
    ruleTtlMs?: number;
    now: number;
  },
):
  | { ok: true; routine: RoutineRow; ruleUsedId: string | null; ruleCreatedId: string | null }
  | { ok: false; httpStatus: 409; code: string; reason: string } {
  const target = `routine:${params.scheduleSpec.kind}`;
  const matchedRule = matchRememberedRule(db, {
    principalId: params.principalId,
    scopeId: params.scopeId,
    toolName: "routine_create",
    target,
    now: params.now,
  });

  if (!matchedRule && !params.confirmed) {
    return {
      ok: false,
      httpStatus: 409,
      code: "tier1_confirmation_required",
      reason: "Creating and enabling a routine requires explicit Tier 1 confirmation (no active remembered rule)",
    };
  }

  let ruleCreatedId: string | null = null;
  if (params.confirmed && params.rememberRule) {
    const ruleRes = createRememberedRule(db, {
      principalId: params.principalId,
      scopeId: params.scopeId,
      toolName: "routine_create",
      targetPattern: "routine:*",
      actionSummary: "自动放行例程创建与启用 (Tier 1)",
      expiresAt: params.now + (params.ruleTtlMs ?? 30 * 24 * 60 * 60 * 1000),
      now: params.now,
    });
    if (ruleRes.ok) {
      ruleCreatedId = ruleRes.rule.rule_id;
    }
  }

  const nextRunUtcMs =
    params.nextRunUtcMs ??
    computeNextRunUtcMs(params.scheduleSpec, params.timezone, params.now) ??
    params.now + 60_000;
  const routineId = mintId("rtn");

  const row = withImmediateTx(db, () => {
    db.prepare(
      `INSERT INTO routines(
         routine_id, principal_id, scope_id, name, prompt, timezone,
         schedule_kind, schedule_json, skip_condition_json, enabled,
         next_run_utc_ms, last_run_utc_ms, last_status, last_result_summary,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, 'SCHEDULED', NULL, ?, ?)`,
    ).run(
      routineId,
      params.principalId,
      params.scopeId,
      params.name,
      params.prompt,
      params.timezone,
      params.scheduleSpec.kind,
      JSON.stringify(params.scheduleSpec),
      params.skipCondition ? JSON.stringify(params.skipCondition) : null,
      nextRunUtcMs,
      params.now,
      params.now,
    );
    writeAuditEvent(db, {
      entityType: "routine",
      entityId: routineId,
      eventKey: `create:${routineId}`,
      eventType: "routine_created",
      occurredAt: params.now,
      details: {
        principalId: params.principalId,
        scopeId: params.scopeId,
        scheduleKind: params.scheduleSpec.kind,
        timezone: params.timezone,
        nextRunUtcMs,
        matchedRuleId: matchedRule?.rule_id ?? null,
        confirmed: Boolean(params.confirmed),
        ruleCreatedId,
      },
    });
    return db.prepare("SELECT * FROM routines WHERE routine_id = ?").get(routineId) as unknown as RoutineRow;
  });

  return {
    ok: true,
    routine: row,
    ruleUsedId: matchedRule?.rule_id ?? null,
    ruleCreatedId,
  };
}

export function listRoutines(db: DatabaseSync, principalId?: string): Array<RoutineRow & { triggers: RoutineTriggerRow[] }> {
  const rows = (
    principalId
      ? db.prepare("SELECT * FROM routines WHERE principal_id = ? ORDER BY created_at DESC").all(principalId)
      : db.prepare("SELECT * FROM routines ORDER BY created_at DESC").all()
  ) as unknown as RoutineRow[];
  return rows.map((r) => {
    const triggers = db
      .prepare("SELECT * FROM routine_triggers WHERE routine_id = ? ORDER BY scheduled_instant_utc DESC LIMIT 10")
      .all(r.routine_id) as unknown as RoutineTriggerRow[];
    return { ...r, triggers };
  });
}

export function pauseRoutine(
  db: DatabaseSync,
  params: { routineId: string; principalId: string; now: number },
): { ok: true; routine: RoutineRow } | { ok: false; httpStatus: 403 | 404; code: string; reason: string } {
  return withImmediateTx(db, () => {
    const r = db.prepare("SELECT * FROM routines WHERE routine_id = ?").get(params.routineId) as
      | RoutineRow
      | undefined;
    if (!r) return { ok: false, httpStatus: 404, code: "routine_not_found", reason: "Routine not found" };
    if (r.principal_id !== params.principalId) {
      return { ok: false, httpStatus: 403, code: "forbidden", reason: "Not authorized for this routine" };
    }
    db.prepare("UPDATE routines SET enabled = 0, last_status = 'PAUSED', updated_at = ? WHERE routine_id = ?").run(
      params.now,
      params.routineId,
    );
    writeAuditEvent(db, {
      entityType: "routine",
      entityId: params.routineId,
      eventKey: `pause:${params.routineId}:${params.now}`,
      eventType: "routine_paused",
      occurredAt: params.now,
    });
    const updated = db.prepare("SELECT * FROM routines WHERE routine_id = ?").get(params.routineId) as unknown as RoutineRow;
    return { ok: true, routine: updated };
  });
}

export function resumeRoutine(
  db: DatabaseSync,
  params: { routineId: string; principalId: string; confirmed?: boolean; now: number },
): { ok: true; routine: RoutineRow } | { ok: false; httpStatus: 403 | 404 | 409; code: string; reason: string } {
  return withImmediateTx(db, () => {
    const r = db.prepare("SELECT * FROM routines WHERE routine_id = ?").get(params.routineId) as
      | RoutineRow
      | undefined;
    if (!r) return { ok: false, httpStatus: 404, code: "routine_not_found", reason: "Routine not found" };
    if (r.principal_id !== params.principalId) {
      return { ok: false, httpStatus: 403, code: "forbidden", reason: "Not authorized for this routine" };
    }
    const matchedRule = matchRememberedRule(db, {
      principalId: params.principalId,
      scopeId: r.scope_id,
      toolName: "routine_create",
      target: `routine:${r.schedule_kind}`,
      now: params.now,
    });
    if (!matchedRule && !params.confirmed) {
      return {
        ok: false,
        httpStatus: 409,
        code: "tier1_confirmation_required",
        reason: "Re-enabling routine requires explicit confirmation after rule revocation",
      };
    }
    const spec = JSON.parse(r.schedule_json) as RoutineScheduleSpec;
    const nextRun = computeNextRunUtcMs(spec, r.timezone, params.now);
    db.prepare(
      `UPDATE routines
          SET enabled = 1,
              next_run_utc_ms = ?,
              last_status = 'SCHEDULED',
              updated_at = ?
        WHERE routine_id = ?`,
    ).run(nextRun, params.now, params.routineId);
    writeAuditEvent(db, {
      entityType: "routine",
      entityId: params.routineId,
      eventKey: `resume:${params.routineId}:${params.now}`,
      eventType: "routine_resumed",
      occurredAt: params.now,
      details: { nextRunUtcMs: nextRun, matchedRuleId: matchedRule?.rule_id ?? null },
    });
    const updated = db.prepare("SELECT * FROM routines WHERE routine_id = ?").get(params.routineId) as unknown as RoutineRow;
    return { ok: true, routine: updated };
  });
}

export interface RoutineTriggerAdmissionResult {
  outcome: "ADMITTED" | "FAILED" | "PENDING_RECONCILE";
  conversationId?: string;
  piRequestId?: string;
  submissionId?: number | null;
  reason?: string;
}

/**
 * Host-owned 30-second routine poller independent of Hono.
 * Registers (routineId, scheduledInstantUtc) uniquely in governance SQLite, collapses missed cycles to
 * the single most recent period, evaluates simple skip conditions, and hands off to Runtime via stable correlationKey.
 */
export class RoutinePoller {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #admitTrigger: (params: {
    routine: RoutineRow;
    trigger: RoutineTriggerRow;
  }) => Promise<RoutineTriggerAdmissionResult>;
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #polling = false;

  constructor(params: {
    govDb: DatabaseSync;
    now?: () => number;
    intervalMs?: number;
    admitTrigger: (args: {
      routine: RoutineRow;
      trigger: RoutineTriggerRow;
    }) => Promise<RoutineTriggerAdmissionResult>;
  }) {
    this.#db = params.govDb;
    this.#now = params.now ?? (() => Date.now());
    this.#intervalMs = params.intervalMs ?? 30_000;
    this.#admitTrigger = params.admitTrigger;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#timer = setInterval(() => {
      void this.pollOnce().catch(() => {});
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Reconciles any REGISTERED or PENDING_RECONCILE triggers against chat_commands on startup.
   */
  reconcileTriggersWithChatCommands(runtimeEpoch: string): number {
    const now = this.#now();
    const pending = this.#db
      .prepare("SELECT * FROM routine_triggers WHERE state IN ('REGISTERED','PENDING_RECONCILE')")
      .all() as unknown as RoutineTriggerRow[];
    let reconciled = 0;
    for (const trig of pending) {
      const cmd = this.#db
        .prepare(
          `SELECT conversation_id, pi_request_id, submission_id, status, reason
             FROM chat_commands
            WHERE runtime_epoch = ? AND chat_key = ?
            LIMIT 1`,
        )
        .get(runtimeEpoch, trig.correlation_key) as
        | {
            conversation_id: string;
            pi_request_id: string;
            submission_id: number | null;
            status: string;
            reason: string | null;
          }
        | undefined;
      if (!cmd) {
        if (trig.state === "REGISTERED") {
          withImmediateTx(this.#db, () => {
            this.#db
              .prepare(
                `UPDATE routine_triggers
                    SET state = 'PENDING_RECONCILE', reason = 'startup_admission_unknown', updated_at = ?
                  WHERE trigger_id = ? AND state = 'REGISTERED'`,
              )
              .run(now, trig.trigger_id);
            this.#db
              .prepare(
                `UPDATE routines SET last_status = 'PENDING_RECONCILE', last_result_summary = '受理待核对', updated_at = ? WHERE routine_id = ?`,
              )
              .run(now, trig.routine_id);
          });
          reconciled++;
        }
        continue;
      }
      const nextState =
        cmd.status === "ADMITTED"
          ? "ADMITTED"
          : cmd.status === "FAILED"
            ? "FAILED"
            : "PENDING_RECONCILE";
      withImmediateTx(this.#db, () => {
        this.#db
          .prepare(
            `UPDATE routine_triggers
                SET state = ?, conversation_id = ?, pi_request_id = ?, submission_id = ?, reason = ?, updated_at = ?
              WHERE trigger_id = ?`,
          )
          .run(nextState, cmd.conversation_id, cmd.pi_request_id, cmd.submission_id, cmd.reason, now, trig.trigger_id);
        this.#db
          .prepare(
            `UPDATE routines SET last_status = ?, last_result_summary = ?, updated_at = ? WHERE routine_id = ?`,
          )
          .run(
            nextState,
            nextState === "ADMITTED" ? `已受理 (conv ${cmd.conversation_id})` : (cmd.reason ?? "受理待核对"),
            now,
            trig.routine_id,
          );
      });
      reconciled++;
    }
    return reconciled;
  }

  async pollOnce(): Promise<{
    dueCount: number;
    admittedCount: number;
    skippedCount: number;
    duplicateIgnoredCount: number;
    pendingReconcileCount: number;
  }> {
    if (this.#polling) {
      return { dueCount: 0, admittedCount: 0, skippedCount: 0, duplicateIgnoredCount: 0, pendingReconcileCount: 0 };
    }
    this.#polling = true;
    try {
      const now = this.#now();
      const dueRoutines = this.#db
        .prepare(
          `SELECT * FROM routines
            WHERE enabled = 1 AND next_run_utc_ms IS NOT NULL AND next_run_utc_ms <= ?
            ORDER BY next_run_utc_ms ASC`,
        )
        .all(now) as unknown as RoutineRow[];

      let admittedCount = 0;
      let skippedCount = 0;
      let duplicateIgnoredCount = 0;
      let pendingReconcileCount = 0;

      for (const routine of dueRoutines) {
        const spec = JSON.parse(routine.schedule_json) as RoutineScheduleSpec;
        const skipCond = routine.skip_condition_json
          ? (JSON.parse(routine.skip_condition_json) as RoutineSkipCondition)
          : null;
        const { latestDueUtcMs, nextFutureUtcMs } = collapseMissedInstantsToLatest(
          spec,
          routine.timezone,
          routine.next_run_utc_ms!,
          now,
        );
        const correlationKey = `rt:${routine.routine_id}:${latestDueUtcMs}`;
        const skipEval = evaluateSkipCondition(skipCond, latestDueUtcMs, routine.timezone);

        // Atomic unique trigger registration by (routine_id, scheduled_instant_utc)
        const reg = withImmediateTx(this.#db, () => {
          const existing = this.#db
            .prepare("SELECT * FROM routine_triggers WHERE routine_id = ? AND scheduled_instant_utc = ?")
            .get(routine.routine_id, latestDueUtcMs) as RoutineTriggerRow | undefined;
          if (existing) {
            // Advance routine cursor so we don't re-scan this instant
            this.#db
              .prepare("UPDATE routines SET next_run_utc_ms = ?, updated_at = ? WHERE routine_id = ?")
              .run(nextFutureUtcMs, now, routine.routine_id);
            return { inserted: false as const, trigger: existing };
          }
          const triggerId = mintId("rtrg");
          const initialState = skipEval.shouldSkip ? "SKIPPED" : "REGISTERED";
          this.#db
            .prepare(
              `INSERT INTO routine_triggers(
                 trigger_id, routine_id, scheduled_instant_utc, correlation_key,
                 conversation_id, pi_request_id, submission_id, state, reason, created_at, updated_at
               ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
            )
            .run(
              triggerId,
              routine.routine_id,
              latestDueUtcMs,
              correlationKey,
              initialState,
              skipEval.reason ?? null,
              now,
              now,
            );

          this.#db
            .prepare(
              `UPDATE routines
                  SET next_run_utc_ms = ?,
                      last_run_utc_ms = ?,
                      last_status = ?,
                      last_result_summary = ?,
                      enabled = CASE WHEN schedule_kind = 'once' THEN 0 ELSE enabled END,
                      updated_at = ?
                WHERE routine_id = ?`,
            )
            .run(
              nextFutureUtcMs,
              latestDueUtcMs,
              initialState,
              skipEval.shouldSkip ? (skipEval.reason ?? "已按条件跳过") : "正在受理",
              now,
              routine.routine_id,
            );

          writeAuditEvent(this.#db, {
            entityType: "routine_trigger",
            entityId: triggerId,
            eventKey: `register:${routine.routine_id}:${latestDueUtcMs}`,
            eventType: skipEval.shouldSkip ? "routine_trigger_skipped" : "routine_trigger_registered",
            occurredAt: now,
            details: {
              routineId: routine.routine_id,
              scheduledInstantUtc: latestDueUtcMs,
              correlationKey,
              nextFutureUtcMs,
              reason: skipEval.reason ?? null,
            },
          });

          const trigger = this.#db
            .prepare("SELECT * FROM routine_triggers WHERE trigger_id = ?")
            .get(triggerId) as unknown as RoutineTriggerRow;
          return { inserted: true as const, trigger };
        });

        if (!reg.inserted) {
          duplicateIgnoredCount++;
          continue;
        }
        if (skipEval.shouldSkip) {
          skippedCount++;
          continue;
        }

        // Hand off registered trigger to Runtime outside DB lock
        let admission: RoutineTriggerAdmissionResult;
        try {
          admission = await this.#admitTrigger({ routine, trigger: reg.trigger });
        } catch (err) {
          admission = {
            outcome: "PENDING_RECONCILE",
            reason: err instanceof Error ? err.message : String(err),
          };
        }

        const doneAt = this.#now();
        withImmediateTx(this.#db, () => {
          this.#db
            .prepare(
              `UPDATE routine_triggers
                  SET state = ?,
                      conversation_id = COALESCE(?, conversation_id),
                      pi_request_id = COALESCE(?, pi_request_id),
                      submission_id = COALESCE(?, submission_id),
                      reason = ?,
                      updated_at = ?
                WHERE trigger_id = ?`,
            )
            .run(
              admission.outcome,
              admission.conversationId ?? null,
              admission.piRequestId ?? null,
              admission.submissionId ?? null,
              admission.reason ?? null,
              doneAt,
              reg.trigger.trigger_id,
            );
          this.#db
            .prepare(
              `UPDATE routines
                  SET last_status = ?,
                      last_result_summary = ?,
                      updated_at = ?
                WHERE routine_id = ?`,
            )
            .run(
              admission.outcome,
              admission.outcome === "ADMITTED"
                ? `已受理 · 会话 #${admission.conversationId ?? "?"}`
                : admission.outcome === "PENDING_RECONCILE"
                  ? `受理待核对 (${admission.reason ?? "unknown"})`
                  : `执行受阻 (${admission.reason ?? "failed"})`,
              doneAt,
              routine.routine_id,
            );
        });

        if (admission.outcome === "ADMITTED") admittedCount++;
        else if (admission.outcome === "PENDING_RECONCILE") pendingReconcileCount++;
      }

      return {
        dueCount: dueRoutines.length,
        admittedCount,
        skippedCount,
        duplicateIgnoredCount,
        pendingReconcileCount,
      };
    } finally {
      this.#polling = false;
    }
  }
}

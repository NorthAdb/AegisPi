import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import {
  availableMu,
  dayAccountIdFor,
  DEFAULT_TIME_ZONE,
  formatChargeDay,
  getBudgetAccount,
  setBudgetAccountLimit,
  taskAccountIdFor,
  type BudgetAccountRow,
  type BudgetReservationRow,
} from "../../src/governance/budget.ts";
import { HostCredentialVault } from "../../src/governance/credentials.ts";
import { AegisHostRuntime } from "../../src/runtime/harness.ts";
import type { ModelSlotConfig } from "../../src/runtime/models.ts";
import { startWebServer } from "../../src/web/server.ts";
import { startFakeModelServer } from "../fakes/client.ts";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a && a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("--")) {
        out[k] = v;
        i++;
      } else {
        out[k] = "true";
      }
    }
  }
  return out;
}

interface CaseEvidence {
  caseId: string;
  entry: "router" | "worker" | "compaction";
  kind: "positive_control" | "negative_task_short_1mu" | "negative_day_short_1mu";
  ownerTaskId: string;
  conversationId: string;
  upperMu: number;
  serverCountBefore: number;
  serverCountAfter: number;
  serverCountDelta: number;
  taskAccountBefore: BudgetAccountRow | null;
  taskAccountAfter: BudgetAccountRow | null;
  dayAccountBefore: BudgetAccountRow | null;
  dayAccountAfter: BudgetAccountRow | null;
  reservationsCreated: BudgetReservationRow[];
  view1Denials: Array<{ code: string; message: string; purpose: string; ownerTaskId: string }>;
  status: "PASS" | "FAIL";
}

async function loginCookie(baseUrl: string, token: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ token }),
  });
  assert.equal(res.status, 200, "W1-A login must succeed");
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie && setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Strict"));
  return setCookie.split(";")[0]!;
}

async function getSnapshot(baseUrl: string, cookie: string, convId: string) {
  const res = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(convId)}/snapshot`, {
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as {
    conversationId: string;
    budgetDenials: Array<{ code: string; message: string; purpose: string; ownerTaskId: string }>;
    budgetReservations: BudgetReservationRow[];
    budgetAccounts: BudgetAccountRow[];
  };
}

export async function runW1A(opts?: { dataDir?: string; evidenceDir?: string }) {
  const runId = `w1a_${randomUUID().slice(0, 8)}`;
  const rootDir = path.resolve(opts?.dataDir ?? `.tmp-week1-w1a-${Date.now()}`);
  const evidenceDir = opts?.evidenceDir ? path.resolve(opts.evidenceDir) : path.join(rootDir, "evidence");
  mkdirSync(rootDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });

  const UPPER_MU = 100;
  const ACTUAL_MU = 60;
  const fixedNow = Date.now();
  const chargeDay = formatChargeDay(fixedNow, DEFAULT_TIME_ZONE);
  const dayAcctId = dayAccountIdFor(chargeDay, DEFAULT_TIME_ZONE);
  const consoleToken = "SYNTHETIC_CONSOLE_TOKEN_W1A";

  const fakeModel = await startFakeModelServer(path.join(rootDir, "fake-model"));
  const vault = new HostCredentialVault();
  vault.registerSlot(
    {
      slotId: "slot:w1a",
      provider: "fake-local",
      allowedBaseUrls: [fakeModel.baseUrl],
      allowedModelIds: ["fake-router-1", "fake-worker-1"],
      priceVersion: "synthetic-100-60",
    },
    "SYNTHETIC_MODEL_KEY_W1A",
  );

  const priceSchedule = {
    priceVersion: "synthetic-100-60",
    inputPerMTokMu: 300_000,
    outputPerMTokMu: 1_200_000,
    syntheticFixedUpperMu: UPPER_MU,
    syntheticFixedActualMu: ACTUAL_MU,
  };

  const modelSlots: ModelSlotConfig[] = [
    {
      slotName: "router",
      provider: "fake-local",
      modelId: "fake-router-1",
      baseUrl: fakeModel.baseUrl,
      credentialSlotId: "slot:w1a",
      contextWindow: 128_000,
      maxTokens: 1024,
      priceSchedule,
      outboundAuthorized: true,
    },
    {
      slotName: "worker",
      provider: "fake-local",
      modelId: "fake-worker-1",
      baseUrl: fakeModel.baseUrl,
      credentialSlotId: "slot:w1a",
      contextWindow: 128_000,
      maxTokens: 1024,
      priceSchedule,
      outboundAuthorized: true,
    },
  ];

  const host = await AegisHostRuntime.start({
    dataDir: path.join(rootDir, "host-data"),
    vault,
    modelSlots,
    smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "unused@local.test" },
    now: () => fixedNow,
    defaultTaskLimitMu: 800_000,
    defaultDayLimitMu: 5_000_000,
    compactionKeepRecentTokens: 15,
    compactionReserveTokens: 256,
  });

  const web = await startWebServer({
    host,
    bindHost: "127.0.0.1",
    port: 0,
    consoleToken,
    now: () => fixedNow,
  });

  const cases: CaseEvidence[] = [];

  try {
    const cookie = await loginCookie(web.baseUrl, consoleToken);
    const readReservationsForTask = (ownerTaskId: string): BudgetReservationRow[] =>
      host.govDb
        .prepare("SELECT * FROM budget_reservations WHERE owner_task_id = ? ORDER BY reserved_at ASC")
        .all(ownerTaskId) as unknown as BudgetReservationRow[];

    // =========================================================================
    // 1. POSITIVE CONTROLS (Router, Worker, Compaction)
    // =========================================================================

    // 1A: Router positive control
    await fakeModel.queue({
      clear: true,
      scripts: [{ kind: "text", text: "Router positive control reply " + "alpha ".repeat(80) }],
    });
    const routerCtrlTask = "w1a-ctrl-router";
    const routerCtrlConv = await host.createManagedConversation({
      slotName: "router",
      budgetTaskId: routerCtrlTask,
    });
    const srvBeforeRC = (await fakeModel.stats()).totalPhysicalRequests;
    const tBeforeRC = getBudgetAccount(host.govDb, taskAccountIdFor(routerCtrlTask));
    const dBeforeRC = getBudgetAccount(host.govDb, dayAcctId);
    const subRC = await routerCtrlConv.submit(
      { type: "input", content: "Router positive control prompt " + "lorem ".repeat(60) },
      BACKGROUND_CONTEXT,
    );
    await subRC.wait(BACKGROUND_CONTEXT);
    await new Promise((r) => setTimeout(r, 40));
    const srvAfterRC = (await fakeModel.stats()).totalPhysicalRequests;
    const tAfterRC = getBudgetAccount(host.govDb, taskAccountIdFor(routerCtrlTask))!;
    const dAfterRC = getBudgetAccount(host.govDb, dayAcctId)!;
    const resRC = readReservationsForTask(routerCtrlTask);
    assert.equal(srvAfterRC - srvBeforeRC, 1, "Router control must send exactly 1 physical request");
    assert.equal(tAfterRC.held_mu, 0);
    assert.equal(tAfterRC.charged_mu, ACTUAL_MU);
    assert.equal(resRC.length, 1);
    assert.equal(resRC[0]?.state, "SETTLED");
    cases.push({
      caseId: "W1A-CTRL-ROUTER",
      entry: "router",
      kind: "positive_control",
      ownerTaskId: routerCtrlTask,
      conversationId: String(routerCtrlConv.id),
      upperMu: UPPER_MU,
      serverCountBefore: srvBeforeRC,
      serverCountAfter: srvAfterRC,
      serverCountDelta: srvAfterRC - srvBeforeRC,
      taskAccountBefore: tBeforeRC,
      taskAccountAfter: tAfterRC,
      dayAccountBefore: dBeforeRC,
      dayAccountAfter: dAfterRC,
      reservationsCreated: resRC,
      view1Denials: (await getSnapshot(web.baseUrl, cookie, String(routerCtrlConv.id))).budgetDenials,
      status: "PASS",
    });

    // 1B: Worker positive control (normal worker slot entry)
    await fakeModel.queue({
      clear: true,
      scripts: [{ kind: "text", text: "Worker positive control reply" }],
    });
    const workerCtrlTask = "w1a-ctrl-worker";
    const workerCtrlConv = await host.createManagedConversation({
      slotName: "worker",
      budgetTaskId: workerCtrlTask,
    });
    const srvBeforeWC = (await fakeModel.stats()).totalPhysicalRequests;
    const tBeforeWC = getBudgetAccount(host.govDb, taskAccountIdFor(workerCtrlTask));
    const dBeforeWC = getBudgetAccount(host.govDb, dayAcctId);
    const subWC = await workerCtrlConv.submit(
      { type: "input", content: "Worker positive control prompt" },
      BACKGROUND_CONTEXT,
    );
    await subWC.wait(BACKGROUND_CONTEXT);
    await new Promise((r) => setTimeout(r, 40));
    const srvAfterWC = (await fakeModel.stats()).totalPhysicalRequests;
    const tAfterWC = getBudgetAccount(host.govDb, taskAccountIdFor(workerCtrlTask))!;
    const dAfterWC = getBudgetAccount(host.govDb, dayAcctId)!;
    const resWC = readReservationsForTask(workerCtrlTask);
    assert.equal(srvAfterWC - srvBeforeWC, 1, "Worker control must send exactly 1 physical request");
    assert.equal(resWC.length, 1);
    assert.equal(resWC[0]?.purpose, "worker");
    assert.equal(resWC[0]?.state, "SETTLED");
    cases.push({
      caseId: "W1A-CTRL-WORKER",
      entry: "worker",
      kind: "positive_control",
      ownerTaskId: workerCtrlTask,
      conversationId: String(workerCtrlConv.id),
      upperMu: UPPER_MU,
      serverCountBefore: srvBeforeWC,
      serverCountAfter: srvAfterWC,
      serverCountDelta: srvAfterWC - srvBeforeWC,
      taskAccountBefore: tBeforeWC,
      taskAccountAfter: tAfterWC,
      dayAccountBefore: dBeforeWC,
      dayAccountAfter: dAfterWC,
      reservationsCreated: resWC,
      view1Denials: (await getSnapshot(web.baseUrl, cookie, String(workerCtrlConv.id))).budgetDenials,
      status: "PASS",
    });

    // 1C: Compaction positive control (seed 2nd turn on routerCtrlConv, then trigger real compact())
    await fakeModel.queue({
      clear: true,
      scripts: [
        { kind: "text", text: "Seed turn 2 " + "beta ".repeat(80) },
        { kind: "text", text: "## Goal\nCompacted summary control" },
      ],
    });
    const subSeed = await routerCtrlConv.submit(
      { type: "input", content: "Seed prompt 2 " + "ipsum ".repeat(60) },
      BACKGROUND_CONTEXT,
    );
    await subSeed.wait(BACKGROUND_CONTEXT);
    await new Promise((r) => setTimeout(r, 40));

    const compactCtrlTask = "w1a-ctrl-compaction";
    const srvBeforeCC = (await fakeModel.stats()).totalPhysicalRequests;
    const tBeforeCC = getBudgetAccount(host.govDb, taskAccountIdFor(compactCtrlTask));
    const dBeforeCC = getBudgetAccount(host.govDb, dayAcctId);
    const cTaskId = await routerCtrlConv.compact("Compact control", BACKGROUND_CONTEXT);
    host.bindPiTaskBudgetOwner(cTaskId, routerCtrlConv.id, compactCtrlTask, "compaction");
    await host.harness.waitForTask(cTaskId, BACKGROUND_CONTEXT);
    await new Promise((r) => setTimeout(r, 40));
    const srvAfterCC = (await fakeModel.stats()).totalPhysicalRequests;
    const tAfterCC = getBudgetAccount(host.govDb, taskAccountIdFor(compactCtrlTask))!;
    const dAfterCC = getBudgetAccount(host.govDb, dayAcctId)!;
    const resCC = readReservationsForTask(compactCtrlTask);
    assert.equal(srvAfterCC - srvBeforeCC, 1, "Compaction control must send exactly 1 physical request");
    assert.equal(resCC.length, 1);
    assert.equal(resCC[0]?.purpose, "compaction");
    assert.equal(resCC[0]?.state, "SETTLED");
    cases.push({
      caseId: "W1A-CTRL-COMPACTION",
      entry: "compaction",
      kind: "positive_control",
      ownerTaskId: compactCtrlTask,
      conversationId: String(routerCtrlConv.id),
      upperMu: UPPER_MU,
      serverCountBefore: srvBeforeCC,
      serverCountAfter: srvAfterCC,
      serverCountDelta: srvAfterCC - srvBeforeCC,
      taskAccountBefore: tBeforeCC,
      taskAccountAfter: tAfterCC,
      dayAccountBefore: dBeforeCC,
      dayAccountAfter: dAfterCC,
      reservationsCreated: resCC,
      view1Denials: (await getSnapshot(web.baseUrl, cookie, String(routerCtrlConv.id))).budgetDenials,
      status: "PASS",
    });

    // Helper: seed a fresh conversation with enough history so compaction will ALWAYS select a cut and reach completeSimple!
    const seedCompactionReadyConv = async (seedTaskId: string): Promise<ConversationId> => {
      // Ensure day limit is ample during seeding
      const curDay = getBudgetAccount(host.govDb, dayAcctId)!;
      setBudgetAccountLimit(host.govDb, {
        accountId: dayAcctId,
        kind: "DAY",
        limitMu: curDay.charged_mu + 100_000,
        now: fixedNow,
        approvedBy: "test-harness",
      });
      await fakeModel.queue({
        clear: true,
        scripts: [
          { kind: "text", text: "Seed A " + "gamma ".repeat(80) },
          { kind: "text", text: "Seed B " + "delta ".repeat(80) },
        ],
      });
      const conv = await host.createManagedConversation({ slotName: "router", budgetTaskId: seedTaskId });
      const sA = await conv.submit({ type: "input", content: "Seed user A " + "word ".repeat(60) }, BACKGROUND_CONTEXT);
      await sA.wait(BACKGROUND_CONTEXT);
      const sB = await conv.submit({ type: "input", content: "Seed user B " + "word ".repeat(60) }, BACKGROUND_CONTEXT);
      await sB.wait(BACKGROUND_CONTEXT);
      await new Promise((r) => setTimeout(r, 40));
      return conv.id;
    };

    const setDayAvailable = (wantAvail: number): BudgetAccountRow => {
      const cur = getBudgetAccount(host.govDb, dayAcctId)!;
      assert.equal(cur.held_mu, 0, "Day account must have 0 residual held_mu before test");
      return setBudgetAccountLimit(host.govDb, {
        accountId: dayAcctId,
        kind: "DAY",
        limitMu: cur.charged_mu + wantAvail,
        now: fixedNow,
        approvedBy: "test-harness",
      });
    };

    // =========================================================================
    // 2. SIX NEGATIVE CASES: Task/Day balance = UPPER_MU - 1 (99 microUSD)
    //    across Router, Worker, and Compaction normal entry points
    // =========================================================================

    const runNegativeCase = async (cfg: {
      caseId: string;
      entry: "router" | "worker" | "compaction";
      shortAccount: "task" | "day";
    }): Promise<void> => {
      // For compaction negative cases, seed history under the conversation's OWN host-bound task account,
      // then tighten that EXACT host-bound task (or day) account to UPPER_MU - 1 (99) before calling
      // POST /api/conversations/:id/compact WITHOUT any client-supplied budgetTaskId!
      const ownerTaskId = `w1a-neg-${cfg.entry}-${cfg.shortAccount}`;
      const taskAcctId = taskAccountIdFor(ownerTaskId);

      let convId: ConversationId;
      if (cfg.entry === "compaction") {
        convId = await seedCompactionReadyConv(ownerTaskId);
      } else {
        const conv = await host.createManagedConversation({
          slotName: cfg.entry,
          budgetTaskId: ownerTaskId,
        });
        convId = conv.id;
      }

      const existingTask = getBudgetAccount(host.govDb, taskAcctId);
      const taskChargedAlready = existingTask?.charged_mu ?? 0;
      const reservationsBefore = readReservationsForTask(ownerTaskId);

      // Set exact balances: short account gets UPPER_MU - 1 (99) available, other gets ample (10000) available
      if (cfg.shortAccount === "task") {
        setBudgetAccountLimit(host.govDb, {
          accountId: taskAcctId,
          kind: "TASK",
          limitMu: taskChargedAlready + (UPPER_MU - 1),
          now: fixedNow,
          approvedBy: "test-harness",
        });
        setDayAvailable(10_000);
      } else {
        setBudgetAccountLimit(host.govDb, {
          accountId: taskAcctId,
          kind: "TASK",
          limitMu: taskChargedAlready + 10_000,
          now: fixedNow,
          approvedBy: "test-harness",
        });
        setDayAvailable(UPPER_MU - 1);
      }

      const tBefore = getBudgetAccount(host.govDb, taskAcctId)!;
      const dBefore = getBudgetAccount(host.govDb, dayAcctId)!;
      assert.equal(
        availableMu(cfg.shortAccount === "task" ? tBefore : dBefore),
        UPPER_MU - 1,
        `${cfg.caseId}: short account must have exactly ${UPPER_MU - 1} microUSD available`,
      );

      await fakeModel.queue({
        clear: true,
        scripts: [{ kind: "text", text: "SHOULD_NEVER_BE_REACHED" }],
      });
      const srvBefore = (await fakeModel.stats()).totalPhysicalRequests;

      // Trigger through NORMAL Web entry point WITHOUT client-supplied budgetTaskId (host owns budget binding!)
      if (cfg.entry === "compaction") {
        const resp = await fetch(`${web.baseUrl}/api/conversations/${convId}/compact`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin: web.baseUrl },
          body: JSON.stringify({ instructions: "Compact under short budget" }),
        });
        assert.equal(resp.status, 200);
        const body = (await resp.json()) as { compactionTaskId: number };
        await host.harness.waitForTask(body.compactionTaskId as TaskId, BACKGROUND_CONTEXT);
      } else {
        const resp = await fetch(`${web.baseUrl}/api/conversations/${convId}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin: web.baseUrl },
          body: JSON.stringify({
            content: `Trigger ${cfg.entry} with short ${cfg.shortAccount} budget`,
            chatKey: `w1a-${cfg.caseId}`,
            runtimeEpoch: host.runtimeEpoch,
          }),
        });
        assert.equal(resp.status, 200);
        const body = (await resp.json()) as { submissionId: number };
        const sub = await host.harness.submission(body.submissionId as never, BACKGROUND_CONTEXT);
        assert.ok(sub);
        await sub.wait(BACKGROUND_CONTEXT);
      }

      await new Promise((r) => setTimeout(r, 40));

      const srvAfter = (await fakeModel.stats()).totalPhysicalRequests;
      const tAfter = getBudgetAccount(host.govDb, taskAcctId)!;
      const dAfter = getBudgetAccount(host.govDb, dayAcctId)!;
      const reservationsAfter = readReservationsForTask(ownerTaskId);
      const newReservations = reservationsAfter.slice(reservationsBefore.length);
      const snap = await getSnapshot(web.baseUrl, cookie, String(convId));
      const matchingDenials = snap.budgetDenials.filter((d) => d.ownerTaskId === ownerTaskId);

      // Hard assertions for W1-A
      assert.equal(srvAfter - srvBefore, 0, `${cfg.caseId}: fake model server MUST receive 0 physical requests`);
      assert.equal(tAfter.held_mu, 0, `${cfg.caseId}: task account must have 0 residual held_mu`);
      assert.equal(dAfter.held_mu, 0, `${cfg.caseId}: day account must have 0 residual held_mu`);
      assert.deepEqual(tAfter, tBefore, `${cfg.caseId}: task account must be unchanged`);
      assert.deepEqual(dAfter, dBefore, `${cfg.caseId}: day account must be unchanged`);
      assert.equal(newReservations.length, 0, `${cfg.caseId}: zero new budget_reservations rows created`);
      assert.ok(matchingDenials.length >= 1, `${cfg.caseId}: View 1 snapshot must show specific denial reason`);
      const expectedCode = cfg.shortAccount === "task" ? "task_budget_exceeded" : "day_budget_exceeded";
      assert.equal(matchingDenials[0]?.code, expectedCode, `${cfg.caseId}: denial code must be ${expectedCode}`);
      assert.equal(matchingDenials[0]?.purpose, cfg.entry, `${cfg.caseId}: denial purpose must be ${cfg.entry}`);

      cases.push({
        caseId: cfg.caseId,
        entry: cfg.entry,
        kind: cfg.shortAccount === "task" ? "negative_task_short_1mu" : "negative_day_short_1mu",
        ownerTaskId,
        conversationId: String(convId),
        upperMu: UPPER_MU,
        serverCountBefore: srvBefore,
        serverCountAfter: srvAfter,
        serverCountDelta: srvAfter - srvBefore,
        taskAccountBefore: tBefore,
        taskAccountAfter: tAfter,
        dayAccountBefore: dBefore,
        dayAccountAfter: dAfter,
        reservationsCreated: newReservations,
        view1Denials: matchingDenials,
        status: "PASS",
      });
    };

    await runNegativeCase({ caseId: "W1A-NEG-1-ROUTER-TASK", entry: "router", shortAccount: "task" });
    await runNegativeCase({ caseId: "W1A-NEG-2-ROUTER-DAY", entry: "router", shortAccount: "day" });
    await runNegativeCase({ caseId: "W1A-NEG-3-WORKER-TASK", entry: "worker", shortAccount: "task" });
    await runNegativeCase({ caseId: "W1A-NEG-4-WORKER-DAY", entry: "worker", shortAccount: "day" });
    await runNegativeCase({ caseId: "W1A-NEG-5-COMPACTION-TASK", entry: "compaction", shortAccount: "task" });
    await runNegativeCase({ caseId: "W1A-NEG-6-COMPACTION-DAY", entry: "compaction", shortAccount: "day" });

    const finalFakeStats = await fakeModel.stats();
    const report = {
      suite: "W1-A",
      runId,
      status: "PASS",
      environment: {
        nodeVersion: process.version,
        sqliteVersion: process.versions.sqlite,
        platform: process.platform,
        zone: DEFAULT_TIME_ZONE,
        chargeDay,
      },
      priceModel: { upperMu: UPPER_MU, actualMu: ACTUAL_MU },
      fakeModelFinalPhysicalRequests: finalFakeStats.totalPhysicalRequests,
      cases,
    };

    const outPath = path.join(evidenceDir, "w1-a-evidence.json");
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    return { report, evidencePath: outPath };
  } finally {
    await web.close().catch(() => {});
    await host.close().catch(() => {});
    await fakeModel.stop().catch(() => {});
  }
}

if (import.meta.url === new URL(`file:///${process.argv[1]!.replace(/\\/g, "/")}`).href) {
  const args = parseArgs(process.argv.slice(2));
  const { report, evidencePath } = await runW1A({
    dataDir: args["data-dir"],
    evidenceDir: args["evidence-dir"],
  });
  console.log(JSON.stringify({ ...report, evidencePath }, null, 2));
}

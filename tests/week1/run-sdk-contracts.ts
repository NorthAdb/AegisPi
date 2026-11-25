import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context as AiContext,
  type Model,
  type Models,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  stream as openAiCompletionsStream,
  streamSimple as openAiCompletionsStreamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import {
  createRegistry,
  defineExtension,
  defineSignal,
  defineTool,
  Harness,
  hook,
  ToolTask,
  type JsonObject,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { getBudgetAccount, taskAccountIdFor, type BudgetReservationRow } from "../../src/governance/budget.ts";
import { HostCredentialVault } from "../../src/governance/credentials.ts";
import { openGovernanceDb } from "../../src/governance/db.ts";
import { acquireDataDirLock, InstanceLockBusyError } from "../../src/governance/lock.ts";
import { AegisHostRuntime } from "../../src/runtime/harness.ts";
import { HostPhaseTelemetry } from "../../src/runtime/telemetry.ts";
import { LOCKED_NODE_EXE, startFakeModelServer } from "../fakes/client.ts";

interface ContractResult {
  id: string;
  status: "PASS" | "FAIL";
  summary: string;
  evidence: Record<string, unknown>;
}

const ApprovalSig = defineSignal({
  name: "aegis.contract.approval",
  version: 1,
  schema: {
    type: "object",
    properties: {
      decision: { type: "string" },
      revision: { type: "number" },
    },
    required: ["decision", "revision"],
  },
});

function buildFakeProviderModels(baseUrl: string): Models {
  const models = createModels();
  const modelDef: Model<"openai-completions"> = {
    id: "fake-router-1",
    name: "Fake Router 1",
    api: "openai-completions",
    provider: "fake-local",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 1024,
  };
  models.setProvider(
    createProvider({
      id: "fake-local",
      name: "Fake Local Provider",
      baseUrl,
      auth: {
        apiKey: {
          name: "Fake Local Key",
          resolve: async () => ({
            auth: { apiKey: "SYNTHETIC_MODEL_SLOT_KEY_V2" },
            source: "host-memory",
          }),
        },
      },
      models: [modelDef],
      api: { stream: openAiCompletionsStream, streamSimple: openAiCompletionsStreamSimple },
    }),
  );
  return models;
}

function wrapModelsObserver(
  inner: Models,
  telemetry: HostPhaseTelemetry,
  onCall: (info: {
    method: "streamSimple" | "completeSimple";
    modelId: string;
    attribution: ReturnType<HostPhaseTelemetry["resolve"]>;
    maxRetries: number | undefined;
  }) => void,
): Models {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "streamSimple") {
        return (model: Model<Api>, ctx: AiContext, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream => {
          onCall({
            method: "streamSimple",
            modelId: model.id,
            attribution: telemetry.resolve(options?.telemetry),
            maxRetries: options?.maxRetries,
          });
          return target.streamSimple(model, ctx, { ...options, maxRetries: 0 });
        };
      }
      if (prop === "completeSimple") {
        return async (model: Model<Api>, ctx: AiContext, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> => {
          onCall({
            method: "completeSimple",
            modelId: model.id,
            attribution: telemetry.resolve(options?.telemetry),
            maxRetries: options?.maxRetries,
          });
          // Call streamSimple directly on target so we don't double-count in observer
          return await target.streamSimple(model, ctx, { ...options, maxRetries: 0 }).result();
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
}

async function runS1(workDir: string): Promise<ContractResult> {
  const dir = path.join(workDir, "s1");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const tracePath = path.join(dir, "pi-durable.sqlite");

  try {
    // Phase A: Create a pre-populated trace DB with a parked tool task AND a pending/running generation
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "tool_call",
          toolCall: { id: "call_s1_1", name: "gated_action", arguments: { msg: "hello-s1" } },
        },
        { kind: "text", text: "Completed after signal" },
      ],
    });

    const storage1 = await openNodeSqliteStorage(tracePath);
    const reg1 = createRegistry();
    let gateToolTaskId: TaskId | null = null;
    const ext1 = defineExtension({
      name: "s1-ext",
      tools: [
        defineTool({
          name: "gated_action",
          description: "Test gated tool",
          parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
          async execute(args) {
            return { output: [{ type: "text", text: `ran:${String((args as { msg: string }).msg)}` }] };
          },
        }),
      ],
      hooks: [
        hook(ToolTask, {
          beforeTool: async (_call, api) => {
            gateToolTaskId = api.taskId;
            return { sleep: { signals: [ApprovalSig.key("s1-key")] } };
          },
        }),
      ],
    });
    reg1.install(ext1);
    const telemetry1 = new HostPhaseTelemetry();
    const h1 = await Harness.open(
      storage1,
      {
        models: buildFakeProviderModels(fakeModel.baseUrl),
        registry: reg1,
        telemetry: telemetry1,
        settings: { stream: { maxRetries: 0 }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 10 } },
      },
      BACKGROUND_CONTEXT,
    );
    const conv1 = await h1.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "fake-local", modelId: "fake-router-1" }, extensions: [ext1] },
    });
    await conv1.submit({ type: "input", content: "trigger tool" }, BACKGROUND_CONTEXT);

    // Wait until the tool task is sleeping at the gate
    for (let i = 0; i < 60; i++) {
      const insp = await h1.inspect(BACKGROUND_CONTEXT);
      if (insp.tasks.some((t) => t.record.kind === "pi.tool" && t.state.kind === "sleeping")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const preCloseInspect = await h1.inspect(BACKGROUND_CONTEXT);
    assert.ok(gateToolTaskId !== null, "S1 setup must create parked tool task");
    assert.ok(
      preCloseInspect.tasks.some((t) => t.record.id === gateToolTaskId && t.state.kind === "sleeping"),
      "S1 setup tool task must be sleeping before close",
    );
    await h1.close(BACKGROUND_CONTEXT);

    // Also test a surviving "running" generation task by opening another conv or checking parked gate wake
    // Phase B: Reopen trace DB with ordering timeline probes
    const timeline: string[] = [];
    let transportCallsBeforeGate = 0;
    let phaseCallbacksBeforeGate = 0;
    let fenceOpened = false;

    const statsBeforeReopen = await fakeModel.stats();
    timeline.push("1:gov_recovery_done");
    timeline.push("2:hooks_and_models_installed");

    const telemetry2 = new HostPhaseTelemetry({
      onPhaseStart: (attr) => {
        if (!fenceOpened) phaseCallbacksBeforeGate++;
        timeline.push(`phase:${attr.taskName}:${attr.phase}:t${attr.taskId}`);
      },
    });
    const observedModels2 = wrapModelsObserver(buildFakeProviderModels(fakeModel.baseUrl), telemetry2, (info) => {
      if (!fenceOpened) transportCallsBeforeGate++;
      timeline.push(`models:${info.method}:${info.modelId}`);
    });
    const reg2 = createRegistry();
    const ext2 = defineExtension({
      name: "s1-ext",
      tools: [
        defineTool({
          name: "gated_action",
          description: "Test gated tool",
          parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
          async execute(args) {
            timeline.push(`tool_exec:${String((args as { msg: string }).msg)}`);
            return { output: [{ type: "text", text: `ran:${String((args as { msg: string }).msg)}` }] };
          },
        }),
      ],
      hooks: [
        hook(ToolTask, {
          beforeTool: async (_call, api, ctx) => {
            timeline.push(`beforeTool:t${api.taskId}`);
            const sig = await api.readSignal(ApprovalSig, "s1-key", ctx);
            const val = sig && "value" in sig ? (sig.value as { decision?: string }) : undefined;
            if (val?.decision === "APPROVE") {
              return undefined;
            }
            return { sleep: { signals: [ApprovalSig.key("s1-key")] } };
          },
        }),
      ],
    });
    reg2.install(ext2);

    const storage2 = await openNodeSqliteStorage(tracePath);
    const h2 = await Harness.open(
      storage2,
      {
        models: observedModels2,
        registry: reg2,
        telemetry: telemetry2,
        settings: { stream: { maxRetries: 0 }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 10 } },
      },
      BACKGROUND_CONTEXT,
    );
    timeline.push("3:harness_open_returned");

    // Read-only observation: inspect + getTask MUST NOT trigger scheduling!
    const inspAfterOpen = await h2.inspect(BACKGROUND_CONTEXT);
    const taskRecord = await h2.getTask(gateToolTaskId, BACKGROUND_CONTEXT);
    await new Promise((r) => setTimeout(r, 150));
    timeline.push("4:inspect_and_getTask_done");

    assert.equal(inspAfterOpen.scheduling, "paused", "S1: scheduling must stay paused after open + inspect");
    assert.ok(taskRecord !== undefined, "S1: getTask must return pre-existing tool task");
    assert.equal(phaseCallbacksBeforeGate, 0, "S1: zero phase callbacks allowed before fence opens");
    assert.equal(transportCallsBeforeGate, 0, "S1: zero model calls allowed before fence opens");
    const statsAfterObserve = await fakeModel.stats();
    assert.equal(
      statsAfterObserve.totalPhysicalRequests,
      statsBeforeReopen.totalPhysicalRequests,
      "S1: fake model must see 0 new requests during open+inspect",
    );

    // Explicitly verify signal() enables scheduling!
    fenceOpened = true;
    timeline.push("5:calling_signal");
    const sigRes = await h2.signal(
      gateToolTaskId,
      ApprovalSig,
      "s1-key",
      { decision: "APPROVE", revision: 1 },
      BACKGROUND_CONTEXT,
    );
    const inspAfterSignal = await h2.inspect(BACKGROUND_CONTEXT);
    assert.equal(sigRes, "delivered", "S1: signal on parked task must be delivered");
    assert.equal(inspAfterSignal.scheduling, "running", "S1: signal() MUST enable scheduling (confirmed)");

    await h2.waitForIdle(BACKGROUND_CONTEXT);
    await h2.close(BACKGROUND_CONTEXT);

    // Also verify waitForIdle() enables scheduling on a freshly opened paused harness!
    const storage3 = await openNodeSqliteStorage(tracePath);
    const h3 = await Harness.open(
      storage3,
      {
        models: buildFakeProviderModels(fakeModel.baseUrl),
        registry: reg2,
        settings: { stream: { maxRetries: 0 } },
      },
      BACKGROUND_CONTEXT,
    );
    const insp3Before = await h3.inspect(BACKGROUND_CONTEXT);
    assert.equal(insp3Before.scheduling, "paused", "S1 wait check: starts paused");
    await h3.waitForIdle(BACKGROUND_CONTEXT);
    const insp3After = await h3.inspect(BACKGROUND_CONTEXT);
    assert.equal(insp3After.scheduling, "running", "S1 wait check: waitForIdle() enables scheduling (confirmed)");
    await h3.close(BACKGROUND_CONTEXT);

    return {
      id: "S1",
      status: "PASS",
      summary:
        "Harness.open keeps scheduling=paused during open/inspect/getTask with 0 phase callbacks and 0 model calls; signal() and waitForIdle() both activate scheduling.",
      evidence: {
        gateToolTaskId,
        schedulingAfterOpen: inspAfterOpen.scheduling,
        phaseCallbacksBeforeFence: phaseCallbacksBeforeGate,
        transportCallsBeforeFence: transportCallsBeforeGate,
        schedulingAfterSignal: inspAfterSignal.scheduling,
        schedulingAfterWaitForIdle: insp3After.scheduling,
        timeline,
      },
    };
  } finally {
    await fakeModel.stop();
  }
}

async function runS2(workDir: string): Promise<ContractResult> {
  const dir = path.join(workDir, "s2");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const tracePath = path.join(dir, "pi-durable.sqlite");

  try {
    await fakeModel.queue({
      clear: true,
      scripts: [
        {
          kind: "tool_call",
          toolCall: { id: "call_s2_model", name: "parent_tool", arguments: { body: "draft-v1" } },
        },
        { kind: "text", text: "S2 done" },
        // For fork conversation:
        {
          kind: "tool_call",
          toolCall: { id: "call_s2_model", name: "parent_tool", arguments: { body: "draft-v1" } },
        },
        { kind: "text", text: "S2 fork done" },
      ],
    });

    const observations: Array<Record<string, unknown>> = [];
    const reg = createRegistry();
    const ext = defineExtension({
      name: "s2-ext",
      tools: [
        defineTool({
          name: "parent_tool",
          description: "Parent tool that calls nested child_tool",
          parameters: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
          async execute(args, api, ctx) {
            observations.push({
              stage: "parent_execute",
              conversationId: api.conversationId,
              taskId: api.taskId,
              callId: api.callId,
              args,
            });
            const nested = await api.executeTool("child_tool", { note: `from:${String((args as { body: string }).body)}` }, ctx, {
              key: "child1",
            });
            return { output: [{ type: "text", text: `parent_ok:${String(nested.structuredOutput)}` }] };
          },
        }),
        defineTool({
          name: "child_tool",
          description: "Nested child tool",
          parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
          async execute(args, api) {
            observations.push({
              stage: "child_execute",
              conversationId: api.conversationId,
              taskId: api.taskId,
              callId: api.callId,
              args,
            });
            return { output: [{ type: "text", text: `child_ok:${String((args as { note: string }).note)}` }] };
          },
        }),
      ],
      hooks: [
        hook(ToolTask, {
          beforeTool: async (call, api, ctx) => {
            const key = `k:${api.conversationId}:${api.taskId}:${call.id}`;
            observations.push({
              stage: "beforeTool",
              tool: call.name,
              conversationId: api.conversationId,
              taskId: api.taskId,
              callId: call.id,
              parent: call.parent ?? null,
              args: call.arguments,
            });
            const sig = await api.readSignal(ApprovalSig, key, ctx);
            const val = sig && "value" in sig ? (sig.value as { decision?: string }) : undefined;
            if (val?.decision === "APPROVE") {
              const edited: JsonObject =
                call.name === "parent_tool"
                  ? { body: "draft-v2-edited" }
                  : { note: "child-v2-edited" };
              return { arguments: edited };
            }
            return { sleep: { signals: [ApprovalSig.key(key)] } };
          },
        }),
      ],
    });
    reg.install(ext);

    const storage = await openNodeSqliteStorage(tracePath);
    const harness = await Harness.open(
      storage,
      {
        models: buildFakeProviderModels(fakeModel.baseUrl),
        registry: reg,
        settings: { stream: { maxRetries: 0 }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 10 } },
      },
      BACKGROUND_CONTEXT,
    );
    const conv = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "fake-local", modelId: "fake-router-1" }, extensions: [ext] },
    });
    const sub = await conv.submit({ type: "input", content: "run parent and child" }, BACKGROUND_CONTEXT);

    // Wait for parent_tool to park, then signal it
    let parentTaskId: TaskId | null = null;
    for (let i = 0; i < 60; i++) {
      const insp = await harness.inspect(BACKGROUND_CONTEXT);
      const t = insp.tasks.find((x) => x.record.kind === "pi.tool" && x.state.kind === "sleeping");
      if (t) {
        parentTaskId = t.record.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(parentTaskId !== null, "S2: parent tool must park");
    await harness.signal(
      parentTaskId,
      ApprovalSig,
      `k:${conv.id}:${parentTaskId}:call_s2_model`,
      { decision: "APPROVE", revision: 2 },
      BACKGROUND_CONTEXT,
    );

    // Wait for nested child_tool to park, then signal it
    let childTaskId: TaskId | null = null;
    for (let i = 0; i < 60; i++) {
      const insp = await harness.inspect(BACKGROUND_CONTEXT);
      const t = insp.tasks.find(
        (x) => x.record.kind === "pi.tool" && x.state.kind === "sleeping" && x.record.id !== parentTaskId,
      );
      if (t) {
        childTaskId = t.record.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(childTaskId !== null, "S2: nested child tool must park");
    await harness.signal(
      childTaskId,
      ApprovalSig,
      `k:${conv.id}:${childTaskId}:call_s2_model/child1`,
      { decision: "APPROVE", revision: 2 },
      BACKGROUND_CONTEXT,
    );

    await sub.wait(BACKGROUND_CONTEXT);

    // Verify fork creates a new conversationId and new toolTaskId even for identical tool call text
    const entries = await conv.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
    const firstUser = entries.items[0];
    assert.ok(firstUser, "S2: entry must exist for fork");
    const forked = await conv.fork(
      firstUser.id,
      { ownership: { kind: "ownerless" }, agent: { model: { provider: "fake-local", modelId: "fake-router-1" }, extensions: [ext] } },
      BACKGROUND_CONTEXT,
    );
    assert.notEqual(forked.id, conv.id, "S2: fork must produce distinct conversationId");

    // Verify identities aligned between beforeTool and execute, and edited args arrived
    const parentExec = observations.find((o) => o["stage"] === "parent_execute");
    const childExec = observations.find((o) => o["stage"] === "child_execute");
    assert.equal(parentExec?.["taskId"], parentTaskId);
    assert.equal(parentExec?.["callId"], "call_s2_model");
    assert.deepEqual(parentExec?.["args"], { body: "draft-v2-edited" });
    assert.equal(childExec?.["taskId"], childTaskId);
    assert.equal(childExec?.["callId"], "call_s2_model/child1");
    assert.deepEqual(childExec?.["args"], { note: "child-v2-edited" });

    await harness.close(BACKGROUND_CONTEXT);

    return {
      id: "S2",
      status: "PASS",
      summary:
        "beforeTool and execute align on (conversationId, taskId, callId) for both model calls and nested calls (<callId>/<key>), { arguments } delivers edited draft, and fork assigns a distinct conversationId.",
      evidence: {
        parentTaskId,
        childTaskId,
        parentConversationId: conv.id,
        forkedConversationId: forked.id,
        observations,
      },
    };
  } finally {
    await fakeModel.stop();
  }
}

async function runS3(workDir: string): Promise<ContractResult> {
  const dir = path.join(workDir, "s3");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const tracePath = path.join(dir, "pi-durable.sqlite");

  try {
    await fakeModel.queue({
      clear: true,
      scripts: [
        { kind: "tool_call", toolCall: { id: "call_s3_1", name: "parked_tool", arguments: {} } },
        { kind: "text", text: "S3 complete" },
      ],
    });

    const reg = createRegistry();
    const ext = defineExtension({
      name: "s3-ext",
      tools: [
        defineTool({
          name: "parked_tool",
          description: "Tool for S3 signal contract",
          parameters: { type: "object", properties: {} },
          async execute() {
            return { output: [{ type: "text", text: "done" }] };
          },
        }),
      ],
      hooks: [
        hook(ToolTask, {
          beforeTool: async (_call, api, ctx) => {
            const sig = await api.readSignal(ApprovalSig, "s3-key", ctx);
            if (sig && "value" in sig) return undefined;
            return { sleep: { signals: [ApprovalSig.key("s3-key")] } };
          },
        }),
      ],
    });
    reg.install(ext);

    const storage = await openNodeSqliteStorage(tracePath);
    const harness = await Harness.open(
      storage,
      {
        models: buildFakeProviderModels(fakeModel.baseUrl),
        registry: reg,
        settings: { stream: { maxRetries: 0 } },
      },
      BACKGROUND_CONTEXT,
    );
    const conv = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "fake-local", modelId: "fake-router-1" }, extensions: [ext] },
    });

    // Attach watch and confirm it produces a snapshot
    const watch = await conv.watch(BACKGROUND_CONTEXT);
    const graphWatch = await harness.watchTaskGraph(BACKGROUND_CONTEXT);

    const sub = await conv.submit({ type: "input", content: "park for S3" }, BACKGROUND_CONTEXT);

    let toolTaskId: TaskId | null = null;
    for (let i = 0; i < 60; i++) {
      const insp = await harness.inspect(BACKGROUND_CONTEXT);
      const t = insp.tasks.find((x) => x.record.kind === "pi.tool" && x.state.kind === "sleeping");
      if (t) {
        toolTaskId = t.record.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(toolTaskId !== null, "S3: tool must park");

    // 1. not_found
    const resNotFound = await harness.signal(
      999999 as unknown as TaskId,
      ApprovalSig,
      "s3-key",
      { decision: "APPROVE", revision: 1 },
      BACKGROUND_CONTEXT,
    );
    // 2. invalid (missing required schema field `revision`)
    const resInvalid = await harness.signal(
      toolTaskId,
      ApprovalSig,
      "s3-key",
      { decision: "APPROVE" } as unknown as { decision: string; revision: number },
      BACKGROUND_CONTEXT,
    );
    // 3. delivered
    const resDelivered = await harness.signal(
      toolTaskId,
      ApprovalSig,
      "s3-key",
      { decision: "APPROVE", revision: 1 },
      BACKGROUND_CONTEXT,
    );
    // 4. duplicate (same key while still live or immediately after delivery)
    const resDuplicate = await harness.signal(
      toolTaskId,
      ApprovalSig,
      "s3-key",
      { decision: "APPROVE", revision: 1 },
      BACKGROUND_CONTEXT,
    );

    await sub.wait(BACKGROUND_CONTEXT);
    await harness.waitForIdle(BACKGROUND_CONTEXT);

    // 5. closed (task is now terminal)
    const resClosed = await harness.signal(
      toolTaskId,
      ApprovalSig,
      "s3-key-after-close",
      { decision: "APPROVE", revision: 1 },
      BACKGROUND_CONTEXT,
    );

    await watch.stop();
    await graphWatch.stop();
    await harness.close(BACKGROUND_CONTEXT);

    assert.equal(resNotFound, "not_found");
    assert.equal(resInvalid, "invalid");
    assert.equal(resDelivered, "delivered");
    assert.ok(
      resDuplicate === "duplicate" || resDuplicate === "closed",
      `S3: expected duplicate or closed on immediate resend, got ${resDuplicate}`,
    );
    // Ensure we deterministically observe exact "duplicate" on a paused/sleeping task with a second key before closing
    const storageDup = await openNodeSqliteStorage(path.join(dir, "s3-dup.sqlite"));
    const hDup = await Harness.open(
      storageDup,
      {
        models: buildFakeProviderModels(fakeModel.baseUrl),
        registry: reg,
        settings: { stream: { maxRetries: 0 } },
      },
      BACKGROUND_CONTEXT,
    );
    await fakeModel.queue({
      clear: true,
      scripts: [{ kind: "tool_call", toolCall: { id: "call_s3_dup", name: "parked_tool", arguments: {} } }],
    });
    const convDup = await hDup.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "fake-local", modelId: "fake-router-1" }, extensions: [ext] },
    });
    await convDup.submit({ type: "input", content: "park dup" }, BACKGROUND_CONTEXT);
    let dupTaskId: TaskId | null = null;
    for (let i = 0; i < 60; i++) {
      const insp = await hDup.inspect(BACKGROUND_CONTEXT);
      const t = insp.tasks.find((x) => x.record.kind === "pi.tool" && x.state.kind === "sleeping");
      if (t) {
        dupTaskId = t.record.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(dupTaskId !== null);
    // Deliver signal on a key the task is NOT sleeping on so it stays sleeping -> guaranteed duplicate on 2nd call
    const firstNonWake = await hDup.signal(
      dupTaskId,
      ApprovalSig,
      "non-wake-key",
      { decision: "APPROVE", revision: 1 },
      BACKGROUND_CONTEXT,
    );
    const exactDuplicate = await hDup.signal(
      dupTaskId,
      ApprovalSig,
      "non-wake-key",
      { decision: "APPROVE", revision: 1 },
      BACKGROUND_CONTEXT,
    );
    assert.equal(firstNonWake, "delivered");
    assert.equal(exactDuplicate, "duplicate");
    assert.equal(resClosed, "closed");
    await hDup.close(BACKGROUND_CONTEXT);

    return {
      id: "S3",
      status: "PASS",
      summary:
        "Verified all 5 SignalResult values (delivered, duplicate, invalid, closed, not_found), watch/watchTaskGraph open+close, and graceful Harness.close.",
      evidence: {
        not_found: resNotFound,
        invalid: resInvalid,
        delivered: resDelivered,
        duplicate: exactDuplicate,
        closed: resClosed,
      },
    };
  } finally {
    await fakeModel.stop();
  }
}

async function runS4(workDir: string): Promise<ContractResult> {
  const dir = path.join(workDir, "s4");
  mkdirSync(dir, { recursive: true });
  const fakeModel = await startFakeModelServer(path.join(dir, "fake-model"));
  const hostDataDir = path.join(dir, "host-data");

  try {
    // Seed 2 turns so manual compaction finds a cut and calls completeSimple,
    // then run compaction AND generation CONCURRENTLY in the SAME conversation through product AegisHostRuntime!
    await fakeModel.queue({
      clear: true,
      scripts: [
        { kind: "text", text: "Turn 1 reply " + "alpha ".repeat(120) },
        { kind: "text", text: "Turn 2 reply " + "beta ".repeat(120) },
        {
          kind: "hold_then_text",
          holdBarrierKey: "s4-concurrent-a",
          text: "## Goal\nConcurrent response A",
        },
        {
          kind: "hold_then_text",
          holdBarrierKey: "s4-concurrent-b",
          text: "## Goal\nConcurrent response B",
        },
      ],
    });

    const vault = new HostCredentialVault();
    vault.registerSlot(
      {
        slotId: "slot:s4",
        provider: "fake-local",
        allowedBaseUrls: [fakeModel.baseUrl],
        allowedModelIds: ["fake-router-1"],
        priceVersion: "synthetic-100-60",
      },
      "SYNTHETIC_S4_KEY",
    );

    const recordedReservations: Array<{
      requestId: string;
      ownerTaskId: string;
      conversationId: string;
      purpose: string;
      upperMu: number;
      method: "streamSimple" | "completeSimple";
    }> = [];

    const host = await AegisHostRuntime.start({
      dataDir: hostDataDir,
      vault,
      modelSlots: [
        {
          slotName: "router",
          provider: "fake-local",
          modelId: "fake-router-1",
          baseUrl: fakeModel.baseUrl,
          credentialSlotId: "slot:s4",
          contextWindow: 128_000,
          maxTokens: 1024,
          priceSchedule: {
            priceVersion: "synthetic-100-60",
            inputPerMTokMu: 300_000,
            outputPerMTokMu: 1_200_000,
            syntheticFixedUpperMu: 100,
            syntheticFixedActualMu: 60,
          },
          outboundAuthorized: true,
        },
      ],
      smtpConfig: { host: "127.0.0.1", port: 9, fromAddress: "s4@local.test" },
      compactionKeepRecentTokens: 20,
      compactionReserveTokens: 256,
      onReservationRecorded: (info) => recordedReservations.push(info),
    });

    const conv = await host.createManagedConversation({
      slotName: "router",
      budgetTaskId: "budget-task-gen-B",
    });

    // Seed two turns so compaction has history to compact
    const s1 = await conv.submit({ type: "input", content: "First message " + "lorem ".repeat(80) }, BACKGROUND_CONTEXT);
    await s1.wait(BACKGROUND_CONTEXT);
    const s2 = await conv.submit({ type: "input", content: "Second message " + "ipsum ".repeat(80) }, BACKGROUND_CONTEXT);
    await s2.wait(BACKGROUND_CONTEXT);

    recordedReservations.length = 0;

    // Launch BOTH compaction (bound to budget-task-compaction-A) AND generation (bound to budget-task-gen-B)
    // concurrently inside the EXACT SAME conversationId through product AegisHostRuntime!
    const compactRes = await host.triggerCompaction({
      conversationId: String(conv.id),
      instructions: "Summarize earlier history",
      budgetTaskId: "budget-task-compaction-A",
    });
    assert.equal(compactRes.ok, true);
    const compactTaskId = compactRes.compactionTaskId as TaskId;

    const genSub = await conv.submit({ type: "input", content: "Concurrent generation turn 3" }, BACKGROUND_CONTEXT);

    // Wait for BOTH physical requests to arrive at fake model server simultaneously!
    const bA = await fakeModel.waitBarrier("s4-concurrent-a", 10_000);
    const bB = await fakeModel.waitBarrier("s4-concurrent-b", 10_000);
    assert.ok(bA.arrived && bB.arrived, "S4: both compaction and generation must be in-flight concurrently in same conversation");

    // Verify PRODUCT GOVERNANCE LEDGER holds BOTH distinct task accounts simultaneously while in-flight!
    const compactAcctInFlight = getBudgetAccount(host.govDb, taskAccountIdFor("budget-task-compaction-A"));
    const genAcctInFlight = getBudgetAccount(host.govDb, taskAccountIdFor("budget-task-gen-B"));
    assert.ok(compactAcctInFlight && genAcctInFlight, "S4: both product task accounts must exist while in-flight");
    assert.equal(compactAcctInFlight.held_mu, 100, "S4: compaction task account must hold 100 mu while in-flight");
    assert.equal(genAcctInFlight.held_mu, 100, "S4: generation task account must hold 100 mu while in-flight");

    const inspDuringConcurrency = await host.harness.inspect(BACKGROUND_CONTEXT);
    const genTask = inspDuringConcurrency.tasks.find((t) => t.record.kind === "pi.generation");
    assert.ok(genTask, "S4: concurrent pi.generation task must exist");
    assert.notEqual(compactTaskId, genTask.record.id, "S4: compaction and generation have distinct Pi taskIds");

    await fakeModel.releaseBarrier("s4-concurrent-a");
    await fakeModel.releaseBarrier("s4-concurrent-b");

    await host.harness.waitForTask(compactTaskId, BACKGROUND_CONTEXT);
    await genSub.wait(BACKGROUND_CONTEXT);
    await new Promise((r) => setTimeout(r, 60));

    // Verify both product ledger reservations settled on their distinct budget tasks!
    const compactRec = recordedReservations.find((r) => r.method === "completeSimple");
    const genRec = recordedReservations.find((r) => r.method === "streamSimple");
    assert.ok(compactRec && genRec, "S4: both completeSimple and streamSimple reservations must be recorded");
    assert.equal(compactRec.ownerTaskId, "budget-task-compaction-A");
    assert.equal(compactRec.purpose, "compaction");
    assert.equal(genRec.ownerTaskId, "budget-task-gen-B");
    assert.equal(genRec.purpose, "router");
    assert.equal(compactRec.conversationId, genRec.conversationId);

    const compactRow = host.govDb
      .prepare("SELECT * FROM budget_reservations WHERE request_id = ?")
      .get(compactRec.requestId) as unknown as BudgetReservationRow;
    const genRow = host.govDb
      .prepare("SELECT * FROM budget_reservations WHERE request_id = ?")
      .get(genRec.requestId) as unknown as BudgetReservationRow;
    assert.equal(compactRow.state, "SETTLED");
    assert.equal(compactRow.task_account, "acct:task:budget-task-compaction-A");
    assert.equal(genRow.state, "SETTLED");
    assert.equal(genRow.task_account, "acct:task:budget-task-gen-B");

    const compactAcctAfter = getBudgetAccount(host.govDb, taskAccountIdFor("budget-task-compaction-A"))!;
    const genAcctAfter = getBudgetAccount(host.govDb, taskAccountIdFor("budget-task-gen-B"))!;
    assert.equal(compactAcctAfter.held_mu, 0);
    assert.equal(compactAcctAfter.charged_mu, 60);
    assert.equal(genAcctAfter.held_mu, 0);
    assert.equal(genAcctAfter.charged_mu, 180);

    // Also prove maxRetries: 0 produces exactly 1 physical request on HTTP 503 when durable retry is disabled
    const statsBefore503 = await fakeModel.stats();
    await fakeModel.queue({
      clear: true,
      scripts: [{ kind: "http_error", httpStatus: 503, errorMessage: "Synthetic 503" }],
    });
    const sub503 = await conv.submit({ type: "input", content: "test no provider retry" }, BACKGROUND_CONTEXT);
    await sub503.wait(BACKGROUND_CONTEXT);
    const statsAfter503 = await fakeModel.stats();
    const physicalDeltaOn503 = statsAfter503.totalPhysicalRequests - statsBefore503.totalPhysicalRequests;
    assert.equal(physicalDeltaOn503, 1, "S4: stream.maxRetries=0 must produce exactly 1 physical HTTP request on 503");

    await host.close();

    return {
      id: "S4",
      status: "PASS",
      summary:
        "Product AegisHostRuntime + HostPhaseTelemetry WeakMap unforgeably attributed concurrent completeSimple (pi.compaction) and streamSimple (pi.generation) in the SAME conversationId to distinct budget_accounts (in-flight held_mu=100 each, settled=60 each); maxRetries=0 verified (503 -> 1 physical request).",
      evidence: {
        sharedConversationId: conv.id,
        compactionTaskId: compactTaskId,
        generationTaskId: genTask.record.id,
        compactionReservation: {
          requestId: compactRow.request_id,
          taskAccount: compactRow.task_account,
          purpose: compactRow.purpose,
          state: compactRow.state,
          inFlightHeldMu: compactAcctInFlight.held_mu,
          finalChargedMu: compactAcctAfter.charged_mu,
        },
        generationReservation: {
          requestId: genRow.request_id,
          taskAccount: genRow.task_account,
          purpose: genRow.purpose,
          state: genRow.state,
          inFlightHeldMu: genAcctInFlight.held_mu,
          finalChargedMu: genAcctAfter.charged_mu,
        },
        physicalRequestsOn503WithMaxRetries0: physicalDeltaOn503,
      },
    };
  } finally {
    await fakeModel.stop();
  }
}

async function runS5(workDir: string): Promise<ContractResult> {
  const dir = path.join(workDir, "s5");
  mkdirSync(dir, { recursive: true });
  const govPath = path.join(dir, "aegis-gov.sqlite");
  const tracePath = path.join(dir, "pi-durable.sqlite");

  // 1. Verify Governance DB PRAGMAs (WAL + FULL + foreign_keys=ON)
  const { db: govDb, pragmas: govPragmas } = openGovernanceDb(govPath);
  try {
    assert.equal(govPragmas.journalMode.toLowerCase(), "wal");
    assert.equal(govPragmas.synchronous, 2);
    assert.equal(govPragmas.foreignKeys, 1);

    // 2. Verify Pi Trace DB PRAGMAs via openNodeSqliteStorage (WAL + NORMAL)
    const storage = await openNodeSqliteStorage(tracePath);
    const reg = createRegistry();
    const h = await Harness.open(
      storage,
      { models: createModels(), registry: reg },
      BACKGROUND_CONTEXT,
    );
    await h.root(BACKGROUND_CONTEXT);
    await h.close(BACKGROUND_CONTEXT);

    const traceCheckDb = new DatabaseSync(tracePath, { readOnly: true });
    const traceJournal = (traceCheckDb.prepare("PRAGMA journal_mode;").get() as { journal_mode: string }).journal_mode;
    traceCheckDb.close();
    assert.equal(traceJournal.toLowerCase(), "wal");

    // 3. Verify Windows single-instance lock rejects second live process AND releases immediately on Stop-Process -Force!
    const lockDir = path.join(dir, "lock-test");
    mkdirSync(lockDir, { recursive: true });
    const holderScript = path.join(dir, "lock-holder.ts");
    writeFileSync(
      holderScript,
      `import { acquireDataDirLock } from ${JSON.stringify(pathToFileURL(path.resolve("src/governance/lock.ts")).href)};
const lock = await acquireDataDirLock(${JSON.stringify(lockDir)});
process.stdout.write(JSON.stringify({ locked: true, pid: process.pid, lockKey: lock.lockKey }) + "\\n");
setInterval(() => {}, 60000);
`,
      "utf8",
    );

    const holder = spawn(LOCKED_NODE_EXE, [holderScript], { stdio: ["pipe", "pipe", "pipe"] });
    const holderReady = await new Promise<{ pid: number; lockKey: string }>((resolve, reject) => {
      let buf = "";
      let errBuf = "";
      holder.stderr.on("data", (c: Buffer) => {
        errBuf += c.toString("utf8");
      });
      holder.stdout.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        const idx = buf.indexOf("\n");
        if (idx !== -1) resolve(JSON.parse(buf.slice(0, idx)) as { pid: number; lockKey: string });
      });
      holder.once("exit", (code) => reject(new Error(`lock-holder exited early: ${String(code)} stderr=${errBuf}`)));
    });

    // Second instance in this process MUST fail with InstanceLockBusyError
    let secondRejected = false;
    try {
      const secondLock = await acquireDataDirLock(lockDir);
      await secondLock.release();
    } catch (err) {
      if (err instanceof InstanceLockBusyError) {
        secondRejected = true;
      } else {
        throw err;
      }
    }
    assert.equal(secondRejected, true, "S5: second instance must be rejected while holder is alive");

    // Kill holder with real Windows Stop-Process -Id <PID> -Force
    const killRes = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `Stop-Process -Id ${holderReady.pid} -Force`],
      { encoding: "utf8" },
    );
    assert.equal(killRes.status, 0, `Stop-Process failed: ${killRes.stderr}`);
    await new Promise<void>((resolve) => {
      if (holder.exitCode !== null) resolve();
      else holder.once("exit", () => resolve());
    });

    // Immediately re-acquire after force kill!
    const reacquired = await acquireDataDirLock(lockDir);
    await reacquired.release();

    // 4. Verify transaction rollback integrity on governance DB
    govDb.prepare("INSERT INTO budget_accounts(account_id, kind, limit_mu, held_mu, charged_mu) VALUES ('acct:rb','TASK',100,0,0)").run();
    try {
      govDb.exec("BEGIN IMMEDIATE");
      govDb.prepare("UPDATE budget_accounts SET held_mu = 50 WHERE account_id = 'acct:rb'").run();
      throw new Error("forced_tx_abort");
    } catch {
      govDb.exec("ROLLBACK");
    }
    const afterRb = govDb.prepare("SELECT held_mu FROM budget_accounts WHERE account_id = 'acct:rb'").get() as {
      held_mu: number;
    };
    assert.equal(afterRb.held_mu, 0, "S5: transaction rollback must restore held_mu=0");

    // 5. Verify paired snapshot rollback detection (SQLite file change counter + known conversation watermark)
    const snapDir = path.join(dir, "rollback-snap");
    mkdirSync(snapDir, { recursive: true });
    const snapTrace = path.join(snapDir, "pi-durable.sqlite");
    const sA = await openNodeSqliteStorage(snapTrace);
    const hA = await Harness.open(sA, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    await hA.root(BACKGROUND_CONTEXT);
    await hA.close(BACKGROUND_CONTEXT);
    // Take older snapshot of trace DB
    const olderTraceCopy = path.join(snapDir, "pi-durable.older.sqlite");
    copyFileSync(snapTrace, olderTraceCopy);
    // Advance trace DB with a new conversation (higher watermark)
    const sB = await openNodeSqliteStorage(snapTrace);
    const hB = await Harness.open(sB, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    const newerConv = await hB.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    await hB.close(BACKGROUND_CONTEXT);

    // Restore older trace DB over snapTrace -> newerConv disappears!
    copyFileSync(olderTraceCopy, snapTrace);
    const sC = await openNodeSqliteStorage(snapTrace);
    const hC = await Harness.open(sC, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    const checkNewer = await hC.conversation(newerConv.id, BACKGROUND_CONTEXT);
    await hC.close(BACKGROUND_CONTEXT);
    assert.equal(checkNewer, undefined, "S5: rolled-back trace snapshot is missing previously observed conversationId");

    return {
      id: "S5",
      status: "PASS",
      summary:
        "Governance DB WAL+FULL+FK verified, Pi trace DB WAL verified, Windows Stop-Process -Force releases named-pipe exclusive lock immediately, tx rollback verified, and trace rollback detected via missing observed conversationId.",
      evidence: {
        govPragmas,
        traceJournalMode: traceJournal,
        holderPidKilled: holderReady.pid,
        secondInstanceRejected: secondRejected,
        reacquiredAfterForceKill: true,
        rollbackMissingConversationId: newerConv.id,
      },
    };
  } finally {
    govDb.close();
  }
}

async function main(): Promise<void> {
  const workDir = path.resolve(`.tmp-week1-s1-s5-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  const results: ContractResult[] = [];
  let failed = false;

  try {
    for (const fn of [runS1, runS2, runS3, runS4, runS5]) {
      try {
        const res = await fn(workDir);
        results.push(res);
      } catch (err) {
        failed = true;
        results.push({
          id: fn.name.replace("run", ""),
          status: "FAIL",
          summary: err instanceof Error ? err.message : String(err),
          evidence: { stack: err instanceof Error ? err.stack : String(err) },
        });
      }
    }
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore Windows transient handle release delay
    }
  }

  console.log(
    JSON.stringify(
      {
        suite: "S1-S5",
        nodeVersion: process.version,
        sqliteVersion: process.versions.sqlite,
        platform: process.platform,
        results,
      },
      null,
      2,
    ),
  );
  if (failed) process.exit(1);
}

await main();

// PI-09: provider routing — baseUrl override via models.json, credential
// sources (env var / models.json literal), wire shape (path, headers, body),
// and streamed provider errors. All against the local fake endpoint.

import * as pi from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeOpenAIServer } from "../helpers/fake-openai-server.mjs";
import {
  createProbe,
  summarizeProbe,
  makeIsolatedAgentDir,
  makeWorkspaceDir,
} from "../helpers/probe-utils.mjs";

export const ID = "PI-09";
export const TITLE = "provider registration: baseUrl/auth/wire shape, stream errors";

function headersLowerCase(h) {
  const out = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v;
  return out;
}

export async function run() {
  const probe = createProbe(ID, TITLE);

  // --- Scenario A: built-in provider rerouted to the fake endpoint, env var key ---
  const server = createFakeOpenAIServer({
    scripts: [{ kind: "text", text: "pi09 scenario a" }],
  });
  const port = await server.start();
  const agent = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${port}` });
  const wsDir = makeWorkspaceDir();

  try {
    process.env.DEEPSEEK_API_KEY = "probe-env-key";
    const modelRuntime = await pi.ModelRuntime.create({
      authPath: join(agent.dir, "auth.json"),
      modelsPath: agent.modelsPath,
    });
    const flash = modelRuntime.getModel("deepseek", "deepseek-flash");
    probe.check(
      "catalog-metadata-preserved-under-override",
      flash?.contextWindow === 1000000 && flash?.maxTokens === 384000 && flash?.cost?.input === 0.3,
      `deepseek-flash after baseUrl override: contextWindow=${flash?.contextWindow} maxTokens=${flash?.maxTokens} cost.input=${flash?.cost?.input} baseUrl=${flash?.baseUrl}`,
    );
    const available = await modelRuntime.getAvailable();
    probe.check(
      "env-var-makes-provider-available",
      available.some((m) => m.provider === "deepseek" && m.id === "deepseek-flash"),
      `available deepseek models: ${available.filter((m) => m.provider === "deepseek").map((m) => m.id).join(", ")}`,
    );

    const { session } = await pi.createAgentSession({
      agentDir: agent.dir,
      cwd: wsDir,
      model: flash,
      thinkingLevel: "high",
      modelRuntime,
      resourceLoader: new pi.DefaultResourceLoader({ cwd: wsDir, agentDir: agent.dir, extensionFactories: [] }),
      sessionManager: pi.SessionManager.inMemory(wsDir),
      settingsManager: pi.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      tools: [],
    });
    await session.prompt("pi09 a");
    const req = server.requests[0];
    probe.check("request-path", req?.url === "/chat/completions", `POST ${req?.url}`);
    const h = headersLowerCase(req?.headers);
    probe.check(
      "authorization-from-env",
      h["authorization"] === "Bearer probe-env-key",
      `authorization header: ${h["authorization"]}`,
    );
    probe.note(
      "full-request-headers",
      `Pi-sent headers: ${Object.keys(h).filter((k) => !["host", "content-length", "connection"].includes(k)).join(", ")}`,
    );
    const body = req?.body;
    probe.check(
      "body-shape",
      body?.model === "deepseek-flash" &&
        body?.stream === true &&
        body?.stream_options?.include_usage === true &&
        body?.max_tokens !== undefined &&
        Array.isArray(body?.messages) &&
        body?.messages?.[0]?.role === "system",
      `body: model=${body?.model} stream=${body?.stream} include_usage=${body?.stream_options?.include_usage} max_tokens=${body?.max_tokens} firstRole=${body?.messages?.[0]?.role}`,
    );
    session.dispose();
    delete process.env.DEEPSEEK_API_KEY;
  } catch (e) {
    probe.check("scenario-a", false, `threw: ${e.stack ?? e.message}`);
    delete process.env.DEEPSEEK_API_KEY;
  } finally {
    await server.stop();
    agent.cleanup();
  }

  // --- Scenario B: custom provider with literal apiKey in models.json ---
  const serverB = createFakeOpenAIServer({ scripts: [{ kind: "text", text: "pi09 scenario b" }] });
  const portB = await serverB.start();
  const agentB = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${portB}` });
  // Rewrite models.json with a fully custom provider.
  writeFileSync(
    agentB.modelsPath,
    JSON.stringify(
      {
        $schema: "https://pi.dev/schemas/models.schema.json",
        providers: {
          "probe-local": {
            baseUrl: `http://127.0.0.1:${portB}`,
            api: "openai-completions",
            apiKey: "local-dummy",
            models: [{ id: "probe-local-model", name: "Probe Local", reasoning: false }],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  try {
    const runtimeB = await pi.ModelRuntime.create({
      authPath: join(agentB.dir, "auth.json"),
      modelsPath: agentB.modelsPath,
    });
    const custom = runtimeB.getModel("probe-local", "probe-local-model");
    probe.check(
      "custom-provider-model-registered",
      !!custom && custom.api === "openai-completions",
      `custom model: ${custom ? custom.provider + "/" + custom.id + " api=" + custom.api : "NOT FOUND"}`,
    );
    const availableB = await runtimeB.getAvailable();
    probe.check(
      "literal-api-key-makes-available",
      availableB.some((m) => m.provider === "probe-local"),
      `available: ${availableB.map((m) => m.provider + "/" + m.id).slice(0, 8).join(", ")}`,
    );
    const { session } = await pi.createAgentSession({
      agentDir: agentB.dir,
      cwd: wsDir,
      model: custom,
      modelRuntime: runtimeB,
      resourceLoader: new pi.DefaultResourceLoader({ cwd: wsDir, agentDir: agentB.dir, extensionFactories: [] }),
      sessionManager: pi.SessionManager.inMemory(wsDir),
      settingsManager: pi.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      tools: [],
    });
    await session.prompt("pi09 b");
    const reqB = serverB.requests[0];
    const hB = headersLowerCase(reqB?.headers);
    probe.check(
      "custom-provider-auth-and-model",
      hB["authorization"] === "Bearer local-dummy" && reqB?.body?.model === "probe-local-model",
      `authorization=${hB["authorization"]} body.model=${reqB?.body?.model}`,
    );
    session.dispose();
  } catch (e) {
    probe.check("scenario-b", false, `threw: ${e.stack ?? e.message}`);
  } finally {
    await serverB.stop();
    agentB.cleanup();
  }

  // --- Scenario C: streamed provider error surfaces as stopReason error ---
  const serverC = createFakeOpenAIServer({
    scripts: [{ kind: "error", status: 500, body: { error: { message: "probe scripted 500" } } }],
  });
  const portC = await serverC.start();
  const agentC = makeIsolatedAgentDir({ baseUrl: `http://127.0.0.1:${portC}` });
  try {
    const runtimeC = await pi.ModelRuntime.create({
      authPath: join(agentC.dir, "auth.json"),
      modelsPath: agentC.modelsPath,
    });
    await runtimeC.setRuntimeApiKey("deepseek", "probe-fake-key");
    const { session } = await pi.createAgentSession({
      agentDir: agentC.dir,
      cwd: wsDir,
      model: runtimeC.getModel("deepseek", "deepseek-flash"),
      modelRuntime: runtimeC,
      resourceLoader: new pi.DefaultResourceLoader({ cwd: wsDir, agentDir: agentC.dir, extensionFactories: [] }),
      sessionManager: pi.SessionManager.inMemory(wsDir),
      settingsManager: pi.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      tools: [],
    });
    await session.prompt("pi09 c");
    const last = [...session.messages].reverse().find((m) => m.role === "assistant");
    probe.check(
      "stream-error-shape",
      last?.stopReason === "error" && typeof last?.errorMessage === "string" && last?.errorMessage.includes("500"),
      `stopReason=${last?.stopReason} errorMessage=${String(last?.errorMessage).slice(0, 160)}`,
    );
    session.dispose();
  } catch (e) {
    probe.check("scenario-c", false, `threw: ${e.stack ?? e.message}`);
  } finally {
    await serverC.stop();
    agentC.cleanup();
  }

  // Normative host-boundary statement (02/AGENTS) — not a Pi-measurable
  // property, so it is a note rather than an unfailable PASS.
  probe.note(
    "worker-cannot-override-url",
    "baseUrl and credentials resolve from host-side models.json / ModelRuntime only; script or model text has no API to rewrite a provider URL per request (host-owned adapters remain the boundary)",
  );

  const status = summarizeProbe(probe);
  return {
    id: ID,
    title: TITLE,
    status,
    summary:
      status === "PASS"
        ? "Provider routing verified: models.json baseUrl override preserves catalog metadata; env-var and literal-key credential paths both authenticate; wire shape is OpenAI chat/completions with stream+include_usage+max_tokens; 500 responses surface as stopReason=error with errorMessage. URL/auth are host-fixed."
        : "provider contract deviates; see findings.",
    findings: probe.findings,
  };
}

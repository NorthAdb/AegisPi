// PI-01: exact 1.5.2 exports — createAgentSession, resource loading,
// extension binding. Static export checks + minimal isolated run.

import * as pi from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createProbe,
  summarizeProbe,
  makeIsolatedAgentDir,
  makeWorkspaceDir,
  piEnv,
} from "../helpers/probe-utils.mjs";

export const ID = "PI-01";
export const TITLE = "exact 1.5.2 exports, resource loading, extension binding";

const REQUIRED_EXPORTS = [
  "createAgentSession",
  "createAgentSessionRuntime",
  "createAgentSessionServices",
  "AgentSession",
  "SessionManager",
  "SettingsManager",
  "ModelRuntime",
  "ModelRegistry",
  "DefaultResourceLoader",
  "createExtensionRuntime",
  "RpcClient",
  "runRpcMode",
  "runPrintMode",
  "createBashTool",
  "createReadTool",
  "createEditTool",
  "createWriteTool",
  "createGrepTool",
  "createFindTool",
  "createLsTool",
  "createPowerShellTool",
  "createReadOnlyTools",
  "createCodingTools",
  "defineTool",
  "wrapRegisteredTool",
  "wrapRegisteredTools",
  "createCodemodeExtension",
  "createMcpExtension",
  "createToolSearchExtension",
  "loadSkills",
  "loadSkillsFromDir",
  "parseSkillBlock",
  "getAgentDir",
  "VERSION",
];

const REQUIRED_TYPE_EXPORTS = [
  "AgentSessionConfig",
  "AgentSessionEvent",
  "CreateAgentSessionOptions",
  "ExtensionAPI",
  "BeforeAgentStartEvent",
  "BeforeAgentStartUserEvent",
  "BeforeAgentStartCustomEvent",
  "BeforeAgentStartEventResult",
  "ExtensionUIContext",
  "ExtensionUIDialogOptions",
  "VirtualModelDefinition",
  "ModelRoute",
  "ModelRouteRequest",
  "ModelRouteReason",
  "CacheWarmingDecision",
  "CacheWarmingDecisionEvent",
  "ProviderConfig",
  "CodemodeExtensionOptions",
];

export async function run() {
  const probe = createProbe(ID, TITLE);
  const dts = readFileSync(
    join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.d.ts"),
    "utf8",
  );

  for (const name of REQUIRED_EXPORTS) {
    probe.check(
      `export:${name}`,
      typeof pi[name] !== "undefined",
      `runtime export present: ${typeof pi[name]}`,
    );
  }
  for (const name of REQUIRED_TYPE_EXPORTS) {
    probe.check(`type-export:${name}`, dts.includes(name), `name appears in dist/index.d.ts`);
  }

  probe.check(
    "VERSION-matches-lockfile",
    pi.VERSION === "1.5.2",
    `VERSION export = ${pi.VERSION}`,
  );

  // Minimal isolated run: in-memory session manager, no model requests,
  // inline extension registers a tool through DefaultResourceLoader.
  const wsDir = makeWorkspaceDir();
  const agent = makeIsolatedAgentDir({ baseUrl: "http://127.0.0.1:1" });
  let registeredToolSeen = false;
  try {
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: wsDir,
      agentDir: agent.dir,
      extensionFactories: [
        (ext) => {
          ext.registerTool({
            name: "probe_pi01_tool",
            label: "Probe Tool",
            description: "Registers through an inline extension factory",
            parameters: { type: "object", properties: { x: { type: "string" } } },
            execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
          });
          registeredToolSeen = true;
        },
      ],
    });
    await resourceLoader.reload();

    const settingsManager = pi.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const { session } = await pi.createAgentSession({
      agentDir: agent.dir,
      cwd: wsDir,
      resourceLoader,
      sessionManager: pi.SessionManager.inMemory(wsDir),
      settingsManager,
      noTools: true,
    });
    const active = session.getActiveToolNames();
    probe.check(
      "inline-extension-tool-active",
      Array.isArray(active) && active.includes("probe_pi01_tool"),
      `getActiveToolNames() = ${JSON.stringify(active)}`,
    );
    probe.check("extension-factory-ran", registeredToolSeen, "inline factory executed during load");
    session.dispose();
    probe.note("dispose", "session.dispose() completed without error");
  } catch (e) {
    probe.check("minimal-run", false, `threw: ${e.message}`);
  } finally {
    agent.cleanup();
  }

  const status = summarizeProbe(probe);
  return {
    id: ID,
    title: TITLE,
    status,
    summary:
      status === "PASS"
        ? "All required runtime/type exports verified against exact 1.5.2; inline extension tool binding works in an isolated minimal run."
        : "Missing exports or binding failure; see findings.",
    findings: probe.findings,
  };
}

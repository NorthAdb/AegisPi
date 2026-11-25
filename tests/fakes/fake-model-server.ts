import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export interface ModelArrivalRecord {
  seq: number;
  receivedAt: string;
  method: string;
  path: string;
  model: string | null;
  stream: boolean;
  messageCount: number;
  hasAuthHeader: boolean;
  authHeaderDigestPrefix: string | null;
  lastUserPreview: string;
  scriptApplied: string;
  statusCode: number;
  usageSent: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

export interface ScriptedResponse {
  kind: "text" | "tool_call" | "http_error" | "missing_usage" | "hold_then_text";
  text?: string;
  toolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
  httpStatus?: number;
  errorMessage?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
  delayMs?: number;
  holdBarrierKey?: string;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg && arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        out[key] = val;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function appendJsonlDurable(filePath: string, obj: unknown): void {
  const fd = openSync(filePath, "a");
  try {
    appendFileSync(fd, JSON.stringify(obj) + "\n", "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const args = parseArgs(process.argv.slice(2));
const dataDir = args["data-dir"] ? path.resolve(args["data-dir"]) : path.resolve(".tmp-fake-model");
const port = Number(args["port"] ?? "0");
const host = args["host"] ?? "127.0.0.1";

mkdirSync(dataDir, { recursive: true });
const logPath = path.join(dataDir, "model-requests.jsonl");

const records: ModelArrivalRecord[] = readJsonl<ModelArrivalRecord>(logPath);
let defaultScript: ScriptedResponse = {
  kind: "text",
  text: "Synthetic model response ok.",
  usage: { prompt_tokens: 100, completion_tokens: 20 },
};
const scriptedQueue: ScriptedResponse[] = [];
const heldBarriers = new Map<string, Array<() => void>>();
const barrierArrivals = new Set<string>();
const barrierWaiters = new Map<string, Array<() => void>>();

function notifyBarrierArrived(key: string): void {
  barrierArrivals.add(key);
  const waiters = barrierWaiters.get(key);
  if (waiters) {
    barrierWaiters.delete(key);
    for (const w of waiters) w();
  }
}

function writeSseEvent(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}`);

  const sendJson = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  try {
    // Control plane (strictly for test controller & auditor; host never calls these)
    if (url.pathname === "/__control/stats" && req.method === "GET") {
      const diskRecords = readJsonl<ModelArrivalRecord>(logPath);
      sendJson(200, {
        pid: process.pid,
        totalPhysicalRequests: diskRecords.length,
        logPath,
        queuedScripts: scriptedQueue.length,
        arrivedBarriers: [...barrierArrivals],
        records: diskRecords,
      });
      return;
    }

    if (url.pathname === "/__control/queue" && req.method === "POST") {
      const raw = await readBody(req);
      const parsed = raw ? (JSON.parse(raw) as { scripts?: ScriptedResponse[]; clear?: boolean; defaultScript?: ScriptedResponse }) : {};
      if (parsed.clear) {
        scriptedQueue.length = 0;
      }
      if (parsed.defaultScript) {
        defaultScript = parsed.defaultScript;
      }
      if (Array.isArray(parsed.scripts)) {
        scriptedQueue.push(...parsed.scripts);
      }
      sendJson(200, { ok: true, queuedScripts: scriptedQueue.length, totalPhysicalRequests: records.length });
      return;
    }

    if (url.pathname === "/__control/wait-barrier" && req.method === "GET") {
      const key = url.searchParams.get("key") ?? "";
      const timeoutMs = Number(url.searchParams.get("timeoutMs") ?? "15000");
      if (barrierArrivals.has(key)) {
        sendJson(200, { arrived: true, key, totalPhysicalRequests: records.length });
        return;
      }
      const ok = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        const list = barrierWaiters.get(key) ?? [];
        list.push(() => {
          clearTimeout(timer);
          resolve(true);
        });
        barrierWaiters.set(key, list);
      });
      sendJson(ok ? 200 : 408, { arrived: ok, key, totalPhysicalRequests: records.length });
      return;
    }

    if (url.pathname === "/__control/release-barrier" && req.method === "POST") {
      const raw = await readBody(req);
      const parsed = raw ? (JSON.parse(raw) as { key?: string }) : {};
      const key = parsed.key ?? "";
      const waiters = heldBarriers.get(key) ?? [];
      heldBarriers.delete(key);
      for (const release of waiters) release();
      sendJson(200, { ok: true, key, released: waiters.length });
      return;
    }

    if (url.pathname === "/__control/shutdown" && req.method === "POST") {
      sendJson(200, { ok: true, shuttingDown: true });
      setImmediate(() => {
        server.close();
        process.exit(0);
      });
      return;
    }

    // OpenAI Chat Completions compatible endpoint
    if (
      req.method === "POST" &&
      (url.pathname === "/chat/completions" || url.pathname === "/v1/chat/completions")
    ) {
      const raw = await readBody(req);
      const body = (raw ? JSON.parse(raw) : {}) as {
        model?: string;
        stream?: boolean;
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      const script = scriptedQueue.shift() ?? defaultScript;
      const modelName = typeof body.model === "string" ? body.model : "fake-model";
      const isStream = body.stream !== false;
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const lastUserText =
        typeof lastUser?.content === "string"
          ? lastUser.content.slice(0, 120)
          : Array.isArray(lastUser?.content)
            ? JSON.stringify(lastUser.content).slice(0, 120)
            : "";

      const authHeader = typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : "";
      const usageObj =
        script.kind === "missing_usage" || script.kind === "http_error"
          ? null
          : {
              prompt_tokens: script.usage?.prompt_tokens ?? 100,
              completion_tokens: script.usage?.completion_tokens ?? 20,
              total_tokens: (script.usage?.prompt_tokens ?? 100) + (script.usage?.completion_tokens ?? 20),
            };
      const statusCode = script.kind === "http_error" ? (script.httpStatus ?? 503) : 200;

      const seq = records.length + 1;
      const rec: ModelArrivalRecord = {
        seq,
        receivedAt: new Date().toISOString(),
        method: req.method,
        path: url.pathname,
        model: modelName,
        stream: isStream,
        messageCount: messages.length,
        hasAuthHeader: authHeader.length > 0,
        authHeaderDigestPrefix: authHeader.length > 0 ? `len:${authHeader.length}` : null,
        lastUserPreview: lastUserText,
        scriptApplied: script.kind,
        statusCode,
        usageSent: usageObj,
      };
      // Durably record EVERY physical arrival immediately before responding (never deduplicates)
      appendJsonlDurable(logPath, rec);
      records.push(rec);

      if (script.delayMs && script.delayMs > 0) {
        await new Promise((r) => setTimeout(r, script.delayMs));
      }

      if (script.kind === "hold_then_text" && script.holdBarrierKey) {
        notifyBarrierArrived(script.holdBarrierKey);
        await new Promise<void>((resolve) => {
          const list = heldBarriers.get(script.holdBarrierKey!) ?? [];
          list.push(resolve);
          heldBarriers.set(script.holdBarrierKey!, list);
        });
      } else if (script.holdBarrierKey) {
        notifyBarrierArrived(script.holdBarrierKey);
      }

      if (script.kind === "http_error") {
        sendJson(statusCode, {
          error: {
            message: script.errorMessage ?? "Synthetic retryable upstream error",
            type: "server_error",
            code: String(statusCode),
          },
        });
        return;
      }

      const id = `chatcmpl-fake-${seq}`;
      const created = Math.floor(Date.now() / 1000);

      if (!isStream) {
        const message =
          script.kind === "tool_call" && script.toolCall
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: script.toolCall.id,
                    type: "function",
                    function: {
                      name: script.toolCall.name,
                      arguments: JSON.stringify(script.toolCall.arguments),
                    },
                  },
                ],
              }
            : {
                role: "assistant",
                content: script.text ?? "Synthetic response ok.",
              };
        sendJson(200, {
          id,
          object: "chat.completion",
          created,
          model: modelName,
          choices: [
            {
              index: 0,
              message,
              finish_reason: script.kind === "tool_call" ? "tool_calls" : "stop",
            },
          ],
          ...(usageObj ? { usage: usageObj } : {}),
        });
        return;
      }

      // SSE Streaming response matching OpenAI Chat Completions format expected by pi-ai
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      if (script.kind === "tool_call" && script.toolCall) {
        writeSseEvent(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model: modelName,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: script.toolCall.id,
                    type: "function",
                    function: {
                      name: script.toolCall.name,
                      arguments: JSON.stringify(script.toolCall.arguments),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        writeSseEvent(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model: modelName,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          ...(usageObj ? { usage: usageObj } : {}),
        });
      } else {
        const text = script.text ?? "Synthetic model response ok.";
        writeSseEvent(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model: modelName,
          choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
        });
        writeSseEvent(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model: modelName,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          ...(usageObj ? { usage: usageObj } : {}),
        });
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    sendJson(404, { error: "not_found", path: url.pathname });
  } catch (err) {
    sendJson(500, { error: err instanceof Error ? err.message : String(err) });
  }
});

await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
const addr = server.address() as AddressInfo;
process.stdout.write(
  JSON.stringify({
    ready: true,
    service: "fake-model",
    pid: process.pid,
    host,
    port: addr.port,
    baseUrl: `http://${host}:${addr.port}`,
    dataDir,
    logPath,
    initialTotalPhysicalRequests: records.length,
  }) + "\n",
);

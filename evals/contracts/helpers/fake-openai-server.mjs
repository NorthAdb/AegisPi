// Local fake OpenAI-compatible endpoint for Pi contract probes.
// PI-09/PI-10 evidence: records the exact wire shape Pi sends
// (path, headers, body) and streams scripted SSE responses back.
// Never talks to a real provider. Listens on 127.0.0.1 only.

import http from "node:http";

export function createFakeOpenAIServer({ scripts = [] } = {}) {
  const state = {
    server: null,
    port: 0,
    requests: [],
    remaining: [...scripts],
    hits: 0,
  };

  function sse(res, chunks, streamDelayMs = 0) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const writeNext = (i) => {
      if (i >= chunks.length) {
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.write(chunks[i]);
      setTimeout(() => writeNext(i + 1), streamDelayMs);
    };
    writeNext(0);
  }

  function textChunks({ text = "", reasoning = "", usage, model = "deepseek-flash" }) {
    const chunks = [];
    chunks.push(
      `data: ${JSON.stringify({
        id: "chatcmpl-probe",
        object: "chat.completion.chunk",
        created: 0,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      })}\n\n`,
    );
    if (reasoning) {
      chunks.push(
        `data: ${JSON.stringify({
          id: "chatcmpl-probe",
          object: "chat.completion.chunk",
          created: 0,
          model,
          choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }],
        })}\n\n`,
      );
    }
    for (const piece of splitText(text)) {
      chunks.push(
        `data: ${JSON.stringify({
          id: "chatcmpl-probe",
          object: "chat.completion.chunk",
          created: 0,
          model,
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        })}\n\n`,
      );
    }
    chunks.push(
      `data: ${JSON.stringify({
        id: "chatcmpl-probe",
        object: "chat.completion.chunk",
        created: 0,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: usage?.prompt_tokens ?? 12,
          completion_tokens: usage?.completion_tokens ?? 34,
          total_tokens: (usage?.prompt_tokens ?? 12) + (usage?.completion_tokens ?? 34),
        },
      })}\n\n`,
    );
    return chunks;
  }

  function toolCallChunks({ name, args, text = "", usage, model = "deepseek-flash" }) {
    const chunks = [];
    chunks.push(
      `data: ${JSON.stringify({
        id: "chatcmpl-probe",
        object: "chat.completion.chunk",
        created: 0,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      })}\n\n`,
    );
    if (text) {
      chunks.push(
        `data: ${JSON.stringify({
          id: "chatcmpl-probe",
          object: "chat.completion.chunk",
          created: 0,
          model,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        })}\n\n`,
      );
    }
    chunks.push(
      `data: ${JSON.stringify({
        id: "chatcmpl-probe",
        object: "chat.completion.chunk",
        created: 0,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_probe_1",
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
    chunks.push(
      `data: ${JSON.stringify({
        id: "chatcmpl-probe",
        object: "chat.completion.chunk",
        created: 0,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: {
          prompt_tokens: usage?.prompt_tokens ?? 12,
          completion_tokens: usage?.completion_tokens ?? 34,
          total_tokens: (usage?.prompt_tokens ?? 12) + (usage?.completion_tokens ?? 34),
        },
      })}\n\n`,
    );
    return chunks;
  }

  function splitText(text) {
    if (!text) return [];
    const pieces = [];
    for (let i = 0; i < text.length; i += 512) pieces.push(text.slice(i, i + 512));
    return pieces;
  }

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${req.url}` } }));
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      state.hits++;
      const raw = Buffer.concat(chunks);
      let body = null;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        body = { parseError: true, byteLength: raw.length };
      }
      const recorded = {
        hit: state.hits,
        url: req.url,
        headers: { ...req.headers },
        body,
      };
      state.requests.push(recorded);
      const script = state.remaining.shift() ?? { kind: "text", text: "probe-default-response" };
      const streamDelayMs = script.streamDelayMs ?? 0;
      if (script.delayMs) {
        const t = setTimeout(() => respond(script, streamDelayMs, res), script.delayMs);
        res.on("close", () => clearTimeout(t));
        return;
      }
      respond(script, streamDelayMs, res);
    });

    function respond(script, streamDelayMs, res) {
      if (script.kind === "error") {
        res.writeHead(script.status ?? 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify(script.body ?? { error: { message: "probe-scripted-failure" } }));
        return;
      }
      if (script.kind === "raw_sse") {
        sse(res, script.chunks, streamDelayMs);
        return;
      }
      if (script.kind === "tool_call") {
        sse(res, toolCallChunks(script), streamDelayMs);
        return;
      }
      sse(res, textChunks(script), streamDelayMs);
    }
  });

  state.server = server;
  state.start = () =>
    new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        state.port = server.address().port;
        resolve(state.port);
      });
    });
  state.stop = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
    });
  state.pushScript = (script) => state.remaining.push(script);
  return state;
}

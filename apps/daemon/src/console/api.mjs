// Minimal Phase 2 console (04 sections 3/4): a LOCAL, authenticated,
// read-only diagnostics surface — task list, checkpoints, notification status
// and the recovery report. It is NOT an approval/budget/governance console
// (Phase 3+) and endpoints from those phases answer 501 with an explicit
// not-implemented body instead of fake data. Every endpoint requires the
// bearer token generated at first boot under workspace-state/console/token;
// the server binds 127.0.0.1 only and re-checks Origin/Host so a browser page
// from anywhere else cannot touch it. When recovery opened read-only, every
// endpoint except the diagnostics answers 503.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Hono } from "hono";

export const CONSOLE_BIND = "127.0.0.1";
export const CONSOLE_DEFAULT_PORT = 4310;

export function ensureConsoleToken(dataDir) {
  const dir = join(dataDir, "console");
  mkdirSync(dir, { recursive: true });
  const tokenPath = join(dir, "token");
  if (existsSync(tokenPath)) {
    return { tokenPath, token: readFileSync(tokenPath, "utf8").trim() };
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, token + "\n", { encoding: "utf8", flag: "wx" });
  return { tokenPath, token };
}

export function createConsoleApp(db, { recovery, mode, token, port = CONSOLE_DEFAULT_PORT }) {
  const app = new Hono();
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
  ]);

  app.use("*", async (c, next) => {
    // Host/Origin validation: the console is same-origin local only.
    const host = c.req.header("host") ?? "";
    const origin = c.req.header("origin");
    if (!allowedHosts.has(host)) {
      return c.json({ code: "forbidden_host", message: `console host ${host} is not the local same-origin bind` }, 403);
    }
    if (origin !== undefined && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) {
      return c.json({ code: "forbidden_origin", message: "cross-origin console requests are refused" }, 403);
    }
    return next();
  });

  app.use("/api/*", async (c, next) => {
    // Read-only maintenance: only diagnostics stay reachable (04 section 4:
    // 503 recovery/only-read maintenance).
    if (mode !== "open" && !c.req.path.startsWith("/api/recovery") && c.req.path !== "/api/health") {
      return c.json(
        { code: "read_only_maintenance", message: `recovery failed at ${recovery.failedStep}; only diagnostics are open` },
        503,
      );
    }
    return next();
  });

  app.use("/api/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    if (auth !== `Bearer ${token}`) {
      return c.json({ code: "unauthenticated", message: "console endpoints require the local bearer token" }, 401);
    }
    return next();
  });

  app.get("/api/health", (c) => c.json({ ok: true, mode, node: process.version }));

  app.get("/api/recovery", (c) => {
    return c.json({
      mode,
      failedStep: recovery.failedStep ?? null,
      actions: recovery.actions,
    });
  });

  app.get("/api/snapshot", (c) => {
    const tasksByState = db
      .prepare("SELECT state, count(*) c FROM tasks GROUP BY state ORDER BY state")
      .all();
    const effectsByState = db
      .prepare("SELECT state, count(*) c FROM effects GROUP BY state ORDER BY state")
      .all();
    const inboxByState = db
      .prepare("SELECT state, count(*) c FROM inbox GROUP BY state ORDER BY state")
      .all();
    const timersByState = db
      .prepare("SELECT state, count(*) c FROM timers GROUP BY state ORDER BY state")
      .all();
    const approvalsByState = db
      .prepare("SELECT state, count(*) c FROM approvals GROUP BY state ORDER BY state")
      .all();
    const budgets = db
      .prepare("SELECT id, period_key, limit_microusd, spent_microusd, held_microusd, frozen FROM budget_accounts ORDER BY id")
      .all();
    const watermark = db
      .prepare("SELECT seq FROM stream_events ORDER BY seq DESC LIMIT 1")
      .get();
    const generation = db
      .prepare("SELECT value FROM system_state WHERE key='stream_generation'")
      .get();
    return c.json({
      generation: generation ? Number(generation.value) : 1,
      watermark: watermark ? watermark.seq : 0,
      overview: {
        tasksByState,
        effectsByState,
        inboxByState,
        timersByState,
        approvalsByState,
      },
      budgetAccounts: budgets,
    });
  });

  app.get("/api/tasks", (c) => {
    const tasks = db
      .prepare(
        `SELECT id, scope_id, state, priority, result_class, attempt_no, fence, available_at, deadline_at,
           step_count, max_steps, created_at, updated_at
         FROM tasks ORDER BY created_at DESC LIMIT 100`,
      )
      .all();
    return c.json({ tasks });
  });

  app.get("/api/tasks/:id", (c) => {
    const task = db
      .prepare(
        `SELECT id, scope_id, principal_id, origin_event_id, dispatch_key, state, priority,
           result_class, result_object_id, attempt_no, fence, available_at, deadline_at,
           step_count, max_steps, created_at, updated_at
         FROM tasks WHERE id=?`,
      )
      .get(c.req.param("id"));
    if (!task) {
      return c.json({ code: "not_found", message: "no such task" }, 404);
    }
    const attempts = db
      .prepare(
        "SELECT id, attempt_no, fence, state, started_at, ended_at, checkpoint_object_id, error_code FROM attempts WHERE task_id=? ORDER BY attempt_no",
      )
      .all(task.id);
    const effects = db
      .prepare(
        "SELECT id, state, retry_mode, business_key, external_id, last_error, updated_at FROM effects WHERE task_id=?",
      )
      .all(task.id);
    const deliveries = db
      .prepare("SELECT event_id, state, command_id, checkpoint_object_id, updated_at FROM event_deliveries WHERE task_id=?")
      .all(task.id);
    return c.json({ task, attempts, effects, deliveries });
  });

  app.get("/api/tasks/:id/checkpoints", (c) => {
    const attempts = db
      .prepare(
        "SELECT attempt_no, checkpoint_object_id FROM attempts WHERE task_id=? AND checkpoint_object_id IS NOT NULL ORDER BY attempt_no",
      )
      .all(c.req.param("id"));
    const checkpoints = attempts.map((a) => {
      const object = db
        .prepare("SELECT id, kind, content_hash, storage_ref, observed_at FROM objects WHERE id=?")
        .get(a.checkpoint_object_id);
      return { attemptNo: a.attempt_no, object };
    });
    return c.json({ checkpoints });
  });

  app.get("/api/notifications", (c) => {
    const rows = db
      .prepare(
        `SELECT o.id, o.effect_id, o.channel, o.destination, o.not_before, o.notify_reason,
                o.supersedes_outbox_id, e.state AS effect_state, e.external_id, e.expires_at
         FROM outbox o JOIN effects e ON e.id=o.effect_id
         ORDER BY o.not_before LIMIT 100`,
      )
      .all();
    return c.json({ notifications: rows, deliveryNote: "delivery status is effects.state; the outbox never keeps a second status" });
  });

  // Phase 3+ surfaces answer explicitly-not-implemented, never fake data
  // (04 section 4: "phase中尚未实现的端点返回明确不可用，不用假数据模拟完成").
  app.all("/api/*", (c) => {
    return c.json(
      {
        code: "not_implemented_in_phase2",
        message: "this console surface (approvals/governance/replay/budget management) is a later phase; no fake data is served",
      },
      501,
    );
  });

  return app;
}

export function serveConsole(app, { port = CONSOLE_DEFAULT_PORT }) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      // Keep the Host header: the same-origin middleware validates it.
      const headers = { ...req.headers };
      const body = await new Promise((resolve) => {
        const chunks = [];
        req.on("data", (d) => chunks.push(d));
        req.on("end", () => resolve(Buffer.concat(chunks)));
      });
      const request = new Request(url, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : body,
      });
      const response = await app.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "console_error", message: e.message }));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, CONSOLE_BIND, () => resolve({ server, port, bind: CONSOLE_BIND }));
  });
}

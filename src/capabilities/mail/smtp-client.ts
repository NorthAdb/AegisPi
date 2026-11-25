import net from "node:net";

export interface SmtpSendRequest {
  host: string;
  port: number;
  from: string;
  to: string[];
  subject: string;
  body: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface SmtpSendResult {
  status: "succeeded" | "failed_remote" | "failed_local" | "unknown";
  receiptRef?: string;
  reason?: string;
  bytesSent: number;
}

function dotStuff(text: string): string {
  return text
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? "." + line : line))
    .join("\r\n");
}

/**
 * Minimal pure-Node TCP SMTP client used exclusively by the sole host submitter
 * AFTER claimEffectForSubmission (READY -> SUBMITTING) has committed.
 * Clearly distinguishes pre-connect failure (failed_local, bytesSent=0),
 * definitive 5xx rejection (failed_remote), 250 receipt (succeeded),
 * and post-DATA timeout/disconnect (unknown).
 */
export function sendSmtpMessage(req: SmtpSendRequest): Promise<SmtpSendResult> {
  const timeoutMs = req.timeoutMs ?? 15_000;
  return new Promise<SmtpSendResult>((resolve) => {
    let settled = false;
    let bytesSent = 0;
    let dataTransmitted = false;

    const finish = (result: SmtpSendResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const socket = net.createConnection({ host: req.host, port: req.port });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);

    let buffer = "";
    const lineWaiters: Array<(line: string) => void> = [];
    const bufferedLines: string[] = [];

    const nextReply = (): Promise<{ code: number; lines: string[] }> => {
      return new Promise((resReply) => {
        const lines: string[] = [];
        const onLine = (line: string): void => {
          lines.push(line);
          if (/^\d{3} /.test(line)) {
            resReply({ code: Number(line.slice(0, 3)), lines });
          } else {
            takeLine(onLine);
          }
        };
        takeLine(onLine);
      });
    };

    const takeLine = (cb: (line: string) => void): void => {
      const existing = bufferedLines.shift();
      if (existing !== undefined) {
        cb(existing);
      } else {
        lineWaiters.push(cb);
      }
    };

    const writeCmd = (cmd: string): void => {
      const wire = cmd + "\r\n";
      bytesSent += Buffer.byteLength(wire, "utf8");
      socket.write(wire);
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        let line = buffer.slice(0, idx);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        buffer = buffer.slice(idx + 1);
        const waiter = lineWaiters.shift();
        if (waiter) {
          waiter(line);
        } else {
          bufferedLines.push(line);
        }
        idx = buffer.indexOf("\n");
      }
    });

    socket.on("timeout", () => {
      finish({
        status: dataTransmitted ? "unknown" : bytesSent === 0 ? "failed_local" : "unknown",
        reason: dataTransmitted ? "smtp_reply_timeout_after_data" : "smtp_timeout",
        bytesSent,
      });
    });

    socket.on("error", (err) => {
      finish({
        status: dataTransmitted ? "unknown" : bytesSent === 0 ? "failed_local" : "unknown",
        reason: `smtp_socket_error: ${err.message}`,
        bytesSent,
      });
    });

    socket.on("close", () => {
      if (!settled) {
        finish({
          status: dataTransmitted ? "unknown" : "failed_local",
          reason: dataTransmitted ? "smtp_closed_before_receipt" : "smtp_closed_before_data",
          bytesSent,
        });
      }
    });

    socket.once("connect", () => {
      void (async () => {
        try {
          const greeting = await nextReply();
          if (greeting.code !== 220) {
            finish({ status: "failed_remote", reason: `unexpected greeting: ${greeting.lines.join(" | ")}`, bytesSent });
            return;
          }
          writeCmd("EHLO aegispi.local");
          const ehlo = await nextReply();
          if (ehlo.code !== 250) {
            finish({ status: "failed_remote", reason: `EHLO failed: ${ehlo.lines.join(" | ")}`, bytesSent });
            return;
          }
          writeCmd(`MAIL FROM:<${req.from}>`);
          const mf = await nextReply();
          if (mf.code !== 250) {
            finish({ status: "failed_remote", reason: `MAIL FROM failed: ${mf.lines.join(" | ")}`, bytesSent });
            return;
          }
          for (const recipient of req.to) {
            writeCmd(`RCPT TO:<${recipient}>`);
            const rt = await nextReply();
            if (rt.code !== 250 && rt.code !== 251) {
              finish({ status: "failed_remote", reason: `RCPT TO failed: ${rt.lines.join(" | ")}`, bytesSent });
              return;
            }
          }
          writeCmd("DATA");
          const dataReady = await nextReply();
          if (dataReady.code !== 354) {
            finish({ status: "failed_remote", reason: `DATA rejected: ${dataReady.lines.join(" | ")}`, bytesSent });
            return;
          }

          const extraHeaders = Object.entries(req.headers ?? {})
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n");
          const messagePayload = [
            `From: ${req.from}`,
            `To: ${req.to.join(", ")}`,
            `Subject: ${req.subject}`,
            ...(extraHeaders ? [extraHeaders] : []),
            "",
            dotStuff(req.body),
            ".",
          ].join("\r\n");

          dataTransmitted = true;
          writeCmd(messagePayload);
          const dataReply = await nextReply();
          if (dataReply.code >= 200 && dataReply.code < 300) {
            const receiptRef = dataReply.lines[dataReply.lines.length - 1] ?? `250 OK`;
            writeCmd("QUIT");
            finish({ status: "succeeded", receiptRef, bytesSent });
          } else if (dataReply.code >= 500) {
            writeCmd("QUIT");
            finish({ status: "failed_remote", reason: dataReply.lines.join(" | "), bytesSent });
          } else {
            finish({ status: "unknown", reason: `ambiguous DATA reply: ${dataReply.lines.join(" | ")}`, bytesSent });
          }
        } catch (err) {
          finish({
            status: dataTransmitted ? "unknown" : "failed_local",
            reason: err instanceof Error ? err.message : String(err),
            bytesSent,
          });
        }
      })();
    });
  });
}

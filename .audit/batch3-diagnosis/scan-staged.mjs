import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const staged = execSync("git diff --cached --name-only", { encoding: "utf8" }).trim().split("\n");
const envTxt = readFileSync(".env", "utf8");
const secrets = [];
for (const line of envTxt.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)\s*$/);
  if (m && m[1] !== "MAIL_IMAP_PORT" && m[1] !== "MAIL_SMTP_PORT") secrets.push([m[1], m[2]]);
}
const leaks = [];
let scanned = 0;
for (const f of staged) {
  let t;
  try {
    t = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  scanned += 1;
  for (const [k, v] of secrets) {
    if (v && v.length > 3 && t.includes(v)) {
      leaks.push(`${f} <- ${k}`);
      break;
    }
  }
}
console.log("STAGED FILES:", staged.length, "| scanned:", scanned, "| secrets checked:", secrets.length);
console.log(leaks.length === 0 ? "STAGED TREE CLEAN — zero raw secrets" : "LEAKS: " + leaks.join("; "));

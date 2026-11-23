import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { openDatabase } from "../../apps/daemon/src/db/connect.mjs";
import { readObjectContent } from "../../apps/daemon/src/objects.mjs";
import { redactSecrets } from "../../apps/daemon/src/spill.mjs";

const mailStateDir = "D:/AegisPi/aegis-pi/workspace-state/phase5/scenarios-real-mail";
const db = openDatabase(join(mailStateDir, "db", "aegis.db"), { readOnly: true });
const effect = db.prepare("SELECT * FROM effects WHERE operation='mail.send'").get();
const action = JSON.parse(effect.action_json);
const draftRow = db.prepare("SELECT id FROM objects WHERE kind='mail_draft' ORDER BY observed_at DESC LIMIT 1").get();
const draftContent = JSON.parse(readObjectContent(db, mailStateDir, draftRow.id) ?? "{}");
console.log("draft.equal-raw:", draftContent.draft === action.bodyText);
console.log("draft.equal-redacted:", draftContent.draft === redactSecrets(action.bodyText));
const respRow = db.prepare("SELECT storage_ref FROM objects WHERE id=?").get(effect.response_object_id);
console.log("resp.storage_ref:", respRow ? respRow.storage_ref : "MISSING");
try {
  const resp = JSON.parse(readFileSync(join(mailStateDir, ...respRow.storage_ref.split("/")), "utf8"));
  console.log("resp.external_id matches effect:", resp.external_id === effect.external_id);
} catch (e) {
  console.log("resp read error:", e.message);
}
const settled = db.prepare("SELECT details_json FROM audit_log WHERE code='budget_settled'").all();
for (const s of settled) console.log("budget_settled details:", String(s.details_json).slice(0, 220));
console.log("action.content_hash check:", action.content_hash === createHash("sha256").update(action.bodyText).digest("hex"));
db.close();

import { join } from "node:path";
import { openDatabase } from "../../apps/daemon/src/db/connect.mjs";
import { readObjectContent } from "../../apps/daemon/src/objects.mjs";
import { redactSecrets } from "../../apps/daemon/src/spill.mjs";

const mailStateDir = "D:/AegisPi/aegis-pi/workspace-state/phase5/scenarios-real-mail";
const db = openDatabase(join(mailStateDir, "db", "aegis.db"), { readOnly: true });
const effect = db.prepare("SELECT * FROM effects WHERE operation='mail.send'").get();
const action = JSON.parse(effect.action_json);
const draftRow = db.prepare("SELECT id FROM objects WHERE kind='mail_draft' ORDER BY observed_at DESC LIMIT 1").get();
const draftContent = JSON.parse(readObjectContent(db, mailStateDir, draftRow.id) ?? "{}");
const a = action.bodyText;
const b = draftContent.draft;
console.log("len action:", a.length, "len draft:", b.length);
for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
  if (a[i] !== b[i]) {
    console.log("first diff at", i);
    console.log("action  ...", JSON.stringify(a.slice(Math.max(0, i - 20), i + 30)));
    console.log("draft   ...", JSON.stringify(b.slice(Math.max(0, i - 20), i + 30)));
    break;
  }
}
console.log("redacted(action) === draft:", redactSecrets(a) === b);
db.close();

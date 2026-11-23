import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("D:/AegisPi/aegis-pi/workspace-state/phase5/scenarios-real-mail/db/aegis.db", { readOnly: true });
const e = db.prepare("SELECT id,state,attempt_count,max_attempts,next_attempt_at,last_error,external_id FROM effects").all();
console.log(JSON.stringify(e, null, 1));
const a = db.prepare("SELECT code, substr(details_json,1,160) d FROM audit_log WHERE code LIKE 'effect%' OR code LIKE 'adapter%' ORDER BY rowid DESC LIMIT 10").all();
for (const r of a) console.log(r.code + ": " + r.d);
db.close();

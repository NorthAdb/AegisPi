// Crash-window scenario for the Telegram pull cursor (Unit 5.2): the child
// runs ONE pull pass and is SIGKILLed by the armed crashpoint exactly
// AFTER the batch's receiveEvent transactions have committed and BEFORE
// telegram_pull_offset advances. The parent then reopens the workspace,
// re-pulls the same update_ids, and asserts the inbox UNIQUE absorbed the
// duplicates with zero new tasks before the cursor finally advances.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../../../apps/daemon/src/db/connect.mjs";
import { loadCanonicalSchema, migrate } from "../../../../apps/daemon/src/db/migrate.mjs";
import { createCredentialService } from "../../../../apps/daemon/src/credentials.mjs";
import { pullTelegramUpdates } from "../../../../apps/daemon/src/telegram-pull.mjs";

const ws = process.env.AEGISPI_WS;
const apiBase = process.env.AEGISPI_API_BASE;
const proxyHost = process.env.AEGISPI_PROXY_HOST ?? null;
const proxyPortRaw = process.env.AEGISPI_PROXY_PORT ?? null;
const proxyPort = proxyPortRaw !== null ? Number(proxyPortRaw) : null;
const allowedChatIds = JSON.parse(process.env.AEGISPI_ALLOWED_CHAT_IDS ?? "[]");

const db = openDatabase(join(ws, "db", "aegis.db"));
migrate(db, loadCanonicalSchema());
const credentials = createCredentialService(db);
const res = pullTelegramUpdates(db, ws, {
  telegram: {
    apiBase,
    allowedChatIds,
    pullBatchLimit: 20,
    pullTimeoutSeconds: 0,
    timeoutMs: 15000,
    proxyUrl: proxyHost !== null ? `http://${proxyHost}:${proxyPort}` : null,
  },
  credentials,
  now: Date.now(),
});
// Never reached when the crashpoint is armed (the SIGKILL lands inside
// pullTelegramUpdates); printed only on a no-arms dry run.
console.log(JSON.stringify({ pulled: res.pulled ?? 0, offsetAfter: res.offsetAfter ?? null }));
db.close();

// Disk watermark (06 section 10: "常开前必须有实测磁盘水位告警"; the Phase 3
// handoff: "磁盘水位要能阻止失控").
//
// Levels:
//   ok        free bytes and free ratio both above the warn thresholds
//   warn      below either warn threshold: offline job submission blocks, an
//             audit_alert streams, the loop keeps running read/write durable
//             state (SQLite still needs room to breathe, but nothing NEW may
//             allocate workspace)
//   critical  below either critical threshold: the daemon opens READ-ONLY
//             diagnostics (06 section 9: recovery failure semantics — never
//             auto-start containers on a full disk)

import { statfsSync } from "node:fs";
import { withTx } from "./tx.mjs";
import { writeAudit, writeStreamEvent } from "../audit.mjs";

export function diskWatermark(path, { warnFreeBytes, criticalFreeBytes, warnFreeRatio = 0.05, criticalFreeRatio = 0.02 } = {}) {
  const st = statfsSync(path);
  const freeBytes = Number(st.bavail) * Number(st.bsize);
  const totalBytes = Number(st.blocks) * Number(st.bsize);
  const freeRatio = totalBytes > 0 ? freeBytes / totalBytes : 0;
  let level = "ok";
  if (freeBytes <= criticalFreeBytes || freeRatio <= criticalFreeRatio) {
    level = "critical";
  } else if (freeBytes <= warnFreeBytes || freeRatio <= warnFreeRatio) {
    level = "warn";
  }
  return { level, freeBytes, totalBytes, freeRatio: Number(freeRatio.toFixed(4)) };
}

// The daemon-side reaction: audit + stream alert once per level CHANGE (not
// per tick), so a long warn stint does not flood the audit log.
export function recordWatermark(db, { state, previousLevel, now }) {
  if (state.level === previousLevel) {
    return { level: state.level, alerted: false };
  }
  withTx(db, () => {
    writeAudit(db, {
      code: state.level === "ok" ? "disk_watermark_recovered" : "disk_watermark_alert",
      details: { level: state.level, free_bytes: state.freeBytes, free_ratio: state.freeRatio },
      now,
    });
    if (state.level !== "ok") {
      writeStreamEvent(db, {
        scopeId: "scp:service:budget",
        eventType: "audit_alert",
        entityId: "disk:watermark",
        entityVersion: 1,
        payload: { level: state.level, free_bytes: state.freeBytes },
        now,
      });
    }
  });
  return { level: state.level, alerted: true };
}

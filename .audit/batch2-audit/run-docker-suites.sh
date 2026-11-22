#!/bin/bash
# Batch 2 independent audit: Docker-linked suites, sequential, locked Node only.
export PATH="/d/AegisPi/tools/node-v22.23.5:$PATH"
cd /d/AegisPi/aegis-pi || exit 9
LOG=.audit/batch2-audit/logs
unset AEGISPI_ALLOW_REAL_TELEGRAM_READ AEGISPI_ALLOW_REAL_TRIAGE_ACCEPTANCE \
      AEGISPI_ALLOW_REAL_MODEL_ACCEPTANCE AEGISPI_ALLOW_REAL_OBSERVE_ACCEPTANCE

run() {
  name="$1"; shift
  echo "=== $name start $(date '+%F %T') ===" > "$LOG/$name.log"
  "$@" >> "$LOG/$name.log" 2>&1
  rc=$?
  echo "$rc" > "$LOG/$name.exit"
  echo "=== $name end rc=$rc $(date '+%F %T') ===" >> "$LOG/$name.log"
  echo "DONE $name rc=$rc"
}

run model-proposal      node evals/phase3/model-proposal/run.mjs
run repo-observe        node evals/phase3/repo-observe/run.mjs
run eval-triage         node evals/phase4/triage/run.mjs
run offline-jobs        node evals/phase3/offline-jobs/run.mjs
run security-integration node evals/phase3/security-integration/run.mjs
run quota-calibration   node evals/phase3/quota-calibration/run.mjs
echo "ALL DOCKER SUITES FINISHED $(date '+%F %T')"

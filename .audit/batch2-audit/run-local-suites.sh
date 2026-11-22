#!/bin/bash
# Batch 2 independent audit: local (non-Docker) suites, sequential, locked Node only.
# Evidence logs -> .audit/batch2-audit/logs/<name>.log ; exit code -> <name>.exit
export PATH="/d/AegisPi/tools/node-v22.23.5:$PATH"
cd /d/AegisPi/aegis-pi || exit 9
LOG=.audit/batch2-audit/logs
unset AEGISPI_ALLOW_REAL_TELEGRAM_READ AEGISPI_ALLOW_REAL_TRIAGE_ACCEPTANCE \
      AEGISPI_ALLOW_REAL_MODEL_ACCEPTANCE AEGISPI_ALLOW_REAL_OBSERVE_ACCEPTANCE \
      AEGISPI_ALLOW_REAL_PHASE5_ACCEPTANCE AEGISPI_ALLOW_REAL_EXTERNAL_WRITE

node -v > $LOG/node-version.log 2>&1

run() {
  name="$1"; shift
  echo "=== $name start $(date '+%F %T') ===" > "$LOG/$name.log"
  "$@" >> "$LOG/$name.log" 2>&1
  rc=$?
  echo "$rc" > "$LOG/$name.exit"
  echo "=== $name end rc=$rc $(date '+%F %T') ===" >> "$LOG/$name.log"
  echo "DONE $name rc=$rc"
}

run image-gate          node evals/phase3/lib/image-gate.mjs
run hono-pair           node evals/contracts/tools/verify-hono-oracle-pair.mjs
run scenarios           node evals/phase5/scenarios/run.mjs
run security-unit       node evals/phase3/security-unit/run.mjs
run cancel-approval     node evals/phase3/cancel-approval/run.mjs
run memory-lifecycle    node evals/phase5/memory-lifecycle/run.mjs
run cross-channel       node evals/phase5/cross-channel/run.mjs
run durability          node evals/phase2/durability/run.mjs
run acl                 node evals/phase2/acl/run.mjs
run budget              node evals/phase2/budget/run.mjs
run restore             node evals/phase3/restore/run.mjs
run ingress-telegram    node evals/phase3/ingress-telegram/run.mjs
run contracts           node evals/contracts/run-contracts.mjs
run user-value          node evals/phase4/report-user-value/run.mjs
run real-ingress        node evals/phase3/ingress-telegram/real.mjs
run real-triage         node evals/phase4/triage-real/run.mjs
run real-model          node evals/phase3/model-real/run.mjs
run real-observe        node evals/phase4/repo-observe-real/run.mjs
run real-extwrite       node evals/phase3/external-write-real/run.mjs
echo "ALL LOCAL SUITES FINISHED $(date '+%F %T')"

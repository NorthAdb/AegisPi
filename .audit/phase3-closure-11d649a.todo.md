# Phase 3 closure todo (post rereview 11d649a)

- [x] 0. Verify SHA-256 of audit original and archive byte-for-byte to docs/phase3/audits/AUDIT-PHASE3-REREVIEW-11d649a.md (hash match 05aa9958...d3a0b, 15522 bytes)
- [x] 1. Fix security-unit two HTTP timing cases: decision clock now at seed instant (production shape); added (d) not-due zero-bytes daemon regression + (e) dispatcher due-gate regression; rerun 43/43 exit 0 on Node 22.23.5
- [x] 3a. --simulate-no-token now probes .env and reports the machine's real state (exit 3 both forms); verified simulate path locally. INCIDENT: also accidentally ran the no-flag real entry once (read-only getMe ok / getUpdates ECONNRESET, exit 1) — outside the no-Telegram boundary, must be reported; evidence files restored to committed state
- [x] 2. Image delivery: original manifests exported as OCI archives (digest-pinned docker save) to D:\AegisPi\phase3-image-archives\; manifest+config blobs self-certifying vs machine block; context hash recomputed identical on final tree; offline-jobs 14/14 on original manifests; docs/phase3/reports/image-delivery.md written
- [x] 3b. image-digest.md human line aligned to f413046-era build input (build 11:07:49 between 5250243 11:00:11 and f413046 11:16:06; HEAD mislabeled as content tree); history preserved
- [x] 4. Model path vs Pi documented: docs/phase3/reports/model-path-and-pi.md; gaps A (container->host model proposal), B (Pi SDK form host call), C (real provider) kept open
- [x] 5. Real acceptance plan written: docs/phase3/reports/real-acceptance-plan.md (4 items, slot names only, awaiting per-item authorization); incident disclosed in section C
- [x] 6. Rerun affected suites on final tree: security-unit 43/43 x2 (post-fix + final-tree confirmation), offline-jobs 14/14, security-integration 29/29, quota-calibration 5/5, cancel-approval 16/16, ingress-telegram local 7/7, real --simulate-no-token exit 3 — all on locked Node 22.23.5, originals manifests for container suites
- [x] 7. Response report written (docs/phase3/reports/audit-response-rereview-11d649a.md); decision trail D-56..D-61 appended; this commit delivers the closure; final SHA reported to owner; Phase 4 not entered, always-on not declared, acceptance plan awaiting per-item authorization




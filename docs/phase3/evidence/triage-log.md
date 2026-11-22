# eval:triage: Scenario 4 repository triage and four-class oracle offline acceptance

生成：2026-11-22T09:52:19.862Z；Node v22.23.5；suite `triage`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | triage-e2e-dependency-advisory-unaffected-and-telegram | exit=0 task=SUCCEEDED/unaffected cost=28 jobs=SUCCEEDED:0,FAILED:1 effect=SUCCEEDED/tg:6101:9001 manifestValid=true err=(node:50684) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the wa |
| PASS | triage-e2e-snapshot-regression-affected-ignores-forged-stdout | exit=0 task=SUCCEEDED/affected jobs=SUCCEEDED:0,FAILED:1 |
| PASS | triage-baseline-failure-forces-infra-error-never-affected | exit=0 task=FAILED/infra_error err=triage_baseline_failed |
| PASS | triage-missing-dependency-exit-2-classifies-infra-error | exit=0 task=FAILED/infra_error baseExit=2 err=triage_baseline_infra_error |
| PASS | triage-indeterminate-target-classifies-unknown | exit=0 task=SUCCEEDED/unknown tgtExit=3 |
| PASS | triage-empty-model-reply-refuses-execution-containers | task=FAILED/infra_error err=model_output_truncated_empty jobs=0 settled=4928 |
| PASS | triage-fail-closed-guards-and-defaults | badPreset=triage_preset_not_allowed realBlocked=triage_real_disabled fetchBlocked=acquisition_real_fetch_disabled badNotify=triage_notify_target_not_allowed sym=acquisition_failed trav=true dotDot=true subPaths=2/true reproGuard=true hitsDelta=0 |

合计：7 PASS / 0 FAIL。

数据源：digest 钉住 agent / acquisition / execution 三镜像 + 本地 HTTP 归档 + Hono 4.13.19/4.12.24 夹具与 csrf-textping-check + pi-ai 环回模型 + 环回 Telegram /sendMessage；零真实仓库拉取、零真实模型调用、零真实 Telegram 外发，未读 .env。

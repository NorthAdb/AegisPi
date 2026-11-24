# test:repo-observe — Phase 4.2 Permission 1 离线仓库 Observe 全链、fail-closed 门禁与 D-80 加固回归

生成：2026-11-24T13:29:23.812Z；Node v22.23.5；suite `repo-observe`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | repo-observe-e2e-acquisition-to-settled-28 | exit=0 task=SUCCEEDED req=SETTLED res=SETTLED(28) maxTok=128 prefixBeforeQ=true redacted=true edge=derived_from leftDirs=0 err=(node:48140) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
 |
| PASS | fail-closed-targets-hosts-and-nonloopback-token-caps | unlisted=acquisition_target_not_allowed disabled=acquisition_real_fetch_disabled badHost=acquisition_host_not_allowed cap=token_caps_not_configured daemonTask=FAILED/acquisition_target_not_allowed |
| PASS | model-max-input-bytes-pre-row-refusal | code=input_bytes_exceeded rowCreated=false rows=0 res=0 |
| PASS | acquisition-rejects-bad-sha256-and-symlink-archive-before-agent | hash=FAILED/acquisition_failed sym=FAILED/acquisition_failed hitsDelta=0 scrub=true nonFile=acquisition_non_file_rejected |
| PASS | observe-held-settlement-never-completes-succeeded | exit=0 task=FAILED/settlement_held_uncompleted req=HELD res=HELD audit=1 |
| PASS | async-heartbeat-extends-lease-and-model-real-optin-exit-4 | status=settled req=SETTLED orphan=false task=RUNNING leaseDelta=2997 realGuardExit=4 |
| PASS | repo-observe-kv-prefix-stable-and-question-survives-cap | prefixEqual=true prefixLen=423 envBytes=494 tooSmall=input_bytes_exceeded/hits=0 |

合计：7 PASS / 0 FAIL。

数据源：digest 钉住 acquisition 与 agent 双容器 + 本地 throwaway HTTP archive + 本地 OpenAI SSE 环回 + pi-ai 1.5.2 + 真实 SQLite 账本；零真实仓库拉取、零真实模型调用、未读 .env。

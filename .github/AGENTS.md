# AGENTS.md — GitHub Actions

Run jobs on Windows runners (`windows-*` labels) under native `pwsh`. The required `windows` job is the deliberate exception: it runs Windows Node under Wine on hosted Linux and blocks `all checks passed`; the independent `windows-native` job runs on standard hosted Windows and reports its own unmasked result. Required CI uses standard GitHub-hosted runners only; introducing custom runner labels or failover selectors requires a separately approved process decision.

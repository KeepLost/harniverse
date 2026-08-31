# Agent Note: Standard-hosted required CI

Status: implemented

English | [中文](2026-08-22-standard-hosted-required-ci.zh.md)

## Problem

Required pull-request jobs depended on organization-owned runner labels and a repository-variable failover path. That topology made mergeability depend on infrastructure outside the repository, while its standby and benchmark definitions remained in the active workflow after they were disabled. The stale definitions and runbook described recovery paths that no longer existed.

The `CI` workflow also responded to `master` pushes only to seed a Wine package cache. GitHub therefore displayed a successful `CI` run even though the pull-request coverage, snapshot, Python runtime, and Windows inventories had not run for that commit.

## Decision

[CI](../../../../.github/workflows/ci.yml) is a pull-request-only workflow. The required Node 24 jobs, Node compatibility matrix, Python checks, Wine-hosted Windows gate, independent native Windows inventory, and `all checks passed` verdict use standard GitHub-hosted runners. The workflow contains no custom runner labels, self-hosted selectors, failover repository variables, disabled standby jobs, or dormant larger-runner benchmarks. A newer revision cancels the superseded pull-request run because none of its results can describe the new head.

The native Windows inventory remains independent from `all checks passed`: Wine provides the required Windows build signal on `ubuntu-latest`, while `windows-native` reports the complete `windows-latest` result without masking a failure. The aggregate continues to fail when any listed required dependency fails, is cancelled, or is skipped.

[Wine apt cache](../../../../.github/workflows/wine-apt-cache.yml) owns the default-branch cache seeder as a separate workflow. Its name states the work it performs, and a newer `master` push cancels a stale seed run. Pull requests restore the default-branch cache without turning a cache-maintenance run into a CI verdict.

This decision supersedes the custom-pool and default-branch reference topologies recorded in the archived [larger-runner](../../archived/process/2026-07-22-evidence-based-larger-hosted-runners.md), [serial reference](../../archived/process/2026-07-21-serial-cross-platform-ci-reference.md), and [failover](../../archived/process/2026-07-26-ci-failover-runbook.md) notes.

## Alternatives considered

**Retain disabled custom-runner jobs as workflow documentation.** Rejected because executable configuration is not a historical archive. Dead jobs drifted from active runner policy, action versions, caches, and tests while still appearing authoritative.

**Run the full pull-request inventory again on every `master` push.** Rejected because the merge commit already contains the reviewed head and exhaustive platform work is expensive. Branch protection consumes the pull-request evidence; the default branch does not need a second concurrent copy to seed one cache.

**Remove the Wine cache seeder.** Rejected because every new pull request would download the same apt dependency closure. A separate workflow preserves the reusable default-branch cache without mislabeling cache maintenance as repository validation.

## Consequences

Required CI no longer depends on organization runner provisioning or a mutable failover variable. Hosted capacity can still queue or fail, but every active runner selector is visible and portable in the workflow itself.

The repository gives up hot-standby drills and in-workflow larger-runner benchmarks. Historical measurements and rationale remain frozen in the archive; reintroducing custom capacity requires a new process decision, an active readiness signal, and current trust-boundary review rather than reviving dead YAML.

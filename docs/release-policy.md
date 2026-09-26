# Harniverse version and branch policy

English | [中文](release-policy.zh.md)

This reference governs product versions, integration, stabilization and release selection. Start here when taking over release work without conversation history; the [release-family decision](../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md) owns package boundaries and publication mechanics. Read the root [contributor instructions](../AGENTS.md) before making repository changes.

## Recover the current state

Inspect the working tree, current branch, upstream tracking, remote release branches, annotated release tags and GitHub releases. Read the root version and run `pnpm run release:verify --family dsh`. A manifest version is preparation state; only a published release and its fixed tag identify delivered bytes. Check release notes for distribution scope, exact commit, CI provenance and incomplete qualification. Never infer the newest release from a mutable branch or from a local tag alone.

The first 1.0 candidate is tagged `harniverse-v1.0.0-rc.1`; its stabilization line is `release/1.0`. Resolve the tag and branch from the remote when working on that line. A branch can advance after a release while the tag remains fixed. This document is policy, not a running release ledger.

## Version identities

The workspace root and dsh product family share one version. Vendored framework packages and native packages retain independent version lines. Package scope, plugin identity, product version, Git revision and durable-data version are distinct; a product release does not rename the inherited package namespace or republish unrelated families.

Use `major.minor.patch-rc.N` for a release candidate and `major.minor.patch` for stable. Increment `N` when preparing a genuinely new candidate for publication, not for every commit, fix or PR. Unreleased integration commits are distinguished by their Git SHA even while manifests retain a candidate version. Such a checkout must not be presented as the exact published candidate unless its commit is the tag's commit.

Use an explicit version for RC progression and stable promotion: `1.0.0-rc.1` → `1.0.0-rc.2` → `1.0.0`. The current bump command interprets `patch` after `1.0.0-rc.1` as `1.0.1`; it does not mean “remove the RC suffix.” Build metadata such as `+sha` is not accepted by that command. For declared supported APIs, compatible fixes use patch, compatible additions use minor, and breaking changes use major.

Product numbering never overrides durable-format commitments. Session format `v0` remains permanently additive-only, including across a product major release. SQLite schema versions advance independently and monotonically; product versions alone do not promise database downgrade support. Review the pre-release stance in the root instructions before the first stable release; an RC does not retire it.

## Branch roles and admission

| Ref | Role | Admission rule |
|---|---|---|
| `dev` and feature branches | Prepare and review integration work | Preserve the plugin-native architecture and keep unrelated work intact. |
| `master` | Integrated development, including work for later releases | Existing supported behavior and contracts remain valid; incomplete features satisfy the isolation rules below. |
| `release/1.0` | Stabilize the 1.0 release line | Select complete, reviewed changes needed for that release; do not automatically absorb later feature work. |
| `harniverse-v<version>` | Exact released source identity | Annotated tag at the verified release commit; never move or reuse a published tag. |

An incomplete feature can enter integration only when it is disabled by default or omitted from shipped profile/composition registration, does not expose an unfinished public route, command or contract, and does not break existing behavior, tests or durable formats. A hidden button alone is insufficient isolation. Implement isolation through plugin configuration and composition; do not add provider or feature special cases to the agent loop. If a change cannot be isolated, keep it on its feature branch until it can meet admission requirements.

Cut the stabilization branch at the selected first candidate commit. Thereafter, choose fixes explicitly for that line rather than merging all of `master`. Backport the reviewed change and necessary dependencies, resolve conflicts against the stabilization source, and verify the resulting tree. Carry fixes made first on the stabilization line back into integration so later development does not reintroduce the defect. The exact Git operation follows the authorized workflow; this policy does not authorize commits, branch changes, pushes, merges or releases by itself.

An RC number is not a feature-development milestone. A partial feature remains excluded from the candidate until complete even when some of its implementation already exists on `master`. Stable publication additionally requires the release's declared qualification to be complete; do not relabel a candidate to bypass performance, signing or distribution requirements.

## Prepare and publish a candidate

1. Establish the authorized release scope and exact target branch. Inspect the working tree and remote refs; preserve unrelated changes. Select a new unused version and verify that the intended tag and registry version do not already represent different bytes. The current bump tool does not enforce every version-monotonicity or tag-reuse rule, so the operator performs these checks.
2. Preview with `pnpm run release:dsh --dry-run 1.0.0-rc.2`, then prepare with `pnpm run release:dsh --no-commit 1.0.0-rc.2`. Substitute the selected version, including explicit `1.0.0` for promotion. Review all family manifests and the lockfile. The preparation command does not stage or commit; a lockfile-sync failure leaves written manifests for inspection.
3. Review and integrate the prepared version through the authorized Git workflow. Run focused local checks appropriate to the changes; CI owns exhaustive checks under the root instructions. Verify CI and packaging for the exact selected commit, or document an identical tested tree and independently verified packaging commit. A release-branch push does not itself prove that every existing workflow runs on that branch; inspect workflow triggers and arrange the required PR or manual verification before publication.
4. Create and push an annotated `harniverse-v<version>` tag at the verified commit. For the first candidate, establish the stabilization branch at that same commit. Confirm the remote branch and peeled tag targets. Never retag an already published candidate to incorporate a fix; issue the next candidate instead.
5. Publish release notes naming the version, commit, branch, supported installation path, asset scope, CI evidence and remaining limitations. Attach verified source/developer artifacts with provenance and checksums when that is the authorized distribution. Mark an RC as a prerelease rather than the stable latest release. GitHub publication does not imply npm, PyPI or signed desktop publication.
6. Registry publication is a separate explicit operation using the matching tag and protected workflow. Prerelease npm versions use `next`, stable versions use `latest`; scope ownership and credentials must be established for the intended distribution. Desktop distribution requires its own signing/notarization and final-artifact verification. Do not publish under an inherited namespace merely because its name is present in manifests.
7. Read back the published release, download its assets and verify hashes against the intended bytes. Check remote tag identity and final repository state. Record release-specific evidence in that release's notes and metadata, not in a new central ledger. Leave unfinished qualifications explicitly visible.

## Failed or superseded releases

Before publication, a draft can be corrected while its artifacts are still being verified. After publication, source tags and versioned artifacts remain fixed. A failed registry upload can be retried only with the same verified bytes; an integrity mismatch requires a new version. A missing or withdrawn asset is not permission to silently replace released contents. Explain withdrawal or known defects in release notes and publish a corrected candidate with a new version.

These rules separate integration velocity from release stability: incomplete work can progress through plugin boundaries without silently changing an existing candidate. Evidence, release scope and exact source identity remain recoverable from the repository and its release artifacts.

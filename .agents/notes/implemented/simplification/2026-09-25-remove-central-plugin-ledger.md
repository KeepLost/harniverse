# Agent Note: Remove the central plugin ledger

Status: implemented

English | [中文](2026-09-25-remove-central-plugin-ledger.zh.md)

## Problem

The central plugin ledger combined the original upstream inventory, current capability contracts, shipped composition, implementation status, and commit tracking. Package READMEs, subsystem references, source configuration, generated catalogs, and decision records already owned those facts. Requiring another row for each change and a later commit to fill in its SHA created competing authority and maintenance work without proving that the documentation or compatibility claim was correct.

The compatibility-tail convention had a useful motivation: reviewers needed an explicit compatibility claim and a command that checked it. Its syntax check only proved that a row contained the required labels. It could neither prove additivity nor replace verification of the actual durable contract.

## Decision

The repository removes the central ledger, its compatibility-tail verifier, and the mandatory row and follow-up SHA workflow. It has no replacement inventory, redirect file, or centralized compatibility gate. [Architecture](../../../../docs/architecture.md) maps composition and extension points; [package references](../../../../packages/README.md) and [subsystem references](../../../../docs/subsystems/README.md) own current contracts. Owning Agent Notes retain decisions, alternatives, compatibility rationale, and required verification; Git and PRs carry implementation history.

The original import identifiers have one attribution owner in the [licensing decision](../process/2026-09-19-relicense-bsd3-inherited-mit.md). Existing package and subsystem documentation retains runtime contracts; copied inventories, status annotations, and historical implementation rows are deleted rather than moved.

This partially supersedes the [session-contract digest decision](../process/2026-09-20-session-contract-digest-gate.md): only its ledger-tail mechanism is removed. The source-extracted digest, committed baseline, structural/additive drift classification, and persistence-catalog check remain. Session v0 stays permanently additive-only, and SQLite schema versions remain independent and monotonic. A baseline refresh follows an explicit compatibility rationale and verification in the owning Agent Note; a structural breaking change is still disallowed. This removal changes neither schema nor session data and does not refresh the digest baseline.

## Alternatives considered

**Keep a smaller ledger or rename it.** A second inventory still duplicates the owners and invites per-change bookkeeping; moving the file would preserve the maintenance problem.

**Replace row labels with another centralized compatibility registry.** A new registry would duplicate decision records and still could not establish semantic compatibility. The source-derived checks and review of the owning decision provide the relevant evidence.

**Delete the session digest with the ledger.** The digest detects real contract drift independently of prose formatting, so removing it would weaken the durable-format guarantee.

## Consequences

There is no single manually maintained list of every downstream change. Readers use current owners for behavior and Git or PRs for history. New capabilities and composition changes still update their owning documentation in the same change, and future upstream integrations retain their exact source revision in their owning Agent Note. A new central inventory would require a separately justified consumer need that the existing owners cannot satisfy.

The session-digest note remains active because its freeze, classification limits, and rejected runtime registry still guide future changes. The affected scheduler, onboarding, licensing, and coverage notes retain independent ownership, durability, attribution, or test-policy rationale; removing their ledger references does not supersede those decisions. No note qualifies for archival solely because the ledger is removed; frozen archives remain historical snapshots.

## Verification

The focused [digest spec](../../../../scripts/gen-session-contract-digest.spec.ts) retains source/baseline equality and additive-versus-structural assertions; only the deleted ledger-format tests are removed. `verify-session-contract-digest` and `verify-persistence-catalog` check the real source contracts. Markdown links, note format/classification, wrapping, bilingual pairing, and the generated translation-prompt snapshot check the updated documentation. Active documentation and executable paths must have no dependency on the deleted ledger or its verifier.

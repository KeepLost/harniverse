# Agent Note: An open subagent catalog is user-held across transient evidence dips

Status: implemented

English | [中文](2026-09-18-open-catalog-evidence-hysteresis.zh.md)

- Date: 2026-09-18
- Scope: `@deepseek-ai/dsh-client-ui-subagent` (catalog action lifecycle)
- PR: pending (this note ships with the fix)

## Problem

The `cold-resumes the original subagent while its ordinary fork stays active` e2e failed on the release branch's Windows coverage and web shards: the catalog trigger click never landed — Playwright reported the button `not stable` and then `detached from the DOM` for the full 30-second actionability window, and a poll-retried click never saw the catalog tree open.

`SubagentCatalogAction` gated its own render on child `visible` evidence: catalog entries, summary-indexed descendants, or a load error. While the forked session streams, the session-list store republishes `byId` and `subagentsByParent` on every commit, and a rehydration or refresh commit can momentarily carry neither the descendant summaries nor the catalog rows. On such a commit `visible` dipped to false and the component returned `null` — unmounting the trigger mid-interaction — and the old auto-close effect (`if (visible || !open) return; setOpen(false)`) force-closed an already-open menu on the same dip. Under sustained streaming the dips repeated for the whole window, so no click could open and keep the catalog.

## Decision

An open catalog is user-held. The component now renders while open regardless of the momentary evidence (`if (!visible && !open) return null`), and the menu subtree is additionally guarded on `presentedCatalog !== undefined` so a dip cannot render `CatalogRows` without a snapshot. The close-on-empty effect fires only when the authoritative catalog settles empty **with the summaries concurring** (`state === 'ready'`, zero entries, zero indexed descendants) — a stale-empty catalog alone stays open, matching the documented summary-backed bootstrap behavior.

Closed-trigger visibility is unchanged: a bare loading catalog with no other child evidence still does not flash the action in on childless sessions.

## Consequences

- Clicking the catalog during streaming or rehydration is reliable: the trigger stays attached and an open menu survives store-commit dips that transiently drop child evidence.
- A menu whose children genuinely disappear closes automatically once the catalog refresh settles empty and the summaries agree; observed catalogs are released exactly as before.
- While a dip hides the menu body (trigger remains), keyboard tree items are absent for that commit; focus already sits on the trigger, which remains interactive.
- The e2e keeps its poll-based `openSubagentCatalog` helper as defense-in-depth against pure visual jitter, but it no longer depends on it for correctness.

## Alternatives considered

- **Never hide once mounted (full hysteresis):** rejected — a session that truly loses all children would keep a dead count-zero trigger forever; the concurrence check gives deletion a deterministic settle point.
- **Fixing the store to never publish child-dropping snapshots:** deeper and riskier; the object layer legitimately rebuilds baselines during cold resume, and presentation robustness should not require transactional store guarantees.
- **Test-side retry only (the poll-click already merged):** insufficient — the CI run showed 30 seconds of continuous detach, which no click strategy defeats when the menu itself is force-closed each commit.

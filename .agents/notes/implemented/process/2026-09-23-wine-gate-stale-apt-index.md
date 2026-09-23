# Agent Note: The Wine gate installed a cached closure against a stale index

Status: implemented

English | [中文](2026-09-23-wine-gate-stale-apt-index.zh.md)

## Problem

The blocking Wine gate failed four consecutive times on one line: a 404 for `libgstreamer-plugins-base1.0-0 1.24.2-1ubuntu0.4`, a file no Ubuntu pool carries any more — every mirror has moved to `0.5`. The job reads as a mirror outage and a rerun cleared it once, which is exactly what made it look like a flake.

It was not a flake, and it was not the mirror. The step had two paths: install the cached deb closure when `~/wine-debs` holds one, else download the closure and install that. Only the download path ran `apt-get update`. The runner image ships baked apt lists, so on the cached path apt resolved the closure's dependencies against an index that still named a withdrawn file, and nothing in that path could ever correct it. The cache was hitting on every run, so the gate's health depended entirely on which image generation the runner came from: a generation whose baked lists were still current passed, and one whose lists had aged out failed permanently until the cache expired.

## Decision

Refresh the index before resolving anything, on both paths, and treat a closure the current index cannot satisfy as spent rather than as a transient fault — the step discards it so the next attempt downloads a fresh one.

This keeps the cache's purpose intact. It exists to skip a 108 MB download on a gate that only needs a `wine` binary, not to pin a particular Wine build, so replacing a closure that no longer installs costs one slow run and restores the fast path afterwards.

## Testing

CI is the only place this runs. The gate went from four consecutive failures to passing in 4m48s on the same image generation that had been failing, taking the discard-and-redownload path, and the run's `all checks passed` gate turned green with it.

## Alternatives considered

**Retrying the download.** The first attempt at this added a bounded retry around the download, on the theory that a mirror was lagging behind its own index. It never executed a second attempt, because the failing path was the cached one and never reached the loop. A retry would not have helped regardless: the file is gone from every pool, not late.

**Rewriting the mirror source to the canonical archive.** The second attempt fell back to `archive.ubuntu.com` on failure, reading the runner's mirror list as stale. The mirror list was fine — `apt-get update` against it yields `0.5`. This would have traded a correct fix for a slower download.

**Keying the cache on something shorter-lived.** A key that expires sooner would bound the staleness window instead of removing it, and would spend the 108 MB download more often for the privilege.

## Consequences

Every run of this job now pays one `apt-get update`, a few seconds against a gate that takes minutes.

A cached closure survives only as long as the archive can still satisfy it, so the first run after a withdrawal is slow. That is the intended trade: the gate tells the truth about Windows Node under Wine, and its provisioning is not a place to be clever.

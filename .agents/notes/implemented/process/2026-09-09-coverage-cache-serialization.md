# Agent Note: Serialize coverage lanes that share the transform cache

Status: implemented

English | [中文](2026-09-09-coverage-cache-serialization.zh.md)

## Problem

The `ci-coverage` gate starts an instrumented Vitest run and an uninstrumented heavy-suite run. Both processes use the repository's shared Vite transform cache. On an intermittent failure, all 992 test files passed, but Istanbul reported 80% branches for `packages/context/context-reset/src/invariant.ts` and the coverage reporter exposed negative counters such as `-11` and `-21`. A negative counter is impossible for valid execution; the corresponding zero-valued sibling entries were misleading coverage gaps produced by an invalid merge.

## Decision

The two coverage lanes are serialized in `scripts/run-gates.ts`: `test:coverage` depends on `test:coverage-exempt-heavy`. This preserves both gates and their blocking status while preventing concurrent instrumented and uninstrumented transforms from sharing the cache. The dependency is pinned by `scripts/run-gates.spec.ts`.

## Diagnosis Procedure

When a 100% coverage gate intermittently fails while the test count is green:

1. Read the complete gate log and separate test failures from coverage-threshold failures.
2. Inspect per-file counters before changing tests or adding ignore comments.
3. Treat any negative statement, function, line, or branch counter as corrupt coverage data, not an uncovered path.
4. Use a custom reporter to print negative counters separately; exact-zero entries beside a negative entry in the same file are not trustworthy.
5. Inspect concurrent coverage and non-coverage processes for shared transform or report directories.
6. Serialize or isolate those resources, then rerun the original gate and its focused regression.

The required evidence is zero test failures, no negative counters, and a passing threshold gate. A rerun that happens to pass without addressing shared state is not a fix.

## Consequences

The coverage job can take the heavy-suite duration plus the instrumented-suite duration instead of their maximum, but it no longer relies on a race-prone shared transform cache. The two lanes remain independently visible and blocking. Future CI diagnosis should preserve corrupt-counter evidence before considering coverage exclusions or `v8 ignore` comments.

## Alternatives considered

Increasing test timeouts, rerunning failed jobs, adding coverage exclusions, and suppressing the affected branches were rejected: none prevents invalid counters and each can hide a real coverage regression. Giving each process a separate cache was also rejected for now because the gate runner already provides a deterministic ordering seam with no new cache configuration contract.

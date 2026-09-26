# Agent Note: Coding-agent performance gates

Status: implemented

English | [中文](2026-09-26-coding-agent-performance-gates.zh.md)

## Problem

Harniverse had opt-in browser performance diagnostics and a small Python SDK benchmark note, but no repository-level performance contract for the coding-agent paths users exercise most often. A high-frequency stream can remain functionally correct while starving the browser event loop, retaining unbounded output, or leaving a Chromium process tree alive. A benchmark that runs several families on one limited-memory host can also become a source of failures instead of evidence.

## Decision

The repository owns a Linux-only blocking performance gate for three high-frequency I/O families: production `BashTerminalBackend` and `LocalPtySession` output, the Session-owned `BrowserController` with one Chromium process and four pages, and the real Web scaffold's reasoning-chunk stream. Each family runs as an independent CI job; samples inside one family are serial and use a fresh Vitest worker.

### Workloads and endpoints

- `terminal-io` writes 512 KiB through the production Bash PTY backend, observes a 10 ms heartbeat, reads a bounded 64 KiB result from 256 KiB scrollback, and checks completion, truncation, latency, heartbeat delay, and retained heap.
- `browser-controller` launches the product BrowserController against the lockfile-selected Chromium, creates four pages in one Session browser, navigates and follows the first page, measures the first frame and text-input acknowledgement, observes process-tree RSS, closes one page while three remain, and closes the final page.
- `web-streaming` reuses the assembled keyless browser scaffold and emits a reviewed 4,000-reasoning-chunk workload. It measures the browser main-thread heartbeat and a scheduled interaction while the real client session reduction and rendering path are live. The existing 100,000-chunk workload remains an opt-in diagnostic.

### Safety and CI

`scripts/run-benchmark.ts` runs each family in a detached Linux process group and samples `/proc` RSS for the complete process tree. A 2,048 MiB safety ceiling terminates the group before a limited-memory runner can be taken down by the benchmark. The Browser family has a reviewed 1,800 MiB process-tree budget; the other families use their source-level heap or latency budgets. The safety ceiling is not an environment-variable performance override.

The three jobs are included in the existing `all checks passed` aggregation. Their timing budgets are source constants, their inputs are synthetic, and no model key or external network is required. CI logs retain the JSON `HARNIVERSE_BENCHMARK_RESULT` record with workload, samples, aggregates, budgets, and runtime safety output.

### Calibration record

The calibration on 2026-09-26 used Linux x64, Node v24.14.0, pnpm 11.7.0, and Playwright Chromium 149.0.7827.55 revision 1228. `terminal-io` recorded a 41.851 ms median completion, 3.455 ms maximum heartbeat delay, 0.295 MiB maximum retained heap, and 446 MiB process-tree peak. `browser-controller` recorded a 31.52 ms p95 first-frame time, 1.447 ms p95 input acknowledgement, 1,266.641 MiB maximum observed process-tree RSS, 64.374 MiB retained heap, and 1,615 MiB runner peak. `web-streaming` recorded 21.9 ms maximum main-thread delay and 0.3 ms scheduled interaction delay for 4,000 chunks, with a 1,148 MiB runner peak.

## Alternatives considered

**One serialized benchmark job.** Rejected: unrelated families do not share a runner, so job-level parallelism reduces pull-request wall time without putting multiple Chromium trees on the limited-memory host. Samples remain serial inside each job for measurement isolation.

**Make every existing performance diagnostic blocking.** Rejected: complex-history and the 100,000-chunk stress workload are valuable investigations, but their setup, browser state and host variance are too large for the high-frequency gate. The gate keeps a smaller reviewed workload and the diagnostics remain available for diagnosis.

**Use a performance environment-variable override.** Rejected: a local or CI run must not pass by silently lowering the workload or raising a budget. The stream workload selector is a reviewed workload choice in the package command; the latency and memory budgets remain source constants.

**Measure only Node heap.** Rejected: Chromium renderer and browser processes dominate the multi-page Browser path. The runner observes the complete process tree and the Browser benchmark records that RSS alongside Node retained heap.

## Consequences

Pull requests now receive a blocking Linux performance signal focused on the I/O paths most visible to coding-agent users. The gate adds three hosted jobs and each job repeats install/build setup, but the families run in parallel and cannot consume one another's memory. The current scope deliberately leaves MCP discovery, cold history, browser startup-only analysis, and high-cardinality long-session diagnostics outside the blocking timing contract; those remain candidates for separately calibrated evidence when a concrete regression justifies them.

## Testing

The benchmark commands are `pnpm run benchmark:terminal`, `pnpm run benchmark:browser`, and `pnpm run benchmark:stream`. Their `:built` variants run after an existing build. TypeScript host/client checks cover the benchmark helpers and browser host test, while the CI jobs install Chromium and run the complete safety-wrapped commands on standard Linux runners.

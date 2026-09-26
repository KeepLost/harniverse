# Harniverse coding-agent benchmarks

This document owns the coding-agent performance benchmark contract. The goal is
to protect user-visible high-frequency I/O: streamed model/tool events, PTY
output, browser frame/input traffic, and Session event persistence. The gate
measures response latency, event-loop stalls, retained memory, and complete
cleanup. It does not attempt to turn every low-frequency operation into a
blocking performance test.

## Scope

The blocking workload has three Linux-only families:

| Family | Production path | User-facing endpoint |
|---|---|---|
| `terminal-io` | `BashTerminalBackend` → `LocalPtySession` → bounded scrollback | 512 KiB PTY output, 64 KiB bounded read, heartbeat delay and retained heap |
| `browser-controller` | `BrowserController` → Chromium/CDP → `HostBrowserPage` | one Session, one Chromium, four pages, frame delivery, text input acknowledgement and process-tree RSS |
| `web-streaming` | real Web scaffold → SSE → session reduction → React surface | 4,000 reasoning chunks, scheduled interaction delay and browser heartbeat delay |

Existing `apps/web/tests/complex-history.perf.ts`, MCP discovery diagnostics,
cold browser startup/teardown measurements, and the default 100,000-chunk
stress workload remain opt-in diagnostic evidence. They are deliberately not
blocking thresholds in this gate because their setup and host sensitivity are
larger than the high-frequency I/O contract.

The Browser family preserves the product lifecycle: one Session owns one
Chromium process, while that process owns multiple pages/tabs. The benchmark
creates four pages in the same browser, checks frame/input I/O, closes one page
while the other pages remain, and then closes the final page.

## Environment

The required gate runs on one standard `ubuntu-latest` runner per family:

- Linux only; Node `24`; pnpm `11.7.0`.
- Chromium is the lockfile-selected Playwright browser, installed with system
  dependencies for the browser families.
- No model credential, model request, recorded user Session, external network,
  or ambient repository content is used.
- Inputs are generated from constants in the benchmark source.
- Each family runs as an independent CI job. Samples inside a family run
  serially in a fresh Vitest worker.
- `scripts/run-benchmark.ts` monitors the complete Linux process tree and
  terminates the process group before it can exceed a 2,048 MiB RSS safety
  ceiling. This is a machine-protection limit, not a tunable performance
  budget.

Commands:

```sh
pnpm run benchmark:terminal
pnpm run benchmark:browser
pnpm run benchmark:stream
```

The `:built` variants skip the build and are used by CI after the normal
workspace build step inside each family command. The benchmark Vitest config
uses one worker and `--expose-gc`; the web family uses the existing real
scaffold and Chromium stress configuration.

## Measurements and budgets

Budgets are reviewed source constants. Environment variables cannot replace or
loosen them. Timing uses the reported sample median or p95 as named below;
memory ceilings apply to every sample.

| Family | Measurement | Blocking budget |
|---|---|---:|
| `terminal-io` | sample median command completion | `<= 3,000 ms` |
| `terminal-io` | maximum scheduled heartbeat delay | `<= 250 ms` |
| `terminal-io` | maximum retained Node heap sample | `<= 128 MiB` |
| `browser-controller` | p95 first image after navigation | `<= 2,000 ms` |
| `browser-controller` | p95 text-input acknowledgement | `<= 250 ms` |
| `browser-controller` | maximum four-page process-tree RSS | `<= 1,800 MiB` |
| `web-streaming` | maximum browser main-thread delay | `<= 250 ms` |
| `web-streaming` | scheduled interaction delay | `<= 250 ms` |

The outer runner's 2,048 MiB ceiling leaves 248 MiB of abort headroom above
the Browser family's reviewed 1,800 MiB process-tree budget. A safety abort
fails the family and prints the peak RSS, exit code, signal, and safety flag.

## Local calibration snapshot

The first calibration was run on 2026-09-26 from the Harniverse `dev` tree:

```text
Linux 6.8.0-101-generic x86_64
Node v24.14.0
pnpm 11.7.0
Playwright Chromium 149.0.7827.55 (revision 1228)
```

`terminal-io`, three samples, 512 KiB output:

```text
durationMs: [41.851, 42.388, 33.25]
durationMedianMs: 41.851
durationP95Ms: 42.388
heartbeatMaxDelayMs: 3.455
retainedHeapMaxMb: 0.295
process-tree peak: 446 MiB
```

`browser-controller`, two samples, four pages in one Session browser:

```text
firstPageMs: [697.547, 509.076]
firstFrameP95Ms: 31.52
inputAckP95Ms: 1.447
processTreeRssMaxMb: 1,266.641
retainedHeapMaxMb: 64.374
process-tree peak: 1,615 MiB
```

`web-streaming`, 4,000 reasoning chunks through the real browser scaffold:

```text
chunkCount: 4,000
maxMainThreadDelayMs: 21.9
interactionDelayMs: 0.3
heartbeatSamples: 20
process-tree peak: 1,148 MiB
```

The original 100,000-chunk diagnostic workload remains available by omitting
`DSH_WEB_STRESS_CHUNKS`; the blocking CI command uses the reviewed 4,000-chunk
workload so the required gate measures a repeatable high-frequency path without
turning the limited-memory runner into an uncontrolled soak test.

## CI gate

`.github/workflows/ci.yml` runs `performance / terminal I/O`, `performance /
browser I/O`, and `performance / streaming I/O` as independent Linux jobs.
They run in parallel on separate hosted runners, so the gate does not serialize
unrelated families. Each job serializes its own samples and enforces the RSS
safety ceiling. All three jobs are listed in the existing `all checks passed`
aggregate, which is the branch-protection check for the `dev` to `master` PR.

A performance change is acceptable only when the corresponding family passes
its workload, latency, memory, event-completeness, and teardown assertions. Raw
`HARNIVERSE_BENCHMARK_RESULT` records are kept in CI logs so a failure can be
compared with the workload and runtime that produced it.

# @deepseek-ai/dsh-plugin-diagnostics-cordis

English | [中文](README.zh.md)

Read-only Cordis lifecycle contributions for [`dsh-plugin-diagnostics`](../plugin-diagnostics/README.md). The plugin registers three effect-owned checks: enabled non-group Host Loader entries, live standing agent-preset mounts, and retained dynamic Cordis activation attempts.

The Host and preset checks classify pending, loading, failed, and unloading root fibers without treating `ACTIVE` as an independent health guarantee. Pending findings list only missing service names. The dynamic check classifies failed attempts as errors and waiting attempts as warnings while omitting exception text, stack traces, source, configuration, and credentials. Stopped or successful dynamic attempts produce no finding.

Every `fixHint` is text. This package cannot retry, stop, disable, delete, reload, write configuration, or control the process. Disposing its plugin fiber removes all three checks.

## Model Experience

None, as the lifecycle checks observe Host state without changing model context.

#### KV Cache effect

None; the package does not assemble provider requests.

## Known Limitations and Deferred Work

- **Three Host domains only** — the checks do not inspect each browser page's separate Cordis root, bundle provenance, durable history, or arbitrary plugin-owned health semantics.
- **Service-name dependency detail** — pending findings identify absent service keys but cannot determine whether deployment ordering, isolation, configuration, or a failed provider caused the absence.

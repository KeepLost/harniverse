# compaction/ — compaction capability family

English | [中文](README.zh.md)

A compaction capability family (see [capability seams](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)): a Service Definition, two exclusive summarizing providers, proactive and recall model Consumers, a model-free tool-result pruning companion, and a human command Consumer. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| [`compaction/`](compaction/README.md) | Compaction seam and event vocabulary | `ctx.compaction` |
| [`compaction-basic/`](compaction-basic/README.md) | Token-pressure and summarization backend | registers `ctx.compaction` |
| [`compaction-settings/`](compaction-settings/README.md) | Root-owned global pressure-threshold settings | registers the `compaction` Settings namespace |
| [`compaction-lossless/`](compaction-lossless/README.md) | Automatic backend plus committed summary-DAG projection | registers `ctx.compaction`, `ctx.compactionHistory` |
| [`tool-compaction/`](tool-compaction/README.md) | Direct model-requested retained-tail compaction | registers on `ctx.tools` |
| [`tool-compaction-history/`](tool-compaction-history/README.md) | Model-facing current-session summary search and expansion | registers on `ctx.tools` |
| [`compaction-tool-result-pruner/`](compaction-tool-result-pruner/README.md) | Optional model-free tool-result pruning | `ctx.toolResultPruner` |
| [`command-compact/`](command-compact/README.md) | Human compaction command | registers on `ctx.commands` |

One backend, the optional pruner, and the proactive, recall, and human Consumers compose through the seam; token measurement remains a separate LLM-family service. The [compaction capability-seam Agent Note](../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md) owns the dependency rationale, the [model-requested compaction Agent Note](../../.agents/notes/implemented/feature/2026-08-21-model-requested-context-compaction.md) owns the proactive trigger, and the [summary DAG Agent Note](../../.agents/notes/implemented/feature/2026-08-18-summary-dag-compaction-history.md) owns recallability.

The subsystem reference — the `compaction/*` events, `CompactionResult`, the service, pruning outcomes — is [docs/subsystems/compaction.md](../../docs/subsystems/compaction.md); the seam's deliberate `dsh-session`/`dsh-llm` dependency is recorded in the [compaction capability-seam Agent Note](../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md).

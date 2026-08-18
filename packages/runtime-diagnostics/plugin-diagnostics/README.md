# @deepseek-ai/dsh-plugin-diagnostics

English | [中文](README.zh.md)

Read-only registry for structured plugin diagnostics. The service registers `ctx.pluginDiagnostics`; product packages contribute stable check ids, descriptions, and `diagnose()` callbacks through effect-scoped registrations. `ctx.pluginDiagnostics.diagnose()` snapshots the current registrations, runs them sequentially, isolates each failure, and returns one severity-sorted `PluginDiagnosticReport`.

Findings identify their check, stable code, severity, runtime domain, message, optional diagnostic path, and optional textual response hint. A contribution cannot publish a finding under another check id. The service exposes no repair callback, restart operation, configuration writer, process control, or durable incident state.

The JSON-safe report types are published through `./types`. Consumers may expose a report over a separately authorized wire operation without importing the service implementation.

## Model Experience

None, as plugin diagnostics observe runtime state without registering prompts, tools, messages, or provider requests.

#### KV Cache effect

None; diagnostics never assemble model input.

## Known Limitations and Deferred Work

- **Point-in-time reports** — the registry retains checks, not findings or incident history; callers must persist or compare reports outside this service if they need chronology.
- **Sequential checks** — a slow contribution delays later checks until cancellation or settlement; the first release owns no timeout policy because callers currently run only local bounded checks.

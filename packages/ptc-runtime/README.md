# ptc-runtime/ — PTC capability family

English | [中文](README.zh.md)

The PTC capability seam (see [capability seams](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)): a runtime Service Definition for executing one model-written program against host-provided async bindings, capturing what it printed and returned; replaceable providers; and the tool registry's [PTC](../core/tools/README.md) Consumer (`tools: { mode: code }` — the `run_code` tool and the SDK generated in the loaded runtime's `language`). Design is in the [PTC Agent Note](../../.agents/notes/implemented/feature/2026-06-15-code-mode.md). **Product** packages.

| Package | Role | ctx key |
|---|---|---|
| [`ptc-runtime/`](ptc-runtime/README.md) | Service Definition and shared vocabulary | `ctx.ptcRuntime` |
| [`ptc-runtime-node/`](ptc-runtime-node/README.md) | TypeScript fresh-process PTC backend | registers `ctx.ptcRuntime` |
| [`ptc-runtime-python/`](ptc-runtime-python/README.md) | Opt-in Python process backend | registers `ctx.ptcRuntime` |

Providers register the service without changing its Consumer. The child READMEs own language, isolation, and execution-budget details.

The subsystem reference — run requests/results, binding namespaces, the failure taxonomy — is [docs/subsystems/ptc-runtime.md](../../docs/subsystems/ptc-runtime.md).

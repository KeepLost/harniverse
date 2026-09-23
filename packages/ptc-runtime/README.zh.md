# ptc-runtime/ — PTC 能力家族

[English](README.md) | 中文

PTC 能力 seam（参见[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)）：运行时 Service Definition，用于对宿主提供的异步绑定执行模型编写的程序，并捕获它打印和返回的内容；可替换的提供方；以及工具注册表的 [PTC](../core/tools/README.md) Consumer（`tools: { mode: code }`，即 `run_code` 工具和按所加载运行时 `language` 生成的 SDK）。设计见 [PTC Agent Note](../../.agents/notes/implemented/feature/2026-06-15-code-mode.md)。这些全是**产品**包。

| 包 | 职责 | ctx key |
|---|---|---|
| [`ptc-runtime/`](ptc-runtime/README.md) | Service Definition 与共享词汇 | `ctx.ptcRuntime` |
| [`ptc-runtime-node/`](ptc-runtime-node/README.md) | TypeScript 新进程 PTC 后端 | 注册 `ctx.ptcRuntime` |
| [`ptc-runtime-python/`](ptc-runtime-python/README.md) | 显式选择的 Python 进程后端 | 注册 `ctx.ptcRuntime` |

提供方在不改变Consumer的情况下注册该服务。子 README 负责语言、隔离和执行预算细节。

子系统参考——运行请求/结果、绑定命名空间、失败分类体系——见 [docs/subsystems/ptc-runtime.md](../../docs/subsystems/ptc-runtime.md)。

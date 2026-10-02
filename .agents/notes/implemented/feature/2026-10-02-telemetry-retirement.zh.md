# Agent Note: 会话遥测退役

Status: implemented

[English](2026-10-02-telemetry-retirement.md) | 中文

## 问题

遥测面 —— `session-telemetry`（`ctx.sessionTelemetry` seam 与 `session-telemetry/record` waterfall）、`session-telemetry-otel`（以 `FULL`/`FEEDBACK_ONLY`/`DISABLED` 模式经 OTLP/HTTP 投递）以及 `anonymous-user-id`（`$DSH_HOME/.anonymous-user-id` 关联 id）—— 在所有组合中都以禁用状态发布，没有任何属主部署消费它，却仍付出真实表面成本：`DSH_TELEMETRY_MODE`/`DSH_TELEMETRY_OTLP_URL`/`DSH_TELEMETRY_DISABLED` 环境缝、CLI 与 remote server 的启动期禁用补丁、每个 `llm-deepseek` 请求上的身份头，以及 `/feedback` 打印的共享披露与匿名 id。

## 决策

整能力移除（wave-4 吸收的 X04）：

- `session-telemetry`、`session-telemetry-otel` 与 `anonymous-user-id` 从树中删除；基础组合行、其 OTel 依赖以及全部启动缝（`DSH_TELEMETRY_*`）一并移除。这些变量如今无人读取。
- 两个 `llm-deepseek` 协议都不再发送 `x-deepseek-harness-user-id` 与 `x-deepseek-harness-session-id`；请求边界的压缩标记 `x-deepseek-harness-compact` 保留。两个协议都有头缺失测试，含命名了会话的请求。
- `/feedback` 只以会话 id 确认 —— 没有匿名用户、没有共享句子 —— 且不再读取 `ctx.get('sessionTelemetry')`。
- 文档、生成的目录（config catalog、cordis catalog、api-catalog、module graph、capability seams、event relations）、knip 与 type-equivalence manifest 不再提及该 seam。

本注取代[遥测默认关闭](2026-08-10-telemetry-default-off.md)、[反馈门控会话遥测](2026-08-05-feedback-gated-session-telemetry.md)、[web 遥测默认挂载](2026-07-31-web-telemetry-default-mount.md)与[session-telemetry-otel 复活](2026-07-23-session-telemetry-otel-revival.md)；这些注作为被移除能力的设计史保留。

## 备选方案（Alternatives considered）

**保留无后端的休眠 seam。** 否决：带着环境开关与身份管线的未挂载 seam 正是退役要移除的表面；休眠仍在为一个没有任何东西在用的能力做广告。

**只移除 OTel 后端，保留 seam 与匿名 id。** 否决：没有后端、没有披露之后，seam 没有任何消费方，而匿名 id 的存在意义就是关联遥测（它最后两个消费方是身份头与反馈确认，都在本次移除）。

## 后果

会话遥测无法通过配置重新启用；重新引入意味着从历史中恢复包、组合行与环境缝。`/feedback` 不再创建 `$DSH_HOME/.anonymous-user-id`，已有的 id 文件变为惰性。依赖 `x-deepseek-harness-*` 身份头做网关路由的部署必须停止依赖它们。放弃的能力：为需要它的部署提供可选的会话记录 OTLP 导出。

## 测试

`pnpm exec vitest run packages/feedback/command-feedback/tests packages/llm/llm-deepseek/tests packages/bundle/base/tests` —— 反馈确认形状、两个协议的头缺失、无该行的基础组合。`pnpm run verify-config-catalog`、`verify-cordis-catalog`、`verify-api-catalog`、`verify-cordis-api`、`verify-module-graph`、`verify-translation-pairing` 与 `verify-agent-note-format` 覆盖再生的工件。

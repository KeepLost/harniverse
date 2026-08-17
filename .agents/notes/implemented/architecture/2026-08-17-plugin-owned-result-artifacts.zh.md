# Agent Note: 插件拥有结果产物

Status: implemented

[English](2026-08-17-plugin-owned-result-artifacts.md) | 中文

## 问题

最终结果保留曾位于 `ToolRuntime` 内部，核心因此导入可选的 spill Service Definition，并发出点名 `artifact_read` 的说明。取回工具却由另一个独立组装的包提供。合法 patch 因而可能保留核心 retention，却移除唯一能恢复产物的 Consumer，产生承诺了不可用工具的成功结果。`SpillRef.retrievalHint` 还允许每个存储 Provider 选择面向模型的措辞，而存储与呈现的演进原因并不相同。

认证 token 管理在应用边界存在同类归属错误：通用 launcher 解析 Provider 特有命令并直接导入 `dsh-authentication-local`，没有通过 profile 树启动应用插件。

## 决策

`ToolRuntime` 公开 `tools/finalize-result`：这是一个按 scope 筛选的异步 waterfall，位于定义自有 `finalizeContent` 之后、权威无损物化与 `tools/result` 之前。核心负责调用顺序、失败规范化、不可变提交和观测；它不再拥有 spill 依赖、保留上限、产物标记或取回工具名称。

`@deepseek-ai/dsh-tool-result-artifacts` 同时是 `ctx.tools` 与 `ctx.spillStore` 的 Consumer。它的单个插件既注册最终结果保留监听器，也注册 `artifact_read`，因此 retention、标记措辞、`TOOL_RESULT_RETENTION_FAILED`、分页上限和取回生命周期无法被 patch 拆开。Base 与 headless 在全局组装它；Web 禁用该行，并由每个 agent preset 在自己的 scope 中挂载同一包。

`SpillRef` 只携带 `{ locator, bytes }`。Provider 负责持久化、不透明寻址、分页、取消和精确字节报告。Consumer 负责所有面向模型的通知与指令。可选的 `spill-policy` 仍是独立的尽力而为早期转换器，并渲染自己的 Provider 无关 locator 指引。

独立的 `@deepseek-ai/dsh-auth-app` bundle 将同一归属规则应用于管理入口。`dsh auth` 只是 `auth` profile 的别名；`auth-startup` 解析应用语法并释放注入的 `auth-runner`，后者调用本地管理 API 并请求有界退出。该 profile 不挂载 Agent、WebServer 或运行时认证 Provider，因此空 Harness home 可以创建首个 token。

Notification 与 session-telemetry Definition 包继续内置各自的 coordinator Consumer。生成的能力投影会在 Consumer 列列出同一个包，而不是显示该角色缺失。

## 考虑过的替代方案

**让 ToolRuntime 按名称要求 `artifact_read`。** 不予采用，因为核心注册表仍会知道一个 Consumer 的模型协议和包生命周期；名称检查也无法证明 retention 与 retrieval 会同时卸载。

**把 retention 留在核心，并在那里注册内置取回工具。** 不予采用，因为这会把可选存储 seam 变成核心策略，并让不带 Provider 的工具运行时携带无关配置和模型表面。

**继续让 Provider 返回取回措辞。** 不予采用，因为后端存储事实无法决定部署组装了哪些工具或 UI。远程 Provider 可以变化，而稳定的 Consumer 指令无需变化。

**把 `dsh auth` 保留为无需启动的 launcher 模式。** 不予采用，因为这会在 Cordis 之外建立第二套应用协议，并让根 launcher 依赖一个具体认证 Provider。

## 后果

一旦组装结果产物 Consumer，每个成功保留标记所点名的取回工具必定由同一个 fiber 挂载。自定义部署可以省略整项能力；此时 ToolRuntime 会返回未经最终结果策略限制的定义已终结结果，因为没有组装任何相关策略。随附 bundle 而非核心选择 50,000 码点上限。

最终结果 waterfall 权限较大：监听器可以异步转换完整结果，抛出则会成为规范化工具失败。监听器必须调用 `next()`，保留自己不拥有的同进程类型字段，为自有工作遵循取消，并在不可变通知之前完成结算。

真实 Loader 测试覆盖空 home token 创建和合并后的 retention/retrieval 包。聚焦流水线测试固定 finalizer 顺序，agent-loop 测试固定持久产物引用和有界 surface，生成目录检查则防止包或事件投影过期。

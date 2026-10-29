# @deepseek-ai/dsh-tool-subagent-oar

[English](README.md) | 中文

本包注册一个委派工具（默认名 `subagent_oar`），让模型为每个自包含任务选择一个已配置的外部运行时。该工具是 [`dsh-subagent`](../subagent/README.md) 之上的薄适配层：把部署方持有的 `providers` 表（模型可见的运行时别名到已注册一次性 provider 名称的映射——通常是 [`dsh-subagent-oar`](../subagent-oar/README.md) 实例）作为唯一配置，自身不包含任何运行时逻辑。

## 模型看到什么

```yaml
- id: tool-subagent-oar
  name: '@deepseek-ai/dsh-tool-subagent-oar'
  config:
    providers:
      codex: oar-codex
      claude: oar-claude
```

声明暴露 `runtime`（已配置别名的枚举）、`description` 与 `prompt`。参数枚举由不可变配置构建，未配置的运行时名称会在任何子代理启动前就失败于 schema 校验。每次调用都要求存在调用方 agent，且要求提供具有独立会话上下文的一次性 provider——继承父上下文或支持续聊的 provider 会被显式拒绝，而不是被驱赶到外部路径上。

子代理在自有上下文中工作，看不到本会话，不接受后续消息，也不能超出本次调用存活：工具等待子代理的唯一回合并返回其最终答案。并发安全：子代理绝不改变父会话。

## 输出

| 字段 | 含义 |
|---|---|
| `mode` | 恒为 `sync` —— 一次性结果在调用内结算。 |
| `invocationId` / `sessionId` | 子运行身份（`dsh-subagent` 运行 id）。 |
| `output` | 子代理的最终内容块。 |

提前停止的子代理被压平为携带停止原因、安全 provider 诊断与任何部分输出的错误；渲染行会指名子会话，并说明一次性会话不接受后续轮次。

## Model Experience

### 父级工具调用

#### 模型看到什么

`runtime`（已配置别名的枚举）、`description` 与完整的 `prompt`；会话中没有其他内容跨过缝隙，子代理的原生记录绝不进入本会话。

#### Token 效应

被委派的任务完全在外部运行时内执行；父请求只携带本工具的声明与结果，父级 token 成本与子级规模无关。

#### KV Cache 效应

委派不改变父级前缀：工具调用及其结果追加在会话尾部，父级更早的每一个 KV 条目保持有效。

## 已知限制与遗留工作

- 上游的工具立即返回激活凭据，并在此后经父级完成通知送达最终答案；Harniverse 的一次性缝隙在调用内结算运行，因为异步激活机制保留给可续聊 provider 使用（已记录的适配）。
- 无按调用的 `cwd` 参数：子工作目录遵循共享缝隙的父会话派生。

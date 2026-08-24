# Agent Note：产品 subagent 失败事实

Status: implemented

[English](2026-08-24-product-subagent-failure-facts.md) | 中文

## 问题

Claude Code 与 Codex 一次性提供方会把产品、协议和进程失败扁平化为共享的未完成结果，但单独的终止原因无法区分产品上限、权限拒绝、协议关闭或进程退出。若把原生错误、stderr、提示词、路径、环境值、凭证或协议 payload 复制给父级模型，就会暴露不可信且可能包含秘密的数据。

## 决策

`SubagentResult` 提供可选的提供方撰写 `diagnostic`，用于承载非 assistant 的失败详情。共享进程外结算路径把完整值限制在 4096 个 UTF-8 字节内且不切断代码点，并在取消胜出时省略该字段。消费方让该字段与 assistant `output` 保持分离；前台委派工具会在任何部分 assistant 回答之前，以 `Diagnostic:` 标签渲染它。

每项产品失败都以 `Product subagent failure (product: <product>; stage: <stage>; category: <category>)` 开头，而且只可附加校验过的 HTTP 状态以及独立观察到的进程退出码或信号。该行是展示文本，不是可解析协议。成功与本地取消会省略它。

Claude Code 只映射已知 SDK 失败子类型，以及固定的 invalid-success、missing-result、process-exit 和 unknown 类别。其固定无人值守策略仍不增加公开配置：可用的 SDK 回调会拒绝工具审批、拒绝 MCP elicitation 并取消受支持的阻塞式对话，而 diagnostic 只记录固定请求类别与决策。原始错误通过安全包装和 cause 继续提供给 Host `onError`。

Codex 只映射固定字符串和单键对象 `codexErrorInfo` 变体，仅从受认可的连接与流变体接受数值 HTTP 状态，并把畸形或未来变体归为 unknown。协议层会记录固定的默认拒绝请求决策，而且只识别准确的审批拒绝与沙箱违规 stderr 特征，包括跨 chunk 的情形。原始 stderr 会转发给 Host，但绝不会保留在 diagnostic 文本中；JSON-RPC 与进程结算仍是终态权威来源。

## 验证

行为测试覆盖共享多字节限制、不变的成功与取消结果、Claude SDK 与进程失败、Claude 无人值守决策、Codex 终态类别与 HTTP 状态、Codex 请求与 stderr 权限路径、进程与协议失败、max-token 结果、不安全数据排除，以及前台 diagnostic 分离。一个无密钥组装 ACP 快照会固定 Claude Code 与 Codex 前台和后台 diagnostic 的呈现。聚焦的 TypeScript 项目构建覆盖共享服务、两个产品提供方和前台消费方。

## 考虑过的替代方案

**复制经过脱敏的原生错误消息或 stderr。** 脱敏无法枚举每条路径、提示词、环境值、凭证或未来协议字段，因此 diagnostic 改用固定白名单与独立进程事实。

**在移植 diagnostic 时增加可配置权限模式。** Harniverse 已把产品策略交给原生设置，并公开固定的无人值守行为；diagnostic 不能成为新增公开权限控制的理由。

**在字符串中编码结构化机器协议。** 消费方需要有界说明文本，而稳定的机器字段需要单独进行版本化的类型约定。

## 后果

父级模型会收到可操作的产品来源事实，而不会收到产品 payload 或秘密。随着产品协议演进，提供方必须维护显式类别白名单和安全权限特征；Host 日志仍可独立保留更丰富的原始失败。共享字节限制会约束每个被扁平化的提供方 diagnostic，包括未来使用同一结算辅助函数的提供方。

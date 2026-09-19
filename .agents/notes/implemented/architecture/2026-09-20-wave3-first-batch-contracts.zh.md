# Agent Note: Wave-3 第一批共享契约——MCP、控制通道、远端执行、图片卸载与归档导入

Status: implemented

[English](2026-09-20-wave3-first-batch-contracts.md) | 中文

## Problem

wave-3 上游评审接受了五项行为，其持久性与跨插件词汇必须在 provider、传输和 UI 运行时落地之前存在：Profile 权威下的 MCP 资源、PTC 与 SSH 共享的有界控制通道、远端执行世界描述符、基于年龄的图片卸载、以及有损外部会话导入。先做任何运行时都会迫使这些共享类型被晚发现——那时多个消费者已编码了分歧的假设。

## Decision

第一批交付五个契约先行的包，全部为纯或近纯包并带行为测试，先于各自运行时。`@deepseek-ai/dsh-image-offload-policy` 拥有 `imageOffloadAfterUserTurns` 设置形状、每图用户轮次计龄规则（assistant 消息、工具流量和快照不给图片计龄；此前的卸载或压缩遮蔽使图片完结）、压力结算、required-on-read 的 `image/offload` 事件、以及规范桩文本——配置年龄到期立即卸载，缓存复用从不延迟。`@deepseek-ai/dsh-session-import` 分类外部头（`official-v1`/`v2`/`v3`、`current`、拒绝的 `unknown`），拥有首事件 `import/record` 归档标记及其 invariant，并导出 `assertNotResumable` 排除守卫。`dsh-mcp-client` 增加资源身份与可见性契约（`mcp-resource` 成员 kind、capability-id 约定、收窄成员的 `resolveMcpMemberVisibility`、区分 topology 刷新与仅其产生新 generation 的 composition 变更的 `classifyMcpRefresh`）；`CapabilityMemberDescriptor.kind` additive 拓宽。`@deepseek-ai/dsh-control-channel` 拥有带字节上限的长度前缀帧编解码、排队写入与未决调用背压、正交失败词汇表、以及终态类别互不横渡、清理独立报告的生命周期状态机。`@deepseek-ai/dsh-execution-descriptor` 拥有不可变的机器自有描述符：POSIX workspace 根、允许的能力 kind、按环境变量名的凭据引用、解析时校验的规范 sha256 digest、深度冻结、以及对 Host 本地 `cordis` preset 的拒绝。

## Alternatives considered

- 把每个契约定义在其未来运行时包内：拒绝——运行时包尚不存在，等待会把词汇发现耦合到评审并未排定的 provider 截止期。
- 单一共享 "wave-3 contracts" 包：拒绝，五个契约的消费者不相交；一个包会迫使 MCP、subprocess、compaction 和 persistence 共享依赖根，毫无理由。
- 通过拓宽 `SessionHeader.origin` 表达归档标记：拒绝——它会为一个调用方同时触及两个持久化后端的头校验，而首事件标记与现有日志词汇组合，并携带头字段装不下的姿态与工件字段。

## Consequences

两个新会话事件（`image/offload`、`import/record`）additive 拓宽 v0 词汇；digest 基线与持久化目录随其重生成，对应账目行按新约定带 `Compat:`/`Verify:` 尾注。`mcp-resource` 成员 kind 是 `dsh-capabilities` 的 additive 公共 API 拓宽。运行时集成刻意保持开放：图片投影、导入映射与搜索、MCP 资源发现、PTC/SSH 传输、描述符发布，各自在排定工作项中组合这些包；契约的测试钉住它们依赖的语义。

## Scope

五个包及其测试、`dsh-mcp-client` 契约模块与 README、`dsh-capabilities` 成员 kind 拓宽、重生成的目录与 digest 基线、以及本 note。不含任何 provider、传输、投影或 UI 运行时。

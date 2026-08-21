# Agent Note: 作用域能力控制平面

Status: implemented

[English](2026-08-20-scoped-capability-control-plane.md) | 中文

## Problem

Agent Profile 通过插件行组装工具、Skills、MCP client 与委派表层，但运行时 registry 只能描述已经挂载的内容。为了构建管理目录而挂载每个健康 Profile，会仅因检查就启动插件，也无法表达把目标 Profile 中缺失的行加入组装。分散的 Settings form 同样无法提供统一的全局/Profile 继承组装、依赖预览或保持运行中 Session history 的统一规则。

## Decision

`dsh-capabilities` 管理可扩展类型化配方目录、继承的组装覆盖以及受 revision 约束的 `plan`/`apply` 事务。配方除了 kind、provenance、owner、assembleability、实现健康状态、源默认值、manageability 与硬依赖外，还可声明不可变的模型可发现成员及显式的 Profile 安全配置契约。`dsh-agent-presets` 在不挂载的情况下读取健康 Profile YAML，并把每个顶层行或 group 投影为一项配方。每个 target 使用同一份部署级配方全集，同时保留各 Profile 的原生源默认值。

全局 Agent 值流入每个 Profile，Profile 的显式值优先。省略表示继承，最终回退到目标 YAML 的原生状态。加载选择、显式成员 allowlist 与 owner 声明的原始配置字段采用同一分层。Planner 除自动加入可组装硬依赖、阻止未知、不可管理、不可组装或破坏依赖的变更外，还校验成员 id 和配置字段，并在 Settings 或 adapter 拓扑变化时使 plan 过期。应用 plan 只写期望组装；旧字符串选择会规范化为对应的结构化覆盖。

Profile generation 启动时，roster 把期望选择和配置编译为原生 `Include` patch：卸载的源行变为 disabled，目标中缺失的已选配方插入其部署规范行，Persona 获得完整解析配置，Web 或可选委派工具等由配置控制的内置成员获得原生行值。Generation-scoped Tool 与 Skill allowlist 通过各自原生 registry 强制发现与执行限制，包括 Code Mode 嵌套分派。MCP client 动态发布 server 成员，并在保持 Host 共享连接运行的同时，以 Profile restriction 隐藏整台 server 或选定工具。共享 Subagent provider 保持可见、只读，而各 Profile 的委派插件 group 及模型可见成员可以选择。

Agent Profile standing generation 把有效选择、可见成员 id 和解析配置纳入组装签名。新 Session 加入最新 generation，已有 Session 保持在其 schema 与 history 已使用的 generation。硬激活失败会阻止 Session 发布。每个成功 generation 捕获不可变配方及成员结果；授权 Session Remote 暴露 generation id、解析后的成员，以及已加载、未加载、加载失败、依赖阻止或安全拒绝状态。进程全局的只读 Cordis Inspect provider 使用显式兼容共享租约，因此 Creator 的多个 generation 可以共存，而普通重复 provider 仍然失败。该机制扩展[Agent scope runtime](2026-07-12-agent-scope-runtime-design.md) 的 scope ownership，而不把运行中模型目录变成可变 Session 状态。

Host management Remote 把目录与 Session 运行态读取保留在 `harniverse.observe`，规划与应用需要 `harniverse.administer`。插件诊断仍是只观察服务。Web Settings 暂存本地选择、成员和配置编辑，显示 Host plan 与 blocker，并只提交无阻止项的 plan id 和预期 revision。能力卡片把成员和配置控件折叠在简洁摘要之后；独立的 Session“能力”视图保持只读。

## Alternatives considered

**检查已挂载 registry 并应用 deny filter。** 拒绝，因为目录读取会挂载每个 Profile，缺失插件无法被选择，且 UI 会混淆实现健康状态与期望组装。

**每个子系统一张组装页。** 独立 Tool、Skill、MCP 与 Subagent 页面会重复 target 选择、继承、revision fencing、依赖规划与 Session generation 规则。Adapter 在统一组装事务之后保留原生语义。

**修改所有运行中 Session。** History 已存在后增加或移除模型可见 schema 会破坏 replay 与工具调用连续性。Generation pinning 让新对话获得所需组装而不改写活动对话；紧急撤销仍由独立的单调 runtime guard 处理。

## Consequences

用户获得一套全局/Profile 组装 editor、不可修改定义但可按 Profile 控制可见性的内置成员、类型化 Persona 配置、动态 Skill/MCP 成员选择、自动硬依赖选择，以及每个 Session 的不可变运行态视图。目录读取会解析文件并发现 Skill，但不启动 Profile 插件。工具可见性不替代沙箱或权限策略：另一项可见工具仍可能产生相同效果。Loader 保持生命周期权威，运行中 Session 保持稳定。顶层行和 group 仍是加载单元，声明的成员进一步收窄模型可见表层；凭据、冲突、软依赖和可选 `ctx.get()` 路径等语义依赖在配方描述前保持保守。

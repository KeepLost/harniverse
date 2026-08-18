# Agent Note: 只读插件诊断

Status: implemented

[English](2026-08-18-read-only-plugin-diagnostics.md) | 中文

## Problem

Cordis 通过多个独立 owner 公开插件生命周期状态：Host Loader 条目、standing agent preset 挂载、保留的动态 package 尝试，以及每个浏览器页面各自的 Cordis root。Loader `ACTIVE` 表示激活完成，不证明插件持续健康。运维人员已有清单视图，但没有结构化方法区分依赖缺失、激活失败、过渡状态或无法观察目标的诊断检查。复制 OpenClaw Doctor 可执行修改的命令模型，还会让观察路径基于不完整的时间点证据重启、改写或删除状态。

## Decision

`@deepseek-ai/dsh-plugin-diagnostics` 是 Service Definition 和协调者。`ctx.pluginDiagnostics.register()` 通过 Cordis effect 拥有贡献，`diagnose()` 对当前检查制作快照，依次执行检查并返回排序后的 `PluginDiagnosticReport`。每个发现项包含稳定归属、严重程度、域、人类可读观察，以及可选路径和文本处理建议。检查异常记录在 Host 日志中，并转为通用发现项，因此单个损坏检查既不会中止报告，也不会通过 wire 发送异常详情。

`@deepseek-ai/dsh-plugin-diagnostics-cordis` 是已装配 Provider。它贡献针对已启用 Host Loader root、活动 standing preset root 和保留的动态 Cordis 尝试的检查。检查在诊断运行时查询 owner 清单，并且只发布服务名称或生命周期阶段。动态异常文本、stack trace、package 源码、配置和凭据绝不进入发现项。浏览器页面 Cordis root 不属于 Host 诊断，因为 Host 没有其完整本地插件树的权威视图。

现有 `PluginInventoryGateway` 是 Consumer 和 wire adapter。其 `pluginInventory/diagnose` Remote 与已有清单操作一样要求 `harniverse.observe`。现有 Web 插件设置标签页一起加载清单和诊断，并渲染严重程度、代码、消息、路径与文本建议。服务、Provider、Remote 和 UI 都不定义修复、重启、重试、禁用、删除、配置写入或进程控制操作。

报告仅表示调用当下并用于建议。`ACTIVE` 不产生发现项，但绝不充当健康证明。等待和瞬态状态不会触发操作。文本提示可以告知运维人员验证哪些事实，但调用方无法把提示作为可执行命令传回此能力。

## Alternatives considered

**Doctor 风格的 detect-and-repair 接口。** OpenClaw Doctor 展示了有用的稳定检查 id 和失败隔离，但其普通路径在历史上混合了观察、写入和重启。Harniverse 把修复留在此能力之外，直到独立授权的操作能够证明归属、新鲜度、幂等性和后置条件验证。

**把检查嵌入 `PluginInventoryGateway`。** 这会把每个生命周期 owner 耦合到 Host Remote 包，并使非 Web 消费方依赖 wire adapter。effect 作用域注册表保留插件归属，也允许其他报告消费方加入而无需移动检查。

**单独的诊断 Settings 插件。** 清单和诊断描述同一组已部署插件，并共享授权、加载、重试和空状态行为。扩展现有标签页可避免另一个导航贡献和 Remote adapter。

**从 Host 诊断浏览器 Cordis root。** 浏览器 root 逐页面存在，在加载、HMR、重连或标签关闭期间可能不同。把一个客户端报告当作 Host 真相会合并权限域并产生基于陈旧状态执行修复的压力，因此首版保持 Host owner 范围。

## Consequences

运维人员通过现有插件设置路径获得一份结构化且安全授权的报告，包作者可以添加检查而无需编辑注册表或 gateway。effect 归属会在重新加载时移除贡献，失败收容则使部分报告保持可用。代价是刻意受限的范围：报告没有持久事故历史、自动刷新、浏览器 root 诊断、检查超时策略或修复路径。未来 remediation 必须通过单独的决策与能力实现，而不是向诊断发现项添加回调。

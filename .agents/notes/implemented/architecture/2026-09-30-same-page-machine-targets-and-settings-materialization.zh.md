# Agent Note: 同页机器目标与仅限主机的设置物化

Status: implemented

[English](2026-09-30-same-page-machine-targets-and-settings-materialization.md) | 中文

## Problem

打开远程 workspace 需要以 `dshRemoteHost=<RemoteHostId>` 为键的第二个浏览器页面。跨机器工作意味着重复的标签页，各自持有独立的 runtime 持久化作用域，而且远程页面通过自己的进程环境解释被同步的模型设置：未固定凭据的路由会静默地用该环境恰好持有的无关秘密完成认证。在单个文档内部，除了刷新页面之外，没有任何机制能退役一台机器的会话、store、scope 与进行中的操作，因此双页拆分也是客户端当时唯一的隔离边界。

## Decision

机器目标是一等概念，并在同一文档内切换。`MachineTarget`——`{ kind: 'host' }` 或 `{ kind: 'remote', id }`——是连接层的路由词汇，经可观察的 `ctx.connection.target` 发布。`switchTarget(target)` 停止当前流循环，退役当前 `TargetGeneration`（其 AbortController 取消前一台机器的 unary 调用、上传与事件流），运行流消费方的 `onTargetChange` 清理，并仅在清理落定后启动新流；它不等网络就绪即返回，因此远程不可用时仍能立即返回本机，重复选择同一目标会共享既有切换。`captureApi()` 把机器所属对象绑定到当前 generation，使其迟到调用被拒绝；稳定的 `api` 接口把主机管理命名空间（`remoteHosts`、`settings`、`credentials` 与认证）路由到页面权威，其余一切经 `dshRemoteHost` 载体参数承载。

runtime 按机器替换内部 Session 与 Workspace manager，同时保留公开服务、列表数据源与当前 provide 数据源：会话 scope 携带 incarnation 标记，使寻址或解析已退役机器的 scope 严格失败；`SessionListState.targetGeneration` 即使在会话 id 冲突时也能区分机器生命周期；会话作用域 store 与选中持久化使用按机器命名的命名空间，而根级 UI 偏好保持本地。`ui-workspace` 通过一个 Cordis-effect generator 按机器重新注册各入口（清空搜索、对话框、预览与文件缓存），并声明 `sidebar.workspaces.machine`，`ui-remote-hosts` 在其中挂载机器指示器——活跃机器名称与无条件返回本机的操作——旁边还有即时连接反馈与部署行有界的进度阶段（`checking-artifact`、带按文件计数的 `uploading`、`verifying`、`authorizing`、`starting`、`forwarding`、`synchronizing`）。

设置以仅限主机的物化快照跨越进程边界。`SettingsRegisterOptions.materialize` 允许 namespace owner 把主机事实解析进一份分离的、经 schema 校验的副本，由 `SettingsProvider.materialize(ns)` 提供；实时值、`describe` 与设置事件绝不会观察到它。`llm-pi-ai` 以此固定环境凭据：对未点名 `apiKeyEnv` 的 profile，向提供方自己的 api-key resolver 询问凭据服务或启动环境能应答它的哪个环境名，快照携带胜出的名字及其 `authMode`（提供方解析出的 auth 携带 `authorization` 标头时为 `bearer`，否则为 `api-key`）；什么都解析不出的路由固定为 `authMode: 'none'`，它会禁用环境再发现，使被同步的远端无法用无关的环境密钥认证。`llm-deepseek` 物化其已解析的端点事实（协议、凭据引用、基址、已解析模型列表）。SSH 协调器的同步消费物化快照，并经凭据服务解析 schema 选中的凭据引用；主机进程环境绝不复制。

## Alternatives considered

- 每台机器一个浏览器页面：拒绝，因为跨机器工作会复制标签页与持久化作用域，且管理页面不引入第二套 runtime 实例就无法在本地会话旁呈现远程状态。
- 不带 generation 地原地替换全局 Connection 实例：拒绝，因为进行中的操作会在错误机器的权限下结算；`TargetGeneration` 退役加 `captureApi()` 在载体边界显式化取消与迟到拒绝。
- 每次切换整体重启客户端 runtime：拒绝，因为 slot registry、locale 与 layout 服务是页面作用域的；按机器替换 manager 恰好只退役机器所属状态，而这些服务保持身份。
- 把主机进程环境或已解析的秘密值复制进同步设置：拒绝，因为这扩大了远端的秘密面，并与实时设置漂移；物化只携带引用与 owner 解析的事实，解析不出时以 `authMode: 'none'` 严格失败。
- 教会每个消费方按机器 id 过滤：拒绝，因为每处过滤都是一次遗漏就会跨机器泄漏的机会；绑定 generation 的 API 捕获与带 incarnation 标记的 scope 在 runtime 一处强制该边界。

## Consequences

单个文档可以承载任意已连接机器并获得完整的退役隔离：来自已退役机器的迟到 fork、搜索与文件读取会被拒绝，而不是跨边界选中或缓存，返回本机是即时的。代价是 runtime 中显式的生命周期机制——Session、Workspace 与各 manager 集群中的 `dispose`／`assertCurrent` 状态——以及单机部署永远不会观察到的按机器持久化键（`targetGeneration` 在那里保持缺失）。远端保有其同步快照直到下一次 connect；仍没有实时设置订阅，且超出可引用密钥形态的提供方原生凭据体系（OAuth 流程、AWS 风格签名链）不予物化，这些路由在远端以未认证运行——`llm-pi-ai` 与协调器 README 记录了该边界。`dshRemoteHost` URL 参数仍是载体路由键；改变的只是文档内的进入方式。

定向测试覆盖 target generation 与载体退役（`target-streams`）、runtime 与两个 UI 包中的机器替换（`machine-target`、workspace 重注册、provider-roster 重置）、协调器从物化快照同步并经凭据服务解析（`sync-providers`、`sync`），以及各物化钩子（`llm-pi-ai` 环境固定，含 bearer 与不可解析路由；`llm-deepseek` 端点解析；`settings` 分离／校验语义）。完整的真实 SSH 部署与跨平台验证仍属于配置好的 Linux 测试主机。

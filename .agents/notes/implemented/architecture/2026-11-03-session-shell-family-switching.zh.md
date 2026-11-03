# Agent Note: 会话级 shell 家族切换

Status: implemented

[English](2026-11-03-session-shell-family-switching.md) | 中文

## 问题

会话的 shell 家族（bash 对 pwsh）本是启动期事实，烤死在 system prompt 里（"You are working on the machine X (os, bash shell)"）和组合本身里：宿主只组合恰好一个沙箱执行器（`tool-bash` 或 `tool-pwsh`），需要另一家族的会话只能换个 preset 重建。会话中途切换不可能不拆会话，而 prompt 里陈旧的 shell 事实会在任何假想切换之后污染每一份上下文快照。

## 决策

切换是带纪元语义的指针变更，在下一个模型请求边界生效：

- **`@deepseek-ai/dsh-shell-router`** 在单一 `ctx.shell` 缝下用隔离子作用域（`ctx.isolate('shell')`；因家族共享 `shell` settings 命名空间、`settings.register` 遇重复即 throw，只有**生效默认**家族保持 settings 可见——其执行器在宿主级安装 `shell` 节，设置卡片与热更新表现与从前完全一致，另一家族按组合项运行）挂载两个沙箱执行器家族（`bash-sandbox`、`pwsh-sandbox`）。经 `ctx.subprocess.resolveExecutable` 的二进制探测是**排序**而非**准入门**：什么都探不到的环境（桌面宿主以空 PATH fork）仍会未探测挂载默认家族，执行失败按命令逐一暴露；只有挂载失败才让家族降级，双双失败才失败关闭。按家族的组合项经路由器的 `families` 配置原样透传。路由依据家族工具自盖的增量字段 `ShellExecRequest.family`；每个解析出的 spec 由 `ROUTED_FAMILY` symbol 标签随行，`run`/`start` 分发从不重推导。
- **`@deepseek-ai/dsh-session-shell`** 持有会话指针：durable `session-shell/change` 事件、`sessionShell` projection（last-wins）、带存活/可用性校验的串行化 `switch(agent, family)`、在 `agent/created` 与每次切换时施行的按 agent `tools.restrict({ deny: [另一家族] })` 交换、以及一个运行时上下文贡献者——其钉死文本取代 environment 节删掉的 shell 事实。路由器探测是结构化的（`availability()` 存在与否），不用 `instanceof`——当服务与路由器从不同模块图（源码 vs 构建 lib）加载时类身份会断裂，何况这条缝本就是 plugin-native 的结构风格。
- environment preset 不再陈述 shell；shell 事实只经运行时上下文快照抵达模型，切换因此恰好在下一请求处宣布。在途 shell 调用照常完成；两家族的后台终端与持久 shell 继续运行；什么都不拆。退役家族的工具离开该请求的目录（restrict 与呈现、查找、分发共用同一可见性解析器）。
- HTTP 面：sessions API 上的 `session.shell`（observe）与 `session.switchShell`（operate），外加无路由器/服务宿主的新错误码 `shell-unavailable`。
- 组合：web-app bundle 组合 router + session-shell 并禁用裸执行器行；四个 agent preset 以 `DSH_SESSION_SHELL !== '1'` 门控 `tool-bash`/`tool-pwsh`；`runProfile` 在 router 行组合时于树挂载前发布 `DSH_SESSION_SHELL=1`。

会话契约漂移（增量）：事件类型 `session-shell/change` 与 projection `sessionShell`。兼容性：不认识该事件的读取方会忽略它（durable 追加日志，未知事件容忍本就是格式的契约）；projection 是 values 袋里的新键。由 session-shell 套件（家族解析、durable 切换、restrict 交换、上下文文本）与刷新后的契约 digest 基线验证。

## 备选方案

- **切换时换 preset 重建会话**——否决：为语义上的一次指针变更丢掉在途状态、后台作业和会话表面。
- **分发时执行器拒绝（纪元栅栏）**——否决：有下一请求边界与同边界目录交换，已无可拒绝之物；栅栏只会给每次执行添一个失败模式。
- **服务里 `instanceof ShellRouter` 探测**——在跨包测试通道里真实翻车（同一类的两个模块身份）后否决；经 `availability()` 的结构探测与身份无关，也符合缝的 plugin-native 风格。
- **shell 事实留在 environment 节、按请求重写**——否决：environment 节是启动形状且被缓存；运行时上下文快照正是为这类按请求事实而生的。

## 后果

- 只有生效默认家族跟随运行时 `shell` settings；另一家族按组合项运行（`shell-router` 的 Known Limitation）。第一轮 CI 同时抓住了这个设计的两半：双家族都隔离 settings 时设置卡片消失，无 PATH 的桌面启动被探针失败关闭——探针排序、挂载把关、恰好一个家族持有命名空间。
- 无路由器的宿主保持单家族行为，`session.shell` 答 `switchable: false`；终端面板隐藏开关，切换 API 以 `shell-unavailable` 拒绝。
- 切换落定后，终端面板的新终端把 shell 选择器重瞄到该家族已发现的 shell；手动选择保持到家族再次变更。
- 证据：`shell-router`（16 测试，passthrough 沙箱下真实 bash 端到端）、`session-shell`（20 测试：durable 切换、并发切换串行化、restrict 交换、无作用域 agent 守卫、能力读）、`apiproxy` wire 往返 + 委托（sessions API）、`ui-terminal` 控制器/视图套件，以及 preset/web-app 组合行。

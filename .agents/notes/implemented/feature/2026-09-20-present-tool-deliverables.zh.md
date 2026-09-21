# Agent Note: Present 工具与轮次边界投影——声明式交付物

Status: implemented

[English](2026-09-20-present-tool-deliverables.md) | 中文

Scope: `packages/deliverables/tool-present`、`packages/core/agent-loop`、`packages/client/ui-deliverables`

## 问题

产出文件词表从成功的修改调用推断交付物：间接创建的文件（终端命令、代码执行）除非被模型在正文中点名，否则一直不可见，而正文不是持久化 UI 状态。官方 harness 用 `present` 工具、它在轮次中读取的 `turnBoundary` 会话投影，以及 UI 的 host 桌面打开路由来解决。Harniverse 三者皆无。

## 决策

- **工具**逐字移植（`packages/deliverables/tool-present`）：模型可见描述、schema、输出渲染器、逐文件验证顺序、`maxFiles` 上限，以及只在成功结果时追加的 `deliverables/presented` 事件全部一致。该事件是持久契约；UI 按轮折叠。
- **投影**由 agent-loop 拥有而非工具：`turnBoundaryProjectionDefinition`（`packages/core/agent-loop/src/projection.ts`）在构造器中经可选的 `ctx.inject(['sessionProjections'], …)` 注册，因此无循环的组合保持可用，而每个带注册表启动循环的组合都从唯一属主获得“打开轮次”事实。`stateVersion` 为 `1`——Harniverse 的日志格式没有需要迁移的投影历史（官方基线的 `2` 反映的是它自己的过去）。
- **UI 适配**砍掉 host 路由：没有 `/api/present.open`、没有 `PresentedHost`、没有 workspace 桌面面。被声明的文件在既有 `ui-deliverables` 尾行中渲染为第二条可换行 lane，并经聊天视图的 `openFile` 打开——与产出 lane 相同的、受 loopback 门控的 Host 打开器。`presentedForClosing` 在收尾 seq 处按路径取最新声明、按首次声明顺序去重；提及解析器放宽到“产出＋声明”并集。声明 lane 采用换行而非适配测量：模型明确作出的声明绝不会被 `+ N 个文件` 静默省略。

## 备选方案

- 声明落地前的审批门：否决——呈现是 UI 路由事实而非特权动作；文件已经存在，事件也是 log-only。
- 移植官方 `present-open.ts` 的 host HTTP 路由：否决——它们依赖 Harniverse 未提供的 workspace-desktop 控制器；chat opener 已经以自己的 loopback／本地 opener 门控拥有原生交接。
- 在 `dsh-tool-present` 内注册投影：否决——“打开轮次”事实是循环词表（turn/start、step 边界），第二个注册方会需要注册表面不提供的重注册规则；工具保持为快照的纯读取方。

## 后果

预设挂载为 Standard／Code／Cordis（位于各自 tool-web 行之后，与官方摆放一致）；Minimal 不含。会话契约新增一个加性 log-only 事件——`deliverables/presented`——digest／known-events 目录已重新生成。不变式伴侣校验事件形状；`tools/result` 监听器跳过出错或被阻断的调用，因此失败的 present 不声明任何内容，自然重试。Subagent 的声明落在 subagent 自己的会话日志中，与其他所有会话所有的事实一致。

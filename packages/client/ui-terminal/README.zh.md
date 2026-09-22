# @deepseek-ai/dsh-client-ui-terminal

[English](README.md) | 中文

Web 应用的用户终端面板：基于认证的 terminal-controller 流的一个 xterm.js 渲染面。侧栏底部触发器打开 center 视图，呈现会话的终端标签页——新建（可选已发现的 shell）、重命名、关闭与随容器拟合的尺寸调整——而独占输入附件决定当前窗口对该终端是可写还是只读（只读时提供接管入口）。输出走先快照后增量的流并校验序号；慢消费者失败沿有界的重连阶梯回升，耗尽后呈现手动重试横幅。面板为人类的交互服务：无工具、无会话事件、不对模型可见。

## 组合

| 方面 | 行为 |
|---|---|
| 注入 | `slots`、`locale`、`layout`、`connection`。 |
| 触发器插槽 | `sidebar.footer.action`，id `terminal-view`，order 40（后于 browser 触发器）；调用 `ctx.layout.setCenterView('terminal')`。 |
| 视图插槽 | `center.view`，id `terminal`；被布局指名时覆盖中心栏，通过 `ctx.layout.clearCenterView()` 关闭（切换会话同样会清除）。 |
| 存储 | 一个共享的 `createTerminalViewStore` 实例：中心视图在挂载/卸载时写入占用事实，底部触发器把它镜像为按下态。 |
| 控制器 | `TerminalPanelController`（随插件 fiber 存活、无 DOM）持有终端列表、活动标签的跟随流、所有运行中终端的窗口持有，以及有界的慢消费者重连阶梯；面板状态经 inject 的 `hooks` 间隔发布，跨视图重挂载存活。 |
| 线上面 | 一元动词走共享的 `/api` 逻辑通道（`terminal/environment|shells|list|create|write|resize|rename|close`）；流走 api-client 的 `terminal`（附件）与 `hold`（窗口保留）事件面。 |
| 输入所有权 | 打开跟随流即认领独占输入附件；被降级的附件在快照/状态帧中看到 `controllerId` 不匹配，呈现只读，并可通过重新附着取回输入。 |
| 尺寸调整 | 容器 resize → FitAddon → 钳制到环境上限的尺寸 → `terminal/resize`；本地钳制是乐观的，主机权威校验。 |

## Model Experience

### 终端面板

#### What the model sees

无：面板是挂载为名为 `terminal` 的 `center.view` 的纯浏览器端载具。它不注册任何工具、不发出任何会话事件，用户在终端中输入或从其输出读到的内容都不会进入 prompt、消息或工具结果。

#### Token effect

无；本包从不组装或发送提供方请求，终端状态留在浏览器端控制器与主机的终端记录中。

#### KV Cache effect

无；本包从不组装或发送提供方请求。

## Known Limitations and Deferred Work（已知限制与延后工作）

- 同一时间仅一个活动终端：面板只渲染一个标签页的屏幕；其余终端在主机侧保持存活（窗口持有），仅通过标签状态可见。
- 重连横幅语义：慢消费者恢复是有界的（五级、250 毫秒至 4 秒）；耗尽后呈现手动重试横幅，任何成功送达的快照都会重置阶梯——在快照之前失败的流仍计为一次失败。
- 输入独占：接管输入会直接降级原持有者，除其自身的只读横幅外没有任何通知；没有协商或多写者仲裁。
- 保留可见性：主机持有流只暴露一次性的 `retained` 帧，因此面板不渲染保留倒计时或回收通知。
- 重命名校验镜像主机边界（修剪后 1–120 字符）；无效的草稿被静默丢弃而非表单级校验。
- jsdom 中的 xterm：真实终端可在测试中挂载，但 jsdom 没有字体度量，拟合尺寸的上报通过打桩的 `proposeDimensions`（仅测试缝隙）覆盖；浏览器布局本身由 e2e 通道验证。

# @deepseek-ai/dsh-client-ui-terminal

[English](README.md) | 中文

Web 应用的用户终端面板：基于认证的 terminal-controller 流的一个 xterm.js 渲染面。侧栏底部触发器打开 center 视图，呈现会话的终端标签页——新建（可选已发现的 shell）、重命名、关闭与随容器拟合的尺寸调整——而独占输入附件决定当前窗口对该终端是可写还是只读（只读时提供接管入口）。输出走先快照后增量的流并校验序号；慢消费者失败沿有界的重连阶梯回升，耗尽后呈现手动重试横幅。面板为人类的交互服务：无工具、无会话事件、不对模型可见。

## 组合

| 方面 | 行为 |
|---|---|
| 注入 | `slots`、`locale`、`layout`、`connection`、`theme`。 |
| 触发器插槽 | `sidebar.footer.action`，id `terminal-view`，order 40（后于 browser 触发器）；调用 `ctx.layout.setCenterView('terminal')`。 |
| 视图插槽 | `center.view`，id `terminal`；被布局指名时覆盖中心栏，通过 `ctx.layout.clearCenterView()` 关闭（切换会话同样会清除）。 |
| 存储 | 一个共享的 `createTerminalViewStore` 实例：中心视图在挂载/卸载时写入占用事实，底部触发器把它镜像为按下态。 |
| 控制器 | `TerminalPanelController`（随插件 fiber 存活、无 DOM）持有终端列表、活动标签的跟随流、所有运行中终端的窗口持有，以及有界的慢消费者重连阶梯；面板状态经 inject 的 `hooks` 间隔发布，跨视图重挂载存活。 |
| 线上面 | 一元动词走共享的 `/api` 逻辑通道（`terminal/environment|shells|list|create|write|resize|rename|close`）；流走 api-client 的 `terminal`（附件）与 `hold`（窗口保留）事件面。 |
| 输入所有权 | 打开跟随流即认领独占输入附件；被降级的附件在快照/状态帧中看到 `controllerId` 不匹配，呈现只读，并可通过重新附着取回输入。 |
| 尺寸调整 | 容器 resize、`visualViewport` 变化（软键盘会缩小可视视口而不改变布局视口）以及 `document.fonts.ready` 都会触发重新拟合 → FitAddon → 钳制到环境上限的尺寸 → `terminal/resize`；本地钳制是乐观的，主机权威校验。 |
| 面板挂载 | xterm 面与占位提示是互斥分支，而非兄弟节点：没有会话或没有终端时视图只渲染提示，面在第一个终端出现时挂载、随最后一个终端退场。挂在提示之后的面会把提示盖住，而隐藏容器会让 FitAddon 去测量一个已塌缩的父元素。 |
| 呈现 | xterm 以 JavaScript 选项接收颜色与度量，因此 CSS 在面上声明 `--dsh-terminal-{bg,fg,cursor,selection,font-family,font-size}`，组件再把计算值读回终端选项。`theme/change` 发布会经 inject 的 `hooks` 间隔推进一个外观修订号，由它重新解析这些属性并重新拟合。 |
| 触摸与手机形态 | `@media (pointer: coarse)` 显示控制键条（Esc、Tab、Ctrl C/D/Z、方向键），写入软键盘无法产生的转义序列，并保持焦点以免键盘收起；`[data-viewport='phone']` 隐去标题、把每个控件提升到 44 像素触摸目标，并把单元格缩到 12 像素。 |

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
- jsdom 中的 xterm：真实终端可在组件测试中挂载，但 jsdom 没有布局引擎也不应用 CSS，因此拟合尺寸的上报通过打桩的 `proposeDimensions`（仅测试缝隙）覆盖，外观也只会解析到回退值。一切关于尺寸与观感的断言改由 `apps/web/tests/terminal-panel.e2e.ts` 在真实浏览器与真实 PTY 上完成。
- 控制键覆盖范围：键条只承载屏幕键盘无法输入的九个序列；其余按键（功能键、Alt 组合、Ctrl 加其他字母）仍需物理键盘。
- 触摸选择：xterm 自身的隐藏 textarea 模型使得粗指针下的拖选与复制不可靠，面板也没有自建手势层。

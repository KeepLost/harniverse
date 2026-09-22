# @deepseek-ai/dsh-client-ui-browser

[English](README.md) | 中文

Web 应用的内嵌浏览器载具面板：用户驱动的 URL 栏加沙箱 iframe，配合应用自有的内存历史（后退/前进/重载），历史在同一次应用会话内跨越视图重挂载存活，且从不触碰浏览器历史。侧栏底部触发器打开 center 视图；导航时 URL 策略会在 iframe 导航之前拒绝非 http(s) 协议、内嵌凭据的 URL 以及应用自身的 origin。面板为人类的浏览行为服务：无工具、无会话事件、不对模型可见。

## 组合

| 方面 | 行为 |
|---|---|
| 注入 | `slots`、`locale`、`settingsScope`、`layout`。 |
| 触发器插槽 | `sidebar.footer.action`，id `browser-view`，order 30（后于 scheduler 与 governor 触发器）；调用 `ctx.layout.setCenterView('browser')`。 |
| 视图插槽 | `center.view`，id `browser`；被布局指名时覆盖中心栏，通过 `ctx.layout.clearCenterView()` 关闭（切换会话同样会清除）。 |
| 存储 | 一个共享的 `createBrowserViewStore` 实例：中心视图在挂载/卸载时写入占用事实，底部触发器把它镜像为按下态；访问过的 URL（连续重复合并、上限 50 条、超出丢最旧）存于 store，因此重挂载可恢复浏览轨迹。 |
| URL 策略 | `reviewNavigation` 是纯模块，在导航时强制执行：仅允许 `http`/`https`；内嵌 `user:pass@` 凭据、应用自身 origin（带端口归一化比较）、以及配置了允许列表时不在此列的主机均被拒绝并给出内联提示——iframe 绝不导航。 |
| 配置 | node 半区注册 `browser` 设置命名空间（`allowedHosts?: string[]`，裸主机名在加载时校验）；browser 半区通过 `settingsScope` 绑定，并在每次导航时重新读取取值。 |
| 沙箱 | iframe 以 `sandbox="allow-scripts allow-forms allow-popups allow-downloads"` 运行且不带 `allow-same-origin`，因此被嵌入页面获得不透明 origin，永远无法触及 harness 的 cookie、存储或 DOM；`referrerpolicy="no-referrer"` 使出站请求不携带 harness origin。 |

## Model Experience

### 浏览器载具面板

#### What the model sees

无：面板是挂载为名为 `browser` 的 `center.view` 的纯浏览器端载具。它不注册任何工具、不发出任何会话事件，用户在 URL 栏输入或在框架中访问的内容都不会进入 prompt、消息或工具结果。

#### Token effect

无；本包从不组装或发送提供方请求，浏览状态留在浏览器端 store。

#### KV Cache effect

无；本包从不组装或发送提供方请求。

## Known Limitations and Deferred Work（已知限制与延后工作）

- 不透明 origin 沙箱：没有 `allow-same-origin`，依赖自身 cookie 或存储的被嵌入页面（部分 SSO 流程）无法工作；授予该能力会让页面读取 harness origin 的状态，因此保持关闭。
- 拒绝被嵌入的远端页面（`X-Frame-Options`/CSP `frame-ancestors`）呈现为空白框架；该拒绝无法从 JavaScript 探测，因此面板无法给出原因。
- 除沙箱授权外无下载管理：下载交给浏览器自身的处理器；面板既不列出也不清理下载项。
- 设置物化：设置 schema 会把缺失的 `allowedHosts` 解析为 `[]`；面板把空列表视为开放浏览（用户主动导航仍是守卫），因此需要锁定的部署必须显式列出主机——而剥离设置行的部署会完全失去允许列表。
- 无凭据录入辅助：内嵌 `user:pass@` 的 URL 被拒绝；面板绝不提示、存储或填充凭据。
- 仅接受绝对 URL：相对或无协议的输入按 malformed 拒绝（面板没有可用于解析的 base 文档）。

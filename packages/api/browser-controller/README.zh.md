# @deepseek-ai/dsh-api-browser-controller

[English](README.md) | 中文

宿主侧浏览器 Remote。`ctx.browserController` 在 harness 旁运行真实的 Chromium 进程，按 Session 持有其页面，并以录屏图像加页面元数据的形式提供给浏览器面板。因此页面流量从**宿主**的网络位置发出，而不是用户设备：宿主自身 localhost 上的工作区开发服务器可达，目标看到的是宿主地址，而拒绝被嵌入的页面（`X-Frame-Options`、CSP `frame-ancestors`）也能正常渲染，因为这里根本没有嵌入行为。[子系统页面](../../../docs/subsystems/browser-controller.md)负责线上形状、控制与策略语义，以及 CDP 命令词汇。

这一界面是给人使用的载体，而不是模型接缝：控制器是受认证 API 把关的 Host Remote，页面内容不产生任何会话日志事件，模型自身的抓取仍留在 [`web-fetch-http`](../../web/web-fetch-http/README.md) 及其独立的锁定解析策略中。浏览器进程以 `ambientEnv: 'scrubbed'` 运行——与用户终端不同，页面永不继承 harness 凭据——并使用每个 Session 一份的一次性 profile 目录。无论启动失败、最后一个页面关闭，还是 Session 释放，目录都在浏览器进程树退出且进程完成后删除；清理失败时继续保留进程和目录的所有权，以供重试。

## 服务：`BrowserController`（ctx 键：`browserController`）

在 macOS 上，一次性 profile 使用 `--use-mock-keychain`，避免导航期间出现系统 Keychain 访问提示。此临时 profile 中的 Cookie 不受用户 Keychain 保护；目录生命周期与 Chromium 沙箱策略保持不变。

该服务在 `browser` 命名空间下扩展 `TypertRemoteService`。`environment` 与 `list` 需要 `harniverse.observe`；`create`、`navigate`、`act`、`input`、`resize` 与 `close` 需要 `harniverse.operate`。在一个 Session 的注册表内，create 对处于打开状态的标识是幂等的，已关闭的标识不能重建，每个 Session 的页面数量受 `maxPages` 约束。一个 Session 最多启动一个浏览器：启动过程被记忆化，第一个页面将其拉起，最后一个页面释放时将其关停，因此一直关闭的面板不产生任何成本。

导航在宿主侧先经审查，之后才要求浏览器移动：仅允许 `http`/`https`，不允许内嵌凭据，并且除非设置 `allowPrivateAddresses`，回环、链路本地与私有网段都会被拒绝。非空的 `allowedHosts` 会进一步收窄范围，按精确主机或子域匹配。拒绝会以 `browser-navigation-refused` 这一 Remote 错误呈现，绝不表现为静默的空白页面。

浏览器程序在该 Session 自己的执行环境中解析：设置了 `executablePath` 就用它，否则按顺序探测 `browserCandidates`（Chrome、Chromium 与 Edge 的 Linux 名称，以及它们在 macOS 与 Windows 上的安装路径）。宿主机上没有这类程序是受支持的状态，而非缺陷：`environment` 会回答 `available: false`，并给出一条指明「探测了什么」的原因，`create` 也以同样的文本以 `browser-unavailable` 失败，因此面板能告诉运维应满足哪个名称、或该配置哪条路径。客户端那一半则改为把对话链接交给读者自己的浏览器。

启动预算也约束初始 DevTools 套接字握手与目标发现响应。如果其中任一步失败，`create` 会以 `browser-unavailable` 报告 DevTools 故障，并在删除 profile 前等待其拥有的进程树停止。若无法确认进程树已退出，错误会同时报告原始故障和清理失败；Session 保留句柄和 profile，供后续关闭或释放时重试，清理成功前不会用新进程取代这棵进程树。

同一时刻只有一个附着持有控制权；后来的附着会接过控制权，先前的附着降级为观看，因此过期附着的导航与输入会以 `browser-control-unavailable` 失败，而不是争夺页面。帧是完整图像，所以每个跟随者只保留最新的图像与最新的元数据，而不是有序积压——慢速消费者丢失中间帧，永不使自己的流失败。

`follow` 生成器是普通的宿主方法而非 `@Remote` 声明：harniverse 的 Gateway 派发是一问一答，因此宿主 `apiproxy` 将其包装为 EventsApi 界面上的 `events.browser` SSE 流。

## 模型体验

无，因为该包服务于浏览器面板，不注册任何提示词、工具或会话事件。

#### KV 缓存影响

无直接影响；页面内容不会进入模型请求或 Session 日志。

## 已知限制与后续工作

- Chromium 自行解析 DNS 并抓取子资源，因此宿主审查约束的是用户输入的目标，而不是页面后续访问的每个地址；审查通过之后才解析到私有地址的域名不会被重新检查。模型的抓取接缝之所以按请求锁定解析，正是因为它有这个能力。
- 该面板是每标签一页的界面：页面自行打开的弹窗不会被接管，页面自己打开的目标对客户端始终不可见。
- 不处理下载、打印、文件选择器与权限提示；需要其中任一项的页面会停滞，且面板上看不到原因。
- 当 harness 以 root 运行（容器中的常见姿态）时，Chromium 自身的沙箱根本无法启动，因此默认值 `sandbox: 'auto'` 仅在该处放弃沙箱，其余环境保持开启；进程仍以脱敏环境运行且 profile 隔离，但页面漏洞面对的边界少了一层。`sandbox: 'chromium'` 强制要求沙箱，在 root 部署下将完全得不到浏览器；`sandbox: 'none'` 则始终放弃沙箱。
- 录屏图像为 JPEG，因此文字比原生页面更柔和，画质需通过 `screencastQuality` 与带宽权衡；没有无损或矢量通路。

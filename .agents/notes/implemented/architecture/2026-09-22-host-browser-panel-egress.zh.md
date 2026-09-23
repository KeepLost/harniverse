# Agent Note：浏览器面板改为宿主浏览器进程

Status: implemented

[English](2026-09-22-host-browser-panel-egress.md) | 中文

## Problem

W14 最初把浏览器面板做成用户自己浏览器里的沙箱 `<iframe>`，镜像上游的 `ui-sidebar-browser`。这个载体回答的问题，与该界面存在的理由并不相同。

- 出网来自用户设备。每个请求携带用户的 IP、DNS 与代理，因此 URL 栏里的 `localhost` 意味着用户的 localhost。harness 用户最常想访问的那个目标——Agent 刚在 harness 宿主上启动的开发服务器，或只有宿主能路由到的内网面板——在结构上不可达。
- 面板与 harness 自身的姿态相矛盾。模型的 `web_fetch` 经 `web-fetch-http` 从宿主发出；人的浏览器面板却从笔记本发出。一个产品出现两种网络身份。
- 嵌入可被拒绝。`X-Frame-Options` 与 CSP `frame-ancestors` 会让框架空白，而这种拒绝在 JavaScript 中无法检测，因此面板连"页面为何空白"都说不出来。上游记录了同样的盲区，包括 Web 模式在框架内导航后无法读取当前 URL。
- 没有任何入口指向该面板。harniverse 没有 `openExternalLink` 的对应物，因此对话里的链接仍打开浏览器标签页，而面板唯一的入口是一个底部按钮加空白 URL 栏。

## Decision

面板改为运行在 harness 旁的真实浏览器进程的远程视图，页面由宿主拥有。

新增的 `packages/api/browser-controller` 镜像 `terminal-controller` 的生命周期模型：`browser` 命名空间下的 `TypertRemoteService`、按 Session 拥有、调用方铸造标识、幂等 create、`maxPages` 上界、能力把关的动词（`environment`/`list` 为 observe；`create`/`navigate`/`act`/`input`/`resize`/`close` 为 operate），以及被 apiproxy 包装为 `events.browser` SSE 流的非 `@Remote` `follow()` 生成器。一个 Session 最多启动一个 Chromium 并记忆化：第一个页面拉起它，最后一个页面释放时关停它。

控制通过 Node 全局 `WebSocket` 走 CDP，因此该能力不引入新依赖。像素来自 `Page.startScreencast` 的 JPEG 帧，输入以页面空间坐标经 `Input.dispatch*` 回传，因此宿主永不看到客户端的元素几何。历史使用 `Page.getNavigationHistory` 加 `navigateToHistoryEntry`，因为协议暴露的是条目而非 back/forward。

与终端有三处刻意的差异：

- 帧是折叠而非失败。终端的字节是有序流，因此慢速跟随者必须失败并从快照恢复。录屏帧是完整图像，因此每个跟随者只保留最新图像与最新元数据，慢速消费者仅丢失中间帧。
- 浏览器以 `ambientEnv: 'scrubbed'` 运行，而不是用户终端得到的 `'full'` 继承。终端**就是**用户的 shell；网页不是，且绝不应看到 harness 凭据。每个 Session 还获得一次性 profile 目录，在浏览器消失时删除。
- 导航策略在宿主侧且由运维拥有。此前的客户端 `reviewNavigation` 只是 UI 护栏，客户端完全可以不执行它。现在宿主在浏览器移动之前审查：仅 http/https、不允许内嵌凭据，并且除非运维设置 `allowPrivateAddresses`，回环/链路本地/私有网段都被拒绝——这个开关正是"访问宿主 localhost 上的开发服务器"得以可能的唯一途径，而同样的可达性也暴露宿主内网，因此默认关闭，并由 `allowedHosts` 进一步收窄。

链接路由随之落地。`ILayout.setCenterView(id, request?)` 把一个不作解释的请求字符串带给视图；`ui-primitives` 的 markdown 新增 `externalLinks` 打开器，对普通左键点击 preventDefault，同时为带修饰键的点击与辅助技术保留锚点的 `target="_blank"`；`ui-conversation` 在 `center.view` 存在 `browser` 条目时路由到面板，否则回落到 `window.open`。

## Alternatives considered

- 由宿主 HTTP 反向代理在 harness 源下提供远端页面：以两点理由否决。`frontend-static` 与 `apiproxy` 共享同一个源，因此被代理页面的脚本将与可以拉起 shell 与完全访问子进程的已认证 API 同源——这在构造上就是远程代码执行。而且对 HTML、CSS、JS 及每个动态请求做 URL 重写是没有尽头的跑步机，只会放大 SSRF 面而不是约束它。
- 保留 iframe，并为被拒绝的页面增加宿主抓取兜底：否决——同一个 URL 栏背后出现两种能力、两套 cookie 罐与两种失败模式，而且兜底无法运行脚本，而脚本正是页面的大部分内容。
- 用 Playwright 或 Puppeteer 作为驱动：作为要发布的能力予以否决。两者都带来浏览器下载问题，且表面远大于这里所需的十来个 CDP 命令；协议是稳定的，而平台已经有 WebSocket。
- 像 `web-fetch-http` 为模型所做的那样按次导航锁定 DNS：在浏览器之外不可能做到。Chromium 自行解析名称并抓取子资源，因此诚实的契约是：宿主审查约束用户输入的目标，运维允许清单才是承重控制。这一点被记为限制，而不是用一个不可能存在的检查来暗示。
- 把这次重定义推迟到 W16（Electron），那里原生存在真实的浏览器视图：否决——W16 依赖 W13 与 W14 做对，而出网问题不是桌面打包问题。

## Consequences

页面流量从宿主发出。e2e 直接证明了这一点：127.0.0.1 上一个一次性 `node:http` 源提供带 `X-Frame-Options: DENY` 与 CSP `frame-ancestors 'none'` 的页面，面板将其渲染出来，服务器记录到该请求，而 Playwright 记录的用户页面对该源的请求为空。点击与输入抵达真实页面，页面把它们回显给测试服务器；`file:///etc/passwd` 在宿主侧被拒绝并显示面板提示。

代价是真实且刻意接受的。打开面板的 Session 要付一个 Chromium 进程（CPU、内存与 JPEG 帧带宽）；当 harness 以 root 运行（容器中的常见姿态）时必须放弃 Chromium 自身的沙箱，此时剩下的边界是脱敏环境与隔离 profile；界面是每标签一页，没有弹窗、下载、打印、权限提示或剪贴板桥。

旧的客户端 `browser.allowedHosts` 设置命名空间已移除，因为由客户端执行的策略不是策略。想要锁死面板的部署现在应配置 `browser-controller` 那一行。

## Scope

新增 `packages/api/browser-controller`（`types`、`cdp`、`policy`、`stream`、`launch`、`page`、`index`、`invariant`）及其测试；apiproxy 的 `events.browser` 绑定、帧联合、schema、流实现、GET 路由、客户端面与四个 RPC 错误码；`ui-browser` 围绕 `BrowserPanelController` 与命令式图像界面重写，其 node 半边缩减为空的 `apply()`；`ui-layout` 的中央视图请求；`ui-primitives` markdown 的外链路由与 `ui-conversation` 的打开器；`web-app` 组合行；新的子系统页面对、两个 README 对，以及重新生成的目录与图；`apps/web/tests/browser-panel.e2e.ts` 及其 overlay，以及为新路由更新的行内代码链接 e2e。

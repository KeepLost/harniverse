# Agent Note: 实体流下行通道

Status: implemented

[English](2026-10-28-entity-stream-downlink-channel.md) | 中文

## Problem

每个按实体划分的浏览器流家族都会为每个被监视的实体开一条长寿命 HTTP 连接：`workspace.files.watch` 对应每个展开目录（以及每个打开的编辑器文档）、`events.terminal` 对应每个被跟随的终端、`events.hold` 对应每个*运行中*的终端、`events.browser` 对应每个浏览器视图——再加上页面常驻的两条 WebSocket（`events.mux`、`events.host`）。浏览器对同源 HTTP/1.1 连接的上限约为六条，且**跨标签页共享**。展开四个目录时连接池即被占满：一切普通请求（文件读取、一元调用）永久排队，客户端 30 秒超时（"signal timed out"），请求从未抵达服务进程——这种饿死的表象与服务端卡死完全一致，并曾把一次修复引向 watchdog 方向（[2026-10-27-workspace-fs-stall-watchdog](2026-10-27-workspace-fs-stall-watchdog.md)。这是一个*类*，不是一个 bug：两个终端（各自再持一条保活流）加一个浏览器视图加两个目录的算术同样致命，任何未来的按实体流家族都会继承它。事故的诊断结论（客户端连接池饿死，而非宿主停摆）来自三源互证：客户端事件循环存活、服务端 access 日志零新记录、流准入日志零记录。

## Decision

四个家族全部多路复用到**一条页面作用域、只下行的 WebSocket**——`/api/events.streams`，即 mux（会话事件）与 host（宿主事件）之外的第三条下行流类。页面的长连接数因此恒为三条，与目录数、终端数、工作区数、浏览器数、会话数全部无关。

- **载体。** `events.streams({page})` 是与 mux/host 同形的流生产者：每 socket 一条有界 `FrameQueue`，注册进页→faces 表（`pageStreams` 模式）。`page` 查询令牌**必填**且在 upgrade 前校验，规则与 mux 令牌一致。socket 严格只下行（客户端消息以 1008 关闭），`dshRemoteHost` 桥接与 mux/host 一样覆盖远程机器目标。
- **子流。** `events.streams.open({page, family, payload})` 是普通 unary POST（能力 `harniverse.observe`、效应 `read`——与 `events.adopt` 确立的在场式分类一致），铸造 `sub` id 并运行该家族**完全相同的生产者**（提升出的 `terminalStream`/`holdStream`/`browserStream`/`watchFilesStream`——一种行为、两种载体）。帧以 `sub/ready` → `sub/frame`（家族帧原样透传）→ `sub/end` 流动。`events.streams.close({page, sub})` 幂等。页面最后一条存活下行退出时中止其持有的全部子流——即流中止即解除挂接的子流形态，终端/浏览器独占挂接与保活保留语义原样保留。
- **各家族语义不变。** 终端严格序列失败、浏览器 newest-image-wins 折叠、watch 突发合并都留在各自生产者内；家族失败仍以家族自身的 `stream/error` 帧乘 `sub/frame` 抵达。一个子流的失败绝不拖垮通道；通道失败把每个子流以传输错误终结，由各消费方**自己的恢复阶梯**（终端重挂、watch 退避、浏览器重挂）重新打开——通道自身从不自动重连。
- **界限。** 页面没有存活下行时 `events.streams.open` 以 `stream-channel-absent` 拒绝；每页并发子流受 `entityStreamSubsMaxPerPage`（默认 `256`，越限 `stream-sub-limit-reached`）约束——这是 watch 上限早已在工作区维度施行的注册表约束，现在按页覆盖全部家族。
- **遗留路径。** 四条家族路径的网络 GET 一律回答 **410**（mux/host 保持 426）；SSE 编解码只存活于 `toFetchHandler` 的进程内载体作为同构证明——与 2026-08-04 笔记为 mux/host 设定的姿态一致。
- **客户端。** `WebApiClient` 携带页面令牌并按机器 generation 懒开一条 `EntityStreamChannel`；四个 `IApiClient` opener 签名未动，所有消费方（终端/浏览器面板、工作台 change-feed、编辑器 watch）零改动完成迁移。订阅经普通 unary 载体打开（代际栅栏、认证、诊断抽头全部生效）；帧在 yield 时按家族自身的 schema 校验；未认领帧（POST 派发与返回之间抵达的帧）有界缓冲；调用方中止触发幂等 close。
- **护栏。** 连接预算账本统计页面打开的每条 WebSocket 与每条长寿命 SSE 流，越过六条线即告警一次——未来的按实体扇出在开发期就会很响。`stream-connection-budget` e2e 驱动目录监视加活跃终端，并在 CDP 层断言：恰好三条事件 WebSocket、对遗留家族路径的零请求、文件读取仍然完成。事故类从此是被钉死的不变量，而不是期望。

## Consequences

- 页面至多持有三条长连接（mux、host、streams）加普通短寿命 fetch，HTTP/1.1（每源六条）与任何 HTTP/2 前置都成立；多标签页按每页恰好三条倍增，而不是按被监视实体数倍增。
- 终端与浏览器的挂接声明现在多一跳（open POST → 生产者），丢失的 close POST 要等页面最后一条下行退出才回收挂接；健康页面在中止（close 控制）或消费方 return 时立即回收。两条路径都有测试。
- 通道为实体帧增加一个串行化跳点；终端输出按子流 FIFO（单 socket、每子流一条投递环），浏览器图流也不再能靠占用连接池槽位饿死无关 fetch。
- 进程内载体保留家族 SSE 路由：宿主侧测试、`InProcessApiClient` 与 fixture 原样运行，fixture 的 `streamsOpen` 应答诚实的 `stream-channel-absent` 拒绝（那里不存在下行）。
- 2026-10-04 笔记"不为 watch 流做 WebSocket 升级"的否决在*网络*载体上被取代：为单一家族增加第三种传输使载体面积翻倍；为四个家族共享一条通道则使其减半。2026-08-04 笔记"每个流类一条下行 WebSocket"的模式是被*扩展*而非推翻——实体流是第三个类；其只下行规则与 upgrade 前校验规则逐字适用。

## Verification

- `packages/host/apiproxy/tests/api-proxy-entity-streams.spec.ts`：终端子流的 sub/ready→frames→sub/end；hold 投递与页面消亡回收；`stream-channel-absent`、幂等 close、每页上限；watch 拒绝乘 `sub/frame` 抵达。
- `packages/client/connection/tests/streams-channel.client.spec.ts`：两家族共享一条 socket、按 sub 路由、身份发布、有界未认领缓冲、socket 消亡失败与已中止方静默结束、调用方中止 close（generation 退役时抑制）、畸形帧丢弃、socket 失败后的干净重试、预算计数。
- `packages/client/connection/tests/websocket-downlink.host.spec.ts`：upgrade 前的页令牌校验、principal 附着、子流帧原样透传、第三条 socket 的只下行强制。
- `packages/client/connection/tests/node-half.host.spec.ts`：三条 upgrade 路由、全部事件路径 GET 426、四条遗留家族 GET 410。
- `apps/web/tests/stream-connection-budget.e2e.ts`：真实组合下的 CDP 级预算断言（三条 WebSocket、零遗留 GET、读取完成）。
- `test:gui` 529 文件 / 7,586 用例绿；`DSH_SNAPSHOT=replay pnpm run test:web` 绿（golden 不变——纯线协议变更）。

## Alternatives considered

- **每工作区多路复用 watch 流**（内部诊断采用的修复）：折叠了目录扇出，但终端/保活/浏览器仍按实体、工作区数量仍线性——N 个工作区照样耗尽连接池；事故类存活。
- **把实体流并入 mux WebSocket：** 否决——共享的有界 mux 队列把终端严格序列与 30 fps 浏览器图流耦合到会话事件上（溢出使整页流失败，这是被测试钉死的行为），且 mux 在场/重放语义会与挂接生命周期纠缠。
- **带上行消息的全双工 WebSocket：** 否决——只下行是承重的安全属性（每个变更都过 POST 信封栅栏）；订阅控制作为普通 unary POST 让全部栅栏、幂等账本与远程主机桥接免费保留。
- **HTTP/2 部署：** 不在产品控制内（webserver 是 HTTP/1.1；代理环境各异）；预算必须在最坏环境下成立。

# Agent Note: VM M8 —— egress 诚实化：审批卡与 guest 可见代理

Status: implemented

[English](2026-11-06-vm-m8-egress-approval.md) | 中文

Date: 2026-11-06。范围：vm 世界的 egress 审批链（`packages/vm/subprocess-vm`）、origin 缝隙（`packages/vm/vm`）、guest SOCKS5 代理与协议操作（`packages/vm/vm-qemu-local`）、以及 `dsh-base` 中 vm 行的 egress 模式。`dsh-subprocess` 契约与全部消费方组合不变。

## 背景

世界的 egress 中继自 M2 起就是宿主侧构造期回调（`openWorld({ egressPolicy })`），而产品组合根本够不到它：插件 `Config` 没有这个字段，所以部署世界里的每个拨号都拒绝——诚实但不可用，且 guest 完全没有办法拨号（无网络设备、无代理操作）。路线图 M8 要求三件事：承载于配置的审批来源、经既有 cordis user-questions 基建的审批卡、以及遵守 M5 数据面教训的 guest 可见 socket 代理。

## 决策

**会话亲和靠环境化发起者捕获，而非契约穿针。** `ctx.userQuestions.ask`
要求精确存活的 `Agent`（其 `CALLER_NOT_LIVE` 门禁），所以审批卡只能点名
拨号发生时还活着的会话。subprocess-vm 没有给 `dsh-subprocess` 契约加一个
每个工具都得传的 agent 字段，而是在 spawn 入口捕获
`ctx.agents.currentInitiator()`——agent-loop 早已建立的 AsyncLocalStorage
发起者边界。无活发起者的 spawn 不拿 origin，其拨号拒绝（无人可问）；有
发起者的铸造 `vm-exec-<n>` 并经新的 `VmWorld.registerEgressOrigin` 缝隙
（dsh-vm；默认 no-op，无 egress 面的世界接受注册且永不咨询）注册审批者。
绑定随 spawn 退出或 provider 处置释放。

**guest 可见代理是 guest 回环上的 SOCKS5，而非新设备。** 协议 v3 纯附加
扩展（不 bump 版本，沿 M7 caps 先例）：`exec` 可携带 `origin`；guest
agent 在 127.0.0.1 绑 per-origin SOCKS5 监听（PID 1 现在自行经
SIOCSIFFLAGS 拉起 `lo`），向子进程 env 注入
`ALL_PROXY`/`all_proxy`（`socks5h://127.0.0.1:<port>`），并讲最小握手
（无鉴权、仅 CONNECT、IPv4/域名/IPv6 目标）。原生 curl、wget、git 无改动
即遵守该 env。每个 CONNECT 询问宿主（`egress.open {id, host, port,
origin}`）；宿主的 `GuestEgressBridge` 把它路由进 `WorldEgress`，后者咨询
该 origin 的审批者，再回答 `egress.opened`/`egress.denied` 并以 base64
`egress.write`/`egress.data` 流式中继直到 `egress.end`/`egress.close`。
无网卡铁律不破：回环不是网络设备。

**批准粒度是会话×目的地，且只记忆放行。** 审批者把已放行的
`host:port` 缓存在 `WeakMap<Agent, Set>`——同一会话后续对已缓存目的地的
拨号免卡通过；拒绝与新目的地总是询问；死掉的 Agent 其缓存随对象消亡。
插件 Config 上的 `egress: 'ask' | 'deny'`（默认 `'deny'`）是部署的一刀
开关；`dsh-base` 的 vm 行设为 `ask`，因此没有 user-questions provider 的
headless 组合——或询问失败——不阻塞地拒绝。

## 备选与否决

- **协议携带策略 / op 级强制** —— 与 M7 confinement 同一诚实性缺口而否决：中介必须拥有决策，而不是汇报决策。
- **virtio-serial 或 virtio-net 作代理通道** —— virtio-serial cdev 在本内核仍 ENXIO（种子 spike 实测）；virtio-net 就是网卡，直接破坏无网络设备姿态。
- **Config 上的第二个世界级审批策略** —— 一刀切回调无法把卡路由到会话；origin 注册是唯一诚实的单元，因为只有它携带归属。
- **给 `dsh-subprocess` 契约穿 agent/origin 字段** —— 每个调用方都要为环境化上下文已证明的事实付费；packages/AGENTS.md 的发起者作用域规则点名了这条派生路径。

## 实测

TCG、单世界、本地 echo 服务器（全表见 `dsh-vm-qemu-local` MEASUREMENTS）：
小往返（4 B/9 B）≈ 21–25 ms；64 KiB 双向 ≈ 0.02 MiB/s（双重 base64 + JSON
帧化 + 线程交接，约为裸 UART 上限的 1/10）——API 调用级流量，非 bulk。
中继永不阻塞 guest 控制循环：入站字节在每流写线程排队（停止读取的客户端
在 guest 内增长内存直到其 exec 预算杀死它——已记为已知限制）。

## 验证

- `subprocess-vm` 单测：origin 绑定/释放、无归属拒绝、问一次即缓存、跨发起者隔离、无通道与询问失败拒绝（`tests/runtime.spec.ts`）。
- REAL Loader 组合（CI 可跑）：经 app-boot 的真实 user-questions 服务 + 脚本 provider——放行+缓存、拒绝、无 provider 默认拒、无归属拒绝（`tests/loader.spec.ts`）。
- QEMU e2e：3 次拨号 / 2 个目的地 = 恰好 2 张卡（缓存成立）、SOCKS 路径回程字节、被拒拨号在世界内失败、无归属 exec 拒绝（`tests/egress.e2e.ts`）。
- guest 回归：写线程修复后完整 vm e2e 矩阵 30/30。

## 后续

- egress 的 bulk 级通道（M9 长尾，与 M5 结论并列）。
- 一旦出现停滞客户端策略，写收件箱设界。
- 若 UI 想要专属渲染，给 egress 卡加 `AskUserQuestionIntent` 标签（仅展示层，协议中立）。

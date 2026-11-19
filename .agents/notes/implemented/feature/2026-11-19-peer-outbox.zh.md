# Agent Note: 发起方结算台账

Status: implemented

[English](2026-11-19-peer-outbox.md) | 中文

## Problem

peer 工具(PR #326)让委派对模型可达,但在预算内是同步的:超预算的运行轮次只返回手动续查引导,目标不可达即调用失败,没有任何东西跟踪已接受轮次到完成。Owner 裁定了可靠性形态:配对是双方在线的契约——目标不可达必须立即失败,任何延迟复活都不得在不可预期的时刻运行工作,因为可预期的失败比不可预期的稍后成功更安全。

## Decision

把结算跟踪从提交中拆出,做成三块窄件,各归其既有接缝:

- **`peer/result` Remote**(`dsh-peer-host`):门控在 `list` surface 的只读结算读取。它从活跃会话日志——冷会话则从持久化事件——重新推导一个已拥有轮次的终态、回复与结束原因,使结算读取永远不需要再一次模型回合。`dsh-peer-client` 增加对称的 `runPeerResult`。
- **`dsh-peer-outbox` 服务**(`ctx.peerOutbox`,storage-domain 台账 `peer_outbox`,web-app 组合中与 `peer-host` 相邻):只跟踪已被在线目标接受、但超出工具预算的轮次。实例常驻轮询器按轮询间隔对每个 watching 条目读取 `peer/result`。瞬时传输故障恰好获得**同刻复探一次**;第二次故障即终态失败 `TARGET_UNREACHABLE`。台账不保存未投递工作、没有重试队列、不等待任何人。结算的轮次在空闲维护阶段以一条 `peer` 来源的排队 user 消息把截断回复投回发起会话(沿用 scheduler 的投递模式),同 owner 会话按提交顺序;会话已关闭则以 `OWNER_SESSION_NOT_LIVE` 失败,回复保留在台账中。终态条目超过 200 条即修剪。
- **工具与 CLI 升级**(`dsh-tool-peer`、`dsh-peer-app`):工具在组合了该服务时(经 `ctx.get('peerOutbox')`)把运行轮次登记入账(未组合的部署保持 M3 引导原文),并把模型指向排队投递;`dsh peer run/send --async` 以最小预算提交并打印回执,`dsh peer result` 是任意回执背后的人工结算读取,`dsh peer outbox` 是经实例写入所用的同一存储组合对台账的只读视图。

台账属于 home 而不是进程:CLI 的 `--async` 刻意不写它(实例是域的唯一写者),实例重启后由持久存储在下一次轮询恢复全部跟踪。

## Alternatives considered

- **退避重试队列等目标回来** —— owner 裁定否决:这正是让工作在不可预期时刻开跑的延迟复活语义。
- **peer-app 作为第二轮询宿主** —— 否决:实例对实例是产品形态(DSH_HOME 即实例),第二套轮询实现会复制恢复语义;CLI 保留手动 `result` 读取。
- **冷会话唤醒投递**(scheduler 的完整冷路径)—— 随 M6 推迟:唤醒已关闭会话会在用户未选择的时刻运行一次本地模型回合,与"非预期后果"同族;回复保留在台账中可查。
- **扩展 `peer/sessions` 携带回复正文** —— 否决:列表响应将背负无界正文;专用的按轮读取让边界显式。

## Consequences

- outbox 的失败族是闭集且可检视(`dsh peer outbox`):`TARGET_UNREACHABLE`、`TARGET_RECORD_NOT_FOUND`、`SESSION_DROPPED`、`OWNER_SESSION_NOT_LIVE`、`READ_FAILED`。
- 投递与结算写入之间崩溃会为该条目重放一次投递;回复内容幂等,窗口以会话 flush 屏障为界。
- `dsh peer outbox` 从第二个进程读取持久 JSON 介质;它永不写入,单写者纪律归运行中的实例。
- 投递只面向活跃 agent,按会话内提交顺序;不同会话之间的跨周期顺序不做保证。
- `peer/result` 的重推导在声明滑出常驻后缀且持久层无事件时 fail-closed(`SESSION_NOT_FOUND`)——有界边界,已记录于包 README。

## Required verification

- `packages/peer` vitest 组:`peer-outbox` 单测(投递、全部失败族、FIFO、崩溃恢复重启、保留修剪、周期中销毁,`src/` 100% 语句与分支覆盖)、真 Loader 组合验证台账跨重启持久、`peer-host` result Remote 套件、`runPeerResult` 客户端覆盖、工具在有/无 outbox 服务下的登记行为,以及 CLI `--async`/`result`/`outbox` 经 Loader 组合的路径。
- 刷新 ACP 场景后(工具描述与 peer-host wire 面变更)`pnpm run test:snapshot` keyless replay。

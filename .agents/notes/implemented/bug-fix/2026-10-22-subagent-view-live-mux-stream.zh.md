# Agent Note: 查看子 agent 会话必须流式推送其实时事件

Status: implemented

[English](2026-10-22-subagent-view-live-mux-stream.md) | 中文

## Problem

从目录点开一个子 agent 的会话，只渲染出一份历史快照，之后再也不更新，而子 agent 明明还在跑、父会话视图也一切正常。第一个故障背后还藏着第二个：即便某条子 agent 流已被授权，任何一次连接重建后它都会再度静默——因为没有客户端游标把它带进新的 mux 代次。

## Decision

mux 可见性规则不变：`origin: 'subagent'` 的会话只向「寻址过它」的主体推送。错的是授权点——只有 `subagents.prompt` 登记过地址，纯查看的打开方式（`subagents.history`，目录每次点击驱动的读取面）从不授权，mux 于是过滤掉了子 agent 的每一个事件。

`subagents.history` 现在在其成功路径上执行同一套登记：`catalogChild` 验证过持久直连父地址、父校验通过后，主体的 `addressedMuxAuthorizations` 加入该子会话，同一主体的每个活跃 mux 队列以全量重放订阅它（`subscribeWithReplay(session, true)`），与 prompt 侧的动作完全一致。查看式打开就是 prompt 的读取孪生：两者证明的是同一个持久地址，而授权集合的设计本就只接受这一证明。

客户端侧，`Session.syncCursor()` 不再排除带地址会话：打开的子 agent 窗口把自己的连续尾部游标提供给 `muxSince()`，重连的 mux 代次因此在 `since` 中携带该子会话，宿主 bootstrap 从游标之后重放缺口，已授权的子视图跨连接掉线持续流式更新。宿主端 bootstrap 本来就会为每个可见会话读取 `since`——这条设计好的路径只是从未被客户端喂过。

## Alternatives considered

**在 `subagents.list`（目录拉取）时授权。** 否决：目录证明的是父会话，而非任何具体的子地址；按目录整体授权会让主体仅列出过的所有兄弟子会话都被推流。

**保留客户端游标排除、重连时改拉历史。** 否决：重连时已打开的带地址会话并不处于 loading/error 状态，没有任何东西会重新触发 `subagents.history`；没有游标，冻结视图的 bug 在每次掉线后都会复现。

## Consequences

- 点击健康的目录子项现在渲染出实时会话视图：重放基线（`session/subscribed`），随后是流式事件。
- prompt 侧授权与查看侧授权的子会话跨重连行为完全一致。
- 授权仍是每主体、每宿主进程的内存态；宿主重启即丢弃——这是正确的，因为宿主重启也停掉了所有子会话。
- 一个宿主进程内 `addressedMuxAuthorizations` 仍随主体单调增长——dispose 移除的是单条 mux 的成员关系，而非持久地址证明；增长以主体能寻址的目录为界。

## Testing

- `packages/host/apiproxy` —— `api-proxy-subagents.spec.ts` 新增查看侧孪生用例：先开 mux，再以同一主体调用 `subagents.history`，断言流上先后到达 `session/subscribed` 基线、重放事件与实时推送事件。
- `packages/client/runtime` —— 钉死的游标期望翻转：带地址的已打开窗口现在发布其尾部游标（`publishes its contiguous cursor for ordinary and addressed windows alike`），且经子 agent 历史路由打开。

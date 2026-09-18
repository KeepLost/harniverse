# Agent Note: fork 标题策略短暂等待迟到的 title projection

Status: implemented

[English](2026-09-18-fork-title-settle-wait.md) | 中文

- 日期：2026-09-18
- 范围：`@deepseek-ai/dsh-client-runtime`（fork 标题策略）
- PR：pending（本笔记随修复一同提交）

## 问题

`chat-long-interactions` e2e 在 CI 负载下于发布线失败——两次，其中一次早于今天的全部改动：branch 手势后子会话面包屑 30 秒内始终未出现 ` (1)` 增量。2026-09-17 的修复把策略的读取源换成了常驻 `'title'` projection，但残余窗口仍在：当 title projection 帧**本身**尚未落地（负载下 host 的标题计算落后于 settle）时，`titleOf` 返回 `undefined`，策略按设计静默跳过改名。

## 决策

带 `increaseTitle` 的 `SessionRuntime.fork` 现在经由有界落定等待读取源标题：`titleOf` 立即命中则与原先一样同步返回；未命中则每 50ms 轮询、至多 5 秒，等权威 projection 帧落地；超过上限才维持既有的"无标题不改名"规则。等待只存在于 `increaseTitle` 路径——不带标题策略的 fork 永不等待。

## Consequences

- 在 title projection 迟到窗口内发起的 branch 现在仍产出带增量的子标题；CI 负载 flake 的机制被关闭。
- 无 durable title 的（blank）会话 branch 行为与原先完全一致——只是经过有界等待而非立即返回，除无标题 fork 路径的延迟外不可见。
- 仅在"应有标题却始终未落地"的病态情形下，手势最多耗时 5 秒。

## Alternatives considered

- **重试或等待 list flush**（先前否决的 paper-over）：对象不同——那次修的是读错源；这次等的是权威源自身的到达，任何同步读取都无中生有不出它。
- **fork RPC 的 host 侧增量**：此前已因 wire 契约不成比例而否决；立场不变。
- **缺标题即让 fork 失败**：仍然会破坏合法的无标题会话。

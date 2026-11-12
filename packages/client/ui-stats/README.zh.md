---
description: "会话视图:按轮次/步展示上下文 tokens、缓存读写与命中率、首字延迟、模型与工具耗时、解码速度、重试与错误计数。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-stats

[English](README.md) | 中文

## 概述

在 Chat 与 Trajectory 旁新增"统计"页签。合计栏给出已加载窗口的总览(轮次、步数、模型与工具时间、平均首字、综合解码速度、输出 tokens、缓存命中);轮次行可展开为步,展示上下文 tokens、缓存读·写与命中率、首字、模型与解码耗时、每秒 tokens、工具记账(按名称 pill)、重试与错误。触发列标明开启轮次的内容——用户提示(含文件与图片计数),或插件注入(含生产者与通知摘要)——无步的轮次也会显示其关闭原因。压缩以行的形式出现:编号压缩归入所属轮次,独立压缩位于轮次之间,并带提供者、模型、token 数字、折叠规模、耗时与错误。回滚通过共享的 Session 分页加载更早轮次。该页签只读取会话事件;不注册任何工具、提示区段或服务。费用与计费数字刻意缺席——本视图只展示测量事实。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载到已提供 `slots`、`sessions`、`locale` 与会话注册表的客户端组合中。它向 `conversation.view` 槽贡献一个条目;没有配置字段。

### 何时选择

需要按上下文规模、缓存复用与时间分布比较轮次/步时选它。需要带请求头与交互时间轴的完整事件账本时选 `@deepseek-ai/dsh-client-ui-trajectory`;两个面板读取同一会话,可同时启用。

### 最小配置

```yaml
- id: ui-stats
  name: '@deepseek-ai/dsh-client-ui-stats'
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 —— 点击展开</summary>

四个会话定义把事件窗口折叠为名为 `stats` 的视图目标节点。`stats-step` 每个 `step/start` 持有一个上下文,折叠流块(首字)、装配消息(usage、中断、答案预览)、按 callId 配对的工具调用/结果,以及 `llm/retry` 计数;工具墙时对已结算调用区间取并集,避免并行调用重复计时。`stats-prompt` 每个 `user/message` 持有一个上下文,按引擎解析的 Location 做轮次归属,派生触发事实(来源种类、生产者、声明的形式、通知摘要、预览、文件/图片计数)。`stats-turn-end` 记录关闭标记,使中断尾部与关闭原因可渲染。`stats-compaction` 折叠一次事务(`compaction/start` → `summary` → `end`)的提供者、模型、usage、折叠规模、耗时与错误。

| 文件 | 职责 |
| --- | --- |
| `src/client/stats-step-definition.ts` | 步折叠:计时、usage、工具配对、重试 |
| `src/client/stats-prompt-definition.ts` | 唤醒用户消息的触发事实 |
| `src/client/stats-turn-end-definition.ts` | 轮次关闭标记 |
| `src/client/stats-compaction-definition.ts` | 压缩事务状态 |
| `src/client/stats-aggregate.ts` | 轮次分组、行排序、窗口合计 |
| `src/client/stats-snapshot-builder.ts` | `stats` 视图目标与按键构建器 |
| `src/client/stats-format.ts` | 确定性的计数/时长/速度格式化 |
| `src/client/StatsView.tsx` | 合计栏、轮次表、步展开 |

Token 计数是不相交的:`inputTokens` 不含缓存输入,因此上下文 = input + cacheRead + cacheWrite,命中率以 cacheRead ÷ (cacheRead + input) 计算,与提供方 usage 契约一致。

</details>

## 延伸阅读

- `docs/cookbook/adding-a-conversation-node.md` —— 这些定义遵循的会话节点纪律。
- 上游 `packages/session/session-stats` —— 整日志投影模式;本视图的合计保持在已加载窗口范围内。

## Model Experience

无。统计视图在浏览器中渲染会话数据;本包不触达任何模型请求。

#### KV Cache effect

无;本包既不装配也不发送提供方请求。

## 已知限制与后续工作

- **合计仅覆盖已加载窗口,非整日志** —— 数字派生自分页进入的事件窗口;整日志投影(上游 `dsh-session-stats` 模式)需要宿主侧折叠。
- **PTC 内层派发并入父调用** —— `tool/code-dispatch` 内层调用不单独归因;其时间位于父 `tool/call` 配对的墙时区间内,输出位于父结果内。
- **无逐调用折叠面板** —— 步行显示按名称的工具 pill 与未完成调用计数;逐调用细节留在 Trajectory 检查器。

## 开发注记

吸收自官方 `dsh-experimental-client-ui-stats` 线(wave-6 row 8):逐步事实视图被裁定在"禁本地计量"默认之外,而计费与成本核算仍被禁止。触发词汇遵循本代码库的消息来源(用户提示、带声明形式的插件注入)——官方的团队消息发送者列在此没有对应物。

# Agent Note: user-text 与 session-open 基准

Status: implemented

[English](2026-10-26-user-text-and-session-open-benchmarks.md) | 中文

## Problem

wave-3 的基准决策接受了"回归驱动、在随用户积累而变慢的生命周期端点测量的性能门,预算是评审过的源常量";wave-4 建树并落了终端门,浏览器与流式门随后。wave-5 调查把官方的 benchmarks 扩充(row 11)记为"已批方向获得具体形态"。

## Decision

为基准树新增两个门(owner 决策,2026-10-26),均沿用本树既有风格——由评审常量合成的输入、串行采样、中位数聚合、报告行之后断言绝对预算,并套 `run-benchmark.ts` 的进程树 RSS 上限:

- `benchmarks/user-text.bench.ts` —— 已发送用户文本掩码背后的凭证匹配器,覆盖五种未命中文档形态(典型消息、散文、代码、JSON、base64,各约 256 KiB 或等量消息批次)与两种命中形态(每条消息一个模型 key 或 GitHub 令牌,200 条)。每份文档都通过推进偏移的查询扫到结尾。预算:每文档中位 10 ms(实测:低于 1 ms)。这个门存在的原因,是识别器的回溯式回归不能悄悄落地。
- `benchmarks/session-open.bench.ts` —— 大会话的冷恢复:经生产 append 路径一次性构建 2,000 轮(8,000 事件)的合成日志,然后对 `Session.fromRestore` 加 `deriveMessages()` 逐采样测量。预算:恢复 100 ms、派生 25 ms(实测:约 8 ms 与 0.5 ms)。对不断增长的日志做折叠,是每次会话打开都要付出的积累成本;磁盘 I/O 归持久化包自己的测试。

两者以必需的 `performance / user text` 与 `performance / session open` CI 任务加入矩阵,与既有的终端、浏览器、流式门并列。

## Alternatives considered

**移植官方的机器画像缩放与 worker 框架。** 我们的树已有自己的采样/中位/RSS 纪律,且跑在单一 Linux runner 级别上;在这些预算下,缩放报告机制解决的是我们并不存在的方差问题。

**让 session-open 走完整 JSONL 持久化读取。** 基准必须走生产路径,但捆绑协调器、fsync 与 zstd 解码,测到的会有一半是文件系统;随历史长度增长的正是恢复内核这一段。

## Consequences

- 匹配器与恢复折叠各自拥有了具名、有预算的回归门;预算只能通过编辑本 note 所属基准文件中评审过的常量来更改。
- 验证:两个基准在本地通过(中位数如上);CI workflow 规格校验了新任务与必需门图。

# Agent Note：PTC 输出截断而不取消执行

Status: implemented

[English](2026-11-23-ptc-output-truncation.md) | 中文

## 问题

因捕获输出超出预算而终止程序，会打断一串外部动作：更早的影响已经发生，但调用方无法分辨哪些后续动作执行过；为少拿些输出而重放程序，可能重复这些副作用。日志预算占满还会以 `output-limit` 覆盖随后异常的本来种类，而溢出驱动的状态清除会把一个纯呈现层条件变成保留 REPL/Script 变量的清除。Node 提供方（子进程 `LogBuffer` → `outputLimit` 宿主 RPC；宿主 `OutputLedger` → `admit` 溢出）与 Python 提供方（宿主侧 `capture` 处理 stdout/stderr 与 `log` 帧）共享同一"溢出即终止"语义。

## 决策

两个提供方的捕获输出现在都改为有界保留，对齐官方 0.2.3 的 `ptc-output-truncation` 语义：

- **耗尽时保留有序前缀**（含溢出条目本身能容纳的前缀，经新的 `OutputLedger.admitPrefix`），丢弃后续输出，并置 `PtcRunResult.outputTruncated: true`。不取消执行，也不丢弃保留变量——子进程发来的 `outputLimit` 宿主 RPC 现在记录截断而非终结执行，`RETAINED_STATE_INSTRUCTIONS` 不再把输出溢出列为清态事件。
- **终结时在合并载荷预算内优先保证必需完成值或有界失败诊断**：为放得下的完成值裁剪日志；放不下的诊断被缩短而非改类——截断的诊断保留其失败种类。`output-limit` 只指一件事：连空前缀都放不下的必需完成值。
- **子进程完整发送无损值与按合并预算封顶的诊断**（`prepareCompletion`/`prepareException` 移除了剩余预算改类逻辑；帧上限仍约束线路），合并预算的最终整形由宿主 ledger 单点负责。
- **模型可见结果携带一条有界提示**（`core/tools/src/ptc.ts`），附加在捕获输出之后（或 bounded 诊断旁），说明后续输出被丢弃、执行未被取消，模型应检查当前状态而非重放已完成的动作。超量结果仍照旧沉降进 `tool-result-artifacts` 的 spill + `artifact_read` 分页。

## 备选方案

- **输出耗尽即终止**（旧行为）——把呈现层上限变成无回滚的外部工作中断；按官方记录否决。
- **成功返回截断的完成值**——违反调用方对完整 JSON 数据的要求；只有捕获输出与诊断文本可以缩短。
- **为溢出采用官方 `IMAGE_OFFLOAD_REQUIRED` 式"失败再重试"**——不适用：截断无需重试，且持久化沉降机制属于图片而非输出。

## 后果

- 截断的成功运行仍是成功工具结果并标明截断；失败运行保留失败种类并带 `outputTruncated`。无截止的死循环程序不再死于日志上限——截止、取消、堆栈上限与控制消息上限仍像从前一样约束执行。
- Python 提供方的 `terminalOverride` 击杀路径移除：`capture` 记录截断并继续读取；两个提供方的 ledger 共享同一记账形态（保留克隆检测标记）。
- 证据：node 套件——`runtime.spec`（截断不取消、bounded 诊断种类、值放不下边界）、`persistent.spec`（状态在日志溢出后保留、解析诊断封顶）、`persistent-host`/`host-failures`/`timeout`/`process-main`/`bootstrap`/`output-ledger` 按新契约更新（575 通过）；python 套件——ledger 边界、伪造超宽日志的再封顶、诊断优先（50 通过）；呈现提示在 `core/tools/tests/code-mode.spec` 锚定（93 通过）。

# Agent Note: 串行化共享转换缓存的覆盖率通道

Status: implemented

English | [English](2026-09-09-coverage-cache-serialization.md)

## 问题

`ci-coverage` 同时启动带插桩的 Vitest 运行和不带插桩的 heavy 套件运行。两个进程使用仓库共享的 Vite 转换缓存。一次不稳定失败中，992 个测试文件全部通过，但 Istanbul 将 `packages/context/context-reset/src/invariant.ts` 报为 80% 分支覆盖率，覆盖率 reporter 发现 `-11`、`-21` 等负计数。有效执行不可能产生负计数；同文件中被清零的邻近条目是无效合并造成的误导性缺口。

## 决策

在 `scripts/run-gates.ts` 中串行化两个覆盖率通道：`test:coverage` 依赖 `test:coverage-exempt-heavy`。这保留两个 gate 及其阻塞属性，同时避免带插桩和不带插桩的转换并发共享缓存。依赖关系由 `scripts/run-gates.spec.ts` 固定。

## 诊断步骤

当 100% 覆盖率 gate 不稳定失败、但测试数量全绿时：

1. 读取完整 gate 日志，区分测试失败和 coverage threshold 失败。
2. 先检查逐文件计数，不要先改测试或添加 ignore 注释。
3. 将任何负的 statement、function、line 或 branch 计数视为损坏的覆盖率数据，而不是未覆盖路径。
4. 使用自定义 reporter 单独打印负计数；同文件中负计数旁边的精确零值也不可信。
5. 检查并发的 coverage 与非 coverage 进程是否共享转换缓存或报告目录。
6. 串行化或隔离这些资源，然后重跑原 gate 与聚焦回归测试。

所需证据是零测试失败、无负计数、threshold gate 通过。只重跑后碰巧通过、却没有处理共享状态，不算修复。

## 后果

coverage job 可能耗时为 heavy 套件与插桩套件耗时之和，而不是二者最大值，但不再依赖有竞态的共享转换缓存。两个通道仍独立可见且都阻塞合并。今后的 CI 诊断应先保留损坏计数证据，再考虑 coverage 排除或 `v8 ignore`。

## 已考虑的替代方案

提高测试超时、重跑失败 job、添加 coverage 排除以及压制受影响分支都被否决：它们都不能阻止无效计数，而且可能隐藏真实覆盖率回归。暂不为每个进程配置独立缓存，因为 gate runner 已提供无需新增缓存配置契约的确定性排序接缝。

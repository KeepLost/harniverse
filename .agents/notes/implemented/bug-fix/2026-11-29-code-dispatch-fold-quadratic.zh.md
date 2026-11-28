# Agent Note: Code Dispatch 折叠保持线性

Status: implemented

[English](2026-11-29-code-dispatch-fold-quadratic.md) | 中文

## 问题

客户端有三处折叠把 `tool/code-dispatch-start` 与 `tool/code-dispatch` 记录配对成嵌套的 Tool 调用：Chat 的 Tool Definition（`client/ui-conversation/src/client/conversation-nodes/tool.ts`）、Trajectory 的 Tool Definition（`client/ui-trajectory/src/client/trajectory-tool-definition.ts`），以及运行时的 `ToolCallTree`（`client/runtime/src/client/sessions/tool-call-tree.ts`，它为兼容字段 `nodes` 与 `runningCalls` 提供数据）。三处都通过扫描父调用的兄弟列表来定位子调用，并复制每一个被触及的容器：同一个父调用下有 n 个已结算的子调用时，Chat 对每个事件都复制父子映射、父映射和兄弟数组，Trajectory 复制调用映射，`ToolCallTree` 复制兄弟数组。开销随扇出呈平方增长，而折叠在打开 Session 时同步执行。

改动前在本机实测，一个根调用带 20,000 个已结算子调用：Chat 79,520 ms，Trajectory 103,001 ms，`ToolCallTree` 9,698 ms。官方为同一问题给出的报告是一个 50,294 个事件、24,629 次嵌套分发的 computer-use 会话，折叠耗时 8,950 ms。

## 决策

- **Chat 与 Trajectory 改为持有就地更新的分发树**，采用官方的形态（`6a4ee478d7`，#9387）。Chat 先按父调用、再按子调用 id 索引子节点，替换时保持首次挂载的顺序；Trajectory 保留一份调用映射、每个父调用有序的子调用 id 列表和一份父映射。两处 `update()` 都返回同一个 State 对象；`start()` 仍然新建。Assembler 只是接收 `update()` 的返回值，不按 State 引用判定发布，因此对它没有任何规则变化。
- **投影在发布时才物化数组。** Chat 仍按块身份与子节点身份缓存每个已投影的块，所以未变化的兄弟节点保持对象身份；Trajectory 和此前一样，每次发布投影出一棵新树。发布出的 Tool 调用块持有自己的数组，绝不与树共享引用。
- **`ToolCallTree` 用以 id 为键的 `Map` 存放每个父调用的子节点**，在 `projectBlock` 里物化兄弟数组。它没有官方对应物，因此按它自身的形态套用同一思路。同一父调用下重复的开始事件现在被忽略；此前它会追加一个重复的兄弟节点。

## 考虑过的替代方案

- **保留复制，降低发布频率** —— 否决：平方级的开销发生在折叠阶段，早于任何发布，而且 Assembler 对已注册的 Definition 一律更新，与目标是否激活无关。
- **引入官方的 `conversation-fold` 基准通道并设 CI 预算** —— 本次不做：它需要参考机标定和一条新的 CI 作业。改为在每个 spec 里折叠 20,000 次分发并设五秒的墙钟预算，线性折叠以一个数量级的余量通过，平方实现相差两个数量级。
- **移植官方的统计面板修复（`e255853b03`，#9420）** —— 不需要：我们的 `ui-stats` 步骤折叠本就就地修改它的 `calls` 映射，也不读取分发事件。

## 影响

- 折叠宽扇出的耗时与规模成正比。改动后同样三处折叠在 Vitest 下从源码运行分别耗时 297 ms、282 ms 和 93 ms。
- State 的身份不再是这两个 Definition 的变化信号。任何依赖“每个分发事件产生一个新 State 对象”的代码现在会看到同一个对象；本仓库中没有这样的读者，Assembler 是唯一的读者。
- 每次发布仍会投影整个根调用，所以有 n 个子调用的根调用每次发布花费 O(n)；一次分发数千个子调用的运行会每个事件发布一次。这是常数很小的线性工作，也是官方记录写明的取舍。
- `ToolCallTree` 在结算事件先于开始事件到达时仍保持首次挂载的顺序；一个父调用仍可与另一个父调用共享同一个后代，它的无环图测试钉住了这一点。

## 测试

- `client/ui-conversation/tests/conversation-node-definitions.client.spec.ts` 与 `client/ui-trajectory/tests/conversation-definitions.client.spec.ts`：首次挂载顺序、重复开始被忽略、环、换父和自环被拒绝、父节点挂接后收养游离的子树、调用早于窗口的根调用由其结果重建；每个文件还在五秒预算内折叠并发布 20,000 次已结算分发。移植过来的顺序用例在旧代码上同样通过；宽扇出在旧代码上分别以 79,520 ms 和 103,001 ms 失败。
- `client/runtime/tests/tool-call-tree.client.spec.ts`：首次挂载顺序、重复开始被忽略、更晚的结算不改动更早的投影、未变化的子节点跨投影保持身份；在预算内应用并投影 20,000 次分发。在旧代码上重复开始产生了一个重复的兄弟节点，宽扇出耗时 9,698 ms。

## 相关

- 官方记录 `bug-fix/2026-11-27-ptc-dispatch-fold-quadratic` 与 `bug-fix/2026-11-27-ptc-stats-panel-quadratic-fold`（dsh 0.2.3-alpha.3）。
- [客户端 Tool 呈现归属](../architecture/2026-08-08-client-tool-presentation-ownership.md)。

# Agent Note: 配置刷新与浏览器断言先观察所属数据的就绪条件

Status: implemented

[English](2026-09-11-ci-readiness-boundaries.md) | 中文

## 问题

监听器句柄或已挂载的 UI 并不能证明异步输入已可观察。确切配置路径的注册可能在原生订阅启动期间漏掉唯一一次创建；连续两次相同的无障碍快照也可能都只包含加载占位内容。Cordis 审批还会在初始请求结算后注入模型可见上下文，因此测试不能把运行请求、审批后续处理和显式停止提示词当成两个可以互换的轮次。

## 决定

### 确切配置路径的观察

[HMR（热模块替换）的 `registerConfig`](../../../../vendor/hmr/src/index.ts) 通过最近的现有规范祖先目录解析一个确切路径，并在由 effect 持有的注册返回前取得异步 stat 基线。它独立于原生事件、`usePolling`、模块根目录和目录扫描轮询该路径。每次 stat 结算后才安排下一次轮询，使用 `interval` 或 100 毫秒；不持有事件循环引用的定时器不会让进程继续存活。已存在的文件请求一次初始刷新；缺失文件及其父目录在后续创建时仍可被观察。

快照比较设备号、inode、大小、纳秒级 mtime 和纳秒级 ctime，不比较 atime。`ENOENT` 和 `ENOTDIR` 表示缺失。其他基线错误会拒绝注册；后续 stat 错误会记录警告，并保留原基线供重试。重复的规范路径注册会被拒绝，包括并发注册的别名。在获取基线期间 dispose（资源释放）会以 `INACTIVE_EFFECT` 拒绝注册，不准入任何工作。

Cordis effect 在初始刷新能够 dispose 其所有者之前就持有清理职责。注册或 HMR 的 dispose 会停止轮询、等待在途 stat，并排空已准入的串行化、合并刷新工作；迟到的 stat 结果不会准入新刷新。刷新失败仍规范化为 `Error` 并广播 `hmr/config-update-failed`，观察者的 rejection 不能阻止后续更新。主 Chokidar 模块/Include 监听器保留其配置指定的原生或轮询行为以及 `ignoreInitial: true`；没有用启动器、组合包或 agent loop（智能体循环）的特殊分支替代插件生命周期。

### 浏览器与回放的就绪条件

[`captureStableAria`](../../../../apps/web/tests/scaffold.ts) 只在调用方已观察到场景数据就绪之后稳定 React 渲染。[生命周期命令菜单场景](../../../../apps/web/tests/lifecycle-chrome.e2e.ts) 等待加载完成的 compact 命令选项；[父级离线的 subagent 场景](../../../../apps/web/tests/subagent-interrupt-ui.e2e.ts) 等待已获取的 `partial` 历史文本。两者都保留原有预期输出，而不接受加载中的画面。

[Cordis 场景](../../../../apps/web/tests/cordis-tool-round.e2e.ts) 通过初始提示词选定自己的 Session，并等待每个持久化的 `turn/end`、Agent 空闲状态和 Session flush。审批在轮次 1 完成后进行；host-runner 上下文启动独立的轮次 2；显式停止提示词在轮次 2 完成后发出，并先于轮次 3 的 `cordis_stop`。比较或刷新预期输出前，断言要求三个轮次全部完成，四个工具结果全部成功。

录制的 fixture（测试前置数据）有六次模型请求；若审批后续处理消耗了停止响应，第七次请求就会耗尽脚本。[仅用于回放的伴随文件](../../../../apps/web/tests/snapshots/cordis-tool-round/replay.override.json) 提供 `CORDIS_UI_RUNNING` 作为审批确认，并把停止调用和最终回复各后移一次请求。JSONL 仍保留为未经修改的真实模型录制。[修正后的预期输出](../../../../apps/web/tests/snapshots/cordis-tool-round/ui.expected.md) 在更强的顺序和完成断言下移除先前被接受的耗尽错误，而不是降低预期。

## 曾考虑的替代方案

**延长等待，或反复写入直到监听器响应。** 两者都不能证明首次单次写入能够跨过原生订阅启动期。持有 stat 基线消除了确切配置路径对此的依赖。

**把相同的 ARIA 样本视为 I/O 就绪，或刷新加载中的预期输出。** 稳定的占位内容并不能说明在途命令/历史响应的状态。场景自身的数据内容提供了缺失的条件，无需睡眠等待，也不改变产品输出。

**复用两轮回放，或只检查最后一次完成。** 审批可能在用户请求停止之前就消耗停止响应；后续失败甚至可能成为被接受的快照输出。显式确认加上逐轮完成与顺序断言，保留真实审批动作并暴露脚本耗尽。

## 后果

确切路径轮询以每个已注册路径在前次 stat 结算后、每个间隔执行一次异步 stat 的成本，换取对原生事件的独立性。它合并可观察状态，而不保留每次中间写入：完全发生在两次轮询之间的创建与删除，或所选 stat 字段无法区分的变化，不保证产生通知。广域模块监听没有改为轮询。浏览器就绪条件仍由各场景负责；回放确认是合成内容，不代表重新进行了真实模型录制。

## 测试

[确切配置路径回归测试](../../../../packages/boot/app-boot/tests/hmr-config.spec.ts) 固定了跨延迟原生启动的单次创建、缺失父目录的创建、规范别名互斥、stat 字段/错误恢复、不重叠轮询，以及注册/所有者 dispose 后无迟到工作的行为。[用户补丁组合覆盖](../../../../packages/boot/app-boot/tests/user-patches.spec.ts) 演练添加、无效编辑后保留、恢复和删除，不使用等待 Chokidar 稳定的睡眠。

临时加入一秒 HTTP 延迟的浏览器诊断实验复现了六个测试失败和两个清理错误；相同延迟配合数据就绪等待后，10/10 测试通过。这些诊断延迟已移除。该证据区分了缺少就绪条件与预期 UI 变化，并非新的时间阈值，也不是跨平台浏览器保证。

## 相关决策

本记录部分取代[配置热重载韧性](2026-07-20-config-hot-reload-resilience.md)和[初始扫描启动安全](2026-08-03-hmr-initial-scan-boot-deadlock.md)中的确切路径机制，并澄清[无密钥浏览器测试车道](../testing/2026-07-24-web-gui-browser-e2e-lane.md)关于稳定采集的假设。这些记录仍保持活跃：补偿回滚、Include 串行化及其首次应用失败的缺口、真实组合回放的职责划分仍约束当前行为。[subagent 中断](../feature/2026-08-06-continuable-subagent-interrupt.md)和[仅比较的 CI](../testing/2026-07-30-web-browser-snapshot-ci-gate.md)决策不变；没有任何前序记录被完全取代或归档。

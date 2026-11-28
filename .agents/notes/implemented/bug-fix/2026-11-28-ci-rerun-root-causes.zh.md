# Agent Note: 条目重建、冒烟渲染器探针与环境凭据提示

Status: implemented

[English](2026-11-28-ci-rerun-root-causes.md) | 中文

## 问题

最近十天里大多数 CI 重跑背后的三处缺陷，统计范围是 2026-11-19 至 2026-11-28 之间每个工作流运行的失败尝试：

1. **Loader 条目在刚移除的 id 下重建时，被移除的 Fiber 还在卸载。** `EntryGroup.remove` 删除条目并启动其 Fiber 的处置，却不保留这个 promise；`EntryGroup.create` 随即立刻登记新条目。notification-http 的组合测试在一次 Include 刷新里移除该行，在下一次刷新里恢复它，于是重建的后端在被移除的那个关闭 `notification_http` 存储领域之前就去打开它：`DomainError: domain 'notification_http' is already open`。造成三次重跑——Windows 原生通道两次，Linux 覆盖率通道一次——在十二个忙循环的 CPU 负载下，本地十二次运行里失败两次。同一 entry 的配置编辑不受影响：`Entry.update` 重启该 Fiber，而 `_unload` 会等每个处置器结束，`_reload` 才启动下一个实例。
2. **干净安装冒烟只凭一次尝试判定认证 API 探针。** `authenticatedApi` 发出一次十秒上限的 `executeJavaScript` 探针，没有回答就让资格判定失败，尽管 `probeRenderer` 的文档把未获回答的探针定义为“此刻无法回答”，本身从不构成判定失败。`desktop / macOS arm64` 六次重跑，全部发生在重启阶段：应用自身的请求已被接纳，心跳一直在跳，其中两份日志里延迟启动的请求是在页面起来八到十秒后才到达的——是渲染器或 Host 卡顿，而不是坏了。
3. **models-settings e2e 在环境凭据探测落地之前就截取了添加卡片。** API 密钥输入框下方的提示在探测回答之前显示“尚未确认”，而 `captureStableAria` 接受两帧相同；一个停住未决的状态就是稳定的。两次 web e2e 重跑把 `环境凭据状态尚未确认` 钉进了 golden 应为“未检测到”那句的位置。

## 决策

- **`EntryGroup` 保留被移除 Fiber 的卸载直到它结束，`create` 等待同一 id 下的那次卸载**（`vendor/loader/src/config/group.ts`，`vendor/README.md` 中的本地修改 V30）。卸载结束时记录消失；被拒绝的卸载不会让重建的条目失败，因为 Core 已经记录过它。没有进行中卸载的 id 走上游路径，不多加任何 await。notification-http 的测试原样不动：一次刷新移除、下一次刷新恢复，正是操作者第二次保存会产生的序列，也是这一行为的回归测试。
- **`answeredRendererProbe(deadlineMs, attempt)` 重新发出探针，直到它得到回答或超过截止时间**（`apps/desktop/src/smoke.ts`）。`authenticatedApi` 给它三十秒，每次尝试仍是十秒上限，每次未获回答都连同主框架的加载状态记入日志，而对回答为 `false` 的仍然立即失败。回执的含义不变：已认证的 `session.list` 得到了回答，只是期限从十秒变成三十秒。
- **该 e2e 在截取前等待提示稳定**（`apps/web/tests/models-settings.e2e.ts`）。

## 考虑过的替代方案

- **让组合测试在恢复该行之前等待被移除的 Fiber** —— 否决：产品里的竞态仍然存在。在已部署的 profile 里，两次保存落在卸载窗口之内，就会让重建的条目一直失败到下一次配置变更，对所有在处置器里释放资源的插件都是如此。
- **让 `DomainFacility.open` 等待正在关闭的前任** —— 否决：`DomainFacility` 不是 Cordis `Service`，`open` 看不到调用它的 Fiber，只能等到 `Domain.close` 开始之后才能等——在该后端的处置器里，那已经在 shutdown 排空之后，也就是窗口的大半。而且它只服务于持有领域的插件，Loader 的改动则服务于每一个插件。
- **加长冒烟探针的单次上限** —— 否决：一次更长的等待并不比一次短的更能区分卡住的框架和坏掉的框架，而三十秒内反复重发的探针回答的是回执本来就问的那个问题。
- **让 `captureStableAria` 认识“尚未确认”这段文案并等待** —— 否决：那会让共享的 e2e 脚手架耦合到某个插件的本地化文案；稳定的读取应属于截取现场，就像 `waitForSettledModelTrigger` 已经为输入框的模型触发器所做的那样。

## 后果

- 在前一个实例的卸载窗口之内恢复的条目，要等那个实例释放它持有的东西之后才启动。恢复会等待卸载的全部时长，上限是各插件自己的 shutdown 预算；一个卸载永不结束的插件会占住它的 id，而上游的做法是让第二个实例在第一个旁边启动。
- `EntryTree.await()` 和 `loader.await()` 仍然看不到被移除条目的卸载：被移除的条目已不在树中。需要那次卸载本身的调用方去等待该 Fiber 的 `dispose()`。
- macOS 桌面冒烟在重启阶段的探针最长三十秒没有回答时仍能通过；超过这一点的失败会在作业的诊断输出里报出每一次未获回答的尝试以及主框架的加载状态，这正是此前六份日志缺少的证据。
- models-settings 的截取不再依赖环境凭据探测何时回答。

## 测试

- `scripts/cordis-loader-recreate.spec.ts`：一个条目的处置器在延迟后释放一个座位，按 Include 对账文件的方式，在一轮组对账中移除、下一轮恢复；序列是取用、释放、取用，重建的条目为 `ACTIVE`。在旧代码树上，第二个实例在座位仍被占用时被拒绝。
- `packages/notification/notification-http/tests/loader-composition.spec.ts`（未改动）：改动前在十二个忙循环的 CPU 负载下十二次运行失败两次，改动后十二次无失败。
- `apps/desktop/tests/smoke.spec.ts`：第三次尝试才得到回答的探针解析为该回答，被拒绝的回答立即返回；没有任何尝试回答的探针在三次尝试后于截止时间失败。
- `apps/web/tests/models-settings.e2e.ts`：加上这次等待后，十个场景的文件在本地回放中通过。

## 相关

同一窗口内另有四处一次性失败，原因未明、未作改动：`ptc-runtime-node/tests/runtime.spec.ts` 的“cancels a live program and closes its managed process with {}”（Windows 原生通道上 600 秒超时）、`ptc-runtime-node/tests/persistent.spec.ts` 的“terminates after unacknowledged abort in a loop after await and recreates empty state”（停止前写出的文本没有出现在输出里，Windows 原生通道）、`apiproxy/tests/client-handler.spec.ts` 的“stops consuming when the caller aborts”（macOS 信息通道上 5 秒超时），以及 `apps/web/tests/subagent-conversation.e2e.ts` 的“cold-resumes the original subagent while its ordinary fork stays active”（等待目录 30 秒）。它们在 CI 之外都没有复现；每一处都需要对应的平台才能诊断。

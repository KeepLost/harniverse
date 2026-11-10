# Agent Note: 会话配额默认无限；共享池预算转为显式选配

Status: implemented

[English](2026-11-10-per-session-quotas-default-unlimited.md) | 中文

## 问题

治理器的共享池内存预算（`limit: 'auto'` = 主机内存 80%）作用于所有未设显式配额的会话，而 rlimit 档在 Linux 上以 `prlimit --as=` 执行它——约束的是**虚拟地址空间**而非驻留内存。Chromium 系浏览器的 VAS 远超其 RSS（GPU 与沙箱映射），因此在普通会话内启动浏览器实例会在映射阶段以 ENOMEM 失败，哪怕主机内存空闲——默认预算挡住了 Chrome 启动，这是"没人要求的预算被强制执行"最具破坏性的症状。[治理器 Note](2026-09-12-resource-governor-metering-and-quotas.md) 当初把共享池设计为保护性默认；运营上 owner 要的是按会话显式选配的限制，配一个只呈现被限会话的仪表盘页面。

## 决策

- **全局预算默认 `none`。** `governor.memory.limit` 新增 `'none'` 并作为 schema 默认；`'auto'` 与显式字节数保留可选，供需要共享池的运维选回。按 pre-release 立场直接翻转默认，不带兼容垫层。
- **无限制意味着不执法，而非无限执法。** `resolveGlobalLimitBytes` 对 `'none'` 返回 `Infinity`；`QuotaBook.effectiveLimitBytes` 随之对池内会话报告 `Infinity`，各层自然下岗：`applyAddressSpaceLimit` 本就跳过非有限上界（无 `prlimit` 前缀——即 Chrome 修复），看门狗的全局越限永不触发，热采样判据恒冷，`limitsFor` 给 tool-bash 的边界集为空。
- **cgroup 父组解除上限。** 无限时 `ensureParent` 向 `memory.max`/`memory.swap.max` 写入内核 `max` 哨兵，曾带有限额的主机在重解析时移除旧限，而非残留。
- **准入失去天花板，但不失形状。** 无限预算下 `admit()` 如数授予（对 `Infinity` 取 `Math.min`）且永不钳制——显式配额成为纯隔离叶，跨会话自由组合。有限预算下已承诺之和的钳制逻辑不变。
- **wire 上永不出现 `Infinity`。** `SessionQuotaState.effectiveLimitBytes` 与 `GovernorOverview.globalLimitBytes` 为 `number | null`（null = 无限制）；`configGet` 同样映射；`governor/quota` 审计事件在变更前无限制时记录 `fromBytes: null`。模型侧 `resource-quota` 工具在无限制时省略 `effectiveLimitBytes`/`globalLimitBytes` 并渲染 "effective limit none, global budget none"。
- **仪表盘新增会话配额列表。** 第二个 `dashboard.center.tab`（id `quotas`）以侧栏行节奏只列出被设限的会话——状态点（warning/ongoing/done，来自会话流）、显示标题、配额值、带 90% 热臂的用量条、内联调整（MiB）与取消——配以基于 `useSessions` 的加限选择器覆盖无限制会话。无限制行按设计不出现在列表；本机资源页在 `none` 生效时把池内行标注 无限制 并隐藏预算条；设置页提供三态预算（无限制/自动/自定义）。

## 细节

- 被显式设限的会话在 rlimit 档下仍带 `prlimit --as=`（其显式配额），因此**被限会话内**启动浏览器实例仍可能失败（VAS vs RSS）。包 README 的 Known Limitations 记录了规避（调高或清除该会话配额）与暂缓的治本方案（配额会话优先 cgroup `memory.max`，RSS 语义——档位选择手术，现不动）。
- 配额列表的侧栏行解剖（16px 状态槽、14px 标题、12px 元信息）是 `ui-workspace` 行的视觉呼应而非共享组件——跨包符号导入仍被禁止。

## 备选方案

- 在 `limit` 之外加 `enabled: false` 总开关——否决：同一事实两种配置拼法；`'none'` 保持单字段。
- 保留池默认，在计量前缀里特判浏览器 spawn——否决：计量层无从知晓哪个 argv 是浏览器，把进程名豁免雕进执法档是错误的缝。
- 现在就做配额会话的 cgroup 优先执法——否决：档位选择是主机级探测而非会话级；暂缓使本次改动纯语义。

## 后果

- 默认部署失去整机兜底：无限制会话内的失控命令重新只受主机/容器上限约束。需要兜底的运维选回 `auto` 或显式预算——一次设置翻转，无迁移。
- 在普通会话内启动 Chromium 系浏览器恢复正常；在被限会话内仍可能失败（VAS vs RSS），已作为包的已知限制记录，cgroup 优先档暂缓。
- wire 上的配额行以 `number | null` 表达无限制——治理器 Remote 的每个未来消费方必须把 null 当作"无上界"而非零。

## 验证

- `packages/monitor/governor`：83 项单测（config `'none'`/auto/显式解析、无限制准入、cgroup `max` 解除、wire-null 映射、工具无限制输出、新默认下的 Loader 组合）。
- `packages/client/ui-governor`：43 项测试，逐文件覆盖 100%（配额列表、选择器、三态设置、null 预算资源页）。
- `pnpm run typecheck`、`pnpm run test:gui`（574 文件）、再生 `gen-api-catalog`/`gen-cordis-catalog` 产物。

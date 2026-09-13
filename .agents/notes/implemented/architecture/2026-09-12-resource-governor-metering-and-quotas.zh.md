# Agent Note: 资源治理器按执行域分层计量 shell 命令并仲裁共享池内存配额

Status: implemented

[English](2026-09-12-resource-governor-metering-and-quotas.md) | 中文

## Problem

会话的 shell 命令可以执行任意程序，agent 偶尔会跑出一个耗尽宿主内存、直到机器卡死的命令；今天唯一的兜底是容器的内存限额，而 harniverse 总有一天会裸跑在宿主机上，届时这层保护就消失了。代码库里没有任何地方记录过按命令的 CPU、内存、磁盘、网络占用：pid 诞生在 `SubprocessHandle` 上，到 shell 缝就被丢弃，从未与会话关联，因此观测与执法都缺锚点。看板功能要把会话当进程对待，需要这些数字；未来的 Rust VM 沙箱也必须能把按 VM 的指标接入同一套机器而不需要重新设计。

## Decision

- **计量挂在 spawn 缝上。** `SubprocessSpawnSpec` 增加可选的 `correlation {sessionId, commandId, kind}` 与 `limits {maxMemoryBytes}`；bash 工具从 `exec.agent.session` 打标，`LocalBashExecutor` 透传，`dsh-subprocess-local` 发出携带它的 `subprocess/spawned` / `subprocess/exited` 事件。只有打了标的 spawn 会被计量，LSP 服务器、subagent provider 和 ripgrep 默认豁免。
- **一次 `/proc` 遍历产出三种资源。** 单遍扫描 `/proc/*/stat` 按被计量 leader 的进程组（PTY 则按 POSIX 会话）分桶，只为桶内成员读 `statm`/`smaps_rollup`/`io`：CPU（utime+stime 差分）、内存（RSS/PSS/swap，cgroup 档可用时区分匿名页与文件缓存）、磁盘（内核 `read_bytes`/`write_bytes`，而非系统调用级 rchar/wchar）。网络是唯一真实增量：仅当桶内成员持有 socket fd 时才通过 `ss -tinp` 的 pid 匹配归因 TCP 字节与对端清单，宿主总量来自 `/proc/net/dev`，UDP 与包级精度明确不在范围内。采样只触及活着的被计量命令，节奏可配（默认 5s，接近限额时收紧到 1s），命令退出时补一次终读。
- **执法按探测到的能力分层，绝不依赖轮询。** C 档（cgroupfs 可写，不假设 systemd）：`dsh/` 父组 `memory.max`=全局预算，`dsh/<sessionId>/` 叶承载显式配额，内核异步执法——会话配额在结构上不可能穿透父组。R 档（cgroupfs 只读，今天的容器）：非 PTY 的 shell spawn 在 argv 前缀 `prlimit --as=`，采样看门狗按全局预算聚合 RSS，杀掉最大占用者并记录违约。O 档只观测告警。档位通过 `host.describe` 发布。
- **配额是带准入控制的共享池。** 全局内存预算默认为 min(MemTotal, 宿主自身 cgroup 上限) 的 80%，用户可在 `settings.yaml` 的 `governor:` 节配置；无显式配额的会话共享池（父组或看门狗保护），显式配额是隔离叶，准入检查拒绝或钳制提升使已承诺配额之和保持在全局预算内。覆盖值是持久的决定而非运行态：权威副本在 governor 自有的 storage-domain 表中，每次变更向会话日志追加 log-only 的 `governor/quota` 审计事件，resume 时覆盖值重新过准入闸（被钳制会告知 agent），`session/disposed` 与 TTL 清扫回收遗弃行。
- **`resource-quota` 工具让 agent 只能协商自己会话的配额。** 会话身份取自 `exec.agent.session`，绝不来自工具参数；降低随时允许，提升需过准入闸，且在 ask 审批策略下走既有 `user-approval` 缝（与 bash 沙箱升级同策略语义，`danger-full-access` 下不会死锁该工具）。全局预算对模型面不可达；人类通过 settings 或 administer 门控的 Remote 调整。
- **违约结果对模型可见，原始样本不可见。** 看门狗或 cgroup OOM 杀掉命令时，bash 工具结果 meta 携带 `governor: {killed, peakBytes, limitBytes}`（输出 schema 恰为此可选字段加宽），agent 得以自适应；样本流永不进入会话日志，因为那份日志是模型可见契约。历史持久化默认关闭，开启后按用户选择的分辨率与保留期写入 storage-domain 边车表。
- **看板与脚本走同一扇门。** 所有能力面都是 `governor` 命名空间上带 `harniverse.observe`/`operate`/`administer` 门控的 Typert Remote 方法——`overview`、`sessionSamples`、`sessionQuotaGet`/`sessionQuotaAdjust`、`breaches`、`configGet`、`reload`——web 看板轮询它们；网页能做的每件事构造上就是一次 HTTP API 调用。实时样本拉取而非推送：会话投影缝折叠事件，运行态样本不是事件，转发事件白名单保持为 sanctioned 的推送升级路径。
- **未来沙箱作为执行域接入。** 样本与配额类型传输中立并携带 `realmId`；限额随 spawn spec 传递，沙箱 provider 可以在 VM 内执法并按回传的 correlation 上报指标。VM 的物理预算就是它自己的全局——宿主预算不跨执行域。

## Bespoke

cgroup 档通过可注入的文件系统抽象操作；本开发容器 cgroupfs 只读，因此 C 档由 fake-fs 单测覆盖，裸机验证列入包 README 的 Known Limitations。`prlimit` 启动时探测，缺失时 R 档退化为仅看门狗。RLIMIT_AS 约束虚拟地址空间而非驻留内存——README 明示这一近似。

## Alternatives considered

- 只用每会话 cgroup 一条路——否决：在 cgroupfs 只读的容器和无委派的非 systemd 宿主上它会静默失效，而那正是当下宿主运行的地方；档位探测让 cgroup 成为最佳档而非隐蔽的单点故障。
- 靠高频采样执法（看门狗作唯一杀手）——否决：轮询式内存执法存在与采样成本成正比的延迟窗口；内核（cgroup OOM）零轮询成本异步执法，看门狗只作降级档兜底而非主力。
- 把样本记成会话事件以便重放——否决：会话日志里的一切对模型可见且必须能重构模型请求；资源流只会膨胀每个上下文而无模型价值。持久样本放边车域，opt-in。
- 经会话投影通道推送实时指标——放弃：投影是会话事件日志的折叠，制造伪事件来喂养它们会让节奏与持久化耦合；Remote 轮询与 5s 采样节奏匹配，转发事件白名单是 sanctioned 的推送升级。
- 用 `/proc/<pid>/net/dev` 归因网络——实测后否决：那些计数器是网络命名空间作用域的，所有进程数值相同，无法按命令归因；带 pid 匹配的 `ss` socket-diag 是足够准确的基线，eBPF 或按 VM netns 记账推迟到沙箱执行域成为结构性方案时。

## Consequences

- 失控命令死在预算边界上，工具结果里带着真实原因；看板像 `ps` 展示进程那样展示会话——每会话的 CPU、内存、磁盘、网络、配额与违约历史。
- R 档下每个被计量的 shell spawn 多付一次 prlimit exec 前缀；每 tick 遍历成本是每进程微秒级，空闲会话为零。
- 机器级保证不依赖 systemd 成立：cgroup 父组（C 档）或准入检查加看门狗（R 档）把总消耗保持在全局预算内。
- 未来的沙箱 provider 只要尊重 spawn spec 里的 correlation 并按共享样本 schema 上报，就获得了计量与配额执法；宿主侧无需重新设计。
- 已知限制：UDP 流量与子间隔短命 TCP 连接不可见；C 档在本环境的真实 cgroupfs 上未测；Windows 依赖未来的 Job Object provider；网络看门狗默认只告警不击杀。

## 交付跟进（2026-09-13）

- **`dsh-subprocess-local` 启动竞态修复。** 原先 `[Service.init]` 中的 prlimit 探测（约 140ms 真实 fs I/O）阻塞服务启动；由于 `dsh-tool-bash` 惰性读取 `ctx.shell`，其被推迟的 apply 输给了第一个组装的模型请求，于是把 bash 工具挂在 `dsh-subprocess-local` 之后的组合会在第一轮对话里丢失 bash 工具（ACP 快照通道复现）。探测现在从构造器 fire-and-forget 发起、绝不阻塞启动；`prlimitAvailable` 在落定前保持乐观值，测试的 `internals` 覆盖仍在 spawn 时优先。
- **计量 exit 配对不再依赖 spawn 结果。** `subprocess/spawned` 只为拿到 pid 的句柄发出，但配对的 `subprocess/exited`（携带空 exit 事实）现在也会为尚未拿到 pid 即失败的关联 spawn 发出——否则计量消费者会为从未启动的命令泄漏活跃集条目。终端孪生事件同形（node-pty 失败时同步抛出，存活终端句柄必有 pid）。
- **`resource-quota` 预设域挂载，而非服务域。** 工具从 governor 服务自身的注册迁移到独立加载的 `@deepseek-ai/dsh-governor/tool` Consumer 入口（`inject: governor, tools`），由出厂 `standard` 代理预设挂载；全局工具层按代理面架构保持为空，未挂 governor 服务的组合中该行无害地 pending。服务暴露 `admitExplicit`/`budgetLimitBytes`/`liveRssBytes` 作为工具的公共接缝。

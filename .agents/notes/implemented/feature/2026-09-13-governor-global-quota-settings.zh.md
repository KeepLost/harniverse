
# Agent Note: 治理器全局预算经既有 settings 作用域接入设置面板

Status: implemented

[English](2026-09-13-governor-global-quota-settings.md) | 中文

## Problem

治理器执法的全局配额只有一个——内存预算——而它仅有的人类入口是手改 `settings.yaml` 或 administer 门控的 `reload` Remote：两者都是宿主侧动作，站在 web GUI 面前的用户看不见。资源看板展示全局预算条，却有意不能移动它；看板写入是 `harniverse.operate` 的会话动作，而全局配置变更不是。 [治理器计量 note](../architecture/2026-09-12-resource-governor-metering-and-quotas.md) 把人类路径停在「settings 或 administer 门控的 Remote」；设置面板这一交付面就是缺口。

## Decision

### 一个 settings section，而非看板控件

ui-governor 注册 `settings.section` id `governor`（排在 Plugins 页之后——运行时治理随宿主配置而来）。该页只编辑全局内存预算：`auto` 或自定义 GiB 数值。CPU、磁盘、网络按设计仅观测，不设控件；采样节奏与历史持久化保持 `governor:` 的普通 settings 字段，不在此设专属 UI。

### 写入走客户端 settings 作用域；解析权留在宿主

页面绑定 `ctx.settingsScope.bind({ namespace: 'governor' })`；一次应用即一条 `memory.limit` 的 `set` 操作经 `settings.mutate` 落盘，由设置域的 `harniverse.administer` 门与版本检查授权，无该能力的身份得到只读或不可用文案，而非禁用的假象。宿主侧不新增写路径：governor 服务既有的 `installSettingsSection` 钩子在变更时热重解析并重应用预算（`applyGlobalLimit`——先父组后叶组），无需重启。表单旁的生效预算经 `configGet` 回读，因为解析是宿主事实——`auto` 即物理内存与宿主自身 cgroup 上限中较小者的 80%，宿主事实不可读时落到兜底预算——页面在应用后立即并再于 600 ms 后各读一次，覆盖异步应用。任何预算算术都不在客户端计算。

### 会话配额与 swap 原地不动

会话级配额默认继承全局预算，始终是按会话的决定——agent 的 `resource-quota` 工具或看板内联协商——不设 preset 字段：配额是准入闸下的运行态决定，绑定单个会话的生命期，不是组合期配置。cgroup 档将 `memory.swap.max` 钉在 0；rlimit 档不做交换限制。

## Alternatives considered

- **看板上的预算编辑器，紧邻预算条**——否决：看板写入是 `harniverse.operate` 的会话动作，预算是持久的宿主配置；operate 门控的座位后藏 administer 级全局写入，是把错误的能力放在错误的座位后。
- **为 governor 新增专用 Remote 写动词**——否决：设置域已经拥有持久配置写入（`settings.mutate`，administer 门控、版本检查、镜像与脱敏）；第二条写路径会绕过设置镜像的 principal-generation 栅栏。已随看板档位展示交付的 `configGet` 覆盖读侧。
- **页面写完 settings 后调 `reload`**——否决：`installSettingsSection` 的 onChange 已热重应用预算；`reload` 保持为 `settings.yaml` 带外编辑的手动逃生口。
- **把会话配额字段并入 agent preset**——否决：preset 拥有的是会话被组合出哪些能力，而非它可用多少内存；配额提升要过活全局预算的准入闸，静态 preset 承诺不了。

## Consequences

- 持有 `harniverse.administer` 的用户可以在 web GUI 上移动唯一执法的全局配额；写入落入 `settings.yaml` 的 `governor:` 节，无需重启即生效。
- 能力划分与每个面执行的写入对齐：看板保持 operate 门控、会话作用域；设置页 administer 门控、全局。
- 页面只展示宿主解析出的真相（`configGet`）；客户端预算算术无从偏离宿主解析。
- 上文治理器计量 note 保持活跃并互链；本 note 扩展其人类面叙事，不改变其档位模型。
- 包内 spec 覆盖设置页（作用域驱动的模式与草稿、经作用域的显式预算与回归 `auto` 写入、非正数拒绝、只读与不可用臂、生效值读取失败臂）与浏览器半的注册集（inject 清单、`settings.section` 条目与拆卸、`configGet` 绑定）。

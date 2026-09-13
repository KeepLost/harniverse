# @deepseek-ai/dsh-governor

[English](README.md) | 中文

资源治理器（`ctx.governor`）：对带关联标识的 shell 与终端 spawn 做按命令的 CPU/内存/磁盘/轻量网络计量、分层的内存执法，以及共享池的会话内存配额。设计决策由[资源治理 Agent Note](../../../.agents/notes/implemented/architecture/2026-09-12-resource-governor-metering-and-quotas.md) 持有。

## 计量模型

只有携带 correlation 的 spawn 会被计量（bash 工具为每次调用打上会话与调用 id；PTY 后端为其终端会话打标）——LSP 服务器、subagent provider 与内部辅助进程默认豁免。每个采样 tick 一次 `/proc` 遍历，按被计量 leader 的进程组（shell spawn 是 detached 的，pgid == leader pid）或 POSIX 会话（终端）分桶，再为成员读取 `statm`/`smaps_rollup`/`io`：CPU（utime+stime 差分）、内存（RSS/PSS/swap）、磁盘（内核 `read_bytes`/`write_bytes`，而非系统调用级 rchar/wchar）。TCP 字节与对端清单仅在树内成员持有 socket fd 时经 `ss -tinp` 的 pid 匹配归因；宿主总量来自 `/proc/net/dev`。采样只触及活着的被计量命令（空闲会话零成本），节奏可配（基线默认 5s，超过预算 70% 时收紧到 1s）。UDP 流量与子间隔短命 TCP 连接不在范围内。

## 执法档位

档位在启动时探测一次，通过 `host.describe` 与 Remote overview 发布：

| 档位 | 条件 | 机制 |
|---|---|---|
| `cgroup` | cgroupfs 可写（不假设 systemd） | `dsh/` 父组 `memory.max` = 全局预算，`dsh/<sessionId>/` 叶承载显式配额；内核异步执法，会话配额在结构上无法穿透父组。 |
| `rlimit` | cgroupfs 只读（今天的容器） | 非 PTY 的 shell spawn 在 argv 前缀 `prlimit --as=`（驻留内存的地址空间近似），采样看门狗按预算聚合 RSS，持续超限后杀最大占用者。 |
| `observe` | 非 Linux 或工具缺失 | 仅观测与告警。 |

被杀命令会在 bash 工具结果 meta 中报告原因（`governor: {killed, peakBytes, limitBytes}`）供模型自适应；原始样本绝不进入会话日志。违约同时经宿主 `governor/breach` 事件与看板呈现。

## 配额

全局内存预算默认为 min(MemTotal, 宿主自身 cgroup 上限) 的 80%，用户可在 `settings.yaml` 的 `governor:` 节配置。无显式配额的会话共享池；显式配额是隔离叶，其已承诺之和必须保持在全局预算内（准入钳制或拒绝提升）。`resource-quota` 模型工具只能协商自己会话的配额——提升需过准入闸，且在 `ask` 审批策略下需一次批准；`never`（danger-full-access）姿态直接放行。覆盖值是持久的决定：权威副本在 governor 的 `quota_overrides` storage-domain 表中，每次变更追加 log-only 的 `governor/quota` 审计事件，重启按先到顺序重放过准入闸（被钳制会告知 agent），会话显式关闭删行，TTL 清扫回收遗弃行。

## Remote 面

`governor` Typert Remote 命名空间（带能力门控）是脚本与 Web UI 的同一扇门：`overview`、`sessionSamples`、`sessionQuotaGet`、`breaches`、`configGet`（`harniverse.observe`），`sessionQuotaAdjust`（`harniverse.operate`），`reload`（`harniverse.administer`）。看板按采样节奏轮询 `overview`；有意不使用会话投影缝（运行态样本不是会话事件——转发事件白名单保留为推送升级路径）。

## 配置

```yaml
governor:
  memory:
    limit: auto        # auto = 80% of min(MemTotal, own cgroup max); or bytes
  sampling:
    baseMs: 5000
    hotMs: 1000
  history:
    persist: false     # opt-in sample persistence
    resolutionMs: 5000
    retentionMs: 604800000
```

通过独立加载的 `@deepseek-ai/dsh-governor/tool` Consumer 入口挂载（`inject: governor, tools`）：由预设组合逐代理决定配额协商是否对模型可见，服务本身留在宿主平面。出厂 Web 名册在 `standard` 预设中挂载它；未挂 governor 服务的组合中该行无害地保持 pending。

## Model Experience

### resource-quota 工具

#### 模型看到什么

`resource-quota` 的 `action: get` 返回会话的有效限额、全局预算与当前用量；`action: set` 带 `memoryBytes` 请求新的显式配额（提升须超过 64MiB 且可能需要用户批准），不带 `memoryBytes` 的 `set` 重回共享池。违约击杀在 bash 结果中以 `[killed by memory-limit (peak 6.5GiB > limit 6.4GiB)]` 呈现。

#### Token 影响

工具 schema 为列出工具的每个请求增加少量固定成本；结果是单行状态。

#### KV 缓存影响

配额状态绝不注入系统上下文；稳定会话不扰动缓存。

## Known Limitations and Deferred Work

- C 档（cgroup）通过可注入的文件系统抽象操作并由 fake-fs 单测覆盖；本开发容器 cgroupfs 只读，裸机验证是手工步骤。
- RLIMIT_AS 约束虚拟地址空间而非驻留内存——过度预留地址空间的运行时可能提前触发 R 档前缀，聚合由看门狗兜底。
- 网络归因仅覆盖 TCP（UDP、QUIC 与采样间隔内关闭的连接不可见）；网络看门狗默认只告警绝不击杀。
- 磁盘哨兵只观测一个文件系统路径（宿主工作目录），不按命令工作目录区分。
- 沙箱执行域接入是契约性的：未来的 VM provider 尊重 spawn spec 中的 correlation 并按共享样本 schema 上报；宿主侧计量不跨执行域。

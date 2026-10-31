# Agent Note: Remote execution-world trust hardening

Status: implemented

[English](2026-10-31-remote-world-trust-hardening.md) | 中文

## Problem

SSH 家族的边界假设远端机器是可信的。在这个假设下，一大批主机侧代码把"执行世界"当作"本机"对待：browser controller 连接子进程在 stderr 上打印的任意 DevTools 地址；shell 执行器、搜索工具与沙箱策略解析器在请求不带目录时静默回退到主机的 `process.cwd()`；PTC 运行时无视由哪个世界决定 argv，一律用 `node:child_process` 在宿主上派生子进程；机器清单的工具与技能名字不加任何格式约束就注册进主机注册表；工作台检查面以及附件上传、会话导入路由，即便会话——或浏览器页面本身——属于另一台机器，仍然服务主机路径与主机存储。这些行为要么在宿主机上执行错误世界的决定，要么让不可信对端操纵主机侧连接，要么把一个世界的文件静默当作另一个世界的展示。不可信沙箱调查（2026-10）把它们列为任何沙箱预设的准入阻塞项。

## Decision

subprocess seam 上的一个世界事实，加上失败关闭的消费方。

- `SubprocessRuntime.locality` 在基类上为 `'local'`，在 `SshSubprocessRuntime` 上为 `'remote'`——与 `FileSystem.sandboxMode` 相同的能力事实形状。主机路径消费方读取它并拒绝执行，而不是把主机路径套用到远端世界上。
- `bash-local` 与 `pwsh-local` 的 `resolve()` 仅在本地世界里用配置或 `process.cwd()` 补全 `workdir`；远端世界里缺少请求 workdir 直接失败。搜索工具在没有会话 cwd 时以 `SEARCH_FAILED` 失败，`sandbox-policy` 拒绝解析主机回退根目录，理由相同。
- 两个 PTC 运行时在挂载世界为远端时，于任何子进程出现前失败关闭：为另一个世界决定的 argv 不得在宿主机上执行。世界内执行等待 substrate 工作。
- 工作区检查（`workspaceFiles.*`、`workspaceGit.*`，含监听流）以 `workspace-world-remote` 应答，而不是把主机路径当作远端会话的文件渲染。
- browser controller 自己预留 DevTools 回环端口，以 `--remote-debugging-port` 传入，且只接受恰好指向该端口与回环地址的打印端点；其他端点行一律使启动失败。
- 机器清单名字——MCP 服务器名、工具名、技能名以及取回的技能定义——在 `machineInventorySchema` 解析边界被约束为 1–64 个标识符字符，工具名另外永不为 `run_code`。
- 附件上传与会话导入两个 exact 路由像其他所有 `/api` 调用一样遵守 `dshRemoteHost`：本地认证后，经 SSH 协调器把字节流转发到所选机器；目标格式非法以 400 应答、协调器路由缺失以 503 应答，绝不在本地 Host 上落盘。这关闭了与 connection README 既载路由契约相悖的缺陷。

## Alternatives considered

- **现在就把 PTC 运行时重写到 `ctx.subprocess` 上。** 控制通道传输假设宿主侧双工流，而远端拉取读是另一种形状；使世界内 PTC 有意义的按会话世界键仍是未决设计。失败关闭今天就交付安全性质（另一个世界的 argv 不在宿主机执行），代价是远端组合中 PTC 不可用，直到该 substrate 工作落地。
- **命名空间化远端工具名（`server__tool`）而非字符集校验。** 加前缀会改变 ssh 家族所有模型可见名字及其快照，而更深层的跨层遮蔽向量无论如何需要世界键。有界标识符形状加 `run_code` 保留名移除了格式类向量（伪造拼写、控制字符、灌水）而不改任何名字；同拼写的本地名字遮蔽仍是记录在案的缺口，直到世界键出现。
- **让上传走 RPC 载体而非 exact 路由转发。** 载体路径会缓冲请求体；exact 路由的存在意义就是按字节上限流式处理。本地信任围栏之后转发保留了流式主体与本地认证，并以与 RPC 代理完全相同的方式剥离 hop-by-hop 凭据。
- **现在就引入按会话世界信号。** 在这里决定世界键契约会抢先于待定的传输中立连接设计。进程级 `locality` 是诚实的 v0：所有已发行组合都是单世界的，且这些拒绝点消费的事实与未来按会话键将发布的事实相同。

## Consequences

远端世界组合现在会在过去静默做错世界工作的每个点上大声失败：错误目录的搜索、主机根目录的约束、宿主派生的 PTC 子进程、主机路径的工作台视图、以及远端目标页面的主机存储上传。本地行为不变——每个守卫读到 `'local'` 即让路——而 (B) remote-host 产品获得了其文档早已宣称的上传/导入路由。远端完整性事实（helper 哈希、描述符摘要）仍是自报的，并已在 [ssh.md](../../../docs/subsystems/ssh.md) 中如实记载：它们检测传输损坏，检测不了说谎的对端。随本记录一并暂缓：世界内 PTC 执行、远端感知的工作台视图、按会话世界键。

## Testing

各包测试套件钉住每个拒绝点：`packages/api/browser-controller/tests/controller.spec.ts`（端点钉扎与伪造拒绝）、`packages/shell/bash-local` 与 `packages/shell/pwsh-local` 执行器测试（workdir 世界）、`packages/fs/tool-fs-search/tests/tools.spec.ts`（搜索 workdir 拒绝）、`packages/sandbox/sandbox-policy/tests/policy.spec.ts`（回退根拒绝）、两个 PTC 运行时测试（失败关闭）、`packages/ssh/ssh/tests/world.spec.ts`（清单名字约束）、`packages/host/apiproxy/tests/api-proxy-workspace.spec.ts`（`workspace-world-remote`）、以及 `packages/client/connection` 附件/导入路由测试（`dshRemoteHost` 转发与 400/503 拒绝）。

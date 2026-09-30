# Agent Note: SSH 管理远程主机的浏览器目标

Status: implemented

[English](2026-09-27-remote-host-browser-target.md) | 中文

## Problem

本地主机协调器已经能够部署、认证、同步并保持远程 Harniverse 进程运行，但浏览器连接层原先只有一个隐含的本地主机目标。这样，已连接的 SSH 记录无法打开远程 workspace 或传递远程 Session 事件，同时也不能暴露远端 Access Token 或转移本地管理权威。

## Decision

远程主机视图通过 `connection.switchTarget({ kind: 'remote', id })` 在同一文档内切换当前页面的机器（该机制见[同页机器目标 Agent Note](2026-09-30-same-page-machine-targets-and-settings-materialization.md)）；`dshRemoteHost=<RemoteHostId>` 仍作为载体路由参数。现有 Connection 载体会把该目标加入普通 `/api` 请求、上传以及 `events.mux`/`events.host` WebSocket。`remoteHosts`、`settings` 和 `credentials` 保持走本机，使原始页面继续负责管理和同步。

Host Connection 层先在本地认证浏览器，再根据生成的 Typert policy 或 legacy API capability map 解析目标 endpoint；未知或未授权目标在转发前拒绝。SSH 协调器移除本地浏览器凭据，使用每台主机的 Grant 认证上游请求，通过已有的远端回环 transport 转发，并把 JSON 载体身份改写为本地浏览器 generation 身份。远端事件 socket 使用相同的本地准入桥接，浏览器不会接触远端 token。关闭页面不会释放 SSH 协调器或远程进程；断开协调器会结束浏览器 generation，之后重新连接时由持久游标重连路径恢复。

模型和搜索设置仍由本地负责：协调器在 connect 时同步完整的已解析设置，远程页面执行由此得到配置的 API 与 Agent 操作。明确配置的反向映射会在同步期间把匹配的模型/搜索来源改写到已分配的远端回环端口；反向映射不会从浏览器目标推导。

## Alternatives considered

- 直接把 SSH 本地 forward 端口暴露给浏览器：拒绝，因为浏览器需要处理远端 Access Token，并在认证 Host 之外增加第二条信任边界。
- 原地替换本地页面的全局 Connection 实例：拒绝，因为本地管理会静默跟随远程 workspace，且本地与远程 Session 身份可能冲突。
- 把 `remoteHosts` 管理调用发送到目标主机：拒绝，因为主机生命周期、凭据、设置权威和重连所有权属于原始本地协调器。
- 新建第二套浏览器 runtime 包：拒绝，因为现有 Connection、Typert、Session、Workspace 和 WebSocket 载体已经提供所需的生命周期及持久游标行为。

## Consequences

管理页面经 `api-remotes` Client 组合挂载的 `remoteHosts` 贡献访问协调器；缺少该挂载时，`ui-remote-hosts` 插件会一直等待 `remote.remoteHosts`，不注册侧边栏入口。删除主机导出为 `remoteHosts/removeHost`，因为 Gateway 命名空间 Service 自身以 `remove` 作为卸载路径；本地 Service 方法仍为 `remove`。浏览器路径解析器与 Host proxy 解析器都在第一个 `/` 或 `.` 处截取命名空间，因此 Typert 形式的 `settings/...` 端点与旧版 `settings.describe`、`credentials.set` 方法同样留在本机。

远程机器是按主机确定的浏览器目标，在同一文档内通过按机器命名的 store 与选中命名空间隔离 runtime 持久化（该机制由上面链接的 Note 持有）。远程目标要求本地协调器保持连接，不自行重连 SSH。Host proxy 必须保留本地 capability 检查和身份元数据，远程协调器仍是上游 token 与 socket 生命周期的唯一所有者。原生 SSH 部署及 Linux/macOS/Windows 的完整验证仍属于浏览器载体测试之外的工作。

定向测试覆盖远程目标 URL 路由、本地管理排除、目标 HTTP proxy 授权与身份处理、Remote 失败渲染、临时凭据提交、已连接主机打开入口、反向来源同步、既有载体套件和远端 artifact 生命周期 smoke。完整浏览器重连和真实 SSH 主机验证仍需要配置好的 Linux 测试主机。

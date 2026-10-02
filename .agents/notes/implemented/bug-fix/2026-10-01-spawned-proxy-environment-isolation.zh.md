# Agent Note: 派生子进程不再携带派生代理环境

Status: implemented

[English](2026-10-01-spawned-proxy-environment-isolation.md) | 中文

## Problem

`dsh-http-proxy` 会把解析出的策略回写进 `process.env`（两种大小写），`dsh-subprocess` 又在隔离子进程基底上叠加一层派生值（`NODE_USE_ENV_PROXY`、与回环条目强制合并的旁路名单）。于是同一份 `NO_PROXY` 被两类互不兼容的消费者共享：Node 的 `undici` 匹配器只认带方括号的 `[::1]`，而 Python 的 `httpx`/`requests` 与 `curl` 把每条旁路项按 URL 主机解析，遇到带括号形式直接崩溃（`httpx` 在构造客户端时报 `InvalidURL: Invalid port ':1]'`），Agent 下所有 Python SDK 工具随之不可用。除崩溃之外，沙箱内的命令还继承了用户从未指定给它们的路由。

## Decision

策略对象只存在于 dispatcher；环境永不被规范化。

- `installGlobalProxy` 不再改写 `process.env` —— install/dispose 只交换 dispatcher 符号与当前策略，别无其它。复制 `process.env` 的子进程由此逐字收到用户自己的拼写。
- 删除 `proxyEnvironmentForChild()`；`scrubbedParentEnv()` 现在移除两种大小写的全部代理变量名（`clearedProxyEnv()`），因此隔离基底——read-only 与 workspace-write 命令、LSP/MCP/子代理子进程以及浏览器控制器背后的环境——与用户路由彻底隔离。
- 完全信任基底（`ambientEnv: 'full'`，由 bash/pwsh 在 `danger-full-access` 下、以及用户终端设置）复制 harness 的 `process.env`，即 harness 启动时收到的东西：用户自己的变量，没有任何派生值、没有添加的括号。`web_search`/`web_fetch` 与提供方流量经已安装的 dispatcher 在进程内路由，不受影响。

## Alternatives considered

- **按消费者区分有无括号的双拼写** —— 否决：为一个事实维护两种环境方言，恰恰是催生此 bug 的分歧根源；裸 IPv6 字面量不存在 `undici` 与 Python 都接受的拼写，任何共享值对其中一方永远是错的。
- **保留叠加层但去掉括号** —— 否决：`undici` 自己的匹配器会把裸 `::1` 误读为主机 `:`、端口 `1`；合并名单只为读环境的消费者存在，而 Python/curl 解析不了它。

## Consequences

沙箱（read-only/workspace-write）命令与 harness 内部子进程现在无论用户代理如何都直连；要给某个子进程路由的调用方通过 `spec.env` 显式传入——它仍在清除之后合并。完全访问命令与用户终端逐字保留用户自己导出的环境——包括本包拒绝的值（SOCKS 代理继续留给 `curl`）。回放路径经由同一个 `clearedProxyEnv()` 保持直连夹具的行为。harness 不再在任何地方设置 `NODE_USE_ENV_PROXY`。

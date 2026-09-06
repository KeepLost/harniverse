# dsh-http-proxy

[English](README.md) | 中文

Harness 的**进程级出站代理策略**：从启动环境（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`，任意大小写）解析出唯一一份策略，安装到 Node 全局 `fetch` 所解析的 dispatcher 符号之后，并向其余所有表面——子进程、web-fetch 传输——给出同一个路由答案。

Node 内置的 `fetch` 自身忽略代理环境变量，因此无论用户导出什么，每个 harness 请求都会直连。一次安装即可覆盖 LLM 适配器、web 搜索以及任何普通的 `fetch()` 调用者，而无需改动它们的代码：启动器（`dsh` profile boot）在第一个插件挂载之前完成解析与安装，且从启动环境快照而非 `process.env` 解析——这正是让声明在 `.env` 层中的代理得以生效的原因；`NODE_USE_ENV_PROXY` 做不到这一点，因为 Node 在进程启动时就采样了环境。

这是一个**库而非插件**：传输策略在进程内只有一个答案，没有可供组合挂载、替换或作用域化的东西。Harniverse 以**原生方式**承载它——不依赖 `undici`：安装的 dispatcher 讲的就是全局 `fetch` 已经在使用的分发契约，且所有代理跳都经由唯一的共享隧道构建器。

## API

```ts
import {
  clearedProxyEnv,
  installProxyFromEnvironment,
  proxyEnvironmentForChild,
  proxyRouteFor,
  requestViaProxy,
} from '@deepseek-ai/dsh-http-proxy'
```

| 导出 | 职责 |
|---|---|
| `installProxyFromEnvironment(env, report)` | 从启动环境解析策略、上报每一个被拒绝的值，并安装到全局 fetch 的 dispatcher 之后。返回恢复先前 dispatcher、策略与环境的处置函数。 |
| `proxyRouteFor(url)` | 单个请求应如何发送，从当前策略的一次读取作答：`{ proxied: true, proxy }` 或 `{ proxied: false }`。 |
| `requestViaProxy(proxyUrl, url, options)` | 唯一的共享代理跳：`http:` 目标用绝对形式请求，`https:` 目标走 `CONNECT` + TLS。返回最终响应与可中止整跳的句柄。 |
| `proxyEnvironmentForChild()` | 子进程所需的叠加层：已解析的代理变量名加上 `NODE_USE_ENV_PROXY`，并恢复用户手写的值，使 `curl` 保住本包拒绝的 SOCKS 代理。 |
| `clearedProxyEnv()` | 每个代理变量名一条 `undefined` 记录，供必须直连自身夹具服务器的回放使用。 |

## 策略语义

- **解析顺序**：scheme 自身的变量优先，然后是 `ALL_PROXY`，最后——仅对 HTTPS——回退到 HTTP 代理。被拒绝的槽位（非法 URL、SOCKS、不支持的协议）让该 scheme 保持直连；诊断与路由保持一致，任何回退都不会把请求发往用户从未指定的位置。
- **诊断不携带值**：代理 URL 可能内嵌 `user:password`，因此消息只点名变量。
- **回环永不走代理**（`localhost`、`127.0.0.0/8`、`::1`、IPv4 映射形式），且每份旁路名单都会并入这些条目。
- **`NO_PROXY` 匹配**：逗号/空白分隔；条目匹配主机及其全部子域；可选的 `:port` 必须等于有效端口；`*` 旁路一切；不匹配 CIDR。
- **未导出任何代理**：不安装任何东西、不触碰任何环境变量名——全局 `fetch` 逐字节保持 Node 内部默认传输。

## 消费者

- `dsh` profile boot 在启动时安装策略，并在关机时处置。
- `dsh-web-fetch-http` 咨询 `proxyRouteFor` 并让代理 URL 走 `requestViaProxy`（不做本地 DNS 固定——由代理解析）；回环与旁路 URL 保持固定的直连传输。
- `dsh-subprocess` 在 `scrubbedParentEnv()` 中叠加 `proxyEnvironmentForChild()`，使子 Node 进程继承父进程的路由。
- LLM 适配器（`dsh-llm-pi-ai`，discovery 与 provider 流）无需改动：其 `fetch()` 调用经由已安装的 dispatcher 解析。

## Model Experience

仅间接地通过出站路由产生影响：代理改变的是模型请求的网络路径，从不改变其模型可见词汇。

#### KV Cache effect

无；路由变化不携带请求前缀变化。

## Known Limitations and Deferred Work

- **无连接池**——每个代理跳自开 socket（按请求建隧道；`agent: false`）；在未替换任何 dispatcher 时，活跃策略下未代理的直连 URL 同样按请求开 socket。未安装策略时，Node 内部默认传输保持其连接池。
- **隧道仅 HTTP/1.1**——CONNECT 臂不协商 ALPN，因此要求 HTTP/2 多路复用的源站暂无法走代理。
- **代理路由上的升级请求会被拒绝**——WebSocket 式升级不会来自 `fetch`；为其建隧道需要专门的协议处理。
- **不服务 worker 线程**——worker 拥有各自的 `globalThis` 与 dispatcher；在此安装无法触达，且模型脚本的运行时不得接收可能携带凭据的代理 URL。

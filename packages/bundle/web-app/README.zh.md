# `@deepseek-ai/dsh-web-app`

[English](README.md) | 中文

dsh 浏览器表层组合包。[`cordis.patch.yml`](cordis.patch.yml) 叠加在 [`dsh-base`](../base/README.md) 之上，插入带认证的 Web 宿主行和浏览器插件名录、向操作员显示运行时 warning 与 error 的 Cordis 控制台 logger、始终挂载的客户端插件重载链（[`dsh-client-hmr`](../../client/hmr/README.md)）、每个 Web 组合都挂载的 [`dsh-harness-source`](../../context/harness-source/README.md) checkout 根路径上下文，以及本包的 `web-runtime` 粘合插件。该粘合插件解析已构建的前端 dist，只采样一次依赖 bind 的 LAN 信任信息并提供给请求信任栅栏和客户端名录，挂载 [`frontend-static`](../../host/frontend-static/README.md) fallback 所有者并把 `/auth/manage` 声明为显式 pathname 入口，在 `surfaceContext` 为 true 时注册 Web 表层动态上下文及 `DSH_WEB_URL`，并在 Loader 树结算后打印实际 HTTP 或 HTTPS URL。缺失资产与未声明 pathname 返回 404，而非浏览器壳。普通 `web-startup` 提供方（[`src/startup.ts`](src/startup.ts)）解析 `--host`、`--port`、可重复的 `--trusted-host`、成对的 `--tls-cert`／`--tls-key`、`--dangerously-skip-authentication` 与 `--help`，并在任何 listener 绑定前提供 `webStartup`。显式 `0.0.0.0` host 必须带 TLS 参数对，connection 插件会拒绝任何非回环 listener 上的认证 bypass。成功认证活动仍保留在 owner-only `$DSH_HOME/auth/access.jsonl` 审计中，不会重复输出到终端。[`dsh-headless`](../headless/README.md) 是同一 base 之上的同级表层，不挂载本组合包。

## 模型体验

### Harness 源码与 Web 表层上下文

#### 模型看到的内容

`harness:source` 上下文（由 [`dsh-harness-source`](../../context/harness-source/README.md) 插件持有，顺序 −99，不受 `surfaceContext` 影响，每个 Web 组合都挂载）标明磁盘上的 Harniverse 实现 checkout，并指示模型用 `pwd` 获取工作目录；DSH 关系与第三方声明由固定的 harness 身份开头持有。当 `surfaceContext` 为 true 时，动态上下文 `app:web-surface`（顺序 −98，紧随 checkout 根路径之后）向模型说明 Harniverse Web GUI：规范的本地 URL、「this page」指代什么、更新约定（重载接收端始终开启；无刷新重载还需要 `pnpm run dev:web` watcher），以及不要启动替代服务器的指令。两者会通过 `dsh-system-prompt` 的 runtime 快照进入，而不是静态系统提示词。`DSH_WEB_URL` 还会连同描述出现在受管 bash 环境中，每次调用时从运行中的服务器解析。当它为 false 时，Web 表层上下文与该变量不会注册，而 checkout 根路径上下文保留。

#### Token 影响

每个会话一段 checkout 根路径说明和一段 Web 表层提示词，外加两行受管环境变量；每个进程内保持恒定。

#### KV Cache 影响

该上下文通过正常 runtime 快照路径刷新；端口虽然是启动期事实，但将这些 session 专属内容移出静态提示词，可以让静态请求前缀只保留稳定指导。

## 已知限制与延期工作

- **前端 dist 必须已构建**：对 dist 的 `require.resolve` 在激活时明确报错并给出构建提示；没有从源码直接服务的回退路径。
- **`lanAddresses` 是启动期快照**：启动后的网卡变化不会重新公告；打印的 LAN URL 始终与配置的信任栅栏一致。

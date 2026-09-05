# Agent Note: 吸收批次 3——出站代理全链路、client store 抽取

Status: implemented

[English](2026-09-06-absorb-batch-3-proxy-and-store.md) | 中文

## 问题

又有两个获批 Absorb-soon 项与一项能力。Harniverse 静默忽略 `HTTP(S)_PROXY`/`ALL_PROXY`/`NO_PROXY`：web-fetch 传输总是自行解析 DNS 并直连、提供方 `fetch` 走 Node 默认 dispatcher、派生的子进程什么也继承不到——对代理后自托管部署是关键缺口。客户端 store 引擎（每个动态 client bundle 背后的 zustand/Immer 快照存储）藏在 `client/runtime` 内，约 60 个 rider 文件经 runtime 门面导入，阻塞了官方分解追求的客户端边界对齐。JSONL 跨进程写租约已单独成文（[跨进程会话写租约](../feature/2026-09-06-cross-process-session-write-lease.md)），此处不再重复。

## 决策

按所有者的全链路决策：一份策略、三处消费。新 `dsh-http-proxy` 库从启动环境快照解析唯一代理策略（大小写不敏感、小写优先、空白视同未设；仅接受 `http(s):` 代理 URL——SOCKS 与非法 URL 报诊断并保持直连；HTTPS 回退链 自身 → `ALL_PROXY` → `HTTP_PROXY`；`NO_PROXY` 与回环合并、后缀匹配可选端口；回环永不代理）。安装即以原生手写 dispatcher 替换全局 `fetch` 解析的符号（`Symbol.for('undici.globalDispatcher.1')`）——不依赖 `undici`——每个请求经同一 `proxyForUrl` 分类：被代理 URL 经共享 hop 构建器走绝对形式（http）或 CONNECT+TLS（https）隧道；直连 URL 委托给被替换的 dispatcher，没有则走每请求直连传输。Profile boot 在首个插件挂载前安装、关机恢复一切。web-fetch 传输把被代理 URL 经共享隧道发送（不做本地 DNS 固定），被豁免 URL 保持逐字节不变的固定直连传输；`dsh-subprocess` 在 `scrubbedParentEnv` 中叠加解析后的子进程代理环境（恢复用户拼写、补 `NODE_USE_ENV_PROXY`）；`dsh-llm-pi-ai` 经全局 `fetch` 覆盖，出站规格经假回环代理验证。store 引擎原样迁入 `packages/client/store`（`dsh-client-store`）：引擎文件、其 14+1 个契约类型（来自 `ui-slots`，后者成为纯 re-export 垫片）及其测试文件；runtime 再导出引擎值，约 60 个 rider 导入方零改动。两个实现发现由 Node 语义强制并有证据修复：隧道内层请求不得设 `agent: false`（Node 会自建连接并忽略隧道 socket），且必须以明文 HTTP 在已建立的 TLS socket 上表达（`https.request` 会对源主机名重跑 agent DNS）。

## 考虑过的替代方案

**引入 `undici` 依赖用 `EnvHttpProxyAgent`。** 否决：Node 不捆绑可导入的 undici，其读取的符号契约在 Node 22/24 间稳定，所需隧道语义（逐请求分类、委托透传、带背压的 CONNECT）一个手写 dispatcher 即可——经真实假代理服务器验证，含基于已提交自签 fixture 的成功 CONNECT 隧道。

**以改写值的方式向子进程传播代理变量。** 与官方一致否决：子进程的其它工具（`curl`）必须保留用户自己的拼写；overlay 按名恢复用户所写、只补用户未设之名，Node 无法解析的值扣发 `NODE_USE_ENV_PROXY`。

**把 store 抽取并入更大的客户端分解。** 按所有者决策暂缓否决：纯机械迁移即刻落地（零行为变化、同一测试文件、前后 17/17），边界对齐后续在其上继续。

## 结果

代理部署的每个出站 hop——工具 fetch、提供方发现与流、遵循环境的子进程——都经一份策略与一个隧道实现路由；未设环境的行为与之前逐字节一致（断言：不动 dispatcher、不写环境）。客户端包从此可以不经 runtime 门面依赖 store 引擎，解锁 `TODO(webload/store-rehome)` 的 rider 迁移。证据：策略解析、安装/恢复、隧道行为（http 绝对形式、CONNECT 拒绝、带 fixture 证书的成功 CONNECT 隧道、按信号中止）、真实子进程命中假代理的 child overlay、web-fetch 隧道语义、经代理的发现/提供方出站的 RED 先行回归；store 迁移由不变的套件（17/17）加完整 rider 闭包（58 文件 / 855 测试）钉住；`doc-sync` 29/29、`typecheck`/`oxlint`/`knip` 全净；触碰源文件 per-file 覆盖 100%（含随行补齐的 JSONL 租约分支族）。

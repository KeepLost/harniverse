# Agent Note: 代理 dispatcher 曾拒绝一切 WebSocket upgrade，包括回环 CDP

Status: implemented

[English](2026-09-24-proxy-websocket-upgrade-routing.md) | 中文

## Problem

Node 的全局 `WebSocket` 与[代理策略](../../../../packages/util/http-proxy/README.md)安装时使用的是同一个全局 dispatcher 符号，因此已安装的公司代理同样会拦截 upgrade。而 dispatcher 在对 URL 做任何分类之前，就把携带 `options.upgrade` 的 dispatch 一律拒绝——依据是 upgrade“绝不会来自 `fetch`”。于是一旦导出了 `HTTP_PROXY`，浏览器面板的回环 CDP 连接（`ws://127.0.0.1:<port>/devtools/browser/…`，由 [cdp.ts](../../../../packages/api/browser-controller/src/cdp.ts) 发起）被直接拒绝。面板恰恰在代理本应服务的姿态下失效：公司网络里根本不能清掉这些环境变量。

## Decision

upgrade dispatch 先经过与其他请求相同的 `proxyForUrl` 分类，再由各分类以原生方式服务：

- **被绕过、回环、或无策略但有被取代的 dispatcher** —— upgrade 委托给策略取代的那个 dispatcher，在存在时保留 Node 自己的直连传输。
- **直连且无被取代的 dispatcher** —— 发起原生 `http:`/`https:` upgrade 请求，补上 `Connection: Upgrade` 与 `Upgrade: websocket`；响应可能已写出的早期帧通过前插回 socket 予以保留。
- **走代理的 `ws:`/`wss:`** —— 先建一条到源站的 `CONNECT` 隧道，再在隧道内完成 upgrade 握手；`wss:` 以源站服务器名叠加 TLS 并保持正常证书校验。代理凭据只出现在 CONNECT 请求行上，绝不发给源站。

Node 的 `WebSocket` 传入的是 header 对象而 `fetch` 传入扁平 `[name, value, …]` 数组，传入 `http:`/`https:` origin 而 URL 写的是 `ws:`/`wss:`；传输层统一归一化这两种形态。`onUpgrade` 保持可选，既有的纯 HTTP handler 不受影响；成功升级后 socket 连同所有权一并移交调用方。握手失败、非 101 响应、中止与策略卸载都会关闭挂起的 socket；卸载会等待进行中的握手结算。

## Alternatives considered

继续拒绝 upgrade 但先豁免回环只能修复 CDP，走代理的 `wss:` 目标依旧不可达，且分类逻辑被拆进两条路径。建议受影响的部署清掉 `HTTP_PROXY`/`HTTPS_PROXY` 等于放弃策略本应服务的公司出口。为获得 undici 的代理支持而引入依赖违背该包原生、零依赖的契约，还会让启动器的早期安装无从下手。

## Consequences

代理策略现在以与 `fetch` 相同的 URL 分类、绕过合并和“诊断不携带值”规则覆盖 Node 的 `WebSocket`，代价是多出一条传输臂（`wss:` 的 CONNECT 加 TLS）及其握手生命周期。升级后的 socket 与其他 hop 一样逐连接、不池化；README 中“代理路由拒绝 upgrade 请求”的限制已移除。

## Testing

[install.spec.ts](../../../../packages/util/http-proxy/tests/install.spec.ts) 使用真实 HTTP upgrade 服务器与假 CONNECT 代理：策略安装下回环 upgrade 保持直连、走代理的 `ws:` 经 CONNECT 得到 101、`wss:` 在隧道内校验源站证书、绕过列表生效、代理认证只到达代理、拒绝与中止清理各自的 socket；修复前先复现了旧 dispatcher 两个 WebSocket 用例的双失败。

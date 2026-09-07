# Agent Note: Host 头权威性审计——栅栏语义钉住

Status: implemented

[English](2026-09-06-host-header-authority-audit.md) | 中文

## 问题

上游在其 Web 入口新增了 Host 头验证。吸收该决策前，本次审计必须确立：Harniverse 在哪里读 `Host` 头、（若有）从它派生什么权威、是否存在任何路径让客户端可控的 `Host` 值扩大信任。审计风险：DNS 重绑定与请求走私类攻击——伪造的 `Host` 声明部署已宣告的权威，从而跳过认证或获得特权决策。

## 决策

未改产品代码：审计发现栅栏本已正确，仅补一个钉住测试。结论，逐条对照源码验证：

- 唯一与权威相关的 `Host` 读点是 `isTrustedApiRequest`（`packages/client/connection/src/api-request-trust.ts`），在每个面向浏览器的入口强制执行：`/api` 路由与两条 WebSocket 升级路径（`src/index.ts`）、浏览器认证路由（`src/browser-auth-routes.ts`）、RPC host（`src/rpc-host.ts`）。webserver 自身除传输层关注点（accept-encoding、content-type、idempotency-key）外从不读 `Host`。
- 栅栏 fail-closed 且只用于拒绝：请求仅当 `Host` 为回环（任意拼写）或匹配部署声明的 `trustedHosts` 条目（精确 `host:port`；无端口条目匹配任意端口；经 WHATWG 归一化）时通过。缺失、畸形或未声明的 `Host` 在认证运行之前即以 403 拒绝。
- 栅栏通过不授予任何东西：认证（`authenticateIncoming`）在每条路径上于栅栏之后运行，且回环认证旁路绑定于监听器 bind（`src/index.ts`：除非监听器本身绑定 `127.0.0.1`——任何头都伪造不了的 socket 层属性——旁路即被拒绝），而非绑定于 `Host` 头。没有任何代码路径从 `Host` 或 `X-Forwarded-Host` 派生权威；全仓不存在 forwarded 头读点。
- 本次新增的钉住测试（`node-half.host.spec.ts`，"holds a declared trustedHosts entry at the fence: a forged Host authenticates nothing"）锁死该分离：裸客户端声称声明权威的 `Host` 且无凭证，仍收到 401；既有测试钉住顺序（有效凭证 + 不可信 Host → 先 403；回环 Host + 无凭证 → 401）。

## 考虑过的替代方案

**逐字移植上游的 Host 验证实现。** 否决：上游检查防御的重绑定类正是 `isTrustedApiRequest` 已拒绝的，且我方有更严的 WHATWG 归一化匹配与 `trustedHosts` 条目的配置边界断言（`assertTrustedAuthority` 拒绝路径、凭证、空白填充、悬空冒号、会静默扩大授权的非规范拼写）。

**改由对端地址而非头派生信任。** 不必要：监听器绑定规则已把认证旁路系于回环 socket，栅栏把头视为仅可拒绝，没有缺失的增量防御。

## 结果

上游 Host 头验证决策以"等价设计已吸收"关闭：Harniverse 保留 `isTrustedApiRequest` 作为唯一栅栏，审计轨迹（本笔记 + 钉住测试）记录为何无需进一步改动。新增测试首跑即绿——它钉住既有属性而非修复缺陷，与审计交付物一致。证据：`node-half.host.spec.ts` 全套 32/32 绿；`api-request-trust.host.spec.ts` 既有 12 个栅栏用例保持不变且绿。

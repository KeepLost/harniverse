# Agent Note: 进程级入站网络认证

Status: implemented

[English](2026-08-16-inbound-network-authentication.md) | 中文

## 问题

Web 表层可以调用 agent 工具并修改主机配置，但回环绑定与浏览器信任栅栏建立的是可达性和混淆代理人防御，而不是调用者身份。能够到达受信 authority 的 localhost 进程、LAN peer 或浏览器因此需要一个覆盖 HTTP 与两种 WebSocket 载体的认证判断，同时不能把传输令牌变成 Harness 用户、租户或 session 边界。

## 决策

`dsh-authentication` 定义一个进程级接入服务。`dsh-authentication-local` 在 `$DSH_HOME` 下保存具名令牌 digest，在 WebServer 绑定前取得唯一网络实例 lease，创建有上限的进程内存浏览器会话，按载体与直连 peer 限制无效凭据，通过周期 reconciliation 观察 registry 提交，并写入隐私最小化且轮转的 JSONL 访问记录。在 authenticated 模式下，watcher 或 registry 读取失败后会拒绝接入并关闭当前会话与 socket，直到 reconciliation 成功；bypass 不依赖 registry freshness。Web 组合默认选择 authenticated 模式。`--dangerously-skip-authentication` 保留 lease、信任栅栏与访问记录，但只能用于回环监听。全接口监听要求成对提供 `--tls-cert` 与 `--tls-key` 路径。

所有令牌都代表同一个 Harness 逻辑用户。名称是非机密的管理与审计标签；任何令牌都不授予 scope、权限、租户或独立 Harness session。Reset 和 delete 发布精确的失效凭据 revision，因此 connection 消费方只关闭匹配的浏览器会话与 WebSocket。移除最后一个令牌会封存运行中的进程，直到 `dsh auth token add <name>` 恢复接入；初始没有令牌的 authenticated 进程则在 listen 前失败。

浏览器 shell 在解析 boot manifest 或构造 module system 前调用 `/auth/status`，并在需要时调用 `/auth/login`。HTTPS 登录成功会设置由进程内存支持的 `__Host-` cookie，带 Secure、HttpOnly、SameSite=Strict 与 Path 属性；回环 HTTP 保留 HttpOnly 严格 cookie。认证响应不可缓存。非浏览器客户端使用 Bearer 令牌。Host、Origin、Fetch Metadata、media type 与 DNS 重绑定检查保持独立，并与认证共同执行。WebServer 直接终止已配置的 TLS，并拒绝明文全接口监听。

本决策取代[显式绑定地址决策](2026-07-22-web-bind-address.md)中的无认证全接口假设，并完成[浏览器信任边界](../architecture/2026-07-28-api-browser-trust-boundary.md)延后的认证工作。

## 曾考虑的替代方案

**一个无名称令牌。** 不予采纳，因为独立设备与自动化需要定向轮换和删除，而不能断开其他所有客户端；名称提供该管理身份，但不会变成授权。

**在通用 WebServer 内认证。** 不予采纳，因为载体刻意不了解 Harness 概念。认证提供方拥有判断与状态，而 connection 消费方保留 HTTP/WebSocket 协议处理和现有请求信任栅栏。

**持久化浏览器会话。** 不予采纳，因为重启时失效既简单又安全，避免增加另一种包含 secret 的持久格式，而源令牌仍是恢复机制。

**增加授权或每令牌用户。** 不予采纳，因为产品只有一个本地逻辑用户和共享运行状态。把令牌标签当作 principal 会暗示 session、设置、插件和进程层实际不存在的隔离。

## 后果

所有外部 HTTP API 与 WebSocket 接入，包括 localhost，都要求有效凭据，除非显式启用回环 bypass。令牌值只在 add/reset 时出现一次，绝不进入 registry、日志、URL、浏览器存储或模型输入。访问记录失败会把本应成功的接入改为拒绝；已提交令牌撤销的次级应用记录即使失败，仍会关闭会话与 socket。无效凭据最终返回有界的 `rate-limited` 判断与重试间隔，且限速状态不会超过配置容量。直接向网络开放要求操作者提供证书与密钥文件；自动签发证书和可信代理处理不属于本决策。

聚焦测试固定令牌管理、权限与轮换、lease 互斥、sealed 恢复、定向 registry 事件、定向 WebSocket 关闭、localhost 401 响应、失败限速与恢复、HTTP 与 HTTPS cookie 属性、明文远程 listener 拒绝、真实 HTTPS 服务、启动模式选择和浏览器 boot 顺序。组装后的 Web replay 仍是登录先于插件启动的产品级检查。

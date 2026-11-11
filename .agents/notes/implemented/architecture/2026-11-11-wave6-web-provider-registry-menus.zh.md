# Agent Note：Wave-6 web provider 注册表菜单吸收

Status: implemented

[English](2026-11-11-wave6-web-provider-registry-menus.md) | 中文

## Problem

上游 `2026-10-29-web-provider-selection` 令提供方选择菜单改为注册表驱动：菜单枚举已注册提供方及其 `title`/`description` 元数据，在 `providers-changed` 注册表事件时重读，且宿主未注册的已选 id 保持可见。harniverse 早已具备独立的搜索/抓取选择器与更丰富的第一方阵容，但设置卡的菜单是编译进客户端的固定 ID 数组——插件注册的提供方永远无法出现在其中；seam 的 `listProviders` 不携带选择菜单元数据、按 id 排序，且没有变更信号。

## Decision

把注册表驱动菜单机制吸收到既有 web seam 上，保留 harniverse 的机器自有选择器设置与各提供方凭据卡：

- **注册元数据**：`WebSearchProvider`、`WebFetchProvider` 与聚合 `WebProvider` 接受可选 `title`/`description`；注册保留它们，`WebProviderInfo` 透传携带。缺失的元数据省略键。
- **注册顺序的 `listProviders`**：搜索注册在前、仅抓取 id 在后，每条携带完整能力集（既有消费方依赖的合并 caps 契约）；放弃按 id 排序。该方法同时成为 `harniverse.observe` Remote（`web/listProviders`），经生成的 typert 工件对外提供——浏览器选择菜单枚举活注册表而非编译清单。
- **`web/providers-changed`**：无载荷、`@mode emit` 的 cordis 事件，在每个注册提交点（含注销）触发，逐监听器隔离沿用 `llm/adapters-updated` 模式；该事件加入 `API_REMOTE_FORWARDED_EVENTS`，web 客户端经既有下行链路原样收到。
- **设置卡菜单**：选择字段按第一方 id 加活注册表解析（`dynamicSelectField`），选项列表追加注册表条目（第一方本地化标签在前，其后 `title ?? id`），既不在第一方也不在注册表的已暂存 id 保持可见，存储的选择永不遭静默改名。注册表枚举的选择不渲染第一方明细面板——插件自管其配置；每次转发到客户端的 `web/providers-changed` 都触发卡片重读。
- **范围外，已记录**：上游的凭据路由（搜索/抓取跟随会话的 DeepSeek 凭据及网关 YAML 字段）不吸收；各 harniverse 提供方保持自己的凭据卡。

## Alternatives considered

**wire 流重读。** 上游菜单经 stream 模式 Remote 重读；harniverse 的 typert 协议没有 stream 模式，因此活重读走"转发事件 + 拉取"通道（`ctx.remote.$on('web/providers-changed')` 后一次 `listProviders` 调用）。这是 harniverse 既有的事实标准活数据模式，不新增协议面。

**保留固定菜单并把注册 id 规范化掉。** 拒绝：把已注册选择静默改名为第一方默认会使插件提供的后端不可选——恰是本次吸收要闭合的缺口。

## Consequences

插件现在可以带选择菜单元数据贡献搜索或抓取提供方，在其注册期内（含 HMR）出现在 Web 设置选择器中。api-catalog 与子系统页携带新签名与事件；`EVENT_SCOPE_PAGE` 把 `web/*` 映射到 web 子系统页。第一方提供方包注册时不带元数据并保持本地化字典标签，默认组合的菜单不变。客户端状态新增 `extraSearchOptions`/`extraFetchOptions`，注册表选择的无面板渲染已在卡片 spec 中断言。

# Agent Note: web_fetch 遵守运营者 no_proxy 点名的目的地

Status: implemented

[English](2026-10-15-web-fetch-no-proxy-destinations.md) | 中文

## Problem

`web_fetch` 以两层叠加的方式无视内网目的地的 `no_proxy`。旁路匹配器（`bypassesProxy`）不理解 CIDR 条目，因此操作系统风格的 `no_proxy=10.0.0.0/8,...`（curl 与 Python requests 都遵守）之下，所有 `10.x` 字面量仍被路由进代理。而即使旁路命中，`dsh-web-fetch-http` 也照样拒绝目的地：`validateFetchUrl` 在任何路由决策之前就拒绝非公共地址字面量，直连臂的 `assertPublicAddress` 拒绝每一个非公共 DNS 应答——装了代理的运营者永远无法把自己的内网放进抓取器的允许范围。

## Decision

**运营者亲手写下的旁路条目即豁免；CIDR 条目参与匹配；一切未点名的目的地维持默认拒绝。** `@deepseek-ai/dsh-http-proxy` 侧：旁路条目新增 IPv4 CIDR（`10.0.0.0/8`、`172.16.0.0/12`、`/32`、任意端口；畸形的 CIDR 条目不覆盖任何目的地），并新增纯函数 `explicitlyBypasses` 与已安装策略读取 `operatorBypassed(url)`，报告某个 URL 是否被运营者亲笔条目——不含本包并入的回环基底、不含不点名任何目的地的 `*`——显式覆盖。`dsh-web-fetch-http` 侧：字面量 IP 范围检查从 `validateFetchUrl`（回归纯形状校验）移入 `assertLiteralScope(url, allowPrivate)`，provider 把 `operatorBypassed(url)` 传入它和 `assertPublicAddress`：被运营者点名的目的地保持钉死直连路径并放行其私有地址，未点名的目的地在字面量与 DNS 解析两臂都维持仅限公网的默认拒绝。代理臂不变——无运营者条目的私有字面量仍在任何跳转之前被拒，走代理的抓取从不在本地解析。

## Alternatives considered

**只要装了代理策略就放行私有地址。** 否决：装代理并不代表运营者想让模型触达哪些内网主机；`no_proxy` 才是运营者真正逐目的地写下的清单。

**把回环基底也当作豁免。** 否决：基底条目（`localhost`、`127.0.0.1`、`::1`、`[::1]`）是本包出于设计并入的，它们的存在不携带运营者意图；只有运营者亲笔写的条目才算（`127.0.0.2` 这类非基底拼写仍然算）。

**IPv6 CIDR。** 暂缓：在 `no_proxy` 名单中罕见且解析成本高；此类条目和从前一样不覆盖任何目的地。

## Consequences

在设置 `HTTP_PROXY` 且 `no_proxy=10.0.0.0/8,.corp.internal` 时，`web_fetch` 现在通过钉死直连路径抓取 `http://10.1.2.3/…`，并把 `wiki.corp.internal` 解析到真实的私有地址；公网目的地照常走隧道，未点名的私有目的地照常以 `WEB_BLOCKED_URL` 失效关闭。`bypassesProxy` 的每个消费者（全局 dispatcher 路由、WebSocket 升级、web-fetch）现在与 curl 风格的 CIDR 名单一致。`validateFetchUrl` 不再拒绝私有字面量——依赖该行为的调用方必须调用 `assertLiteralScope`（provider 正是这么做的）。

验证：`policy.spec.ts` 覆盖 CIDR 匹配（范围边界、任意端口、名字/IPv6 不匹配、畸形条目）与 `explicitlyBypasses`（基底与 `*` 排除、端口匹配）；`install.spec.ts` 覆盖已安装策略下的 `operatorBypassed`；`fetch-http.spec.ts` 覆盖纯形状的 `validateFetchUrl` 与 `assertLiteralScope` 两臂；`proxy.spec.ts` 端到端驱动 provider（点名的私有字面量直连抓取、未点名字面量被拒、点名主机解析出私有地址被放行）。

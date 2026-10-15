# Agent Note: 产品组合的浏览器面板默认放行私有目的地

Status: implemented

[English](2026-10-15-browser-panel-private-destinations.md) | 中文

## Problem

工作区浏览器面板拒绝内网导航，报 `the operator has not enabled private destinations`。`browser-controller` 的 schema 把 `allowPrivateAddresses` 默认为 false（上游的运营者选项：页面流量从 host 的网络位置发出，默认拒绝其回环/链路本地/私网邻域是合理的），而 Harniverse 的 web-app 组合出货时该行不带任何 config——产品恰好拒绝了它的工作区浏览器存在的意义所在的目的地。

## Decision

**Harniverse 组合层放行；上游包默认值不动。** `packages/bundle/web-app/cordis.patch.yml` 在出货的 `browser-controller` 行上设置 `allowPrivateAddresses: true`，`allowedHosts` 保持为空（全部主机），部署方仍可按站点收窄导航面。配置接缝仍归运营者：schema 默认值、`reviewNavigation` 策略、按部署覆盖的路径全部未动，保持插件原生架构——Harniverse 的产品决策以组合配置表达，而不是分叉包。桌面端资格快照（`apps/desktop/scripts/packaging-browser.ts`）此前会在行的 `name:` 之后**插入**完整 config 块；现在它建立在组合实际出货的行之上（断言出货行已启用私有地址），只追加以 `allowedHosts: ['127.0.0.1']` 收窄和观察者插件，打补丁后的运行时不再出现同一行下的两个 `config:` 块。

## Alternatives considered

**把包 schema 默认值翻成 true。** 否决：对 host 位置的浏览器而言，上游的默认拒绝是真实的运营者姿态（包 README 有明确记载）；Harniverse 的需求是产品组合事实，应表达在组合接缝上，更严格的部署仍可覆盖回去。

**要求运营者按部署写配置。** 否决：Harniverse 为该面板声明的用途就是私网可达；出货一个招牌能力还需要 undisclosed 配置开关的产品，本身就是缺陷。

## Consequences

工作区浏览器开箱即可导航 `10.x`/`172.16.x`/`192.168.x`、`.local` 与回环主机；公网导航不变；部署方仍可通过常规配置分层设置 `allowedHosts` 或覆盖回 `allowPrivateAddresses: false`。桌面打包 fixture 采用了出货的 config 形状，使资格快照的补丁对真实组合保持幂等。

验证：`packages/bundle/web-app` 套件（四个受影响包共 30 文件、423 用例）在新组合下全绿；桌面 `packaging-browser` node:test 套件（12 用例）覆盖重写后的补丁步骤，包括封存源保持出货 config 不变。

PR: #191 (merge)

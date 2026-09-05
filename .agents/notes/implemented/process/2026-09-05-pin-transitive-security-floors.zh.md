# Agent Note: 为传递依赖钉住安全下限

Status: implemented

[English](2026-09-05-pin-transitive-security-floors.md) | 中文

## 问题

Dependabot 针对 `pnpm-lock.yaml` 开了 17 个告警（7 高、9 中、1 低），全部落在 workspace 仅以传递方式引入的包上：`hono` < 4.12.34 与 `qs` < 6.16.0 经 `@modelcontextprotocol/sdk` 进入运行时闭包（分别经由 `@hono/node-server` 与 `body-parser`→`express`），`fast-uri` < 3.1.6 经 `ajv`，`browserslist` <= 4.28.6 经 CSS/浏览器工具链，`undici` 8.x < 8.9.0 经 `e2b` 与 `vitest` 消费的 `undici8` optional-peer 别名。没有任何 workspace manifest 直接声明这些包名，因此改任何 `package.json` 的版本区间都够不到它们。

## 决策

扩展 `pnpm-workspace.yaml` 中既有的 `overrides` 块——与已经在维护 `brace-expansion`、`dompurify`、`nanoid`、`postcss`、`protobufjs`、`undici@7` 下限的同一机制——为每个易受攻击区间加入按主版本限定的钉扎：`browserslist@4: 4.28.7`、`fast-uri@3: 3.1.6`、`hono@4: 4.12.34`、`qs@6: 6.16.0`、`undici@8: 8.9.0`，另加 `undici8: undici@8.9.0`，因为 pnpm 按声明名而非目标包名匹配别名依赖。每个钉扎都是首个修复版本，且不低于原解析版本。

## 考虑过的替代方案

**大范围 `pnpm update`。** 否决：会在整个 lockfile 上掀起无关解析的扰动，让安全修复无法从 diff 中审计。

**根 `package.json` 的 `pnpm.overrides`。** 否决：pnpm 11 不再读取那里的 `pnpm` 字段；install 会警告这些键被忽略，override 静默失效。

**只解决运行时告警、放任纯工具链告警。** 否决：同一份 lockfile 供给所有 CI lane 与打包产物，工具链传递依赖同样属于交付攻击面。

## 结果

Lockfile 对五个被点名的包不再解析出任何易受攻击版本，而运行时路径所需的 `undici@7` 保持在既有下限。`pnpm run build`、license/runtime-closure/third-party-notices 各 hygiene 门禁、以及 MCP SDK 消费方的套件（`mcp-client`、`subagent-claude-code`、`llm-pi-ai`，355 个测试）在修复后的解析上全部通过。

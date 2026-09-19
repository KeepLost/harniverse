# Agent Note: 认证应用 shipped 组合桥接全部 startup 字段

Status: implemented

中文 | [English](2026-09-19-auth-composition-bridge-guard.md)

- Date: 2026-09-19
- Scope: `@deepseek-ai/dsh-auth-app`（bundle 组合与测试）
- PR: pending（本 note 随修复一起提交）

## Problem

`dsh auth code issue --profile owner --ttl 30m` 在生产路径报 `auth-runner: code-issue requires --ttl`，而 flag 本身解析正确。该 bundle 的 shipped `cordis.patch.yml` 用逐字段 `!!js` 行把 `authStartup` 服务字段桥接进 runner 行的 Loader config；邀请口令功能给 `AuthStartupValues` 增加了 `kind`、`bindName`、`ttl`、`count`，却没有同步桥接行。包测试启动的是手写 fixture 组合——fixture 里带着新字段——于是测试全绿，shipped 组合却在半路把值丢掉。

## Decision

- `cordis.patch.yml` 的 runner 行现在桥接全部 `AuthStartupValues` 字段（含四个邀请字段）。桥接是产品面，不是实现细节。
- `auth-app.spec.ts` 新增断言：startup 服务运行时发布的每个字段都必须以 `!!js ctx.authStartup.<field>` 出现在 shipped patch 文件中。未来任何字段漏配桥接行会先红测试，而不是在生产爆雷。

## Consequences

- `dsh auth code issue|list|revoke` 重新在真实启动器下可用；已端到端验证（issue、list、revoke 各 exit 0）。
- 任何 Loader 行 config 由服务经 `!!js` 喂入的插件，其组合文件都要当代码对待：与服务字段同 commit 扩展，并用运行时证据（而非 fixture 副本）守卫配对。

## Alternatives considered

- **测试直接启动 shipped patch 文件：** 否决——fixture 的意义就是通过 mjs shim 指向仓内 `src/`；整文件导入会重建这层间接。
- **从 `Config` schema 推导桥接：** 否决——schema 在 runner 侧，而桥接命名的是 startup 服务发布的键；运行时证据同时耦合两侧。

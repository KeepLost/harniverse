# Agent Note: v0 会话契约 digest gate 与 Compat/Verify 账目尾注

Status: implemented

[English](2026-09-20-session-contract-digest-gate.md) | 中文

## Problem

永久 v0 会话格式冻结此前只是文字政策：删除会话事件类型、改写既有载荷、或改动持久化事件信封时，没有任何机制察觉。`PLUGINS.md` 账目也没有区分触及契约的变更与表面变更，审查者没有可核对的兼容性声明。

## Decision

两个 doc-sync leaf 现在执行该冻结。`verify-session-contract-digest` 将 `docs/session-contract-digest.json` —— 由 AST 从 `SESSION_FORMAT_VERSION`、每个 `SessionEventMap` 合并的事件名与载荷文本、`SurfaceEventType` 成员、以及信封声明的去注释结构哈希构建的基线 —— 与源码比对。漂移会被分类：结构性漂移（版本变化、删除事件、载荷或信封变化）作为 v0 冻结违规失败；additive 漂移（新增事件类型）以 stale 失败，直到基线被有意识地重生成。`verify-ledger-compat` 要求 `compat-convention-start` 标记之后的每个 `PLUGINS.md` 账目行声明 `Compat:` 立场（未触及契约时为 `none`），且每个非 `none` 声明带 `Verify:` 复核命令；标记前的历史行豁免。

## Alternatives considered

- 读取时查询的运行时兼容注册表：拒绝——它会在评审决策明确避免的账目之外再造第二套注册表，也无法把关类型面本身。
- 仅摘要相等（如 `verify-api-catalog`）：单独拒绝，因为不匹配说明不了方向；additive/结构性分类才把基线变成对冻结的执行而非新鲜度检查。
- 对任意载荷变化证明 additive 的类型级 AST diff：拒绝，没有完整类型解析就无法构建；载荷文本漂移走结构性审查，并为真正的可选字段新增保留书面出口。

## Consequences

今后每个会话日志词汇变更都在同一提交内重生成 digest 基线，并在账目行带 `Compat:`/`Verify:` 尾注；digest 变化本身从不证明语义兼容，声明与命令才是审查面。gate 通过 AST 读源码、从不读构建产物，所以 doc-sync 在哪跑它就在哪跑。SQLite schema 变更确认机制按上游评审决定继续推迟到第一次真实 schema 变更。

## Scope

`scripts/gen-session-contract-digest.ts` 及其 spec、`scripts/verify-ledger-compat.ts` 及其 spec、两个 `package.json` 脚本与 `docSyncLeafGates` 接线、已提交的基线、`PLUGINS.md` 标记与维护规则、以及本 note。未改动任何运行时包。

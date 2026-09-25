# Agent Note: v0 会话约定摘要检查

Status: implemented

[English](2026-09-20-session-contract-digest-gate.md) | 中文

## Problem

永久 v0 会话格式冻结此前只是文字政策：删除会话事件类型、改写既有载荷、或改动持久化事件信封时，没有任何机制察觉。审查者也需要针对触及约定的变更取得显式兼容性声明与验证。

## Decision

`verify-session-contract-digest` 这一 doc-sync（文档同步门禁）子检查将[已提交的摘要](../../../../docs/session-contract-digest.json)——由 AST 从 `SESSION_FORMAT_VERSION`、每个 `SessionEventMap` 合并的事件名与载荷文本、`SurfaceEventType` 成员，以及信封声明的去注释结构哈希构建的基线——与源码比对。漂移会被分类：结构性漂移（版本变化、删除事件、载荷或信封变化）作为 v0 冻结违规失败；增量漂移（新增事件类型）以基线过期失败，直到基线被有意识地重生成。

[删除中央台账的决策](../simplification/2026-09-25-remove-central-plugin-ledger.md)部分替代了本决策的台账尾注约定。基于源码的冻结检查继续生效；变更刷新基线时，由其所属 Agent Note 记录兼容性理由与验证。

## Alternatives considered

- 读取时查询的运行时兼容注册表：拒绝——它会在运行时重复审查元数据，也无法把关类型面本身。
- 仅摘要相等（如 `verify-api-catalog`）：单独拒绝，因为不匹配说明不了方向；additive/结构性分类才把基线变成对冻结的执行而非新鲜度检查。
- 对任意载荷变化证明 additive 的类型级 AST diff：拒绝，没有完整类型解析就无法构建；载荷文本漂移走结构性审查，并为真正的可选字段新增保留书面出口。

## Consequences

每个会话日志词汇的增量变更，都在其所属 Agent Note 记录兼容性理由与验证后，在同一变更中有意识地重生成摘要基线。摘要变化本身从不证明语义兼容；结构性破坏变更仍被禁止。检查通过 AST 读源码、从不读构建产物，所以 doc-sync 在哪跑它就在哪跑。SQLite schema 变更确认机制按上游评审决定继续推迟到第一次真实 schema 变更。

## Scope

[生成器](../../../../scripts/gen-session-contract-digest.ts)、[其 spec](../../../../scripts/gen-session-contract-digest.spec.ts)、[package.json](../../../../package.json) 中的生成与验证脚本、[run-gates](../../../../scripts/run-gates.ts) 中的 doc-sync 注册，以及已提交的基线执行本决策。无需改动运行时包。

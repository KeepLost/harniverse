# Agent Note: 补齐 per-file 覆盖率门禁基线

Status: implemented

[English](2026-09-05-cover-per-file-gate-baseline.md) | 中文

## Problem

`node 24 / coverage` 通道在 `master` 上长期失败：74 个源文件共有 1,501 个未覆盖位置，是早于本分支累积的基线债务。该回归之所以不可见，是因为 `all-checks-passed` 丢失了 `node-24-coverage` 的 needs 依赖边，聚合检查在阻塞门禁变红时仍然报告成功。

## Decision

基线用真实测试套件补齐，而非改配置：原先不达标的所有文件均通过行为化测试满足 per-file 100% 阈值（新增聚焦 spec 文件并扩展现有套件，90 个变更文件新增约 2,900 条测试断言）。若未覆盖分支被证明是不可达的防御式代码，则删除死分支而非加注解——涉及 `capability/capabilities`、`core/model-policy-fallback`、`session/session-persistence-jsonl`、`spill/spill-local`、`auth/authentication-local`、`subagent/tool-subagent`、`mcp/mcp-user-config`、`web/web-fetch-http`、`fs/tool-str-replace-editor`、`skill/skill-filesystem`、`context/session-reference`、`settings/settings` 及三个客户端组件——每一处都有所属不变量支撑（Settings schema 校验、vendored-cordis disposer 语义、非可选正则分组、React 禁用按钮语义或渲染门控）。可达路径上的行为没有变化，因此不涉及 `PLUGINS.md` 的插件台账条目。

聚合检查的既定契约同步恢复：`all-checks-passed` 的 needs 重新列入 `node-24-coverage`，未来的覆盖率失败会使 required check 失败，而不是躲过聚合结果。

## Alternatives considered

**`/* v8 ignore */` 注释或阈值排除。** 拒绝：该门禁的价值在于 per-file 强制执行，缺少“构造上不可达”理由的忽略会掩盖漂移，仓库政策明确禁止。

**降低 per-file 阈值。** 拒绝：覆盖良好的大文件会补贴裸文件——这正是 per-file 设计要阻止的失败模式。

**保持门禁不强制、债务不偿还。** 拒绝：`master` 上长期红色的 required 通道正是本分支要清除的 CI 技术债。

## Consequences

覆盖率通道重新强制执行并通过；复用同一门禁的 Windows native complete 随之通过。死防御分支被移除而非忽略，未来的覆盖率报告只提示真实缺口。新的未覆盖代码必须随测试一起提交——门禁不再赦免累积债务。

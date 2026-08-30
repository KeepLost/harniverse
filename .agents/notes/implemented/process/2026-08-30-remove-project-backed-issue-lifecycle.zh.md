# Agent Note: 让 PR 策略独立于 Project

Status: implemented

[English](2026-08-30-remove-project-backed-issue-lifecycle.md) | 中文

## Problem

基于 Project 的 Issue 生命周期自动化需要一个持久的 Project 所有者，以及能够读取和修改该 Project 的凭证。Harniverse 的仓库由用户账号拥有，而现有 GitHub App 安装令牌无法访问用户级 Projects v2 看板。继续保留这项集成会让每个 Issue 事件都产生可预期的失败工作流。

## Decision

Harniverse 保留只读的 pull request 策略，移除基于 Project 的 Issue 生命周期。该策略要求已进入评审的人工非 Draft pull request 至少引用一个同仓库 Issue，恰好使用一个受支持的 `kind/*` 标签，至少使用一个 `area/*` 标签，并避免使用已弃用或仅限 Issue 的标签。Bot、App 和 Draft pull request 仍然豁免。

该策略通过仓库 REST API 解析被引用的 Issue，并使用 `GITHUB_REPOSITORY` 作为仓库身份。它不查询 ProjectV2，不读取 Issue 字段值，不修改 Project item，也不写入 Issue 审计评论。Issue lifecycle 工作流、Project 配置、Project Status 与 Priority 规则，以及由评审驱动的状态转换，都不属于已发布的自动化。

仓库继续在静态 CI gate 中保留策略测试。pull request 模板保留 Issue 引用说明，但不再要求 Project Priority。剩余的策略工作流不需要 GitHub App 凭证。

## Alternatives considered

**使用 GitHub App 保留用户级 Project。** 否决，因为 GitHub App 安装令牌无法访问用户级 Projects v2，因此工作流无法执行所需的 Project mutation。

**在 Actions 中保存维护者的用户令牌。** 否决，因为用户令牌会让自动化绑定个人身份，并将账号级 Project 和仓库权限暴露给受信任的工作流代码。

**删除全部 Issue 和 pull request 策略。** 否决，因为同仓库引用和 PR 标签分类仍是独立且有价值的约束。

**删除 Project 后继续启用生命周期工作流。** 否决，因为 Issue 事件会持续产生失败，而不是明确地不执行任何操作。

## Consequences

Issue 的创建、编辑、关闭、重新打开、分配、标签变化以及 PR 评审事件不再更新 Project，也不再创建生命周期审计评论。Issue 仍然是原生 GitHub 记录，其生命周期通过 GitHub 自身的状态、标签、分配人与评论维护。

人工 PR 进入评审后，pull request 仍会接受仓库的元数据和 Issue 引用策略检查。该策略只需要仓库读取权限，因此可以移除生命周期 App 的 client ID、私钥、安装以及用户级 Project，而不会削弱剩余检查。

如果 Harniverse 采用兼容自动化的 Project 所有者和凭证边界，例如由受限安装的 GitHub App 操作组织级 Project，则可以重新引入已移除的生命周期功能。

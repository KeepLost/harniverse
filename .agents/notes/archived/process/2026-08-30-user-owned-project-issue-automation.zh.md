# Agent Note: Harniverse 用户级 Project 的 Issue 自动化

Status: implemented
Archived: 2026-08-30

[English](2026-08-30-user-owned-project-issue-automation.md) | 中文

## 问题

Issue policy 和 lifecycle 工作流在 Harniverse 中执行，但它们的仓库和 Project 配置仍指向上游 `deepseek-harness/deepseek-harness` 及其组织级 Project。Harniverse 的正确仓库是 `KeepLost/harniverse`，而 `KeepLost` 是 GitHub 用户而不是组织，因此旧的 GraphQL 所有者查询和 REST 路径无法操作下游仓库。

lifecycle 工作流还需要一种既能修改 Issue 评论和用户级 Project、又不会把维护者个人令牌暴露给工作流代码的凭证。

## 决策

Harniverse 使用用户级 Project [Harniverse Issue Management](https://github.com/users/KeepLost/projects/1) 作为生命周期投影。[Issue 管理配置](../../../../.github/issue-management/config.json) 将 `KeepLost/harniverse` 记录为仓库，将 `KeepLost` 记录为 Project 所有者，并声明 `projectOwnerType: "user"`。Project 的 Status 字段严格包含 `Inbox`、`Backlog`、`Ready`、`In progress`、`In review`、`Done` 和 `No action`；Project 还包含配置所需的 `Priority` 字段及 `P0` 到 `P3` 选项。

[策略实现](../../../../.github/issue-management/policy.mjs) 使用仓库所有者执行 REST 请求，并根据配置在 GraphQL 中选择 `user(login:)` 或 `organization(login:)` Project 所有者。这样既明确了 Project 查询目标，也保留了未来改用组织级部署时所需的支持。

[Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml) 创建的安装令牌仅限 `KeepLost` 账户及 `harniverse` 仓库。工作流从 `HARNIVERSE_ISSUE_APP_CLIENT_ID` 读取 App client ID，从 `HARNIVERSE_ISSUE_APP_PRIVATE_KEY` 读取私钥；仓库中不保存个人访问令牌。安装的 App 需要仓库内容和 pull request 的读取权限、Issue 的读写权限、metadata 读取权限，以及用于 Project API mutation 的 Projects 读写权限。

Pull request policy 会先判断 Bot、App 和 Draft 豁免，再解析 pull request 正文中的引用。因此依赖发布说明可以包含无关上游的 `#123` 引用，不会触发 Harniverse Issue 查询或产生错误的策略失败。

## 考虑过的替代方案

**保留上游组织和仓库配置。** 否决，因为 Harniverse 工作流会继续请求下游不存在的资源，生命周期 mutation 也可能指向错误产品。

**使用仓库级 Project。** 否决，因为 `KeepLost` 是用户账户，而本次请求明确需要用户级生命周期看板；实现仍通过显式所有者类型设置保留组织级 Project 支持。

**使用默认 `GITHUB_TOKEN` 执行 Project 和 Issue mutation。** 否决，因为工作流令牌不具备用于用户级 Project API 的所需能力，其仓库级身份也不适合作为专用自动化身份的替代品。

**在仓库 secrets 中保存维护者个人访问令牌。** 否决，因为 GitHub App 可以提供短期安装令牌、明确的仓库选择和可撤销权限，避免自动化绑定个人凭证。

## 后果

在创建 App、安装 App 并授予声明的权限后，`KeepLost/harniverse` 的 Issue 和 pull request 事件可以将生命周期状态投影到用户级 Project。Project 不属于仓库，因此它的访问和可见性由 `KeepLost` 账户控制，必须与仓库的运行需求保持一致。

在 App client ID 变量、私钥 secret、App 安装和 Projects 权限配置完成前，工作流会明确失败。这比静默跳过生命周期更新或回退到个人令牌更安全。Issue policy 仍保持只读，lifecycle 保留已有 audit comment 行为；两个工作流都不会获得 merge、push、publish 或仓库管理权限。

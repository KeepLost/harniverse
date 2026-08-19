# Agent Note: 共享 workspace domain 版本

Status: implemented

[English](2026-08-19-shared-workspace-domain-version.md) | 中文

## 问题

官方 DSH 和 Harniverse 使用相同的 `$DSH_HOME` 存储根目录及相同的 `workspace` 单元名。官方 workspace domain 是版本 2，而 Harniverse 专属的 Session 删除 journal 曾经把该单元提升到了版本 3。存储后端会拒绝与 descriptor 不一致的介质版本，因此在官方 DSH 之后启动 Harniverse 时，Workspace 注册表还未可用就已经失败。

## 决策

共享的 `workspace` domain 保持版本 2，只包含官方 DSH 能理解的数据。Harniverse 将 `pendingSessionDeletionIds` 存入版本 1 的独立 `workspace_deletion` domain。`WorkspaceRegistry` 将两个 domain 作为一个服务一起打开和关闭，公开的删除恢复方法保持不变。

domain descriptor 支持显式的 `migrateFrom` 列表。JSON 和 SQLite 后端会在保留不透明记录的同时，将列表中的旧单元版本重写为当前版本。workspace spec 将版本 3 接受为一次性来源版本；启动时把其中的旧删除标记转移到 `workspace_deletion`，并重写不含该字段的共享 workspace 全局状态。其他不支持的版本仍然明确失败。

## 考虑过的替代方案

**保留版本 3，只修改 Harniverse schema。** 官方 DSH 进程仍会拒绝共享的 `workspace` 单元，因此两个应用交替运行的问题仍然存在。

**将 workspace descriptor 降为版本 2，但继续把删除字段放在其中。** 官方 DSH 可以把该字段作为未知字段解析，但任何官方 workspace 写入都可能擦除 Harniverse 的恢复标记。fork 专属 journal 必须有自己的持久化所有者。

**为 Harniverse 使用独立存储根目录。** 这会避开版本冲突，却会把 workspace 元数据与共享的 session 根目录拆开，并使旧根目录中的记录失去关联。共享官方 workspace 单元才是需要保留的行为。

**静默接受所有版本。** 版本不一致可能代表不兼容的记录布局。只有所属 spec 可以声明来源版本，其他所有版本仍必须被后端拒绝。

## 后果

官方 DSH 和 Harniverse 可以按任意顺序打开并修改共享的版本 2 workspace 单元。Harniverse 的删除恢复状态隔离在 `workspace_deletion` 中，因此不会被官方 DSH 覆盖。已有的 Harniverse 版本 3 workspace 介质会在下一次 Harniverse 启动时重写，并保留旧删除标记。未来不兼容的 workspace 变更必须使用新的显式迁移或新的 domain 版本，不能随意扩大 `migrateFrom`。

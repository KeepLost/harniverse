# Agent Note: 在 Windows 门禁上覆盖平台判别分支

Status: implemented

[English](2026-09-05-cover-windows-platform-arms.md) | 中文

## 问题

Windows native lane 与 Linux coverage lane 执行同一套 per-file 100% 覆盖门禁，但有 36 个位置散布在六个源文件中，只能由在 POSIX 宿主上原生执行这些分支的测试覆盖：`process.platform` 三元分支（`assertPrivateFile` 的非 win32 主体、`runGit` 的 `/dev/fd` 描述符根、`O_NONBLOCK` 读取旗标）、身份检查（spill 与 sqlite 持久化中的 `process.getuid` 归属守卫）、编码分支（codex 运行器中 Buffer 编码的 stderr 分块），以及 JSONL 持久化 unlink 之后的目录 fsync。在 Windows runner 上这些分支是确定性缺口——覆盖它们的测试要么提前返回，要么走平台另一侧——因此 `windows node 24 / native complete` 永远无法仅凭阈值通过。

## 决策

用行为测试在每个宿主上都真实执行这些分支来完成覆盖，全部沿用仓库既有惯用法：`Object.defineProperty(process, 'platform', …)` 翻转（并恢复描述符）让 win32 runner 进入 POSIX 分支；为身份守卫注入 `process.getuid`；复用既有的 `node:fs` 脚本化故障钩子（`statMode`、`renameDestination`、脚本化 `lstat`/`opendir`/`open`），使平台翻转后的操作不依赖宿主文件系统语义。`/dev/fd` 的 Git 分支复用被拦截的 git stub，因此无需真实 Git 解析描述符路径。没有引入任何阈值、排除项、`v8 ignore` 指令或 `it.skipIf` 守卫；未改动产品源码，因此不涉及 `PLUGINS.md` 条目。

## 考虑过的替代方案

**在覆盖配置中加入平台条件排除。** 否决：门禁的 per-file 契约会在某条 lane 上被静默削弱，这正是本分支要清除的掩盖行为。

**在 Windows 上跳过这些未覆盖套件。** 否决：那会把真实的覆盖缺口变成整个平台上永久不受测试的表面。

**把平台分支从产品代码中重构掉。** 否决——这些分支是承重的（Windows 确实需要不同的锁竞争错误码、描述符根与环境重定向）；每个分支都记录着测试必须 exercising 的真实平台契约，而非死代码。

## 结果

Windows lane 的覆盖门禁现在从真实执行中观测到与 Linux 相同的 100% per-file 契约，而不是继承仅在 Linux 上的覆盖。新增 spec（store 别名遍历、sqlite 归属故障、workspace-inspector 描述符根分支、stderr Buffer 解码、平台翻转下的私有文件权限守卫）在所有平台上运行，并保持 Linux 与 macOS lane 既有的 100% 基线，三条 lane 由此执行完全一致的 per-file 契约。

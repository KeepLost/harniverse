# Agent Note: Wave-6 vendor Cordis 同步（cordis 4.1.0 线）

Status: implemented

[English](2026-11-07-wave6-vendor-cordis-sync.md) | 中文

## 问题

Vendored Cordis 线落后官方 wave-6 树两个上游代际：Harniverse 钉在 cordis `4.0.1`（上游 `4.0.0-rc.7`，commit `56b3d4f`）、loader `1.0.2`（`rc.5`）、include `1.0.6`，而官方树经分阶段 rc.11 升级推进到 cordis `4.1.0`（`rc.11`，commit `0b96d9f`）、loader `1.1.0`（`rc.8`）、include `1.1.0`、schemastery `3.19.0`、cosmokit `1.9.0`、group `1.1.0`、timer `1.2.0`、hmr `1.1.0`、logger-console `1.1.0`。Wave-6 owner 裁定现在执行同步，js-yaml v5 解锁视新 `include` 是否仍需要 js-yaml 4 的 `Type` 类而随批处理。

## 决策

对每个变更的源码、manifest 与包内 README 整体采纳官方 vendor 树：官方 rc.11 升级已重放共享的本地修改线（fiber 生命周期加固、JSDoc 补全、volatile 配置、惰性配置解析、journal include），因此对 Harniverse 的差量就是升级本身加官方维护的补丁集。`vendor/README.md` 的 manifest 表与 V 编号本地修改台账随之采纳，含三处 Harniverse 适配：分阶段升级计划文档不 vendor（本 Note 持有记录）、V9 的精确配置监视覆盖指向 `packages/boot/hmr-coordination`（Harniverse 保留仅配置重载的 HMR 层，无模块替换）、V27 覆盖去掉 `creation-recommendations` 引用（未吸纳）。一条 Harniverse 独有条目重放为 **V28**（logger-console 时间戳颜色，ANSI 7）。

调用面迁移，逐项跟随官方升级提交：

- Registry Impl 生命周期访问 `impl.fiber` → `impl.ctx.fiber`（`agent-presets` mount 泄漏/服务归属、`tool-cordis` inspect）——`Entry.fiber` 现持有注册表包装器。
- 只读预设树改覆写新的 `commit(_change)` 接缝而非已退役的 `write()`——否则 journal 会把自处置持久化进预设文件。
- `watchUserPatches` 增加引入失败包容：rc.8 把行失败包容在组更新内（记日志、fiber 留失败态）而非 reject，因此每次刷新审计 include 子树（`subtreeActivationFailures`）、恢复上一代补丁、并向协调层抛错广播。产品承诺不变——用户层刷新要么整体激活、要么保持上一良好代。
- `directory-picker-auto` 在 `ctx.loader.create` 后检测无 fiber 行（rc.8 包容导入失败），并把 `EntryTree.remove` 当作其现在的同步操作。
- `internal/dispatch` 监听器收窄 `string | symbol` 事件名（`scope`、`workflow` invariants）；对可能缺席的已声明服务的上下文属性读取使用 `'x' in ctx` 守卫（gateway 测试）。
- 启动诊断保持 `assertEntriesActivated` 的形状；钉已退役 loader 诊断（"failed to apply loader entry …"）的测试改钉 rc.11 结果，事务性 loader 测试随其钉的行为一并退役——主体移入复制的 vendor 规格（`scripts/cordis-{entry-commit,include-journal,config-access,core-lifecycle,loader-resolve,vendor-hmr-include,timer}.spec.ts`、`volatile-config.spec.ts`；`loader-volatile-update.spec.ts` 未复制，因其驱动 Harniverse 不随附的官方 `dsh-hmr`）。
- Vendored HMR 的 `registerConfig` API 随官方升级消失；Harniverse 的精确配置监视本就在 `hmr-coordination`（17 测试套件），`app-boot/tests/hmr-config.spec.ts` 随其钉的面一并删除。

js-yaml v5 解锁**未**随批：更新后的 `include@1.1.0` 仍为 `!!js` 构造 `new yaml.Type(...)` 并钉 `js-yaml@^4.1.0`。workspace hold 保留，注释更新为记录本次同步的验证。

## 考虑过的替代方案

**在旧基线上重放分阶段 PR 序列。** 官方把升级拆成八个协调 PR 针对其树；Harniverse 的调用面更小（无 `dsh-hmr`、无模块替换），直接采纳其成品树携带已验证的补丁重放，无需重建分期。

**把已退役的事务性组更新补丁重新加回为本地 mod。** rc.8 的逐行包容加 journal 持久化取代全有或全无语义；恢复它们会逆着上游选定的方向重新 fork loader。真正要紧的产品级保证（用户补丁刷新保上一良好代）改在可观察的 boot 层强制。

**保留 vendored `registerConfig` 轮询监视器。** 官方把精确配置监视移出 vendored HMR；Harniverse 的 `hmr-coordination` 已以同等覆盖持有该角色。逆着上游删除保留私有 vendor API 没有消费者。

## 后果

Loader 失败逐行包容，经启动审计、fiber 拒绝或 `hmr-coordination` 广播呈现，而非组更新 reject；假设更新会 reject 的代码必须显式审计（`watchUserPatches` 是模板）。Include 持久化是 journal 模型：`flush()` 重试未写变更、未保存期间 reject，`stop()` 排空并报告同样结果，预设树经空 `commit` 保持只读。失败的 fiber 在其依赖恢复后保持失败——恢复是显式 `fiber.update(fiber.rawConfig, true)`。已声明但未提供服务的上下文属性访问会抛错（预期缺席处用 `'x' in ctx` 守卫）；`Fiber.config` 是原始值而 `effectiveConfig` 承载解析后的值。下一个 js-yaml major 仍阻塞在 vendored `include` 放弃 `Type` 类。

## 测试

`packages/boot/app-boot` 321/321、`hmr-coordination` 17/17、`agent-presets` 151/151、`gateway` 70/70、`directory-picker-auto` 15/15、`tool-cordis` + `scope` + `workflow` + `runtime-diagnostics` 196/196、`core`/`session`/`context`/`monitor`/`queue`/`capability` 2918/2918、复制的 vendor 规格 63/64、`typecheck` 0 错误、`build` 绿。剩余四个本地失败是 root 用户环境假象（`chmod` 无法拒绝 root：`cordis-include-journal` 只读写、`settings-file` 锁/不可读、`agent-instructions` 不可读发现）——非 root CI 上通过。

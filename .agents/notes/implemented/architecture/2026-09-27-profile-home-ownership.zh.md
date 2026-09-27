# Agent Note: 在 profile 启动前由组合包声明 home 所有权

Status: implemented

[English](2026-09-27-profile-home-ownership.md) | 中文

## Problem

Profile 准备阶段会在 Web 认证插件挂载前写入 Harness home。因此，网络实例租约无法阻止另一个 profile 进程同时改写共享的 profile 文件或会话状态；一次性 profile 甚至没有网络租约。

## Decision

`dsh` 在准备阶段之前，以只读方式调用 `loadProfile` 检查已有 manifest（元数据清单），或在 profile 缺失时检查随附模板。只有组合包列表非空且每个解析到的组合包都声明 `dsh.bundle.homeOwnership: "shared"` 时才允许共享；其他组合均要求获取规范化 home 下的进程生命周期租约 `runtime/instance.lease`。auth 组合包声明共享，使其由注册表自行协调的管理操作在 Web 持有 home 时仍然可用，包括远程引导所需的首个 owner 批准。启动器不按 profile 名称区分策略。

每次调用还会在写入 profile 文件之前，获取独立的 `runtime/profile-<encoded-name>.lease`。共享调用跳过全局模块后备链接修复，并通过安装锚点解析裸插件名。关闭、Loader 致命拒绝或启动失败时，只有插件树 dispose（资源释放）结算后才释放租约。插件树排空失败或超时时，保留所有权直至进程退出；后续调用可回收已退出持有者的租约。释放操作仅解除自身 nonce 对应的持有者记录链接，并在移除空目录时容忍 `ENOTEMPTY`、`ENOENT` 或 `EPERM`，保护在这两步之间到达的后继持有者。认证插件仍保留范围更窄的网络实例租约及浏览器认证规则。

## Alternatives considered

- 提前获取现有认证租约：不采用，因为它归 Web 认证提供方所有，无法覆盖 headless profile，也无法覆盖提供方挂载前的写入。
- 通过 Web 监听端口互斥：不采用，因为两个进程可以使用不同端口，却仍然写入同一个 home。
- 按名称豁免 auth profile：不采用，因为重命名的 profile 和第三方管理组合包需要相同策略，而自定义 auth 组合可能包含要求独占的组合包。
- 不获取 profile 租约就允许同一共享 profile 并发运行：不采用，因为即使提供方写入自行协调，profile 初始化、根配置重写和 Loader 写回仍然操作相同文件。

## Consequences

并发运行的独占 profile 必须使用不同的 `DSH_HOME`。共享组合包承诺其提供方及用户添加的 patch 可安全地与 home 持有者并存；该声明不是并发沙箱。共享 profile 中的裸插件必须能从已安装宿主解析。`dsh plugin` 和离线配置输出不是 profile 运行，不获取这些租约。

聚焦测试覆盖只读元数据检查、保守默认策略、并发争用、规范化别名、已退出持有者回收、保护后继持有者的释放、启动失败清理，以及插件树排空期间或拆卸失败时保留所有权。真实源码入口子进程验证持有 home 租约时 auth list/help 可运行、重命名的共享 profile 可运行、同一 profile 被拒绝，以及 Web/headless 或混合组合在写入 profile 文件之前被拒绝。配对契约位于 [app-boot](../../../../packages/boot/app-boot/README.md)、[CLI 参考](../../../../apps/cli/reference/README.md) 和 [auth-app](../../../../packages/bundle/auth-app/README.md)，各自均有同级中文文件及具名配对记录。Windows 文件系统行为和全仓库覆盖率须由相应 CI runner 验证；聚焦 Linux 检查不证明这两项。

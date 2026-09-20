# `@deepseek-ai/dsh-hmr-coordination`

[English](README.md) | 中文

Harniverse 的协调式引导层配置重载：单一独占队列、连续变更合并、嵌套拒绝、失败广播与销毁排空，构建于 chokidar 精确路径监视之上。

vendored 的 Cordis HMR 插件继续拥有模块替换与 Include 刷新（内部并发不可改）。本 additive 层拥有 Harniverse 自己发起的重载工作——`dsh-app-boot` 中经 `watchUserPatches` 注册的用户 patch 层与 `apps/cli` 的 profile 引导。`runExclusive` 在共享队列上一次运行一个任务，拒绝嵌套（`coordinated reloads cannot be nested`）与销毁后的新工作（`HMR coordination is disposed`）；`watchConfig` 精确监视一个文件（支持父目录尚不存在），把每次变更送入队列，并在刷新进行中落盘的写入合并为一次额外执行；失败的执行以规范文件名广播 `hmr-coordination/config-update-failed` 并继续监视。插件提供 `ctx.hmrCoordination`，并随其 fiber 销毁协调器。

## Model Experience

无：该引导生命周期协调服务不贡献任何模型可见上下文。

#### KV Cache effect

无；请求不经过重载协调。

## Known Limitations and Deferred Work

- **模块替换与 Include 刷新留在 vendored 插件** —— 精确配置队列只覆盖经本服务注册的重载；vendored HMR 插件的内部派发按设计保持不协调（additive 层无法触及）。
- **注册时不刷新** —— 与 vendored `registerConfig` 不同，监视器注册时不执行刷新；调用方自行组装初始状态，首次编辑触发首次刷新。

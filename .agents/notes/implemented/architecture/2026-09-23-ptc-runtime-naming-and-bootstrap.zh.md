# Agent Note: PTC runtime naming and Electron child bootstrap

Status: implemented

[English](2026-09-23-ptc-runtime-naming-and-bootstrap.md) | 中文

## Problem

产品文案、包名与运行时服务使用不同名称指代程序化工具调用，导致能力的 Definition、Provider 和 Consumer 难以对应。发布前可以统一命名，无需增加兼容别名。

Node 提供方启动不继承宿主环境的新子进程。在 Electron 中，`process.execPath` 指向 Electron；缺少 Node 引导开关时，执行它会启动应用而非程序运行时。继承宿主环境还会向模型程序暴露凭据。

## Decision

PTC 统一命名产品呈现方式和能力家族。[`ptc-runtime`](../../../../packages/ptc-runtime/ptc-runtime/README.md) 在 `ctx.ptcRuntime` 定义 `PtcRuntime`；[`ptc-runtime-node`](../../../../packages/ptc-runtime/ptc-runtime-node/README.md) 和 [`ptc-runtime-python`](../../../../packages/ptc-runtime/ptc-runtime-python/README.md) 提供服务。工具注册表仍是 Consumer。`code` 等持久化预设标识、`run_code` 工具和分派事件名称保留原有身份。当前源码、配置、包元数据和生成目录统一使用新名称，不提供别名。

Node 提供方仅在启动 Electron 宿主自己的可执行文件时设置 `ELECTRON_RUN_AS_NODE=1`。独立配置的 Node 可执行文件不接收 Electron 开关。源码及构建入口通过 argv 接收堆上限。打包可执行文件的自调用保留路由标记和 `NODE_OPTIONS` 堆上限；显式配置的 Node／引导入口组合使用已安装入口，绕过打包路由。子进程入口在执行模型代码前删除这三个仅供引导使用的变量。

宿主绑定发起的嵌套运行时调用创建独立子进程，各自拥有控制通道和预算。模型创建的子进程看到的是清理后的环境；复用 Electron 可执行文件时，必须显式选择其 Node 模式。提供方的沙箱限制、输出上限、截止时限和静默清理保留既有所有权。

本篇负责命名与可执行文件引导。历史[呈现基础决策](../feature/2026-06-15-code-mode.md) 仍说明注册表所有权及 SDK 分派边界；其更广泛的决策仅被部分替代。

## Alternatives considered

**为旧运行时名称提供兼容别名。** 发布前契约拒绝此方案：别名会为同一服务保留两个公开名称，让旧配置错误在改名后继续存在。

**继承宿主环境。** Electron 只需要一个引导开关，而环境中可能包含提供方凭据和应用状态，因此拒绝此方案。提供方显式构造所需环境，入口删除仅供引导使用的值。

**始终要求独立安装 Node。** 不作为默认方案，因为启用 `runAsNode` fuse 后，Electron 自身即可运行已安装的子进程入口。禁用该 fuse 的部署仍可显式配置 Node 和引导路径。

## Consequences

部署必须使用新包名和 `ptcRuntime` 服务；已存储的预设与工具身份保持稳定。Electron 发行版必须启用 `runAsNode`，或配置真正的 Node 可执行文件和子进程入口。子进程程序仍具有等同 Bash 的信任级别；环境清理不构成安全沙箱。

启动计划回归区分普通 Node、Electron 自调用、显式 Node 与打包路由。源码及构建子进程执行检查证明模型代码无法看到引导变量和宿主测试密钥；嵌套执行检查证明进程和输出各自独立。通过模拟 Electron 版本在 Node 下覆盖选择逻辑，因此实际 Electron 发行版和打包可执行文件仍需发行级启动检查。

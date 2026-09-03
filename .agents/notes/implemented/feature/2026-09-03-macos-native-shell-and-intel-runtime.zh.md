# Agent Note: macOS 原生 shell 与 Intel runtime 覆盖

状态：已实现

[English](2026-09-03-macos-native-shell-and-intel-runtime.md) | 中文

## 问题

macOS 用户已经拥有 POSIX 执行面，但本地一次性执行和持久 shell 路径仍以 Bash 为默认，因为 macOS 的标准 shell 实际是 zsh。runtime wheel 发布还只覆盖 Apple Silicon，没有原生 Intel macOS 产物，使一个受支持的主机架构缺少发布验证。

## 决策

shell capability 负责平台默认值。一次性本地执行和沙箱执行在 macOS 上使用 `/bin/zsh -c`，其他平台使用 `bash -c`。持久 terminal backend 在 macOS 上使用 `/bin/zsh -f -i`，其他平台使用 `/bin/bash --noprofile --norc -i`。Bash 保留 `PROMPT_COMMAND` 标记；zsh 则在 `PS1` 中携带等价的私有 OSC 标记，因此就绪语义保持不变。显式 shell 配置仍然优先。

runtime manifest 负责 `macos-arm64` 和 `macos-x64` 两组 wheel 标签与可执行文件名。GitHub 和 GitLab 的原生发布任务可以构建并校验两个 macOS 目标，包括每个可执行文件的 `node-pty` spawn helper 及 Mach-O 部署目标；本次变更不执行发布。拉取请求 CI 运行原生 macOS 单元测试和真实 Seatbelt 测试，作为独立的非阻断信号，不加入 `all-checks-passed` 依赖。

## 考虑过的替代方案

**继续把 Bash 作为 macOS 默认值。** 否决，因为这与主机标准 shell 不一致，并使直接 shell 执行偏离平台默认行为。

**让一个 macOS runtime 产物兼容两个架构。** 否决，因为可执行文件和原生 `node-pty` helper 都按架构区分。

**继续只在 master CI 校验 Seatbelt。** 否决，因为即使 macOS runner 不加入阻断合并的 verdict，shell 和沙箱回归仍能从拉取请求信号中获益。

## 后果

Linux 和 Windows shell 行为保持不变。macOS shell 输出与 prompt 就绪检测保持相同的 capability contract，只在标记实现上使用 zsh 专属路径。完整的手工 Python 发布验证可以生成一个 SDK wheel 和四个原生 runtime wheel；选择目标的构建只保留请求的 runtime wheel，本次变更不会发布这些产物。当前 Linux 环境无法执行 macOS shell、Seatbelt 或 Intel 构建路径；原生 macOS CI 仍是这些路径的权威验证。

## 验证

相关 shell 与 workflow 测试在本地通过；Python 部署目标测试通过；类型检查、构建、YAML 解析和文档门禁通过。完整单元测试在 root 身份下仍保留既有权限 fixture 失败，因此这些测试需要非 root 环境或原生 CI runner 才能最终确认。

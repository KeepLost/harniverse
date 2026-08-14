# 使用 Web UI

[English](index.md) | 中文

先按照[根 README](../../../README.md#run)启动 Web UI；命令会打印其访问地址。本指南从服务器已经运行的状态开始。`dsh` 进程会把调用目录作为默认文件系统位置，但新的 Web UI 在添加工作区前不会选中任何工作区。

## 配置模型

打开**设置 → 模型**，添加目录提供方或自定义提供方，按需输入凭据并保存。模型路由会立即可用，不需要重启服务器。

[模型配置指南](./providers.md)介绍目录提供方、自定义端点与可选的原生 DeepSeek 适配器。

## 选择工作区

点击**选择工作区**，添加启动 `dsh` 时所在的项目目录，然后选中它。选中工作区前，会话输入框不可用。

## 运行任务

启动一个会话并发送：

> Summarize this repository and identify its main packages.

agent 可以读取和编辑工作区文件、运行命令、委派工作并维护计划。当操作在当前权限策略下需要审批时，Web UI 会先询问你。

## 继续使用

- [配置模型](./providers.md)
- [使用 Python SDK](./python-sdk.md)
- [使用其他 CLI 模式](../../../apps/cli/README.md)
- [开发插件](../develop/basic/)

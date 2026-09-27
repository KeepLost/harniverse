# Agent Note: 作为静态 system-prompt 区块的环境事实

Status: implemented

[English](2026-09-26-environment-facts-section.md) | 中文

## 问题

Agent 在不知道自己运行环境的情况下执行 shell 命令、选择命令行旗标并推理路径。提示词中唯一的平台事实是 `tool-bash` 描述里硬编码的 `bash -c` —— 这在 macOS 上是错的（执行器在那里运行 `/bin/zsh -c`）；工作目录则作为一句话附着在 persona 文本上。受管的 `$DSH_*` shell 变量同样不暴露平台事实，模型无法从被给予的环境中发现自己的 OS 或 shell。

## 决策

新增 preset 行包 `@deepseek-ai/dsh-environment`（`packages/preset/environment`），注册一个 order −90 的静态 system-prompt 区块 `environment:facts` —— 位于 harness identity 之后、工具指引之前。区块文本在挂载时由进程稳定的平台事实计算一次；只有工作目录保持为 `{{cwd}}` prompt 变量，按 agent 从会话头解析 —— 会话生命周期内固定，不随轮次刷新。事实及其来源：

| 事实 | 来源 |
|---|---|
| OS | 粗粒度平台标签（`Linux`、`macOS`、`Windows`；其余原样透出） |
| Shell | harness 的执行选择：macOS 为 `zsh`，Windows 为 PowerShell，其余为 `bash` |
| 用户空间 | Linux 上为 `GNU`，存在 `/etc/alpine-release` 时为 `BusyBox`，macOS 上为 `BSD`；Windows 上省略 |
| 工作机器 | 主机名 |

四个 agent preset 都在 `dsh-persona` 旁挂载该行；每个独立的 example 组合也在其 persona 旁加入该行，基于 include 的 overlay 从基座继承。所有 persona 文本统一改为 `powered by {{provider}}/{{model}}` —— preset、headless 与 web-app 的部署 persona、以及全部 example 组合 —— 并删除 `{{cwd}}` 句（该事实改由 environment 区块承载）。`tool-bash` 的描述改为经 `defaultShellName()` 渲染，macOS 上的 agent 看到 `zsh -c`，描述与执行器一致。

## 备选方案

**动态 runtime-context 贡献。** 否决：context 会以"取代先前快照"的方式重新物化，而这些事实在会话内不可能变化；静态区块更便宜也更真实。

**现在就为 `ExecutionWorldDescriptor` 增加平台字段。** 本轮否决：当前没有任何组合把 environment 行与 SSH 远程 profile 同时挂载，这些字段将成为没有读取方的 wire 表面。包 README 把升级路径（在 descriptor 上发布平台事实并在此解析）记录为 Known Limitation，而不是投机性地扩展 wire。

## 后果

每个挂载该 preset 的 agent 在发出第一条命令前就知道自己的 OS、shell、用户空间族、机器标签与会话内固定的工作目录。该区块位于静态请求前缀，会话内 KV-cache 稳定。认为主机名敏感的部署从自己的 preset 副本中移除该行即可。在 descriptor 扩展落地之前，远程会话仍报告宿主机事实；environment README 写明了这一点。`skill-filesystem` 的 `providerName` JSDoc 也已修正为与实际的 `filesystem` 默认值一致。

## 测试

`packages/preset/environment/tests/environment.spec.ts` 覆盖各平台的检测（含 Alpine BusyBox 探测）、带与不带用户空间从句的区块文本、scope 内注册、经注册表的 `{{cwd}}` 插值，以及 fiber 卸载后的移除（HMR 安全）。`packages/preset/agent-presets` 的组合测试覆盖更新后的 persona 默认值。聚焦套件：`pnpm exec vitest run packages/preset packages/shell/tool-bash`。

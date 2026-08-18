# Harniverse

[English](README.md) | 中文

Harniverse 是本仓库维护的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 源码优先下游项目。它保留由 Cordis 驱动的**一切皆插件**架构，并通过相同的插件 seam（接缝）组合 Harniverse 特有能力与安全策略。

Harniverse 目前没有独立的 npm 发行包。`npx @deepseek-ai/dsh` 安装的是 DeepSeek Harness 官方包，而不是本下游项目；请按以下源码流程使用 Harniverse。

## 快速开始

本教程从一台新机器开始，以 Web UI 收到第一条模型回复为完成标志。

### 1. 检查前置条件

请安装：

- Git 2.26 或更高版本。
- Node.js 22.19.x，或 Node.js 24 及更高版本。
- pnpm 11.7.0。仓库通过 `packageManager` 固定该版本；如果 `pnpm --version` 不可用，请启用 Corepack 或按 pnpm 官方安装方式安装。

克隆前先检查工具：

```sh
git --version
node --version
pnpm --version
```

安装和启动 Web UI 不需要模型 API 密钥；登录后再配置提供方。

<a id="run-from-source"></a>

### 2. 从源码安装 Harniverse

```sh
git clone https://github.com/KeepLost/harniverse.git
cd harniverse
pnpm install
pnpm run build
```

构建会生成源码启动器所需的 Host、Client 和 Web 前端产物。请保留该 checkout；后续命令通过仓库根目录的 `pnpm dsh` 脚本运行 Harniverse。

### 3. 启动 Web UI

在终端 A 中进入 Harniverse checkout 并运行：

```sh
pnpm dsh web
```

首次运行会初始化 `web` profile 并打印实际访问地址，默认为 `http://127.0.0.1:3080`。保持终端 A 运行，然后在浏览器中打开该地址。

运行时 profile、认证 Grant（授权）、凭据、设置与会话位于 `$DSH_HOME` 下，其默认值为 `~/.dsh`。

### 4. 批准第一台浏览器

浏览器会先打开设备配对页，再加载应用：

1. 输入设备名称。
2. 选择**配对个人设备**。
3. 保持页面打开，记下页面显示的批准码与 request id。

在终端 B 中，以同一个操作系统用户进入同一 checkout，并将该请求批准为首个 owner：

```sh
pnpm dsh auth device approve <request-id> --profile owner
```

如果需要重新查看 request id，请列出等待中的请求：

```sh
pnpm dsh auth device list
```

浏览器会轮询请求状态，并在批准后自动进入应用。页面按安装后使用方式显示 `dsh auth ...`；源码用户应通过 `pnpm dsh auth ...` 运行同一命令。

两个终端必须解析到同一个 `DSH_HOME`。如果你覆盖了该变量，Web 与 auth 命令必须使用相同的值，否则 auth 命令看不到浏览器请求。

### 5. 配置并选择模型

新安装在配置提供方之前没有可用的模型路由：

1. 打开**设置 → 模型**。
2. 对已安装的目录提供方选择**添加提供方**，或为 OpenAI 兼容端点选择**添加自定义提供方**。
3. 输入所需凭据并保存提供方。
4. 在模型选择器中选择该提供方的一个模型。

提供方会立即可用，无需重启 Harniverse。通过 UI 保存的密钥是只写的：凭据存储将密钥保存在 `$DSH_HOME/.credentials.yaml`，settings 只保留其引用。原生凭据、自定义端点与模型能力详见[配置模型](docs/user/guide/providers.md)。

### 6. 选择工作区并运行首个任务

选择**选择工作区**，添加允许 Harniverse 操作的项目目录，再选中它。新的 Web UI 刻意不预选工作区；工作区与模型均未选定前，会话输入框保持不可用。

创建会话并发送：

> Summarize this workspace and list its main components.

收到 assistant 回复即完成首次使用流程。受保护的操作会按照当前权限策略请求批准。

## 日常使用与更新

首次设置完成后，通过同一 checkout 启动：

```sh
cd harniverse
pnpm dsh web
```

使用 `Ctrl+C` 停止。浏览器 Grant、提供方设置、profile 与会话会保留在 `$DSH_HOME` 中。

更新 checkout 后，请先刷新依赖和全部运行时产物，再重新启动：

```sh
git pull
pnpm install
pnpm run build
pnpm dsh web
```

## Headless 使用

Headless profile 使用同一个 Harniverse home、提供方设置与凭据存储。配置模型后，无需 Web UI 即可运行一个任务：

```sh
pnpm dsh --profile headless "Summarize the current project"
```

调用命令时所在的目录是 headless 执行的默认工作区。命令会打印 assistant 的最终回复并退出。

## 网络安全

默认回环监听也会启用认证。不要把 `--dangerously-skip-authentication` 当作安装捷径。非回环监听必须提供 TLS 证书和密钥；向其他机器开放 Harniverse 前，请先阅读 [Web UI 指南](docs/user/guide/index.md#remote-access)。

## 排错

- **`pnpm install` 报告 engine 不匹配**：使用 Node.js 22.19.x，或 Node.js 24 及更高版本。
- **启动时报 frontend dist 缺失**：在仓库根目录运行 `pnpm run build`。
- **`dsh: command not found`**：本源码流程使用 `pnpm dsh`，不依赖全局可执行文件。
- **auth 命令找不到请求**：确保两个终端由同一用户运行并使用同一 `DSH_HOME`，再运行 `pnpm dsh auth device list`。
- **Web UI 可以打开但不能发送**：配置并选择模型，再选择工作区。
- **3080 端口已被占用**：使用 `pnpm dsh web --port <port>` 选择其他回环端口。

## 项目关系与状态

Harniverse 继承 DeepSeek Harness、其 `dsh` CLI、`@deepseek-ai/dsh-*` 包命名空间和 Cordis 插件架构。[PLUGINS.md](PLUGINS.md) 记录官方基线、下游能力族、已交付组合变更及其实现提交，是下游差异的权威来源。

在 Harniverse 建立带 tag 的兼容性承诺前，源码接口与持久化格式可能发生不兼容变更。继承的 npm 命名空间并不表示已经存在独立的 Harniverse 发行包。

请通过 [Harniverse Issues](https://github.com/KeepLost/harniverse/issues) 报告 Harniverse bug 与文档问题。公开插件仓库可添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic，便于生态发现。

## 参与贡献与开发

提出改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。贡献者从[开发指南](docs/development.md)开始，阅读[架构文档](docs/architecture.md)，并使用 [PLUGINS.md](PLUGINS.md) 核对下游边界。agent 遵循 [AGENTS.md](AGENTS.md)。

## 许可证与归属

Harniverse 按 [MIT License](LICENSE) 分发。它派生自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)；后者由 [DeepSeek AI](https://deepseek.com) 开发。Harniverse 使用 [Cordis](https://github.com/cordiverse/cordis)，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

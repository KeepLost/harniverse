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

1. 输入由 1 至 64 个字母或数字组成的设备名称，可包含空格、点、下划线或连字符；支持 `我的设备` 等 Unicode 名称。
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

使用 `pnpm dsh auth grant list` 列出已批准设备和 API client；它与 `device list` 不同，会显示已经提交的 Grant 及其 id、名称、类型、capability 和过期时间。已经认证的 owner 浏览器也可以在同一 Web origin 打开 `/auth/manage`，例如 `https://127.0.0.1:3000/auth/manage`，查看等待请求与已批准 Grant。认证活动以 owner-only JSONL 保留在 `$DSH_HOME/auth/access.jsonl`；测试时可以持续查看：

```sh
tail -f "${DSH_HOME:-$HOME/.dsh}/auth/access.jsonl"
```

Web profile 会把信任策略和连接／认证事件输出到服务器终端。每条事件包含 method 或 channel、path、peer 地址、Host、Origin，以及已知的非机密 Grant 名称／id；不会输出 cookie、Authorization 值、公钥或请求体。owner-only 审计文件仍是持久化的最小隐私记录。

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

如果容器发布端口而必须绑定 `0.0.0.0`，不要直接调用 `dsh web`，改用容器启动器：

```sh
pnpm run web:container -- --port 3000
```

`web:container` 不是另一个 profile，也不会使用另一套 Web 组合。原来的 `pnpm dsh web --host 0.0.0.0` 命令仍是直接部署入口，并且在没有显式证书路径时仍会拒绝启动。该包装器只负责创建或复用开发证书、处理信任设置，然后使用与下列参数等价的方式启动同一个需要认证的 `web` profile：

```sh
pnpm dsh web \
  --host 0.0.0.0 \
  --port 3000 \
  --tls-cert "$DSH_HOME/tls/harniverse-dev-server.crt" \
  --tls-key "$DSH_HOME/tls/harniverse-dev-server.key" \
  --trusted-host localhost 127.0.0.1 host.docker.internal
```

它会在 `$DSH_HOME/tls` 下创建并持久化开发 CA 与服务器证书，在镜像允许时把 CA 安装进 Linux 容器的系统信任库，然后以 HTTPS 启动仍然需要认证的 Web profile。请将 `DSH_WEB_TLS_HOSTS` 设置为浏览器实际使用的名称或 IP 地址（逗号分隔），并把 `$DSH_HOME` 挂载为 volume，使容器替换后仍复用同一个 CA。启动器会把这些 host 同时传给 Host 信任栅栏，并在启动时打印生效的 host 与显式 Origin。浏览器宿主机针对这个已挂载的 `DSH_HOME` 运行一次 `pnpm run web:container:trust`；该命令会调用 Linux、macOS 或 Windows 的系统信任工具，并可能请求管理员批准。生产环境则使用受信任的反向代理。

### Tailscale 远程访问

如果浏览器位于另一台 Tailscale 设备上，请使用服务器的 Tailscale IP 或 MagicDNS 名称，不要使用打印出来的 `127.0.0.1` URL。把浏览器实际使用的 authority 同时加入证书 SAN 与 Host allowlist，然后重启启动器：

```sh
export DSH_WEB_TLS_HOSTS=localhost,127.0.0.1,host.docker.internal,100.64.0.2
pnpm run web:container -- --port 3000
```

在远程设备打开 `https://100.64.0.2:3000`，在该设备安装开发 CA，然后完成正常的设备配对和 owner 批准。将 `100.64.0.2` 替换为服务器实际的 Tailscale IP 或 MagicDNS 名称。这种普通 Tailscale 路径是同源访问，只需配置 `DSH_WEB_TLS_HOSTS`；不要为它设置 `DSH_WEB_TRUSTED_ORIGINS`。

`DSH_WEB_TRUSTED_ORIGINS` 是高级集成选项，用于浏览器页面的精确 Origin 与已声明的 Harniverse 请求 Host 不同的情况，例如独立托管的控制面板。它只允许该 Origin 通过 Harniverse 的请求信任栅栏，不会添加 CORS 响应头、处理浏览器 preflight，也不会自动让独立 Web 应用具备跨 Origin 兼容性。这类集成必须自行提供完整的 CORS 或同源反向代理设计。只有把它作为完整部署的一部分时，才通过环境变量或重复的 `--trusted-origin` 配置精确 Origin：

```sh
export DSH_WEB_TRUSTED_ORIGINS=https://panel.example.test
pnpm dsh web --host 0.0.0.0 --port 3000 \
  --tls-cert /path/server.crt --tls-key /path/server.key \
  --trusted-host harniverse.example.test \
  --trusted-origin https://panel.example.test
```

启动行会显示生效的 `hosts` 和显式 `origins`。被拒绝的请求会以 403 记录 Host、Origin、Fetch-Metadata 标记、peer 和 path；通过信任栅栏与认证的请求会记录设备／Grant 和 channel。远程浏览器使用证书或 Host 列表中不存在的名称或 IP 时，会被有意拒绝，不会静默绕过栅栏。

## 排错

- **`pnpm install` 报告 engine 不匹配**：使用 Node.js 22.19.x，或 Node.js 24 及更高版本。
- **启动时报 frontend dist 缺失**：在仓库根目录运行 `pnpm run build`。
- **`dsh: command not found`**：本源码流程使用 `pnpm dsh`，不依赖全局可执行文件。
- **auth 命令找不到请求**：确保两个终端由同一用户运行并使用同一 `DSH_HOME`，再运行 `pnpm dsh auth device list`。
- **已批准设备没有出现在 `device list` 中**：该命令只显示等待中的请求；使用 `pnpm dsh auth grant list` 查看已批准 Grant。
- **终端没有连接行**：修改源码或信任环境后必须重启当前 Web 进程，然后检查启动时的 `dsh web trust:` 行。通过和拒绝的连接都会输出非机密请求标记；持久化准入审计仍在 `$DSH_HOME/auth/access.jsonl`。
- **Tailscale 浏览器收到 `403 forbidden`**：URL 使用服务器准确的 Tailscale IP 或 MagicDNS 名称，把同一个值加入 `DSH_WEB_TLS_HOSTS`，在浏览器设备信任生成的 CA，并重启 `pnpm run web:container`。
- **自定义 UI Origin 收到 `403 forbidden`**：请求 Host 仍需位于 `--trusted-host`，再通过 `DSH_WEB_TRUSTED_ORIGINS` 或 `--trusted-origin` 添加精确的 `https://host[:port]` Origin。这只会改变请求信任栅栏；部署仍须单独提供可用的 CORS 或同源代理。路径、凭据、query string 和通配符 Origin 都会被拒绝。
- **Web UI 可以打开但不能发送**：配置并选择模型，再选择工作区。
- **3080 端口已被占用**：使用 `pnpm dsh web --port <port>` 选择其他回环端口。
- **容器拒绝 `--host 0.0.0.0`**：使用 `pnpm run web:container -- --port 3000`，不要手工准备证书文件。

## 项目关系与状态

Harniverse 继承 DeepSeek Harness、其 `dsh` CLI、`@deepseek-ai/dsh-*` 包命名空间和 Cordis 插件架构。[PLUGINS.md](PLUGINS.md) 记录官方基线、下游能力族、已交付组合变更及其实现提交，是下游差异的权威来源。

在 Harniverse 建立带 tag 的兼容性承诺前，源码接口与持久化格式可能发生不兼容变更。继承的 npm 命名空间并不表示已经存在独立的 Harniverse 发行包。

请通过 [Harniverse Issues](https://github.com/KeepLost/harniverse/issues) 报告 Harniverse bug 与文档问题。公开插件仓库可添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic，便于生态发现。

## 参与贡献与开发

提出改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。贡献者从[开发指南](docs/development.md)开始，阅读[架构文档](docs/architecture.md)，并使用 [PLUGINS.md](PLUGINS.md) 核对下游边界。agent 遵循 [AGENTS.md](AGENTS.md)。

## 许可证与归属

Harniverse 按 [MIT License](LICENSE) 分发。它派生自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)；后者由 [DeepSeek AI](https://deepseek.com) 开发。Harniverse 使用 [Cordis](https://github.com/cordiverse/cordis)，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

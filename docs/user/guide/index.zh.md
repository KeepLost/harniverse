# 使用 Web UI

[English](index.md) | 中文

本教程接续根 README 中的[源码安装流程](../../../README.md#quick-start)，详细介绍浏览器注册、模型设置、工作区选择和网络服务，并以新会话收到第一条 assistant 回复为完成标志。

## 启动服务器

克隆或更新 Harniverse 后先构建一次，再从仓库根目录启动 Web profile：

```sh
pnpm run build
pnpm dsh web
```

首次运行会初始化 `$DSH_HOME/profiles/web` 并打印实际访问地址，通常为 `http://127.0.0.1:3080`。保持该终端运行。`$DSH_HOME` 默认为 `~/.dsh`，也负责保存认证 Grant（授权）、凭据、设置与会话。

## 注册首个 owner 设备

打开终端打印的地址。浏览器插件加载前，认证页会要求输入设备名称。名称由 1 至 64 个字母或数字组成，可以包含空格、点、下划线或连字符，也支持 `我的设备` 等 Unicode 名称。选择**配对个人设备**，保持页面打开并记下批准码与 request id。

在同一 checkout 的第二个终端中批准该请求：

```sh
pnpm dsh auth device approve <request-id> --profile owner
```

需要时可通过以下命令重新取得 request id：

```sh
pnpm dsh auth device list
```

浏览器在本地保存其私有设备密钥，轮询等待中的请求，并在批准后自动进入 Harniverse。服务器持久化公钥 Grant。注册表密封且尚无 owner 时，该批准命令仍可引导首个 owner，并且不会打开另一个网络 listener。

浏览器页面显示的是安装后形式 `dsh auth ...`；源码 checkout 使用 `pnpm dsh auth ...`。两个终端必须由同一个操作系统用户运行，并解析到同一个 `DSH_HOME`；不同 home 各有独立的等待请求注册表。

`pnpm dsh auth device list` 只列出等待中的请求。使用 `pnpm dsh auth grant list` 查看已批准设备和 API client；每一行包含 Grant id、名称、类型、capability 和过期时间。已经认证的 owner 也可以在同一 Web origin 打开 `/auth/manage`，查看等待请求与已批准 Grant。Web 服务器终端接收 Cordis warning 与 error。最小化的认证结果另外保留在 `$DSH_HOME/auth/access.jsonl`；测试时可使用 `tail -f "${DSH_HOME:-$HOME/.dsh}/auth/access.jsonl"` 持续查看这份 owner-only JSONL。

## 配置模型

新安装没有可用的模型路由。打开**设置 → 模型**，添加目录提供方或自定义提供方，按需输入凭据并保存。提供方变更会在下一次请求时生效，不需要重启服务器。

已配置的提供方会出现在模型选择器中。创建首个会话前先选择一个模型。[模型配置指南](./providers.md)介绍目录提供方、自定义端点、原生凭据、模型能力与可选的原生 DeepSeek 适配器。

## 选择工作区

点击**选择工作区**，添加允许 Harniverse 操作的项目目录，再选中它。调用命令时所在的目录会作为默认文件系统位置，但新的 Web UI 刻意不预选工作区。工作区与模型均未选定前，会话输入框保持不可用。

## 运行首个任务

启动一个会话并发送：

> Summarize this workspace and list its main components.

agent 可以读取和编辑工作区文件、运行命令、委派工作并维护计划。当操作在当前权限策略下需要审批时，Web UI 会先询问你。收到 assistant 回复即完成首次使用流程。

<a id="remote-access"></a>

## 向其他机器提供服务

本机使用时保留默认回环监听。绑定所有接口必须直接使用 TLS；非回环 listener 会拒绝认证绕过。请提供证书与密钥，并声明浏览器访问服务器时使用的每个 DNS authority：

```sh
pnpm dsh web \
  --host 0.0.0.0 \
  --tls-cert /absolute/path/to/cert.pem \
  --tls-key /absolute/path/to/key.pem \
  --trusted-host harniverse.example.com
```

`--trusted-host` 接受裸 `host` 或 `host:port`，不接受 URL 或路径。`--trusted-origin` 接受不带 path、query、凭据或通配符的精确 `http://` 或 `https://` Origin。Harniverse 会在启动时推导当前 LAN IP 字面量，但未从活动网卡推导出的 DNS 名称或 Tailscale 地址仍需显式声明 authority。通过 HTTPS 访问时仍须完成浏览器注册与 owner 批准。

如果容器必须绑定 `0.0.0.0`，请使用仓库提供的启动器，不要手工准备证书文件：

```sh
pnpm run web:container -- --port 3000
```

启动器会在 `$DSH_HOME/tls` 下创建并持久化开发 CA 与服务器证书，尝试把 CA 安装进 Linux 容器的系统信任库，再将生成的 HTTPS 路径传给 `dsh web`。请设置 `DSH_WEB_TLS_HOSTS=localhost,127.0.0.1,host.docker.internal`，或替换为浏览器实际使用的全部 authority。它会把列表传给 Host 信任栅栏，并以 `dsh web trust:` 打印生效的 host 与显式 Origin。请将 `$DSH_HOME` 挂载进容器，以保留 CA 与 owner 状态。在能够访问同一挂载 home 的浏览器宿主机上运行一次 `pnpm run web:container:trust`；该命令会通过宿主系统信任工具安装 CA，并可能请求管理员批准。请重启已经打开的浏览器。使用具有公开信任证书的反向代理可以完全避免开发 CA。

### Tailscale

供远程 Tailscale 浏览器访问时，把服务器准确的 Tailscale IP 或 MagicDNS 名称加入 `DSH_WEB_TLS_HOSTS`，重启启动器，再通过同一个 authority 使用 HTTPS：

```sh
export DSH_WEB_TLS_HOSTS=localhost,127.0.0.1,host.docker.internal,100.64.0.2
pnpm run web:container -- --port 3000
```

在远程设备打开 `https://100.64.0.2:3000`，并在该设备信任生成的 CA。除非远程路径实际是 localhost 转发，否则不要使用打印出的 `https://127.0.0.1:3000`。对于反向代理或其他明确配置的跨 Origin UI，可设置 `DSH_WEB_TRUSTED_ORIGINS=https://panel.example.test`，或重复 `--trusted-origin https://panel.example.test`；请求 Host 仍必须通过 `--trusted-host` 声明。

服务器会打印连接／认证通过和拒绝事件，包含 channel、path、peer、Host、Origin，以及已知的非机密设备／Grant 身份。不会打印 cookie、Authorization 值、公钥或请求体。信任拒绝会返回 403，并记录修正 allowlist 所需的准确标记。

## 排查启动问题

- **frontend dist 缺失**：在 Harniverse 根目录运行 `pnpm run build`。
- **找不到批准请求**：确认两个命令使用同一用户和 `DSH_HOME`，再列出等待中的设备。
- **已批准设备没有出现在 `device list` 中**：使用 `pnpm dsh auth grant list` 查看已提交 Grant。
- **终端没有连接行**：修改源码或信任环境后必须重启当前 Web 进程，再检查 `dsh web trust:` 行。通过和拒绝的连接都会输出非机密标记；`$DSH_HOME/auth/access.jsonl` 仍是持久化准入审计。
- **配对返回 409**：另一个 Grant 或等待请求正在使用该设备名称，请换一个名称。配对失败会显示服务器返回的可处理原因；500 响应对应的详细错误位于服务器终端。
- **会话输入框不可用**：配置并选择模型，再选择工作区。
- **3080 端口已被占用**：使用 `pnpm dsh web --port <port>` 重新启动。
- **远程浏览器被拒绝**：HTTPS URL、证书 SAN 与 `--trusted-host`／`DSH_WEB_TLS_HOSTS` 使用准确的 Tailscale IP 或 MagicDNS authority，重启服务器，并在浏览器设备信任 CA。
- **自定义 UI Origin 被拒绝**：请求 Host 仍需位于 `--trusted-host`，并通过 `--trusted-origin` 或 `DSH_WEB_TRUSTED_ORIGINS` 添加精确的 `https://host[:port]` Origin；path 和通配符无效。

## 继续使用

- [配置模型](./providers.md)
- [使用 Python SDK](./python-sdk.md)
- [使用其他 CLI 模式](../../../apps/cli/README.md)
- [开发插件](../develop/basic/)

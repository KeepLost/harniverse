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

打开终端打印的地址。浏览器插件加载前，认证页会要求输入设备名称。选择**配对个人设备**，保持页面打开并记下批准码与 request id。

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

`--trusted-host` 接受裸 `host` 或 `host:port`，不接受 URL 或路径。Harniverse 会在启动时推导当前 LAN IP 字面量，但 DNS 名称仍需显式声明 authority。通过 HTTPS 访问时仍须完成浏览器注册与 owner 批准。

## 排查启动问题

- **frontend dist 缺失**：在 Harniverse 根目录运行 `pnpm run build`。
- **找不到批准请求**：确认两个命令使用同一用户和 `DSH_HOME`，再列出等待中的设备。
- **会话输入框不可用**：配置并选择模型，再选择工作区。
- **3080 端口已被占用**：使用 `pnpm dsh web --port <port>` 重新启动。
- **远程浏览器被拒绝**：使用 HTTPS，并通过 `--trusted-host` 添加准确的 DNS authority。

## 继续使用

- [配置模型](./providers.md)
- [使用 Python SDK](./python-sdk.md)
- [使用其他 CLI 模式](../../../apps/cli/README.md)
- [开发插件](../develop/basic/)

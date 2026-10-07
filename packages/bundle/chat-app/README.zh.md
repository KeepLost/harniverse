# `@deepseek-ai/dsh-chat-app`

[English](README.md) | 中文

这是独立的 IM 聊天桥接组合包。`dsh chat` 启动该 profile；它不挂载 Web 服务、认证 Provider 或 Agent，也不监听端口。桥接器是运行中 Harniverse 的客户端：只通过一个操作员 Grant 访问本地 `/api`，因此 Telegram 和飞书消息与浏览器使用同一个经过认证的接口。

`chat-startup` 解析其余参数并发布 `chatStartup`。裸 `dsh chat` 与 `dsh chat run` 会挂载桥接行（`chat-adapters`、`chat-client`、`chat-telegram`、`chat-feishu`、`chat-bridge`）并持续运行直到停止。三个维护操作只挂载存储、凭据和 `chat-runner` 行，然后通过 `ctx.appExit` 请求有界退出：

- `dsh chat init` 创建 P-256 签名密钥，注册仅含 `harniverse.observe` 与 `harniverse.operate` 的 `chat-bridge` Grant，把密钥和 Grant id 存为凭据；若 `$DSH_HOME/profiles/chat/patch.yml` 尚不存在则写入配置模板，并打印一个 15 分钟内有效的一次性 owner 配对码。Harniverse 必须已有 owner 设备，否则会提示先完成浏览器登录。
- `dsh chat status` 只读：报告密钥、Grant 及其是否仍然有效、Harniverse 在 `--origin`（默认 `http://127.0.0.1:3080`）是否应答，以及桥接状态中的身份、会话和群数量。
- `dsh chat rotate-key` 替换密钥、注册新 Grant，并撤销旧 Grant。

平台令牌、Grant id 和签名密钥保存在 `$DSH_HOME/chat-bridge/credentials.yaml`（权限 0600）；桥接状态保存在 `$DSH_HOME/chat-bridge/storage`。两者都与 Web 组合的存储分开。通过 profile patch 编辑桥接行和平台行；patch 会替换该行的整个 config。

仅运行时的行使用 Loader 的 `disabled` 键，它在创建行时只求值一次，看不到兄弟插件稍后发布的服务。因此随附的 patch 读取启动器的 `cmdlineArgs` 快照，仅在无参数或参数为 `run` 时启用它们。对应的默认运行规则位于 `src/startup.ts`，两处必须保持一致。

其 manifest（元数据清单）声明 `dsh.bundle.homeOwnership: "shared"`，因此 Web 持有 home 租约时，`init`、`status` 和 `rotate-key` 仍然可用（参见 [profile 所有权](../../boot/app-boot/README.md#profiles)）。

## Model Experience

None, as this bundle only relays chat text to a Harniverse session and never creates an Agent or contributes model context itself.

#### KV Cache effect

None; the bundle performs no model request.

## Known Limitations and Deferred Work

- Telegram 和飞书目前只用 mock 测试过。接入真实平台需要把 bot token（Telegram）或应用 id 与 secret（飞书）存为凭据，并在 profile patch 中配置对应的行。
- 桥接器需要一个运行中的 Harniverse。它会重试，`status` 会显示可达性，但不会自行启动 Web。
- `dsh chat run --help` 以及 `run` 之外的参数形式只会打印帮助或错误，不会挂载桥接器。

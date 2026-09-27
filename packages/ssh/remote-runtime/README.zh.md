# @deepseek-ai/dsh-remote-runtime

[English](README.md) | 中文

`RemoteRuntime` 是默认导出的 `TypertRemoteService`，注册为 `ctx.remoteRuntime`，依赖 `agents`、`authentication`、`credentials`、`settings` 和 `webServer`。凭据服务必须是实际的 [`EncryptedCredentialProvider`](../../credentials/credentials-encrypted/README.md) 实例，不能用结构相似的对象代替。启动也会拒绝认证绕过以及非 `127.0.0.1` 监听地址。

## 控制契约

生成的 Remote 命名空间为 `remoteRuntime`。`./typert` 提供 Host 元数据，`./remote` 提供生成的客户端贡献。

| 方法 | 线上参数 | 所需能力 | 返回值 |
| --- | --- | --- | --- |
| `status()` | `{}` | `harniverse.observe` | `{ locked, bootId, platform, arch }` |
| `unlock(key)` | `{ key }` | `harniverse.administer` | void |
| `replaceCredentials(snapshot)` | `{ snapshot }` | `harniverse.administer` | void |
| `syncSettings(snapshot)` | `{ snapshot }` | `harniverse.administer` | void |

`key` 是加密提供者要求的 32 字节随机密钥，采用无填充的规范 base64url 编码。凭据快照类型为 `Record<string, string>`，替换会删除未包含的引用；`{}` 删除全部引用。设置使用现有 Session `JsonValue` 类型，而不是 `unknown`，因此 Typert 能生成严格的递归 JSON schema。先解锁，再替换凭据并同步设置；两项同步均成功后才开始 Agent 工作。错误密钥会保持锁定，或按照提供者契约保留已经解锁的会话。

`assertUnlocked(): void` 是同进程消费者可调用的实际准入检查，在锁定或已释放时抛错，不等待重连。插件通过 `ctx.agents.registerAdmission()` 注册该检查，卸载插件会移除策略。新建、恢复和分叉均受驱动的准入检查约束。浏览器或 SSH 连接断开不会锁定凭据或释放 Agent。加密提供者在自身释放时擦除密钥；即使已有加密文件，新进程仍从锁定状态启动。

## 设置同步

快照按命名空间包含完整、未脱敏的本地**用户设置节**。支持 `llm-deepseek`、`llm-pi-ai`、`agent-default-model`、`model-profiles`、`model-routes`、`web`、`web-search-deepseek`、`web-search-exa`、`web-search-perplexity`、`web-search-tavily`、`web-search-brave`、`web-search-kagi` 和 `web-firecrawl`。

提交的每个命名空间必须已经在远端注册，且值必须为对象。未知、无关或未注册的命名空间在写入前被拒绝。插件通过 `ctx.settings.replace()` 替换每个受支持且已注册的命名空间，保留其所有者的 schema 和语义验证。省略的命名空间收到 `{}`；省略的字段重新继承组合值与 schema 默认值。无关设置保持原样。若本地组合默认值需要覆盖远端默认值，应明确提交本地解析后的值。

并发快照在调用时复制并串行处理。各命名空间独立提交：验证或持久化失败时，之前的设置节可能已经提交。重试同一完整快照即可收敛；设置提供者没有跨命名空间事务。不要使用脱敏的 UI 描述符构造快照。

## 端点发现

`Config.dshHome` 覆盖发现目录，否则按标准 `DSH_HOME` 规则解析。服务端应用为凭据与发现使用同一个主目录，并通过共享启动库持有独占主目录租约。

启动原子发布 `server/endpoint.json`，内容为 `{ version: 1, host: "127.0.0.1", port, protocol, pid, bootId }`。端口是操作系统实际分配的监听端口；协议为 `http:` 或 `https:`。文件不包含密钥、凭据、令牌或签名材料。POSIX 上 `server/` 权限为 `0700`，文件为 `0600`。Windows 在写入前通过系统 PowerShell 设置受保护、仅允许当前用户访问且可继承的 DACL。符号链接形式的服务器目录会被拒绝。释放时，仅当启动标识和 PID 仍匹配当前实例，才删除描述符。

## 模型体验

没有直接影响：此 Host 插件不添加提示词、工具、消息或模型请求。同步的模型和搜索设置由现有所有者插件生效。

#### KV 缓存影响

没有直接影响；插件不组装模型输入。

## 已知限制与延后工作

- 依赖转发且等待重连的工作由协调器网关扩展负责；`assertUnlocked()` 仅立即拒绝未解锁的准入请求。
- 发现机制假设应用持有独占主目录租约。进程崩溃可留下描述符；SSH 消费者在使用前必须核对进程与启动标识。
- Windows DACL 及 macOS、Windows 原生部署验证需要对应宿主机。

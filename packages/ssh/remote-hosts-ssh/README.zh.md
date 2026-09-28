# @deepseek-ai/dsh-remote-hosts-ssh

[English](README.md) | 中文

为独立管理的远程 Harniverse 主机提供固定指纹的 SSH 传输。`RemoteHostSsh` 同时作为具名导出和默认导出的服务类，挂载到 `ctx.remoteHostSsh`。消费方声明 `inject: ['remoteHostSsh']`，并使用导出的 `RemoteHostSshProvider` 约定。其他 Cordis 服务可用相同的键替换该实现。具体服务同时承担 Service Definition 与 Service Provider 角色；协调消费方负责主机设置、用户同意、凭据存储、部署和远程进程生命周期。参见[架构说明](../../../docs/architecture.md#capability-seams)。

## 连接与信任

`open(config, authentication, signal?)` 返回 `RemoteHostSshConnection`。`config` 包含 `host`、`username`、可选的 `port`（默认 `22`），以及必填的规范 OpenSSH `fingerprint`，格式为 `SHA256:<43-character unpadded base64>`。提供方对原始主机密钥字节计算哈希，并在身份验证前要求与固定指纹完全一致。指纹缺失、格式错误或不匹配时，绝不回退到自动接受或已知主机文件。每条新连接都验证其单独批准的指纹。

身份验证方式为以下之一：

- `{ kind: 'password', password }`：显式密码身份验证。
- `{ kind: 'key', privateKey, passphrase? }`：提供私钥内容，支持加密私钥。不能用文件路径替代密钥内容。
- `{ kind: 'agent', socket }`：显式选择 OpenSSH agent（智能体）的 Unix 套接字或 Windows 命名管道。禁用 agent 转发；传输拥有这些本地套接字，身份验证取消时也会清理。

`verify(config, authentication, command, signal?)` 执行一次带身份验证的首次接触检测。提供方接受本次尝试的主机密钥，而不与固定指纹比对；它先以传入凭据完成身份验证，之后才运行 `command`，并返回 `{ fingerprint, output }`。由于身份验证是在该密钥之下完成的，返回的指纹就是调用方为该主机记录下来的固定指纹：调用方批准的固定指纹来自一次登录已成功的连接，而不是来自某次未经身份验证的观测所誊抄的值。`command` 由调用方提供，语义与 `exec` 相同；退出状态非零即判定检测失败。提供方从不保存批准记录或凭据。

## 连接 API

所有路径和命令字符串均原样传给 SSH 服务器。提供方不选择 shell、不为命令添加引用、不规范化远程路径，也不安装辅助程序。

| 方法或属性 | 约定 |
|---|---|
| `exec(command, input?, signal?)` | 发送不带 PTY 的 exec 请求；输入为字符串或 Buffer，并向 stdin 发送 EOF。返回 Buffer 字段 `stdout` 和 `stderr`、可为 null 的数值 `exitCode`，以及可为 null 的字符串 `signal`。非零退出状态是结果而非异常。缺失的退出元数据保持为 `null`；信号名称保留 ssh2 的表示形式。 |
| `upload(localPath, remotePath, signal?)` | 以 `0600` 模式打开或准备目标，确认 `fchmod` 成功，然后通过 SFTP `fastPut` 传输。覆盖已有文件。空文件上传也获得私有权限。 |
| `readFile(path, signal?)` | 通过 SFTP 读取有字节上限的内容并返回 Buffer；超限时拒绝，不返回部分数据。 |
| `realpath(path, signal?)` | 返回服务器提供的规范路径。 |
| `mkdir(path, signal?)` | 以 `0700` 模式创建单个目录；目录已存在时仍报告服务器错误。 |
| `forward(remoteHost, remotePort, signal?)` | 在本地 `127.0.0.1` 上开启临时监听端口；每个接受的套接字通过 `forwardOut` 连接固定的远程目标。返回 `{ port, close() }`，其中 `port` 为本地端口。 |
| `reverse({ remotePort?, localHost, localPort }, signal?)` | 仅在远程 `127.0.0.1` 上请求 `forwardIn`。省略远程端口或指定零时分配临时端口。返回 `{ port, close() }`，其中 `port` 为远程端口。 |
| `signal` | 连接无法继续使用时触发取消，原因是经脱敏的 `RemoteHostSshError`。 |
| `closed` | SSH 套接字、所属通道、监听器、agent 套接字和进行中的上传回调全部完全停稳后完成。 |
| `dispose()` | 幂等关闭此传输并等待 `closed`。不发送远程 agent 的 kill、close RPC 或进程信号。 |

反向转发仅授权在当前连接上注册的精确远程地址和端口。每条映射在绑定前捕获配置的本地目标。地址错误、端口未注册或映射属于另一条连接时均拒绝。关闭句柄时，先停止接受新连接，再等待已接受的套接字完全停稳。消费方只能用该主机设置中已授权的目标调用 `reverse`；此提供方没有全局目标注册表或隐式转发规则。

## 上限与失败

插件 `Config` 接受以下正整数上限，各值均不得超过 `2147483647`：

| 设置 | 默认值 | 适用范围 |
|---|---|---|
| `connectTimeoutMs` | `30000` | TCP/SSH 建连与身份验证。 |
| `operationTimeoutMs` | `120000` | 每次命令、完整的 SFTP 操作、转发建立、已接受套接字的连接建立，以及转发句柄清理。 |
| `maxOutputBytes` | `8388608` | 每条命令保留的 stdout 与 stderr 的总字节数。 |
| `maxReadBytes` | `4194304` | 每次读取返回的完整文件字节数。 |

SSH 每 10 秒执行一次保活，允许三次探测无应答。已建立的转发流持续到句柄或连接关闭；操作期限不是空闲超时。

已经取消的信号会在操作进入前使其拒绝，而不关闭已有连接。操作进入后，取消、超过操作期限或超过字节上限都会关闭其所属的整条连接，包括并发操作。传给 `open`、`verify`、`forward` 或 `reverse` 的信号仅覆盖建立阶段。建立完成后，使用 `dispose` 或返回的转发句柄关闭资源。远程请求失败可以在保留连接可用性的同时使请求拒绝；传输失败则会使连接失效。

失败使用 `RemoteHostSshError`，错误码为 `INVALID_CONFIG`、`INVALID_ARGUMENT`、`HOST_KEY_MISMATCH`、`CONNECT_FAILED`、`OPERATION_FAILED`、`CLOSED`、`ABORTED`、`TIMED_OUT` 或 `LIMIT_EXCEEDED`。消息和 cause 从不复制上游错误、凭据、命令、路径或调用方的取消原因。Exec 输出是明确提供给调用方的数据，本身可能包含秘密；消费方负责存储和呈现。

插件卸载时停止接受新连接，并等待所有正在建立或已经建立的传输。dispose（资源释放）只释放本地传输资源。消费方必须使用相应平台的脱离会话或服务机制启动持久运行的远程 Harniverse 进程；SSH 服务器可能在通道关闭时终止前台会话。

## 依赖与验证

新增的 `ssh2` 依赖无需远程辅助程序即可提供 SSH 身份验证、密钥解析、SFTP 和转发。Node 的 crypto/net 模块提供指纹固定和套接字所有权；`@types/ssh2` 提供开发类型。此包不使用现有的辅助程序管理型 SSH 执行环境，因为该环境的断连生命周期负责清理远程子进程。

[测试](tests/)使用真正的本地 ssh2 服务器，以及通过 Node crypto 在进程内生成的 RSA 密钥。测试覆盖密码、普通及加密私钥、显式 agent 身份验证、指纹不匹配、带身份验证的首次接触检测、SFTP 隐私和上限、转发授权、取消、期限、插件卸载，以及通过 Loader 加载的 `cordis.yml` 组合。测试不使用已配置的主机、真实用户密钥或模型凭据。

在声明的依赖可用时，从仓库根目录运行：

```sh
node_modules/.bin/vitest run --config packages/ssh/remote-hosts-ssh/vitest.config.ts
node_modules/.bin/tsc -p packages/ssh/remote-hosts-ssh/tsconfig.json --noEmit --incremental false --composite false
node_modules/.bin/tsc -p packages/ssh/remote-hosts-ssh/tsconfig.tests.json
node_modules/.bin/oxlint --config .oxlintrc.json packages/ssh/remote-hosts-ssh
```

仅构建此包时，先执行 `node_modules/.bin/tsc -p packages/ssh/remote-hosts-ssh/tsconfig.json --incremental false --composite false`，再从此包目录使用本地 tsdown 配置构建。运行时依赖链接可用后，`node packages/ssh/remote-hosts-ssh/tests/built-smoke.mjs` 会在普通 Node 下针对临时 SSH 服务器验证发布的 JavaScript 和默认导出。工作区依赖必须已有声明及构建产物；这些检查不会重建它们。

## 模型体验

此提供方不注册工具、提示词、模型字段或 Session 事件；消费方负责把传输结果投影为模型可见内容。

#### KV Cache 影响

提供方不改变模型请求前缀，也不使已可复用的前缀失效。消费方投影和模型提供方的缓存行为不属于此包的约定。

## 已知限制与后续工作

- 工作区集成需要安装声明的依赖，并把包加入 Host 编译聚合及选定的消费方组合。此独立包不更新根级聚合、组合包、共享锁文件或生成的目录。
- 传输代码对 Linux、macOS 和 Windows 平台保持中立。实际的 OpenSSH/SFTP 服务器策略、shell 命令、远程守护进程脱离会话和 Windows ACL 需要平台集成测试；本地 ssh2 fixture（测试前置数据）不能证明这些部署可用。
- 上传要求目录由调用方拥有且为私有，路径组成部分可信。上传不是原子操作，失败可能留下部分文件，也不防范其他写入者替换路径。不能执行私有权限操作的服务器会导致上传失败；仅凭模式位无法证明 Windows ACL 的私密性。
- Agent 身份验证支持显式的 OpenSSH 套接字协议，不支持 Pageant/Cygwin 发现、SSH 配置别名、跳板机或键盘交互式身份验证。
- 此包不自动重连、不持久化凭据、不批准主机密钥、不部署、不监管远程进程，也不探测应用健康状态。这些策略属于协调消费方。

# @deepseek-ai/dsh-remote-hosts

[English](README.md) | 中文

本地权威远程主机协调器参考。`RemoteHosts` 同时是具名及默认导出的 `TypertRemoteService`，注册为 `ctx.remoteHosts`。`RemoteHostsProvider` 是服务定义，本类是服务提供者，Typert 管理客户端和可信本地代理插件是消费者。必需注入为 `remoteHostSsh`、`credentials`、`settings`。SSH 和凭据实现均可通过插件替换。

## 配置与所有权

`artifactsRoot` 必须是本地绝对目录，包含按 `linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`、`win32-x64`、`win32-arm64` 命名的原生产物目录。所选目录必须包含[远程服务器产物](../../../apps/remote-server/README.md#artifact-and-build-commands)，包括清单与摘要；只需准备实际使用的平台。`dshHome` 覆盖本地注册表目录，否则采用标准 `DSH_HOME` 解析。`startupTimeoutMs` 默认 60000，`requestTimeoutMs` 默认 30000，两者均为不超过 2147483647 的正整数。

本地 `remote-hosts.json` 格式为 `{ version: 1, hosts: HostRecord[] }`，主机 ID 是带品牌类型的 UUID `RemoteHostId`。文件只保存主机配置和凭据引用，不保存凭据值或连接状态。组合应用负责独占本地 Harness home；注册表写入串行化，通过私有临时文件原子重命名提交。主机操作按 ID 排队，不锁住其他主机。外部修改注册表后应重新加载插件。

远端 `dshHome` 与本地目录相互独立，必须使用所选远端平台的绝对路径。未指定时，用 SSH SFTP `realpath('.')` 加上 `.dsh`；Windows 的 `/C:/...` SFTP 路径规范为 `C:/...`。远程应用持有 home 租约并拒绝重复进程。

## 管理 API

Remote 命名空间为 `remoteHosts`。`list()` 与 `keyFilePicker()` 要求 `harniverse.observe`；`upsert(input)`、`removeHost(id)`、`verify(input)`、`pickKeyFile()`、`connect(input)`、`disconnect(id)` 要求 `harniverse.administer`。正常授权的本地所有者可调用这些方法。即使界面正在显示远程工作区，管理请求也必须始终发往原始本地主机。

`removeHost` 是本地 `ctx.remoteHosts.remove(id)` 方法导出的 Remote 名称。Client Gateway 的命名空间 Service 自身用 `remove` 卸载方法，因此同名 Remote 方法无法挂载。

`upsert` 完整替换主机配置。创建时省略 `id`，编辑时保留返回的 ID。默认值为 `port: 22`、`reverseMappings: []`、`storeCredentials: false`。已连接主机必须先断开再编辑。必填字段为 `name`、`host`、`username`、`fingerprint`、`platform`（`linux`、`darwin`、`win32`）、`architecture`（`x64`、`arm64`）、`authentication`；未知字段被拒绝。

认证形式为 `{ kind: "password", passwordRef? }`、`{ kind: "key", privateKeyRef?, keyPath?, passphraseRef? }` 或 `{ kind: "agent", socket }`。SSH agent 套接字或 Windows 命名管道必须显式指定。引用名遵守凭据服务的 POSIX 标识符格式。私钥要么是引用内容（`privateKeyRef`），要么是保留在记录上的宿主本地文件路径（`keyPath`）——路径只是普通字符串，因为它指向 Host 所在机器上的文件，由 Host 在使用时自行读取；提交的秘密二选一：`privateKey` 或 `privateKeyPath`。

`verify({ host, port?, username, secrets })` 执行保存主机前必须通过的连通性检测。它使用提交的凭据完成身份验证，接受本次尝试的主机密钥，并运行一条固定探测命令，返回 `{ fingerprint, platform, architecture }`。

`keyFilePicker()` 报告当前组合提供的交互形态——宿主能打开自己的选择器时返回 `{ kind: 'native' }`，browse 目录选择器表面在组合中时返回 `{ kind: 'browse' }`，否则返回 `{ kind: 'absent' }`（无拾取交互）——客户端据此渲染对应的入口而不是猜测。它是路由探针；`pickKeyFile()` 是其中 `native` 一侧的交互。`pickKeyFile()` 服务于登录表单的密钥文件入口：它经 `ctx.get('directoryPicker')`（唯一的可选注入——没有 `native` 能力的组合会以 `KEY_PICKER_UNAVAILABLE` 快速失败，例如探针后组合被卸载的竞态）打开以操作者 `~/.ssh` 为起始目录的宿主原生单文件选择器，并返回 `{ path }`——所拾取文件的宿主本地路径，正是 `AuthSecrets.privateKeyPath` 保存的值；操作者取消时该字段不存在。`browse` 一侧在客户端：密钥目录流槽位的对话框列出 Host 所在机器上的目录，确认后成为路径的目录部分（操作者在获得焦点的路径输入框里补全文件名）。密钥凭据是宿主本地路径，绝不是上传：Host 在使用凭据时——`verify` 与 `connect` 时——自行读取文件，上限 64 KiB（`KEY_FILE_TOO_LARGE`）；使用时消失或不可读的文件上报 `KEY_FILE_READ_FAILED`；外来选择器失败被收敛为 `KEY_PICKER_FAILED`。

返回的 `fingerprint` 就是该连接自身观测到的主机密钥，`platform` 与 `architecture` 则是目标主机给出的回答。它们正是 `upsert` 随后保存的值：记录下来的固定指纹来自一次登录已成功的连接，而探测到的目标平台也免去了让操作者声明主机自身已知信息的多余步骤。检测优先接受 POSIX 的 `uname` 回答，若目标是 Windows 默认 shell，则改用 PowerShell 重试；若回答未给出可部署的平台或架构，则判定检测失败。已保存的凭据由后续全新检测重新验证，因此指纹变化会表现为检测失败，而不会退回某个已存的批准记录。

### 具体 UI 提交

独立核验指纹后，UI 提交以下完整 JSON 参数。密码仅为文档示例数据：

```json
{
  "input": {
    "name": "Build workstation",
    "host": "build.example.org",
    "port": 22,
    "username": "runner",
    "fingerprint": "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "platform": "linux",
    "architecture": "x64",
    "dshHome": "/home/runner/.dsh-remote",
    "authentication": { "kind": "password" },
    "secrets": { "kind": "password", "password": "documentation-only-password" },
    "storeCredentials": true,
    "reverseMappings": [
      { "localHost": "127.0.0.1", "localPort": 11434, "remoteOriginalOrigin": "http://127.0.0.1:11434" }
    ]
  }
}
```

向 `POST /api/remoteHosts/upsert` 发送现有 Connection 信封：`type` 为 `client-request`，`rpcId` 为唯一请求 ID，`method` 为 `remoteHosts/upsert`，`payload.args` 为上面的参数对象。响应为同一 `rpcId` 的 `server-response`，含 `result: { ok: true, value: RemoteHostView }` 或标准错误结果。生成的 `./remote` 客户端负责信封。密钥认证使用 `authentication: { kind: "key" }` 和 `secrets: { kind: "key", privateKeyPath, passphrase? }`（宿主本地路径——Host 在使用时读取文件），或 `secrets: { kind: "key", privateKey, passphrase? }`（内联内容，例如粘贴的文本）；仅当 `storeCredentials: true` 时持久保存登录，保存的记录相应保留 `keyPath` 或 `privateKeyRef`。返回的主机视图从不包含密码、私钥或口令值，已保存的路径也永不离开 Host。

假设返回的主机 ID 为 `84fbdabb-7814-4d13-a19a-5afeb7b1eb50`，以下是发往 `POST /api/remoteHosts/connect` 的完整已保存凭据连接请求：

```json
{"type":"client-request","rpcId":"host-connect-1","method":"remoteHosts/connect","payload":{"args":{"input":{"id":"84fbdabb-7814-4d13-a19a-5afeb7b1eb50"}}}}
```

临时登录先不带 `secrets` 调用 upsert，再调用 `connect({ id, secrets: { kind: "password", password }, storeCredentials: false })`。`connect({ id })` 解析已保存引用。`connect` 中显式设置 `storeCredentials: true` 会在连接前保存提交的凭据。并发连接合并，首次受理的参数生效；已连接时再次 connect 会重新同步设置和凭据。Upsert 拒绝未获存储同意的 secrets，不会悄悄保留或丢弃。

`list()` 返回配置，以及 `state`（`offline`、`connecting`、`deploying`、`connected`、`error`）和可选的固定脱敏 `error`。UI 轮询进度；不返回本地隧道端口或访问令牌，不发出未类型化事件。

## 部署、认证与同步

传输前验证清单摘要、平台、架构、路径、每个本地文件的哈希和可移植树内链接。链接物化为已校验的普通文件树，避免依赖 Windows 符号链接权限。上传写入私有随机暂存目录，验证全部成功后才成为 `server/releases/<manifest-digest>`。现有发布目录也重新验证，并拒绝额外文件；不执行或复用不完整暂存目录。

运行复制的 Node 前，Linux 使用 `sha256sum`，macOS 使用 `shasum -a 256`，Windows 使用 PowerShell `Get-FileHash`。随后由已验证的 Node 校验完整传输树并恢复执行位。原生哈希命令失败即中止。远端不需要源码、全局 Node、包管理器或依赖安装。原生哈希工具及可信私有路径祖先是前提；可在执行过程中替换文件的同用户攻击者不在此信任边界内。

POSIX 使用正确引用路径的 `nohup env`，重定向标准输入和日志。Windows 使用编码 PowerShell，通过 `Win32_Process.Create` 在 SSH 进程作业之外创建引导进程，再以 `Start-Process` 启动，显式指定目录、参数、环境和日志。检查 WMI 返回码，Windows 策略必须允许该操作。断开或卸载插件均不终止远程进程。

每个本地主机 ID 对应随机 AES-256 密钥和 P-256 签名私钥，仅通过本地 `ctx.credentials` 引用保存。复制的 Node 使用标准输入 JSON 调用现有认证注册表 API，引导 API-client 所有者授权。复用要求固定授权名、公钥、有效状态和全部能力匹配；冲突中止，不静默替换授权。签名私钥永不传输。AES 密钥仅通过已认证的运行时 RPC 解锁。

发现过程验证 `server/endpoint.json`。活动 PID 必须通过认证的状态 RPC 返回相同启动 ID、平台和架构。活动但身份不符或不能认证的端点失败，不另启进程。缺失或已死的端点触发后台启动并在启动期限内轮询。支持随应用提供的回环 HTTP；自定义 HTTPS 端点在证书信任集成前明确拒绝。

SDK `GrantAccess` 使用 SHA-256 IEEE-P1363 签名挑战，并合并访问令牌续期。运行时请求采用真实 Connection/Typert JSON 信封。解锁后发送完整凭据替换及已解析的本地模型/搜索设置，明确携带本地组合默认值；匹配反向映射的模型/搜索来源会在同步前改写为该映射分配的远端回环端口。省略的命名空间由运行时重置。只解析支持的已注册设置模式中标记为 `role('credential-ref')` 的字段，递归处理对象、字典、数组和交叉类型；含引用且分支不明确的联合/变换拒绝。排除无关本地秘密和协调器自有引用。设置逐命名空间提交，不是全局事务；失败后再次 connect 可收敛。

## 同进程代理与反向映射消费者

搜索模式还允许在 `apiKeyEnv` 旁配置字面量 `apiKey` 秘密。同步从远程设置中移除这些字面量字段，将其有效值放入对应的加密凭据引用。同一引用对应冲突的字面量值，或秘密字段结构不受支持时，操作明确失败；协调器不会将提交的搜索密钥保存到远程明文设置中。

`request(id, path, init?)` 不是 Remote 方法。输入为已连接主机和同源 `/api/` 路径，自动注入当前远程令牌，移除本地浏览器授权、Cookie 和 Origin，拒绝重定向及 `remoteHosts` 管理路径，返回包含流式正文的 `Response`。`openWebSocket(id, path, signal?)` 使用相同的路径栅栏和 Access Token 打开远端事件 socket；`authentication(id)` 只暴露最近一次非机密远程响应身份，用于 expected-principal 转换。本地代理使用这些所有者权限传输前，必须对每个调用者和操作授权，并保留原始本地管理路由。

每个反向映射显式指定 `localHost`、`localPort`、精确 HTTP(S) `remoteOriginalOrigin`，不允许路径、凭据、查询或片段。没有隐式 localhost 转发。`reverseMappings(id)` 仅向可信同进程消费者返回相同配置和已分配远程回环端口 `remotePort`。同步期间，选定模型/搜索命名空间中匹配的来源字符串会变为 `http(s)://127.0.0.1:<remotePort>`，同时保留路径。因此提供者流量只使用显式配置的反向映射。

`disconnect` 关闭 SSH 和转发；远程代理、加密状态和解锁凭据持续到远程进程关闭。`removeHost` 还会删除本地记录，但不撤销远程授权或删除远程文件。协调器生成的凭据引用（包括替换后的登录引用）保留用于明确恢复或清理。远程 home 仍需访问时，不应删除 AES/签名引用。

## 验证

在仓库根目录使用已安装的可执行文件：

```sh
node_modules/.bin/vitest run --config packages/ssh/remote-hosts/vitest.config.ts
node_modules/.bin/tsc -p packages/ssh/remote-hosts/tsconfig.json --noEmit --incremental false --composite false
node_modules/.bin/tsx packages/ssh/remote-hosts/check-tests.ts
node_modules/.bin/oxlint --config .oxlintrc.json packages/ssh/remote-hosts
node_modules/.bin/tsc -p packages/ssh/remote-hosts/tsconfig.json --incremental false --composite false
node_modules/.bin/tsx packages/ssh/remote-hosts/build-typert.ts
```

随后在本包目录运行 `../../../node_modules/.bin/tsdown --config tsdown.config.ts`。类型检查依赖已安装的声明依赖；`check-tests.ts` 纳入新运行时和加密提供者源码，不重建其他包。[测试](tests/) 涵盖 Loader 组合、真实本地认证 HTTP、Linux 原生部署/哈希执行、模拟 SSH 边界、严格生成的 Remote 模式和续期并发；夹具关闭所有本地服务器并删除隔离 home。

## 模型体验

没有新增工具、提示词或 Session 事件；现有远程插件负责模型可见工作，同步设置和显式选择的凭据决定其配置。

#### KV Cache 影响

不直接修改前缀；缓存行为由现有模型提供者设置决定。

## 已知限制与待办工作

- 共享锁文件、Host 聚合、源码别名、bundle、根构建、目录及中央 Agent Note 注册由外部集成负责，本次包级交付不修改这些文件。
- 本地凭据存储安全由选定的可写提供者负责。远端加密提供者拒绝 `set`，不能直接充当本地可写权威库；如需本地加密写入，必须提供单独实现。
- 真实 macOS/Windows OpenSSH 部署和断线持久性必须在相应原生主机验证。Windows CIM 后台启动受账户策略影响；包测试不能证明这些平台保证或所有平台的完整产物启动。
- 没有自动重连、实时设置订阅、远程升级/重启、授权撤销、凭据垃圾回收或旧发布清理。显式 connect 执行同步；活动进程继续使用其正在运行的版本。

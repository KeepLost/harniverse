# Desktop 自有 Host

[English](README.md) | 中文

这个私有进程组合下游 `web` Profile，并加入应用自有的 HTTP 接入与原生目录选择 Provider，以及消费身份认证、会话状态、终端列表和调度器列表的 Consumer。Profile 以启用身份认证的模式绑定稳定的 loopback 地址 `127.0.0.1:19387`，让浏览器设备密钥能够跨桌面应用重启保留。现有 Loader、Agent、调度器、终端、浏览器认证和 API gateway 仍由各自原有属主负责。

外壳使用 `--expose-internals` 启动 `lib/index.js`，并传入两个绝对路径应用参数：专用 Host home，以及已安装的 `@deepseek-ai/dsh/package.json` 路径。私有 `--port <number>` 覆写供隔离测试使用，零表示请求空闲端口。生产环境使用端口 19387，冲突时明确失败，不会更改浏览器 origin。外壳传入继承的 Node IPC，仅保留允许的操作系统环境变量，并显式选择 Electron Node 模式。子进程还会在 Profile 激活前清除凭据名称以及 Node／Electron／DSH 执行覆写，并把清理后的启动快照提供给 subprocess Provider。Electron 可执行文件的 PTC 适配属于 W09 Provider。

Host home 必须为空，或携带 `.desktop-owned` 标记；它必须是真实目录，并在 Unix 上使用仅所有者可访问的权限。默认用户 home 会被拒绝。普通认证 Provider 负责网络进程的独占、可从崩溃中恢复的 lease。每次启动尝试都有独立的私有 Loader 根目录和依赖链接，并在 disposal 后删除；现有 Profile 配置和用户 patch 不会被截断。可执行 Profile 只接受发行版的 Web bundle 组合，不加载用户 patch，也不在运行时安装包。关闭过程保留持久数据。

## 私有 IPC

只有继承的父进程通道接受控制。命令会拒绝未知字段。请求 id 必须是非负安全整数，并且 shell 请求必须递增；目录选择响应使用子进程单独生成的 id。

| 父进程命令 | 子进程响应 |
| --- | --- |
| 启动 | `{ type: 'ready', url, authentication: 'authenticated' }` |
| `{ type: 'enroll', requestId, publicKey }` | `{ type: 'enrolled', requestId, enrollment: { enrollmentId, grant } }` |
| `{ type: 'activity', requestId }` | `{ type: 'activity', requestId, activity }` |
| `{ type: 'update-tasks', requestId, action: 'inspect' \| 'lock' \| 'unlock' }` | `{ type: 'update-tasks', requestId, active, activity }` |
| `{ type: 'directory-result', requestId, path: absolutePathOrNull }` | 结算对应的原生目录选择 |
| `{ type: 'shutdown' }` | `{ type: 'shutdown-complete' }`，随后断开 IPC |

子进程使用 `{ type: 'directory-pick', requestId }` 请求原生对话框，并用 `{ type: 'directory-cancel', requestId }` 取消它。一次只能有一个待处理对话框。调用失败返回 `{ type: responseType, requestId, error }`，enrollment 失败使用 `enrolled` 类型。无效命令和重复 id 会被忽略。父进程校验完整响应字段、请求关联和 loopback authority；格式错误的响应使自有连接失败。启动、运行时及已报告的 teardown 失败会发出 `{ type: 'fatal', message }`；关闭失败不会发出 `shutdown-complete`。

配对是显式的本地操作。Shell 创建 P-256 密钥对，只提供其规范化的 base64url DER SPKI 公钥。Host 只创建并批准这个请求，并把公钥、enrollment id、Grant id 和 revision 记录到仅所有者可访问的 `.desktop-device.json` 回执中，不接受调用方提供的待处理 enrollment id 或替换密钥。后续启动恢复这个精确关联，并重新检查当前 Grant；撤销、过期和认证不可用都不会重新创建权限。浏览器必须复用已保存的不可导出设备密钥，并使用普通 `/auth/challenge` 与 `/auth/exchange` 流程。恢复使用普通认证审批。Host 不返回 bearer credential，也不暴露公开 bootstrap bypass。

在 enrollment 之前或认证／服务丢失时，活动状态为 `{ status: 'unknown' }`。其他情况下，它从现有的会话状态、`terminal/list`、`scheduler/listAll` 和已接纳的 HTTP mutation 中报告 `{ status: 'idle' | 'active', sessions, tasks }`，不会挂载 cold session。活动中的 schedule 会被计为待处理工作，因为它可能自主接纳工作；因此 update lock 要求这些 schedule 已暂停或完成。成功的 `lock` 返回 `active: false`，并且所有新的 HTTP／upgrade 接入在 `unlock` 或关闭前返回 503。

关闭过程关闭接入，结算私有 enrollment／update 操作，通过注册表生命周期关闭存活的 Agent 以解除 scheduler 的 idle 等待，再等待完整的 root fiber disposal，包括 scheduler 与 terminal effects。只有完成这些步骤后才会确认关闭并断开 IPC。父进程断开和进程信号遵循同一条自有 teardown 路径。父进程适配器要求关闭确认和零状态的真实进程 `close`，并拒绝强制终止、缺失确认和非零退出。启动和请求默认期限分别为 60 秒和 10 秒；关闭先等待 15 秒，再分别在 SIGTERM 和 SIGKILL 后等待 5 秒。结算时清除计时器。`hasClosed()` 为显式 Quit／disconnect 恢复决定提供独立证据，不会使失败的 `stop()` 成为安全更新依据。

## 定向验证

在本目录运行，且 workspace 依赖与运行时产物可用：

```sh
node ../../node_modules/tsdown/dist/run.mjs
node ../../node_modules/vitest/vitest.mjs run apps/desktop-host/tests --root ../.. --maxWorkers=1
```

构建进程测试会把应用移到 CLI 依赖闭包旁，使用无模型凭据的隔离 Profile 启动真实进程（包括空 PATH），完成设备 enrollment 与 browser-session challenge exchange，调用带认证的 `session.list` API，并验证真实进程关闭。另一项进程测试通过生产父进程适配器验证 enrollment、update admission 和关闭响应。单元测试与 Loader 测试覆盖严格校验、期限、home 保留、禁用的 Profile 行、设备恢复与撤销、原生目录选择关联，以及真实 scheduler 对 Agent idle 的等待。所有测试都会关闭自有实例，并且只删除临时 home。

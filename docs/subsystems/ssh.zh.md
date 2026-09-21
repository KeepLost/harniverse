# SSH

[English](ssh.md) | 中文

[SSH 提供方家族](../../packages/ssh/README.md) 通过部署方持有的 OpenSSH 连接提供一个远端文件系统／进程环境。Harness、模型传输及 Session 存储留在主机。该家族实现既有文件系统、子进程及沙箱 API，不引入 SSH 专用模型工具。

## 执行坐标

文件系统身份、可执行文件查找、进程 cwd、沙箱工作区根目录及语言服务器文件 URL 都指向 SSH 主机。提供方在文件实际存在的位置规范化路径，保留文件系统对 `symlink/..` 的解释。策略解析器保留执行环境中的绝对路径写法，不尝试在 Harness 主机上解析远端路径。

`processPath()` 提供配套子进程提供方可用的路径。安装远端产物不意味着任意主机路径可移植，因此需要已安装可执行文件或引导程序的消费方必须通过连接的成对摘要字段显式提供并验证远端产物。

## 传输与信任

全部辅助进程流量——管理 RPC、进程 stdin/stdout/stderr 及终端流——都以有界帧形式运行在 SSH exec 流之上的单一共享控制通道里；OpenSSH 认证两端，帧协议不携带第二套凭据面。进程输出按有界分块拉取，stdin 与终端输入带背压，消费方停滞时两侧都不会累积无界缓冲。

部署认证、已安装产物验证及捕获 Profile 检查属于 [`dsh-ssh`](../../packages/ssh/ssh/README.md)。辅助进程使用远端机器上的可信本地提供方执行文件系统与进程请求。SSH 是传输方式；文件效果限制由所选远端沙箱提供方执行。

## 进程生命周期与取消

进程句柄通过 `done` 报告直接结果，`waitForExit` 在其后观察远端托管进程范围。终端操作保留共享异步 API，包括远端 resize。管理截止时限约束单次 RPC 观察，不替代 Bash 或 PTC 运行时消费方选择的执行截止时限。远端等待可以持续挂起，同时其他请求继续推进。SSH 丢失会使待处理操作失效；辅助进程 EOF、信号及租期到期会启动远端清理。客户端如实报告未确认结果，绝不通过重连重放可能已执行的操作。

## 机器持有清单与 Profile 限制

机器持有自己的 MCP 服务器、Skill 与 Hook：辅助进程从远端部署枚举它们，任何客户端请求都不能新增、移除或改写。连接只挂载不可变捕获 Profile 版本选中的成员——未选中的服务器、Skill 与 Hook 一律拒绝——且捕获拒绝本地 Cordis 权限、本地路径与本地凭据。消费方在其注册上执行同一限制，因此传输丢失或 Profile 不匹配时，卸下的恰好是捕获准入的内容。

## 组合范围

headless 通过已挂载的文件系统提供方记录和检查 Session cwd。因此远端 FS、Bash、终端、LSP 消费方可以共享这些坐标。连接暴露已验证的远端 Node 可执行文件，以及配置后按摘要成对的预装 PTC 入口，使新进程运行时可以经配套子进程提供方启动而不借用主机路径。假定可访问主机文件系统的 Web 工作区视图需要单独集成；仅替换提供方并不会使这些视图支持远端。

## 连接 API

```ts type-equiv
/** Deployment-owned SSH identity and installed helper; no model argument selects these values. */
interface Config {
  /** OpenSSH host alias, including its existing user, key and known-host configuration. */
  host: string
  /** Absolute remote Node executable; a completed handshake proves it runnable in the execution world. */
  node: string
  /** Absolute path to the installed, bundled helper entry. */
  helper: string
  /** SHA-256 of that bundled helper; mismatches refuse the connection. */
  helperHash: string
  /** Absolute remote default workspace. */
  workspace: string
  /** Optional local OpenSSH configuration, owned by the deployment. */
  sshConfig?: string
  /** Optional preinstalled built PTC entry, paired with its expected digest. */
  bootstrapPath?: string
  /** SHA-256 of bootstrapPath; both fields must be supplied together. */
  bootstrapHash?: string
  /** Immutable Profile selection, captured before this connection is mounted. */
  profile: CapturedRemoteProfile
  /** Connection and administrative-request deadline. */
  requestTimeoutMs?: number
  /** Remote helper lease; heartbeat loss starts remote managed cleanup. */
  leaseMs?: number
}
```

```ts type-equiv
interface WorldDescription {
  readonly descriptor: ExecutionWorldDescriptor
  readonly profile: CapturedRemoteProfile
  readonly inventory: MachineInventory
}
```

```ts public-api
/** Loss invalidates this connection. A new connection captures a new remote revision. */
declare class SshConnection extends Service {
  static Config: schema<Config>;
  readonly ready: Promise<Hello>;
  constructor(ctx: Context, config: Config);
  /**
   * Issue one bounded RPC against the connected helper.
   * @param method - the protocol method name.
   * @param params - its validated payload.
   * @param result - the schema every successful reply body must satisfy.
   * @param signal - cancellation for this request alone.
   * @param wait - true to use the connection lifetime instead of the administrative request timeout.
   * @returns the parsed reply body.
   */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T>;
  /**
   * This description is pinned for the connection, including the captured Host Profile revision.
   * @returns the immutable world descriptor the helper verified at connect.
   */
  async describeWorld(): Promise<WorldDescription>;
  /** Verified remote Node executable for the paired PTC runtime. */
  get nodeExecutable(): string;
  /** Verified preinstalled PTC entry; unconfigured runtimes fail before program execution. */
  get bootstrapPath(): string;
  /** Notify consumers so their registrations disappear when transport authority is lost. */
  get signal(): AbortSignal;
  /** Join helper cleanup when reachable, then close and join the owned OpenSSH process. */
  dispose(): Promise<void>;
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxssh--sshconnection"></a>

### `ctx.ssh` — `SshConnection`

Loss invalidates this connection. A new connection captures a new remote revision.

```ts cordis-catalog
/**
 * Issue one bounded RPC against the connected helper.
 * @param method - the protocol method name.
 * @param params - its validated payload.
 * @param result - the schema every successful reply body must satisfy.
 * @param signal - cancellation for this request alone.
 * @param wait - true to use the connection lifetime instead of the administrative request timeout.
 * @returns the parsed reply body.
 */
async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T>

/**
 * This description is pinned for the connection, including the captured Host Profile revision.
 * @returns the immutable world descriptor the helper verified at connect.
 */
async describeWorld(): Promise<WorldDescription>

/** Join helper cleanup when reachable, then close and join the owned OpenSSH process. */
dispose(): Promise<void>
```

Source: [`packages/ssh/ssh/src/index.ts:56`](../../packages/ssh/ssh/src/index.ts)
<!-- END GENERATED cordis-surface -->

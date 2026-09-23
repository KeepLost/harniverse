# 终端控制器

[English](terminal-controller.md) | 中文

[terminal-controller 包](../../packages/api/terminal-controller/README.md) 向浏览器面板提供交互式用户 Shell:一个 `ctx.terminalController` Remote 拥有构建于 subprocess provider PTY 接缝之上的按 Session 终端会话,并通过 headless xterm 屏幕报告每个终端,使重连的客户端能够恢复完整的可见状态。这些是用户自己的 system-user 终端,而非模型 PTY:它们以完整 harness 环境生成(叠加 `DSH_SESSION_ID`),并向 PTY 接缝请求 `xterm-256color` 终端类型(`term`,并镜像到 `TERM`),使 `clear`、颜色与全屏程序的行为与任何终端一致,默认启动登录+交互式 Shell,从不施加沙箱约束,其流量对模型不可见——控制器不注册任何工具,也不产生任何会话事件。[terminal 子系统](terminal.md) 仍是面向模型的持久 PTY surface;本页面拥有来自 [`packages/api/terminal-controller/src/types.ts`](../../packages/api/terminal-controller/src/types.ts) 的浏览器面板线上形状,而 host `apiproxy` 在单参 `terminal/*` gateway 端点之外承载两个流 surface(`events.terminal` / `events.hold` SSE)。

## 终端身份与屏幕帧

一个终端作用于一个 Session 与一个 Host 生命周期;进程退出在同一身份上记录最终状态,而不是创建替代 Shell。每个附着以携带序列化屏幕与当前元数据的快照帧开始,随后是有序的输出帧与状态帧;序号让消费者能够检测并拒绝间隙,而不是渲染撕裂的输出。

```ts type-equiv
/** Host-owned terminal state; process exit never creates a replacement shell. */
interface WebTerminalInfo {
  readonly id: WebTerminalId
  readonly title: string
  readonly shell: TerminalShell
  /** Initial working directory; shell directory changes do not update this field. */
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly state: 'running' | 'exited' | 'failed'
  readonly exitCode: number | null
  readonly error?: string
  readonly controllerId?: TerminalAttachmentId
}
```

```ts type-equiv
/** Every attachment begins with a complete bounded screen, then ordered output. */
type TerminalFrame =
  | { readonly type: 'snapshot'; readonly sequence: number; readonly screen: string; readonly info: WebTerminalInfo }
  | { readonly type: 'output'; readonly sequence: number; readonly data: string }
  | { readonly type: 'state'; readonly info: WebTerminalInfo }
```

## 附着控制

同一时刻只有一个附着持有终端的输入控制权;控制者身份标记写入与调整尺寸,所有其他附着以只读方式观察。控制者脱离会释放控制而不关闭进程,让下一个附着从最新快照接管。

```ts type-equiv
/** Create is idempotent for an open identity; closed identities cannot be recreated. */
interface TerminalCreateRequest {
  /** A path returned by shell discovery; absent selects the execution default. */
  readonly shellPath?: string
  readonly id: WebTerminalId
  readonly cols: number
  readonly rows: number
}
```

## Shell 与环境

Shell 发现解析配置的 Shell 或平台默认项,通过 subprocess provider 的可执行查找逐个验证候选,并连同用户启动参数报告选定项:bash 与 zsh 以登录+交互会话运行(`-l -i`,因此 profile 与 rc 文件的加载与用户自己的终端完全一致),fish 以交互方式运行,PowerShell 在不显示 logo 横幅的情况下加载其 profile,cmd 无需参数。显式配置的 Shell 路径与参数覆盖发现结果。环境调用报告 Session 工作目录与控制器的尺寸、输入及回滚限制;生成的终端本身继承完整的 harness 环境,因为它是用户自己的进程 surface。

```ts type-equiv
/** An executable shell verified in the subprocess provider's execution environment. */
interface TerminalShell {
  readonly path: string
  readonly args: readonly string[]
  readonly name: string
}
```

```ts type-equiv
/** Working directory and limits shared by new and restored terminals. */
interface TerminalEnvironment {
  readonly cwd: string
  readonly maxInputBytes: number
  readonly maxCols: number
  readonly maxRows: number
  readonly scrollback: number
}
```

## 窗口持有

未附着到屏幕的浏览器窗口仍通过持有来保活其终端:保持流确认该持有,而无人值守的终端——没有持有者、控制者或活动——会在配置的超时后关闭,使被遗弃的标签页无法泄漏进程。Host 销毁会在宽限期内排空其拥有的每个终端。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxterminalcontroller--terminalcontroller"></a>

### `ctx.terminalController` — `TerminalController`

Typed Remote control of transient Session-owned user terminal processes.

```ts cordis-catalog
/**
 * Read the Session working directory and terminal limits without resolving a shell (`harniverse.observe`).
 * @param agent - Session owner supplied by the Gateway.
 * @param signal - request cancellation.
 * @returns the Session workspace directory and terminal limits.
 */
@Remote({ exportName: 'environment', requiredCapability: 'harniverse.observe' }) environment(agent: Agent, signal: AbortSignal): TerminalEnvironment

/**
 * Discover installed shells in the Session's execution environment (`harniverse.observe`).
 * @param agent - Session owner supplied by the Gateway.
 * @param signal - request cancellation.
 * @returns verified profiles, with the configured or system default first.
 */
@Remote({ exportName: 'shells', requiredCapability: 'harniverse.observe' }) shells(agent: Agent, signal: AbortSignal): Promise<TerminalShell[]>

/**
 * List retained terminals without resolving or activating an Agent (`harniverse.observe`).
 * @param sessionId - displayed Session identity, including offline history.
 * @returns terminals retained for this Host lifetime.
 */
@Remote({ exportName: 'list', requiredCapability: 'harniverse.observe' }) list(sessionId: SessionId): WebTerminalInfo[]

/**
 * Allocate a user shell once for a caller-generated identity, without Agent sandbox or approval restrictions (`harniverse.operate`).
 * @param agent - Session owner supplied by the Gateway.
 * @param request - initial dimensions and idempotency identity.
 * @param signal - allocation cancellation; committed terminals survive disconnection.
 * @returns the existing or newly committed terminal.
 */
@Remote({ exportName: 'create', requiredCapability: 'harniverse.operate' }) async create(agent: Agent, request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo>

/**
 * Retain an existing terminal for a window without activating its Agent or taking input control.
 * Not a Remote invocation: harniverse's Gateway surface is request/response, so
 * the window-hold transport wraps this generator with the EventsApi hold stream.
 * @param sessionId - owning Session identity, including an inactive saved layout.
 * @param id - retained Host terminal identity.
 * @param signal - physical window stream cancellation.
 * @returns a hold acknowledgement followed by an open lifetime stream.
 */
retain(sessionId: SessionId, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame>

/**
 * Attach to a terminal without binding its process lifetime to the transport.
 * Not a Remote invocation: harniverse's Gateway surface is request/response, so
 * the output transport broadcasts the follower frames the EventsApi terminal stream drives.
 * @param agent - Session owner supplied by the Gateway.
 * @param id - terminal identity.
 * @param attachmentId - new exclusive input attachment.
 * @param signal - attachment stream cancellation.
 * @returns screen recovery followed by output and metadata changes.
 */
follow(agent: Agent, id: WebTerminalId, attachmentId: TerminalAttachmentId, signal: AbortSignal): AsyncIterable<TerminalFrame>

/**
 * Deliver raw input, including Tab completion and control characters (`harniverse.operate`).
 * @param agent - Session owner supplied by the Gateway.
 * @param id - terminal identity.
 * @param attachmentId - current writable attachment.
 * @param data - input bytes represented as UTF-8 text.
 * @returns after provider input acceptance.
 */
@Remote({ exportName: 'write', requiredCapability: 'harniverse.operate' }) async write(agent: Agent, id: WebTerminalId, attachmentId: TerminalAttachmentId, data: string): Promise<void>

/**
 * Update the dimensions of the PTY and recovery screen (`harniverse.operate`).
 * @param agent - Session owner supplied by the Gateway.
 * @param id - terminal identity.
 * @param attachmentId - current writable attachment.
 * @param cols - column count.
 * @param rows - row count.
 * @returns after the resize completes.
 */
@Remote({ exportName: 'resize', requiredCapability: 'harniverse.operate' }) async resize(agent: Agent, id: WebTerminalId, attachmentId: TerminalAttachmentId, cols: number, rows: number): Promise<void>

/**
 * Rename a terminal without changing its shell (`harniverse.operate`).
 * @param agent - Session owner supplied by the Gateway.
 * @param id - terminal identity.
 * @param title - nonempty display title, at most 120 characters.
 */
@Remote({ exportName: 'rename', requiredCapability: 'harniverse.operate' }) rename(agent: Agent, id: WebTerminalId, title: string): void

/**
 * Close an identity to future creation and kill its process range; repeated closes succeed (`harniverse.operate`).
 * @param agent - Session owner supplied by the Gateway.
 * @param id - terminal identity.
 * @returns after provider cleanup succeeds. A failure retains the terminal for retry.
 */
@Remote({ exportName: 'close', requiredCapability: 'harniverse.operate' }) async close(agent: Agent, id: WebTerminalId): Promise<void>
```

Types: [Agent](core.md) · [SessionId](core.md)

Source: [`packages/api/terminal-controller/src/index.ts:79`](../../packages/api/terminal-controller/src/index.ts)
<!-- END GENERATED cordis-surface -->

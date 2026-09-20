# Terminal Controller

English | [中文](terminal-controller.zh.md)

The [terminal-controller package](../../packages/api/terminal-controller/README.md) serves Host-backed interactive shells to browser panels: one `ctx.terminalController` Remote owns per-Agent terminal sessions built on the subprocess provider's PTY seam, and reports each terminal through a headless xterm screen so a reconnecting client can restore the complete visible state. The [terminal subsystem](terminal.md) remains the model-facing persistent-PTY surface; this page owns the browser-panel wire shapes from [`packages/api/terminal-controller/src/types.ts`](../../packages/api/terminal-controller/src/types.ts).

## Terminal identity and screen frames

A terminal is scoped to one Agent and one Host lifetime; process exit records the final state on the same identity instead of creating a replacement shell. Every attachment begins with a snapshot frame carrying the serialized screen and current metadata, followed by ordered output frames and state frames; sequence numbers let a consumer detect and reject gaps rather than render torn output.

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

## Attachment control

One attachment at a time holds input control of a terminal; the controller identity stamps writes and resizes, and every other attachment observes read-only. A controller that detaches releases control without closing the process, letting the next attachment claim it from the latest snapshot.

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

## Shells and environment

Shell discovery resolves the configured shell or the platform interactive default through the subprocess provider's executable lookup, verifies each candidate, and reports the selection with its interactive arguments. The environment call reports the Session working directory and the controller's dimension, input and scrollback limits.

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

## Window holds

A browser window that is not attached to the screen still keeps its terminals alive by holding them: the retention stream acknowledges the hold, while unattended terminals — those with no holder, controller or activity — close after the configured timeout so an abandoned tab cannot leak processes. Host disposal drains every owned terminal within the grace period.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxterminalcontroller--terminalcontroller"></a>

### `ctx.terminalController` — `TerminalController`

Typed Remote control of transient Session-owned terminal processes.

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
 * Not a Remote invocation: harniverse's Gateway surface is request/response, so a
 * future window-hold transport will wrap this generator with its own lease protocol.
 * @param sessionId - owning Session identity, including an inactive saved layout.
 * @param id - retained Host terminal identity.
 * @param signal - physical window stream cancellation.
 * @returns a hold acknowledgement followed by an open lifetime stream.
 */
retain(sessionId: SessionId, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame>

/**
 * Attach to a terminal without binding its process lifetime to the transport.
 * Not a Remote invocation: harniverse's Gateway surface is request/response, so a
 * future output transport will broadcast the follower frames it drives.
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

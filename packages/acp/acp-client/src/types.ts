/**
 * Public types of the Agent Client Protocol client core. Types only.
 * @module @deepseek-ai/dsh-acp-client/types
 */

/** Agent Client Protocol major version this client speaks. */
export type AcpProtocol = 1 | 2

/** How to start one external ACP agent. */
export interface AcpAgentDefinition {
  /** Executable that serves the ACP agent over stdio. */
  readonly command: string
  /** Arguments passed to {@link AcpAgentDefinition.command}. */
  readonly args?: readonly string[]
  /** Environment variables added on top of the subprocess seam's scrubbed parent environment. */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Protocol version requested at the handshake. `1`, the default, speaks the
   * stable protocol. `2` requests the Preview protocol and starts a fresh v1
   * child when the agent answers that it speaks v1 only.
   */
  readonly protocol?: AcpProtocol
  /** Id of the {@link AcpAgentProfile} pinned to this agent before the handshake. */
  readonly profile?: string
}

/** A prompt block this client sends. Prompts are text. */
export interface AcpPromptBlock {
  readonly type: 'text'
  readonly text: string
}

/** A content block an agent streamed. Non-text blocks keep their protocol fields untouched. */
export interface AcpContentBlock {
  readonly type: string
  readonly [field: string]: unknown
}

/** A field set on a remote tool call. An absent field leaves the tool call unchanged; `null` clears it. */
export interface AcpToolCallPatch {
  /** Identity of the tool call inside its agent session. */
  readonly toolCallId: string
  readonly title?: string | null
  readonly name?: string | null
  readonly kind?: string | null
  /** The agent's lifecycle word, such as `pending`, `in_progress`, `completed`, or `failed`. */
  readonly status?: string
  readonly content?: readonly AcpContentBlock[] | null
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
  readonly locations?: readonly unknown[] | null
}

/** One entry of the agent's plan. */
export interface AcpPlanEntry {
  readonly content: string
  readonly priority?: string
  readonly status?: string
}

/** Context-window accounting an agent reported. */
export interface AcpUsage {
  readonly used?: number
  readonly size?: number
  readonly cost?: unknown
}

/** Foreground work state an agent reported. */
/**
 * Foreground work state an agent reported. The protocol's `unknown` state and
 * any state this client does not recognize both arrive as `unknown`.
 */
export type AcpWorkState = 'running' | 'idle' | 'requires_action' | 'unknown'

/**
 * Why a turn ended. `unknown` covers a reason the agent gave that this client
 * does not recognize; it never implies success.
 */
export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | 'error'
  | 'unknown'

/**
 * One normalized `session/update`. Both protocol versions map onto this
 * vocabulary; a variant this client does not interpret arrives as `other`.
 */
export type AcpUpdate =
  | { readonly kind: 'message-chunk'; readonly content: AcpContentBlock }
  | { readonly kind: 'thought-chunk'; readonly content: AcpContentBlock }
  | { readonly kind: 'message'; readonly content: readonly AcpContentBlock[] }
  | { readonly kind: 'thought'; readonly content: readonly AcpContentBlock[] }
  | { readonly kind: 'tool-call'; readonly patch: AcpToolCallPatch }
  | { readonly kind: 'plan'; readonly entries: readonly AcpPlanEntry[] }
  | { readonly kind: 'usage'; readonly usage: AcpUsage }
  | { readonly kind: 'session-info'; readonly title?: string; readonly updatedAt?: string }
  | {
    readonly kind: 'notice'
    readonly title: string
    readonly message?: string
    readonly severity?: string
  }
  | {
    readonly kind: 'state'
    readonly state: AcpWorkState
    readonly stopReason?: AcpStopReason
    readonly error?: string
  }
  | { readonly kind: 'other'; readonly sessionUpdate: string; readonly update: Readonly<Record<string, unknown>> }

/** How one turn ended. */
export interface AcpTurnEnd {
  readonly stopReason: AcpStopReason
  /** The agent's own explanation of a failed turn, when it gave one. */
  readonly error?: string
}

/** One prompt exchange with an agent session. */
export interface AcpTurn {
  /** Updates in arrival order. The iterable ends with the turn. */
  readonly updates: AsyncIterable<AcpUpdate>
  /**
   * Settles when the agent reports the end of the turn, or when a local signal
   * cancelled it. Rejects with an `AcpError` when the turn failed.
   */
  readonly end: Promise<AcpTurnEnd>
}

/** Options for {@link AcpSession.prompt}. */
export interface AcpPromptOptions {
  /**
   * Aborts the turn on this client's side: the agent receives
   * `session/cancel`, the update iterable ends, and `end` settles as
   * `cancelled` without waiting for the agent.
   */
  readonly signal?: AbortSignal
}

/** One session on a connected agent. */
export interface AcpSession {
  /** Identity the agent assigned; unique within that agent process. */
  readonly sessionId: string
  /**
   * Send one prompt and observe the turn it starts. A session runs one turn at
   * a time; a second prompt while a turn is active rejects with an `AcpError`.
   * @param prompt - text blocks the agent receives.
   * @param options - local cancellation.
   * @returns the turn's updates and its end.
   */
  prompt(prompt: readonly AcpPromptBlock[], options?: AcpPromptOptions): AcpTurn
  /** Ask the agent to cancel the active turn. Resolves once the notification was written. */
  cancel(): Promise<void>
}

/** A session an agent listed. */
export interface AcpSessionInfo {
  readonly sessionId: string
  readonly cwd?: string
  readonly title?: string
}

/** Operations the connected agent advertised. */
export interface AcpCapabilities {
  /** `resumeSession` is available. */
  readonly resume: boolean
  /** `listSessions` is available. */
  readonly list: boolean
  /** `closeSession` is available. */
  readonly close: boolean
  /** Prompt content the agent accepts. */
  readonly prompt: {
    readonly image: boolean
    readonly audio: boolean
    readonly embeddedContext: boolean
  }
}

/** Identity and operations of the connected agent, as reported at the handshake. */
export interface AcpAgentInfo {
  readonly name?: string
  readonly version?: string
  readonly capabilities: AcpCapabilities
}

/** How the agent process ended. */
export interface AcpExit {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

/** A connected agent process. One connection hosts any number of sessions. */
export interface AcpConnection {
  readonly protocol: AcpProtocol
  readonly agent: AcpAgentInfo
  /** Settles when the agent process exited. */
  readonly exited: Promise<AcpExit>
  /**
   * Start a fresh session in the connection's working directory.
   * @returns the ready session.
   */
  newSession(): Promise<AcpSession>
  /**
   * Reattach to a session the agent still holds. Rejects with an `AcpError`
   * of kind `unsupported` when the agent did not advertise resume.
   * @param sessionId - identity the agent assigned earlier.
   * @returns the resumed session.
   */
  resumeSession(sessionId: string): Promise<AcpSession>
  /** List the sessions the agent holds; `unsupported` without the capability. */
  listSessions(): Promise<readonly AcpSessionInfo[]>
  /** Close one session; `unsupported` without the capability. */
  closeSession(sessionId: string): Promise<void>
  /**
   * End every active turn, close the connection, and reap the process tree.
   * Idempotent; later calls join the first disposal.
   */
  dispose(): Promise<void>
}

/** One answer option an agent offered for a permission request. */
export interface AcpPermissionOption {
  readonly optionId: string
  readonly name: string
  readonly kind: string
}

/** An agent asking whether it may run a tool. */
export interface AcpPermissionRequest {
  readonly sessionId: string
  /** Identity of the tool call, when the agent tied the question to one. */
  readonly toolCallId?: string
  /** The agent's human-readable title of the action. */
  readonly title?: string
  /** The agent's explanation of why it asks. */
  readonly reason?: string
  readonly options: readonly AcpPermissionOption[]
  /** Aborts when the agent withdrew the request or the connection closed. */
  readonly signal: AbortSignal
}

/** The answer to a permission request: one offered option, or no consent. */
export type AcpPermissionAnswer =
  | { readonly outcome: { readonly outcome: 'selected'; readonly optionId: string } }
  | { readonly outcome: { readonly outcome: 'cancelled' } }

/** Decides permission requests for one connection. */
export type AcpPermissionAnswerer = (
  request: AcpPermissionRequest,
) => AcpPermissionAnswer | Promise<AcpPermissionAnswer>

/** One request this client is about to send to the agent. */
export interface AcpAgentRequest {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
}

/**
 * Agent-specific behavior layered on top of the protocol. A profile carries
 * data and at most a request rewrite; the protocol path consults no profile
 * unless the agent definition pins one or the agent's reported name matches.
 */
export interface AcpAgentProfile {
  readonly id: string
  /** Exact `agentInfo.name` values this profile applies to. */
  readonly agents?: readonly string[]
  /** Rewrite agent-bound request params before they are sent. */
  readonly customize?: AcpProfileCustomize
}

/** Rewrite agent-bound request params before they are sent. */
export type AcpProfileCustomize = (
  request: AcpAgentRequest,
) => AcpAgentRequest

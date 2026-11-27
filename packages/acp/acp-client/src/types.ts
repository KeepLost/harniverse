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
  /**
   * Id of the sign-in method this definition completes when the agent demands
   * sign-in. Absent, the first agent-driven method the agent advertises is
   * completed, and the first terminal one when it advertises none.
   */
  readonly authMethod?: string
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

/** A command the agent offers inside a prompt. */
export interface AcpCommand {
  /** Text that invokes it, such as `/compact`. */
  readonly name: string
  readonly description: string
  /** What the agent expects after the name. */
  readonly inputHint?: string
}

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
  /** The whole plan, or the whole of one named plan when the agent keeps several. */
  | { readonly kind: 'plan'; readonly entries: readonly AcpPlanEntry[]; readonly planId?: string }
  | { readonly kind: 'plan-removed'; readonly planId: string }
  | { readonly kind: 'usage'; readonly usage: AcpUsage }
  | { readonly kind: 'session-info'; readonly title?: string; readonly updatedAt?: string }
  | {
    readonly kind: 'notice'
    readonly title: string
    readonly message?: string
    readonly severity?: string
  }
  /** The session's mode changed, on the person's request or the agent's own. */
  | { readonly kind: 'mode'; readonly currentModeId: string }
  /** Every configuration option as it stands after a change. */
  | { readonly kind: 'config'; readonly configOptions: readonly AcpConfigOption[] }
  /** Every command the agent offers, replacing the earlier list. */
  | { readonly kind: 'commands'; readonly commands: readonly AcpCommand[] }
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

/** Options of one request this client sends while a turn may be cancelled. */
export interface AcpSessionRequestOptions {
  /** Ends the wait, and the sign-in it may have started, when it aborts. */
  readonly signal?: AbortSignal
}

/** One mode an agent offers for a session, such as a permission mode. */
export interface AcpSessionMode {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** The modes an agent offers and the one in effect. */
export interface AcpSessionModes {
  readonly current: string
  readonly available: readonly AcpSessionMode[]
}

/** A value a configuration option can be set to. */
export type AcpConfigValue = string | boolean

/** One value a `select` option accepts. */
export interface AcpConfigChoice {
  readonly value: string
  readonly name: string
  readonly description?: string
  /** Label of the group the agent filed the choice under. */
  readonly group?: string
}

/** One setting an agent offers for a session, such as its model or effort. */
export interface AcpConfigOption {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** The agent's grouping, such as `model`, `thought_level`, `speed`, or `mode`. */
  readonly category?: string
  readonly type: 'select' | 'boolean'
  readonly currentValue: AcpConfigValue
  /** Every value a `select` option accepts; absent for a `boolean` one. */
  readonly options?: readonly AcpConfigChoice[]
}

/** One session on a connected agent. */
export interface AcpSession {
  /** Identity the agent assigned; unique within that agent process. */
  readonly sessionId: string
  /** Modes the agent offers, as last reported; `undefined` while it offers none. */
  readonly modes: AcpSessionModes | undefined
  /** Configuration options the agent offers, as last reported. */
  readonly configOptions: readonly AcpConfigOption[] | undefined
  /** Commands the agent offers inside a prompt, as last reported. */
  readonly commands: readonly AcpCommand[] | undefined
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
  /**
   * Switch the session's mode.
   * @param modeId - one of the offered modes.
   * @param options - local cancellation.
   * @returns the modes as the agent reports them afterwards.
   * @throws an `AcpError` of kind `unsupported` when the protocol version has no modes.
   */
  setMode(modeId: string, options?: AcpSessionRequestOptions): Promise<AcpSessionModes>
  /**
   * Set one configuration option.
   * @param configId - one of the offered options.
   * @param value - a value that option accepts.
   * @param options - local cancellation.
   * @returns every option as the agent reports them afterwards.
   */
  setConfigOption(configId: string, value: AcpConfigValue, options?: AcpSessionRequestOptions): Promise<readonly AcpConfigOption[]>
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

/** One sign-in method an agent advertised at the handshake. */
export interface AcpAuthMethod {
  readonly id: string
  readonly name: string
  readonly description?: string
  /**
   * `agent`: the agent completes it once `authenticate` names it. `terminal`:
   * a person completes it by running the agent's own program once.
   */
  readonly kind: 'agent' | 'terminal'
  /** Arguments the terminal run appends to the agent's own. */
  readonly args?: readonly string[]
  /** Environment the terminal run adds on top of the definition's. */
  readonly env?: Readonly<Record<string, string>>
}

/** Identity and operations of the connected agent, as reported at the handshake. */
export interface AcpAgentInfo {
  readonly name?: string
  readonly version?: string
  readonly capabilities: AcpCapabilities
  /** Sign-in methods the agent offers, in its order. */
  readonly authMethods: readonly AcpAuthMethod[]
}

/** A terminal sign-in a person completes outside the ACP connection. */
export interface AcpTerminalSignIn {
  readonly method: AcpAuthMethod
  /** Program the person runs once. */
  readonly command: string
  /** Arguments of that run: the agent's own, then the method's. */
  readonly args: readonly string[]
}

/**
 * What a consumer does for the person while an agent waits for its sign-in.
 * Every member is optional; one that is absent leaves that step to the agent.
 */
export interface AcpSignInHooks {
  /**
   * A browser address the agent printed while it waited: its sign-in page,
   * or an address a later request asked the person to open.
   */
  readonly url?: (url: string) => void
  /**
   * Ask the person to complete a terminal sign-in.
   * @param signIn - the method and the program to run.
   * @param signal - ends the wait when the requesting turn is cancelled.
   * @returns whether to retry; `false` gives up.
   */
  readonly terminal?: (signIn: AcpTerminalSignIn, signal: AbortSignal | undefined) => Promise<boolean>
}

/** One answer option of a question. */
export interface AcpQuestionChoice {
  /** What the agent receives when the person picks it. */
  readonly value: string
  /** What the person reads. */
  readonly label: string
  readonly description?: string
}

/** One field of a question an agent asked. */
export type AcpQuestionField =
  | { readonly type: 'text'; readonly name: string; readonly label: string; readonly required: boolean }
  | { readonly type: 'number'; readonly name: string; readonly label: string; readonly required: boolean }
  | { readonly type: 'boolean'; readonly name: string; readonly label: string; readonly required: boolean }
  | {
    readonly type: 'choice'
    readonly name: string
    readonly label: string
    readonly required: boolean
    readonly options: readonly AcpQuestionChoice[]
    /** Whether several options may be picked. */
    readonly multi: boolean
  }

/** An agent asking the person a question in the middle of its work. */
export interface AcpQuestionRequest {
  /** What the agent asks. */
  readonly message: string
  /** What the agent expects as an answer. */
  readonly fields: readonly AcpQuestionField[]
  /** Aborts when the agent withdrew the request or the connection closed. */
  readonly signal: AbortSignal
}

/** One field's answer. */
export type AcpQuestionValue = string | number | boolean | readonly string[]

/** The answer to a question: the filled fields, a refusal to answer, or a cancelled request. */
export type AcpQuestionAnswer =
  | { readonly action: 'accept'; readonly content: Readonly<Record<string, AcpQuestionValue>> }
  | { readonly action: 'decline' }
  | { readonly action: 'cancel' }

/** Answers the questions of one connection. */
export type AcpQuestionAnswerer = (request: AcpQuestionRequest) => AcpQuestionAnswer | Promise<AcpQuestionAnswer>

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
   * Start a fresh session in the connection's working directory. A sign-in
   * the agent demands here is completed first.
   * @param options - local cancellation.
   * @returns the ready session.
   */
  newSession(options?: AcpSessionRequestOptions): Promise<AcpSession>
  /**
   * Reattach to a session the agent still holds. Rejects with an `AcpError`
   * of kind `unsupported` when the agent did not advertise resume, and with
   * the agent's own not-found error when it no longer holds the session.
   * @param sessionId - identity the agent assigned earlier.
   * @param options - local cancellation.
   * @returns the resumed session.
   */
  resumeSession(sessionId: string, options?: AcpSessionRequestOptions): Promise<AcpSession>
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

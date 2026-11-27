/**
 * The version-specific half of a connection. One binding speaks JSON-RPC with
 * the agent and maps one protocol version onto the normalized vocabulary; the
 * versions differ only in the {@link ProtocolShape} they supply.
 * @module @deepseek-ai/dsh-acp-client/binding
 */

import { AcpError } from './errors.ts'
import { readConfigOptions, readSessionModes } from './options.ts'
import { JsonRpcPeer, METHOD_NOT_FOUND } from './rpc.ts'
import { readQuestion } from './question.ts'
import type { AcpIo } from './transport.ts'
import { isRecord, parseSessionUpdate, toStopReason } from './update.ts'
import { V1 } from './v1.ts'
import { V2 } from './v2.ts'
import type {
  AcpAuthMethod,
  AcpCapabilities,
  AcpConfigOption,
  AcpConfigValue,
  AcpPermissionAnswer,
  AcpPermissionRequest,
  AcpProfileCustomize,
  AcpPromptBlock,
  AcpProtocol,
  AcpQuestionAnswer,
  AcpQuestionRequest,
  AcpSessionInfo,
  AcpSessionModes,
  AcpUpdate,
} from './types.ts'

/** The JSON-RPC method names of both protocol versions this client calls or answers. */
const METHOD = {
  initialize: 'initialize',
  newSession: 'session/new',
  list: 'session/list',
  close: 'session/close',
  setMode: 'session/set_mode',
  setConfigOption: 'session/set_config_option',
  prompt: 'session/prompt',
  cancel: 'session/cancel',
  update: 'session/update',
  permission: 'session/request_permission',
  question: 'elicitation/create',
} as const

/** JSON-RPC `Invalid params`. */
const INVALID_PARAMS = -32602

/** JSON-RPC `Resource not found`, which closing an absent session legitimately answers. */
const RESOURCE_NOT_FOUND = -32002

const DECLINE: AcpQuestionAnswer = { action: 'decline' }
const CANCEL: AcpQuestionAnswer = { action: 'cancel' }
const ACCEPT: AcpQuestionAnswer = { action: 'accept', content: {} }

/** The agent's answer to `initialize`, already normalized. */
export interface AcpHandshake {
  /** Protocol version the connection speaks from here on. */
  readonly protocolVersion: number
  readonly name?: string
  readonly version?: string
  readonly capabilities: AcpCapabilities
  /** Sign-in methods the agent offers, in its order. */
  readonly authMethods: readonly AcpAuthMethod[]
}

/** How a raw turn ended, before the stop reason was normalized. */
export interface RawTurnEnd {
  readonly stopReason: unknown
  readonly error?: string
}

/** Identity this client reports at the handshake. */
export interface AcpClientInfo {
  readonly name: string
  readonly version: string
}

/** What the client tells the agent it can do for a person. */
export interface AcpClientCapabilities {
  /** Answer an `elicitation/create` form. */
  readonly elicitation: boolean
  /** Have the agent offer its terminal sign-in methods. */
  readonly terminalAuth: boolean
}

/** The connection-side sinks a binding reports protocol traffic through. */
export interface BindingHandlers {
  /** A normalized `session/update` for one session. */
  update(sessionId: string, update: AcpUpdate): void
  /** Answer one `session/request_permission` request. */
  permission(request: AcpPermissionRequest): Promise<AcpPermissionAnswer>
  /** Answer one question; a consumer that answers nothing declines every one. */
  question(request: AcpQuestionRequest): Promise<AcpQuestionAnswer>
  /** Report an address the agent asked the person to open; `true` when someone shows it. */
  link(url: string): boolean
}

/** The options in effect when a session opened or reattached, or after a change. */
export interface AcpSessionSetup {
  readonly modes?: AcpSessionModes
  readonly configOptions?: readonly AcpConfigOption[]
}

/** How a protocol version reports the end of a turn. */
export type TurnCompletion =
  /** The `session/prompt` response carries the stop reason. */
  | 'response'
  /** An idle `state_update` ends the turn the prompt started. */
  | 'idle-state'

/** Everything that differs between protocol versions. */
export interface ProtocolShape {
  readonly version: AcpProtocol
  /** Method that completes one advertised authentication method. */
  readonly authenticate: string
  readonly completion: TurnCompletion
  initialize(client: AcpClientInfo, capabilities: AcpClientCapabilities): Record<string, unknown>
  newSession(cwd: string): Record<string, unknown>
  /** Resume a saved session: v1 picks `session/load` or `session/resume` by the handshake. */
  resume(handshakeResponse: unknown, sessionId: string, cwd: string): {
    readonly method: string
    readonly params: Record<string, unknown>
  }
  /** Read a raw permission request; `undefined` when its params are malformed. */
  permission(params: Readonly<Record<string, unknown>>, signal: AbortSignal): AcpPermissionRequest | undefined
  /** The mode switch of this version; absent where the version has none. */
  readonly setMode?: (sessionId: string, modeId: string) => { readonly method: string; readonly params: Record<string, unknown> }
  /** One option value in this version's wire shape. */
  configValue(value: AcpConfigValue): Record<string, unknown>
}

/** One protocol binding over an open byte stream. */
export interface AcpBinding {
  readonly version: AcpProtocol
  /** Settles when the connection closed from either side. */
  readonly closed: Promise<void>
  /**
   * Send `initialize`. `customize`, when a profile is pinned, rewrites the
   * request first.
   */
  initialize(customize: AcpProfileCustomize | undefined): Promise<AcpHandshake>
  /**
   * Install the rewrite every later agent-bound request passes through.
   * Called once the connection selected a profile by the agent's reported name.
   */
  use(customize: AcpProfileCustomize | undefined): void
  /** Complete one advertised authentication method. */
  authenticate(methodId: string): Promise<void>
  /** Start a session in the connection's working directory and read what it offers. */
  newSession(): Promise<AcpSessionSetup & { readonly sessionId: string }>
  /** Reattach to a session the agent still holds and read what it offers. */
  resumeSession(sessionId: string): Promise<AcpSessionSetup>
  listSessions(): Promise<readonly AcpSessionInfo[]>
  closeSession(sessionId: string): Promise<void>
  /**
   * Send one prompt. The promise settles when the turn ends on the agent's
   * side, and rejects when the agent refused the prompt, the turn failed, or
   * the connection broke.
   */
  prompt(sessionId: string, prompt: readonly AcpPromptBlock[]): Promise<RawTurnEnd>
  /** Send `session/cancel`. */
  cancel(sessionId: string): Promise<void>
  /** Switch the session's mode; `unsupported` where the version has none. */
  setMode(sessionId: string, modeId: string): Promise<void>
  /** Set one option and read every option as the agent reports them afterwards. */
  setConfigOption(sessionId: string, configId: string, value: AcpConfigValue): Promise<AcpSessionSetup>
  /** Close the connection; pending requests reject. */
  close(): void
}

/** Read the sign-in methods an agent advertised; an entry without an id is skipped and one without a name is called by its id. */
function readAuthMethods(value: unknown): AcpAuthMethod[] {
  if (!Array.isArray(value)) return []
  const methods: AcpAuthMethod[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string') continue
    const name = typeof item.name === 'string' ? item.name : item.id
    const description = typeof item.description === 'string' ? item.description : undefined
    const args = Array.isArray(item.args) && item.args.every(arg => typeof arg === 'string') ? item.args : undefined
    const env = isRecord(item.env) && Object.values(item.env).every(entry => typeof entry === 'string')
      ? item.env as Record<string, string>
      : undefined
    if (item.type === 'terminal') {
      methods.push({
        id: item.id,
        name,
        ...description === undefined ? {} : { description },
        kind: 'terminal',
        ...args === undefined ? {} : { args },
        ...env === undefined ? {} : { env },
      })
      continue
    }
    methods.push({ id: item.id, name, ...description === undefined ? {} : { description }, kind: 'agent' })
  }
  return methods
}

/**
 * Read one normalized handshake from a raw `initialize` response. Missing
 * fields read as absent, and a v2 agent owes resume, list, and close without
 * advertising them.
 * @param version - the version this client requested.
 * @param response - the agent's raw response.
 * @returns the normalized handshake.
 */
export function readHandshake(version: AcpProtocol, response: unknown): AcpHandshake {
  const raw = isRecord(response) ? response : {}
  const capabilities = isRecord(raw.agentCapabilities) ? raw.agentCapabilities : isRecord(raw.capabilities) ? raw.capabilities : {}
  const session = isRecord(capabilities.sessionCapabilities)
    ? capabilities.sessionCapabilities
    : isRecord(capabilities.session) ? capabilities.session : {}
  const prompt = isRecord(capabilities.promptCapabilities)
    ? capabilities.promptCapabilities
    : isRecord(session.prompt) ? session.prompt : {}
  const info = isRecord(raw.agentInfo) ? raw.agentInfo : isRecord(raw.info) ? raw.info : {}
  const name = typeof info.name === 'string' ? info.name : undefined
  const agentVersion = typeof info.version === 'string' ? info.version : undefined
  const required = version === 2
  return {
    protocolVersion: typeof raw.protocolVersion === 'number' ? raw.protocolVersion : 0,
    ...name === undefined ? {} : { name },
    ...agentVersion === undefined ? {} : { version: agentVersion },
    capabilities: {
      resume: required || capabilities.loadSession === true || session.resume != null,
      list: required || session.list != null,
      close: required || session.close != null,
      prompt: {
        image: prompt.image === true,
        audio: prompt.audio === true,
        embeddedContext: prompt.embeddedContext === true,
      },
    },
    authMethods: readAuthMethods(raw.authMethods),
  }
}

/** Read the id a `session/new` response published. */
function readSessionId(response: unknown): string {
  const sessionId = isRecord(response) ? response.sessionId : undefined
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new AcpError('protocol', 'session/new returned no session id')
  }
  return sessionId
}

/** Read the options one setup response carries; a response without any reads as none. */
function readSetup(response: unknown): AcpSessionSetup {
  if (!isRecord(response)) return {}
  const modes = readSessionModes(response.modes)
  const configOptions = readConfigOptions(response.configOptions)
  return {
    ...modes === undefined ? {} : { modes },
    ...configOptions === undefined ? {} : { configOptions },
  }
}

/**
 * Open the binding of one protocol version over an open byte stream.
 * @param version - the version this side speaks.
 * @param io - the agent's stdio as web streams.
 * @param cwd - working directory every new or resumed session uses.
 * @param clientInfo - identity this client reports at the handshake.
 * @param capabilities - what the consumer can do for a person.
 * @param handlers - the connection's sinks.
 * @returns the binding.
 */
export function openBinding(
  version: AcpProtocol,
  io: AcpIo,
  cwd: string,
  clientInfo: AcpClientInfo,
  capabilities: AcpClientCapabilities,
  handlers: BindingHandlers,
): AcpBinding {
  const shape = version === 1 ? V1 : V2
  let rewrite: AcpProfileCustomize | undefined
  let handshakeResponse: unknown
  /** The v2 turn each session has in flight, settled by that session's idle state update. */
  const inflight = new Map<string, PromiseWithResolvers<RawTurnEnd>>()
  const peer = new JsonRpcPeer(io, {
    notification: (method, params) => {
      if (method !== METHOD.update) return
      const envelope = parseSessionUpdate(params)
      if (envelope === undefined) return
      const update = envelope.update
      // v1 reports completion through the prompt response; its own state update would repeat it.
      if (shape.completion === 'response' && update.kind === 'state') return
      handlers.update(envelope.sessionId, update)
      if (shape.completion !== 'idle-state' || update.kind !== 'state' || update.state !== 'idle') return
      const pending = inflight.get(envelope.sessionId)
      if (pending === undefined) return
      inflight.delete(envelope.sessionId)
      pending.resolve({ stopReason: update.stopReason, ...update.error === undefined ? {} : { error: update.error } })
    },
    request: (method, params, signal) => {
      switch (method) {
        case METHOD.permission: {
          const request = shape.permission(isRecord(params) ? params : {}, signal)
          return request === undefined
            ? Promise.reject(new AcpError('protocol', 'malformed session/request_permission params', { code: INVALID_PARAMS }))
            : handlers.permission(request)
        }
        case METHOD.question: {
          const parsed = readQuestion(params, signal)
          if (parsed.kind === 'url') return Promise.resolve(handlers.link(parsed.url) ? ACCEPT : CANCEL)
          if (parsed.kind === 'unsupported') return Promise.resolve(DECLINE)
          // A consumer that cannot ask declines, and one that fails cancels: the agent proceeds either way.
          return Promise.resolve().then(() => handlers.question(parsed.request)).catch(() => CANCEL)
        }
        default:
          return Promise.reject(new AcpError('unsupported', `this client does not provide "${method}"`, { code: METHOD_NOT_FOUND }))
      }
    },
  })
  const shaped = (method: string, params: Record<string, unknown>, customize: AcpProfileCustomize | undefined): Record<string, unknown> =>
    customize === undefined ? params : customize({ method, params }).params
  const send = <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    peer.request<T>(method, shaped(method, params, rewrite))

  return {
    version,
    closed: peer.closed,
    async initialize(customize) {
      const request = shape.initialize(clientInfo, capabilities)
      handshakeResponse = await peer.request(METHOD.initialize, shaped(METHOD.initialize, request, customize))
      return readHandshake(version, handshakeResponse)
    },
    use(customize) {
      rewrite = customize
    },
    authenticate(methodId) {
      return send(shape.authenticate, { methodId }).then(() => undefined)
    },
    async newSession() {
      const response = await send(METHOD.newSession, shape.newSession(cwd))
      return { sessionId: readSessionId(response), ...readSetup(response) }
    },
    async resumeSession(sessionId) {
      const resume = shape.resume(handshakeResponse, sessionId, cwd)
      return readSetup(await send(resume.method, resume.params))
    },
    async listSessions() {
      const response = await send(METHOD.list, { cwd })
      const sessions: AcpSessionInfo[] = []
      for (const session of isRecord(response) && Array.isArray(response.sessions) ? response.sessions : []) {
        if (!isRecord(session) || typeof session.sessionId !== 'string') continue
        sessions.push({
          sessionId: session.sessionId,
          ...typeof session.cwd === 'string' ? { cwd: session.cwd } : {},
          ...typeof session.title === 'string' ? { title: session.title } : {},
        })
      }
      return sessions
    },
    async closeSession(sessionId) {
      try {
        await send(METHOD.close, { sessionId })
      } catch (error: unknown) {
        // Closing a session the agent no longer holds reaches the same end state.
        if (!(error instanceof AcpError) || error.code !== RESOURCE_NOT_FOUND) throw error
      }
    },
    async setMode(sessionId, modeId) {
      const set = shape.setMode
      if (set === undefined) throw new AcpError('unsupported', `ACP version ${version} has no session modes`)
      const request = set(sessionId, modeId)
      await send(request.method, request.params)
    },
    async setConfigOption(sessionId, configId, value) {
      return readSetup(await send(METHOD.setConfigOption, { sessionId, configId, ...shape.configValue(value) }))
    },
    prompt(sessionId, prompt) {
      if (shape.completion === 'idle-state') {
        const end = Promise.withResolvers<RawTurnEnd>()
        inflight.set(sessionId, end)
        // The response only acknowledges insertion; a refused prompt ends the turn here.
        void send(METHOD.prompt, { sessionId, prompt }).then(() => undefined, (error: unknown) => {
          if (inflight.get(sessionId) !== end) return
          inflight.delete(sessionId)
          end.reject(error)
        })
        return end.promise
      }
      const state = (update: Omit<Extract<AcpUpdate, { kind: 'state' }>, 'kind'>): void => {
        handlers.update(sessionId, { kind: 'state', ...update })
      }
      state({ state: 'running' })
      return send(METHOD.prompt, { sessionId, prompt }).then(
        (response: unknown): RawTurnEnd => {
          const end = { stopReason: isRecord(response) ? response.stopReason : undefined }
          state({ state: 'idle', stopReason: toStopReason(end.stopReason) })
          return end
        },
        (error: unknown) => {
          // A lost connection is the connection's failure to report, not a state the agent reached.
          if (!(error instanceof AcpError && error.kind === 'transport')) state({ state: 'idle', stopReason: 'error' })
          throw error
        },
      )
    },
    cancel(sessionId) {
      return peer.notify(METHOD.cancel, { sessionId })
    },
    close() {
      peer.close()
    },
  }
}

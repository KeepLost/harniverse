/**
 * The version-specific half of a connection. One binding speaks JSON-RPC with
 * the agent and maps one protocol version onto the normalized vocabulary; the
 * versions differ only in the {@link ProtocolShape} they supply.
 * @module @deepseek-ai/dsh-acp-client/binding
 */

import { AcpError } from './errors.ts'
import { JsonRpcPeer, METHOD_NOT_FOUND } from './rpc.ts'
import type { AcpIo } from './transport.ts'
import { isRecord, parseSessionUpdate, toStopReason } from './update.ts'
import { V1 } from './v1.ts'
import { V2 } from './v2.ts'
import type {
  AcpCapabilities,
  AcpPermissionAnswer,
  AcpPermissionRequest,
  AcpProfileCustomize,
  AcpPromptBlock,
  AcpProtocol,
  AcpSessionInfo,
  AcpUpdate,
} from './types.ts'

/** The JSON-RPC method names of both protocol versions this client calls or answers. */
const METHOD = {
  initialize: 'initialize',
  newSession: 'session/new',
  list: 'session/list',
  close: 'session/close',
  prompt: 'session/prompt',
  cancel: 'session/cancel',
  update: 'session/update',
  permission: 'session/request_permission',
} as const

/** JSON-RPC `Invalid params`. */
const INVALID_PARAMS = -32602

/** JSON-RPC `Resource not found`, which closing an absent session legitimately answers. */
const RESOURCE_NOT_FOUND = -32002

/** The agent's answer to `initialize`, already normalized. */
export interface AcpHandshake {
  /** Protocol version the connection speaks from here on. */
  readonly protocolVersion: number
  readonly name?: string
  readonly version?: string
  readonly capabilities: AcpCapabilities
  /** Authentication methods the agent still needs, in its order. */
  readonly authMethods: readonly AcpAuthMethod[]
}

/** One authentication method an agent advertised. */
export interface AcpAuthMethod {
  readonly id: string
  /** `true` when the method needs an interactive terminal this client does not provide. */
  readonly terminal: boolean
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

/** The connection-side sinks a binding reports protocol traffic through. */
export interface BindingHandlers {
  /** A normalized `session/update` for one session. */
  update(sessionId: string, update: AcpUpdate): void
  /** Answer one `session/request_permission` request. */
  permission(request: AcpPermissionRequest): Promise<AcpPermissionAnswer>
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
  initialize(client: AcpClientInfo): Record<string, unknown>
  newSession(cwd: string): Record<string, unknown>
  /** Resume a saved session: v1 picks `session/load` or `session/resume` by the handshake. */
  resume(handshakeResponse: unknown, sessionId: string, cwd: string): {
    readonly method: string
    readonly params: Record<string, unknown>
  }
  /** Read a raw permission request; `undefined` when its params are malformed. */
  permission(params: Readonly<Record<string, unknown>>, signal: AbortSignal): AcpPermissionRequest | undefined
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
  /** Start a session in the connection's working directory and return its id. */
  newSession(): Promise<string>
  /** Reattach to a session the agent still holds. */
  resumeSession(sessionId: string): Promise<void>
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
  /** Close the connection; pending requests reject. */
  close(): void
}

/** Read the authentication methods an agent advertised; entries without a string id are skipped. */
function readAuthMethods(value: unknown): AcpAuthMethod[] {
  if (!Array.isArray(value)) return []
  const methods: AcpAuthMethod[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string') continue
    methods.push({ id: item.id, terminal: item.type === 'terminal' })
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

/**
 * Open the binding of one protocol version over an open byte stream.
 * @param version - the version this side speaks.
 * @param io - the agent's stdio as web streams.
 * @param cwd - working directory every new or resumed session uses.
 * @param clientInfo - identity this client reports at the handshake.
 * @param handlers - the connection's sinks.
 * @returns the binding.
 */
export function openBinding(
  version: AcpProtocol,
  io: AcpIo,
  cwd: string,
  clientInfo: AcpClientInfo,
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
      if (method !== METHOD.permission) {
        return Promise.reject(new AcpError('unsupported', `this client does not provide "${method}"`, { code: METHOD_NOT_FOUND }))
      }
      const request = shape.permission(isRecord(params) ? params : {}, signal)
      return request === undefined
        ? Promise.reject(new AcpError('protocol', 'malformed session/request_permission params', { code: INVALID_PARAMS }))
        : handlers.permission(request)
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
      handshakeResponse = await peer.request(METHOD.initialize, shaped(METHOD.initialize, shape.initialize(clientInfo), customize))
      return readHandshake(version, handshakeResponse)
    },
    use(customize) {
      rewrite = customize
    },
    authenticate(methodId) {
      return send(shape.authenticate, { methodId }).then(() => undefined)
    },
    async newSession() {
      return readSessionId(await send(METHOD.newSession, shape.newSession(cwd)))
    },
    async resumeSession(sessionId) {
      const resume = shape.resume(handshakeResponse, sessionId, cwd)
      await send(resume.method, resume.params)
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

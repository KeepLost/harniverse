/**
 * An in-memory ACP agent for connection tests. The fake process exposes the
 * same two PassThrough streams on both sides: the client under test reads and
 * writes them through the subprocess handle, and a real SDK agent app binds to
 * their other ends, so the ndJSON codec and both SDK app layers run for real.
 */
import { PassThrough, Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentApp,
  type AgentRequestContext,
  type AuthenticateRequest,
  type CloseSessionRequest,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type LoadSessionRequest,
  type NewSessionRequest,
  type AuthenticateResponse,
  type CloseSessionResponse,
  type ListSessionsResponse,
  type LoadSessionResponse,
  type PromptRequest,
  type PromptResponse,
} from '@agentclientprotocol/sdk'
import type { SubprocessCollectedOutputs, SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** The requests a fake agent received, in arrival order. */
export interface Received {
  readonly method: string
  readonly params: unknown
}

/** Hooks of one fake v1 agent. Every hook may return a value or throw. */
export interface V1Script {
  initialize?: (params: InitializeRequest) => InitializeResponse | Promise<InitializeResponse>
  authenticate?: (params: AuthenticateRequest) => Promise<void> | void
  newSession?: (params: NewSessionRequest) => { sessionId: string } | Promise<{ sessionId: string }>
  prompt?: (
    request: PromptRequest,
    agent: AgentRequestContext<PromptRequest>['client'],
    signal: AbortSignal,
  ) => Promise<PromptResponse>
  cancel?: (sessionId: string) => void
  loadSession?: (params: LoadSessionRequest) => unknown
  listSessions?: (params: ListSessionsRequest) => unknown
  closeSession?: (params: CloseSessionRequest) => unknown
  /** Runs once the client closed the connection; replaces the default exit. */
  onClosed?: (process: FakeProcess) => void
}

/** The fake agent process as the subprocess seam presents it. */
export class FakeProcess implements SubprocessHandle {
  readonly pid = 4242
  readonly stdin: PassThrough = new PassThrough()
  readonly stdout: PassThrough = new PassThrough()
  readonly stderr = undefined
  readonly control = undefined
  readonly collected: SubprocessCollectedOutputs = {}
  readonly done: Promise<SubprocessOutcome>
  /** What `terminate()` does; the default models SIGTERM ending the process. */
  onTerminate: () => void = () => { this.exit(null, 'SIGTERM') }
  spec: SubprocessSpawnSpec | undefined
  private readonly outcome = Promise.withResolvers<SubprocessOutcome>()
  private settled = false

  constructor() {
    this.done = this.outcome.promise
    void this.done.catch(() => {
      // A test that fails the spawn observes the rejection through the client.
    })
  }

  /** End the process tree with an outcome. Later calls are ignored. */
  exit(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.settled) return
    this.settled = true
    this.stdout.end()
    this.stdin.end()
    this.outcome.resolve({ exitCode, signal })
  }

  /** Fail the spawn itself: `done` rejects and no process exists. */
  failSpawn(reason: unknown): void {
    this.settled = true
    this.outcome.reject(reason)
  }

  terminate(): void {
    this.onTerminate()
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.settled) return true
    const aborted = Promise.withResolvers<boolean>()
    const onAbort = (): void => { aborted.resolve(false) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await Promise.race([this.done.then(() => true), aborted.promise])
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

/** A subprocess seam whose every spawn yields a fake process bound to `start`. */
export function fakeSeam(start: (process: FakeProcess) => void): {
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  readonly processes: FakeProcess[]
} {
  const processes: FakeProcess[] = []
  return {
    processes,
    spawn: (spec) => {
      const process = new FakeProcess()
      process.spec = spec
      processes.push(process)
      start(process)
      return process
    },
  }
}

/**
 * Write one raw JSON-RPC message straight onto the client's input. The SDK
 * agent app validates what it sends, so an update variant outside its schema
 * reaches the client only this way.
 */
export function rawNotification(process: FakeProcess, method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

/** Bind a real v1 agent app to one fake process. */
export function attachV1(process: FakeProcess, script: V1Script, received: Received[] = []): {
  readonly app: AgentApp
  readonly received: Received[]
} {
  const app = agent()
  /** A script's answer, or the error it asked the agent to fail with. */
  const answer = (value: unknown): unknown => {
    if (value instanceof Error) throw value
    return value
  }
  app.onRequest(methods.agent.initialize, ({ params }) => {
    received.push({ method: 'initialize', params })
    return answer(script.initialize?.(params) ?? {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      authMethods: [],
      agentInfo: { name: 'fake-agent', version: '0.1.0' },
    }) as InitializeResponse
  })
  app.onRequest(methods.agent.authenticate, ({ params }) => {
    received.push({ method: 'authenticate', params })
    return answer(script.authenticate?.(params) ?? {}) as AuthenticateResponse
  })
  app.onRequest(methods.agent.session.new, ({ params }) => {
    received.push({ method: 'session/new', params })
    return answer(script.newSession?.(params) ?? { sessionId: 'session-1' }) as { sessionId: string }
  })
  app.onRequest(methods.agent.session.load, ({ params }) => {
    received.push({ method: 'session/load', params })
    return answer(script.loadSession?.(params) ?? {}) as LoadSessionResponse
  })
  app.onRequest(methods.agent.session.list, ({ params }) => {
    received.push({ method: 'session/list', params })
    return answer(script.listSessions?.(params) ?? { sessions: [] }) as ListSessionsResponse
  })
  app.onRequest(methods.agent.session.close, ({ params }) => {
    received.push({ method: 'session/close', params })
    return answer(script.closeSession?.(params) ?? {}) as CloseSessionResponse
  })
  app.onRequest(methods.agent.session.prompt, async ({ params, client, signal }) => {
    received.push({ method: 'session/prompt', params })
    if (script.prompt === undefined) return { stopReason: 'end_turn' }
    return script.prompt(params, client, signal)
  })
  app.onNotification(methods.agent.session.cancel, ({ params }) => {
    received.push({ method: 'session/cancel', params })
    script.cancel?.(params.sessionId)
  })
  app.onRequest('*', ({ method, params }) => {
    received.push({ method, params })
    return {}
  })
  const connection = app.connect(ndJsonStream(
    NodeWritable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    NodeReadable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ))
  // A real agent exits when its client goes away; a script that models a
  // different exit owns that through onClosed.
  void connection.closed.then(() => {
    if (script.onClosed === undefined) process.exit(0, null)
    else script.onClosed(process)
  })
  return { app, received }
}

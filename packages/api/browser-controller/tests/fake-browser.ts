/**
 * A fake browser speaking the Chrome DevTools Protocol over a real WebSocket
 * server. The controller's transport, flat-session multiplexing, and frame
 * decoding are the parts most likely to break, so the tests drive them over
 * genuine WebSocket framing instead of a hand-stubbed connection.
 */
import { createServer, type Server } from 'node:http'
import { PassThrough } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** Decode one ws frame, whose declared type covers every buffer shape. */
function rawText(data: unknown): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8')
  throw new TypeError('expected WebSocket raw data')
}

/** One command the fake browser received. */
interface RecordedCommand {
  readonly method: string
  readonly params: Record<string, unknown>
  readonly sessionId?: string
}

/** The fake browser's control surface for tests. */
export interface FakeBrowser {
  /** `ws://` endpoint the launcher reports. */
  readonly endpoint: string
  /** Every command received, in arrival order. */
  readonly commands: RecordedCommand[]
  /** Reply overrides keyed by method name. */
  readonly replies: Map<string, (params: Record<string, unknown>) => Record<string, unknown>>
  /** Methods that must answer with a protocol error. */
  readonly failures: Map<string, string>
  /** Methods the browser deliberately never answers. */
  readonly silent: Set<string>
  /** Methods answered with a reply carrying no `result` member. */
  readonly bare: Set<string>
  /** Methods answered with an error object carrying neither code nor message. */
  readonly vagueFailures: Set<string>
  /** Push one protocol event to the connected client. */
  emit: (method: string, params: Record<string, unknown>, sessionId?: string) => void
  /** Send one raw text frame (malformed-input material). */
  raw: (text: string) => void
  /** Send one binary frame, which the protocol never uses. */
  binary: (bytes: Uint8Array) => void
  /** Wait until the client has sent a command matching one method. */
  waitFor: (method: string) => Promise<RecordedCommand>
  /** Close the socket without a protocol goodbye. */
  drop: () => void
  /** Sever the socket abruptly, so the client observes a transport error. */
  kill: () => void
  /** Stop the server. */
  close: () => Promise<void>
}

/** Target ids the fake browser hands out, in creation order. */
const TARGET_PREFIX = 'target-'

/**
 * Start a fake browser endpoint.
 * @returns the running fake browser.
 */
export async function startFakeBrowser(): Promise<FakeBrowser> {
  const server: Server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake browser did not bind a port')
  const browserPath = '/devtools/browser/fake'
  // A real browser routes the DevTools socket by path: the tail is its own
  // session id, and an unknown one is refused rather than served. Matching that
  // is what makes a half-read endpoint observable here instead of silently
  // connecting to a permissive test double.
  const sockets = new WebSocketServer({ server, path: browserPath })
  const commands: RecordedCommand[] = []
  const replies = new Map<string, (params: Record<string, unknown>) => Record<string, unknown>>()
  const failures = new Map<string, string>()
  const silent = new Set<string>()
  const bare = new Set<string>()
  const vagueFailures = new Set<string>()
  const waiters = new Map<string, (command: RecordedCommand) => void>()
  let client: WebSocket | undefined
  let targets = 0

  sockets.on('connection', (socket) => {
    client = socket
    socket.on('message', (data) => {
      const message = JSON.parse(rawText(data)) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string }
      const record: RecordedCommand = {
        method: message.method,
        params: message.params,
        ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
      }
      commands.push(record)
      waiters.get(message.method)?.(record)
      waiters.delete(message.method)
      if (silent.has(message.method)) return
      if (bare.has(message.method)) {
        socket.send(JSON.stringify({ id: message.id }))
        return
      }
      if (vagueFailures.has(message.method)) {
        socket.send(JSON.stringify({ id: message.id, error: {} }))
        return
      }
      const failure = failures.get(message.method)
      if (failure !== undefined) {
        socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: failure } }))
        return
      }
      const override = replies.get(message.method)
      const result = override !== undefined ? override(message.params) : defaultResult(message.method, () => {
        targets += 1
        return `${TARGET_PREFIX}${String(targets)}`
      })
      socket.send(JSON.stringify({ id: message.id, result }))
    })
  })

  return {
    endpoint: `ws://127.0.0.1:${String(address.port)}${browserPath}`,
    commands,
    replies,
    failures,
    silent,
    bare,
    vagueFailures,
    emit: (method, params, sessionId) => {
      client?.send(JSON.stringify({ method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    },
    raw: (text) => { client?.send(text) },
    binary: (bytes) => { client?.send(bytes, { binary: true }) },
    waitFor: (method) => {
      const seen = commands.find(command => command.method === method)
      if (seen !== undefined) return Promise.resolve(seen)
      return new Promise<RecordedCommand>((resolve) => { waiters.set(method, resolve) })
    },
    drop: () => { client?.close() },
    kill: () => {
      client?.terminate()
    },
    close: () => new Promise<void>((resolve) => { sockets.close(() => { server.close(() => { resolve() }) }) }),
  }
}

/**
 * Default reply for one protocol method.
 * @param method - protocol method name.
 * @param mintTarget - allocate the next target id.
 * @returns the reply's result object.
 */
function defaultResult(method: string, mintTarget: () => string): Record<string, unknown> {
  if (method === 'Target.createTarget') return { targetId: mintTarget() }
  if (method === 'Target.attachToTarget') return { sessionId: 'flat-session' }
  if (method === 'Page.getNavigationHistory') {
    return { currentIndex: 1, entries: [{ id: 10, url: 'https://first.example' }, { id: 11, url: 'https://second.example' }] }
  }
  return {}
}

/** A fake subprocess provider whose spawn reports the fake browser's endpoint. */
export interface FakeSubprocess {
  readonly runtime: SubprocessRuntime
  /** Spawn specs the controller submitted. */
  readonly spawns: SubprocessSpawnSpec[]
  /** Executables the controller probed. */
  readonly probes: string[]
  /** Handles the provider returned. */
  readonly handles: { terminate: () => void; exit: () => void; fail: () => void; endStderr: () => void }[]
  /** Executables that resolve; every other probe fails. */
  resolvable: Set<string>
  /** Endpoint line written to the child's stderr; undefined writes nothing. */
  endpoint: string | undefined
  /** When true, awaiting a spawned tree's exit fails. */
  failWaitForExit: boolean
  /** When true, the spawned handle exposes no diagnostic stream. */
  withoutStderr: boolean
  /** When true, stderr is decoded to strings before the launcher reads it. */
  stringChunks: boolean
  /** Diagnostic noise written before the endpoint line. */
  prelude: string | undefined
  /**
   * Bytes of the endpoint line withheld from the first stderr chunk, mimicking
   * a pipe that delivers the line in two reads. A real browser's endpoint line
   * arrives split whenever the preceding diagnostic noise lands the boundary
   * mid-line.
   */
  splitEndpointTail: number | undefined
}

/**
 * Build a subprocess provider that answers a browser launch.
 * @param endpoint - endpoint line to report, or undefined to report none.
 * @returns the fake provider and its recordings.
 */
export function fakeSubprocess(endpoint: string | undefined): FakeSubprocess {
  const spawns: SubprocessSpawnSpec[] = []
  const probes: string[] = []
  const handles: { terminate: () => void; exit: () => void; fail: () => void; endStderr: () => void }[] = []
  const fake: FakeSubprocess = {
    spawns,
    probes,
    handles,
    resolvable: new Set(['google-chrome']),
    endpoint,
    failWaitForExit: false,
    withoutStderr: false,
    stringChunks: false,
    prelude: undefined,
    splitEndpointTail: undefined,
    runtime: {
      resolveExecutable: (command: string) => {
        probes.push(command)
        return fake.resolvable.has(command)
          ? Promise.resolve(`/usr/bin/${command}`)
          : Promise.reject(new Error(`${command} not found`))
      },
      spawn: (spec: SubprocessSpawnSpec) => {
        spawns.push(spec)
        const stderr = fake.stringChunks ? new PassThrough({ encoding: 'utf8' }) : new PassThrough()
        const exit = Promise.withResolvers<{ exitCode: number; signal: null }>()
        const handle = {
          pid: 4321,
          stdin: undefined,
          stdout: undefined,
          stderr: fake.withoutStderr ? undefined : stderr,
          collected: {},
          done: exit.promise,
          terminate: () => { exit.resolve({ exitCode: 0, signal: null }) },
          waitForExit: () => fake.failWaitForExit
            ? Promise.reject(new Error('the browser tree never quiesced'))
            : exit.promise.then(() => true),
        } as unknown as SubprocessHandle
        handles.push({
          terminate: () => { handle.terminate() },
          exit: () => { exit.resolve({ exitCode: 1, signal: null }) },
          fail: () => { exit.reject(new Error('the browser process could not be observed')) },
          endStderr: () => { stderr.end() },
        })
        if (fake.prelude !== undefined) setTimeout(() => { stderr.write(`${String(fake.prelude)}\n`) }, 0)
        if (fake.endpoint !== undefined) {
          const line = `DevTools listening on ${fake.endpoint}\n`
          const withheld = fake.splitEndpointTail
          setTimeout(() => {
            if (withheld === undefined) {
              stderr.write(line)
              return
            }
            stderr.write(line.slice(0, line.length - withheld))
            setTimeout(() => { stderr.write(line.slice(line.length - withheld)) }, 0)
          }, 0)
        }
        return handle
      },
      spawnTerminal: () => Promise.reject(new Error('the browser controller never allocates a terminal')),
    } as unknown as SubprocessRuntime,
  }
  return fake
}

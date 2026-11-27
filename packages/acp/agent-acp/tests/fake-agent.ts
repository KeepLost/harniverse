/**
 * Scripted external ACP agent for the agent-acp tests: a real process speaking
 * real ACP over stdio through the SDK's agent app. `ACP_FAKE_SCENARIO` names a
 * JSON file with one script entry per prompt, in order; `ACP_FAKE_LOG` names
 * the file that records every request the agent receives, and
 * `ACP_FAKE_EOF` the marker it writes when its client closes the connection.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { agent, methods, ndJsonStream, RequestError } from '@agentclientprotocol/sdk'

interface Turn {
  updates?: Record<string, unknown>[]
  stopReason?: string
  permission?: { title?: string; toolCallId?: string; options: { optionId: string; name: string; kind: string }[] }
  /** A form question the agent asks before it goes on. */
  question?: { message: string; requestedSchema: Record<string, unknown> }
  hang?: boolean
  exit?: number
  /** Milliseconds to wait after the updates, letting them reach the client before what follows. */
  settle?: number
  echoCwd?: boolean
}

interface Scenario {
  /** `null` reports no agent name at all. */
  name?: string | null
  version?: string
  turns: Turn[]
  /** Advertise `loadSession` and answer `session/load` for a session this agent opened. */
  resumable?: boolean
  /** Refuse every session until the sign-in is completed. */
  auth?: {
    method: 'agent' | 'terminal'
    /** An address the agent prints while it waits for its browser sign-in. */
    url?: string
    /** Print the address twice, as an agent that repeats itself does. */
    twice?: boolean
    /** `false`: the terminal method names no environment. */
    env?: boolean
    /** `beside-log`: a file beside the log whose existence means the person completed the terminal sign-in. */
    marker?: 'beside-log'
  }
  /** What `session/new` reports beside its id. */
  options?: { modes?: unknown; configOptions?: Record<string, unknown>[] }
  /** Make `session/load` fail with an internal error instead of answering. */
  loadFails?: boolean
}

const scenarioPath = process.env.ACP_FAKE_SCENARIO
const logPath = process.env.ACP_FAKE_LOG
const eofPath = process.env.ACP_FAKE_EOF
if (scenarioPath === undefined || logPath === undefined) {
  throw new Error('the fake ACP agent needs ACP_FAKE_SCENARIO and ACP_FAKE_LOG')
}
const logFile: string = logPath
const scenario = JSON.parse(await readFile(scenarioPath, 'utf8')) as Scenario
// The script position survives across processes, so a restarted agent continues the scenario.
const counter = `${logFile}.turn`
function nextTurn(): Turn | undefined {
  const index = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
  writeFileSync(counter, String(index + 1))
  return scenario.turns[index]
}
/** The sessions every process of this agent opened, so a later one can resume them. */
const sessionsFile = `${logFile}.sessions`
const openedSessions = (): string[] => (existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, 'utf8')) as string[] : [])
let sessionCwd = ''
let cancelReason: string | undefined

function log(entry: Record<string, unknown>): void {
  appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
}

const signedIn = (): boolean => scenario.auth === undefined
  || existsSync(scenario.auth.marker === 'beside-log' ? `${logFile}.login-done` : `${logFile}.auth`)

const app = agent()

app.onRequest(methods.agent.initialize, ({ params }) => {
  log({ method: 'initialize', params, env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('FAKE_'))) })
  return {
    protocolVersion: 1,
    ...scenario.name === null
      ? {}
      : {
        agentInfo: { name: scenario.name ?? 'fake-external', version: scenario.version ?? '1.0.0' },
      },
    agentCapabilities: {
      loadSession: scenario.resumable === true,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    },
    authMethods: scenario.auth === undefined
      ? []
      : scenario.auth.method === 'terminal'
        ? [{
          id: 'setup', name: 'Setup', type: 'terminal', args: ['--login'],
          ...scenario.auth.env === false ? {} : { env: { SETUP_MODE: '1' } },
        }]
        : [{ id: 'agent-login', name: 'Login' }],
  }
})

app.onRequest(methods.agent.authenticate, ({ params }) => {
  log({ method: 'authenticate', params })
  if (scenario.auth?.url !== undefined) {
    process.stderr.write(`Sign in at ${scenario.auth.url} to continue.\n`)
    if (scenario.auth.twice === true) process.stderr.write(`Still waiting on ${scenario.auth.url} ...\n`)
  }
  writeFileSync(`${logFile}.auth`, 'ok')
})

app.onRequest(methods.agent.session.new, ({ params }) => {
  sessionCwd = params.cwd
  log({ method: 'session/new', params })
  if (!signedIn()) throw new RequestError(-32000, 'Authentication required')
  const opened = openedSessions()
  const sessionId = `external-${opened.length + 1}`
  writeFileSync(sessionsFile, JSON.stringify([...opened, sessionId]))
  return { sessionId, ...scenario.options } as never
})

app.onRequest(methods.agent.session.load, ({ params }) => {
  log({ method: 'session/load', params })
  sessionCwd = params.cwd
  if (scenario.loadFails === true) throw new RequestError(-32603, 'Internal error')
  if (!openedSessions().includes(params.sessionId)) throw new RequestError(-32002, 'Resource not found')
  return { ...scenario.options } as never
})

app.onRequest(methods.agent.session.setMode, ({ params }) => {
  log({ method: 'session/set_mode', params })
  const modes = scenario.options?.modes as { availableModes?: { id: string }[] } | undefined
  if (modes !== undefined && !(modes.availableModes ?? []).some(mode => mode.id === params.modeId)) {
    throw new RequestError(-32602, 'Invalid params')
  }
  return {}
})

/** The options in effect, as the agent keeps them; a set request replaces one value. */
const configOptions: Record<string, unknown>[] = (scenario.options?.configOptions ?? []).map(option => ({ ...option }))
app.onRequest(methods.agent.session.setConfigOption, ({ params }) => {
  log({ method: 'session/set_config_option', params })
  const option = configOptions.find(candidate => candidate.id === params.configId)
  if (option !== undefined) option.currentValue = params.value
  return { configOptions } as never
})

app.onNotification(methods.agent.session.cancel, ({ params }) => {
  log({ method: 'session/cancel', params })
  cancelReason = 'cancelled'
})

app.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
  log({ method: 'session/prompt', params })
  const turn = nextTurn()
  if (turn === undefined) return { stopReason: 'end_turn' }
  if (turn.permission !== undefined) {
    const decision = await client.request(methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: {
        ...turn.permission.toolCallId === undefined ? {} : { toolCallId: turn.permission.toolCallId },
        ...turn.permission.title === undefined ? {} : { title: turn.permission.title },
      },
      options: turn.permission.options,
    } as never)
    log({ method: 'permission-decision', decision })
  }
  if (turn.question !== undefined) {
    const answer = await client.request(methods.client.elicitation.create, {
      mode: 'form',
      message: turn.question.message,
      sessionId: params.sessionId,
      requestedSchema: turn.question.requestedSchema,
    } as never)
    log({ method: 'question-answer', answer })
  }
  for (const update of turn.updates ?? []) {
    await client.notify(methods.client.session.update, { sessionId: params.sessionId, update } as never)
  }
  if (turn.settle !== undefined) await new Promise(resolveWait => setTimeout(resolveWait, turn.settle))
  if (turn.exit !== undefined) process.exit(turn.exit)
  if (turn.echoCwd === true) {
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${process.cwd()}|${sessionCwd}` } },
    })
  }
  if (turn.hang === true) {
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (cancelReason !== undefined) {
          clearInterval(timer)
          resolve()
        }
      }, 10)
    })
    return { stopReason: (cancelReason ?? 'cancelled') as 'cancelled' }
  }
  return { stopReason: (turn.stopReason ?? 'end_turn') as 'end_turn' }
})

const connection = app.connect(ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
))

// A real agent exits when its client goes away; the marker proves the reap to the test.
void connection.closed.then(() => {
  if (eofPath !== undefined) writeFileSync(eofPath, 'eof')
  process.exit(0)
})

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
import { agent, methods, ndJsonStream } from '@agentclientprotocol/sdk'

interface Turn {
  updates?: Record<string, unknown>[]
  stopReason?: string
  permission?: { title?: string; toolCallId?: string; options: { optionId: string; name: string; kind: string }[] }
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
const counter = `${logPath}.turn`
function nextTurn(): Turn | undefined {
  const index = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
  writeFileSync(counter, String(index + 1))
  return scenario.turns[index]
}
let sessionCwd = ''
let cancelReason: string | undefined

function log(entry: Record<string, unknown>): void {
  appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
}

const app = agent()

app.onRequest(methods.agent.initialize, ({ params }) => {
  log({ method: 'initialize', params })
  return {
    protocolVersion: 1,
    ...scenario.name === null ? {} : { agentInfo: { name: scenario.name ?? 'fake-external', version: scenario.version ?? '1.0.0' } },
    agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
    authMethods: [],
  }
})

app.onRequest(methods.agent.session.new, ({ params }) => {
  sessionCwd = params.cwd
  log({ method: 'session/new', params })
  return { sessionId: 'external-1' }
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

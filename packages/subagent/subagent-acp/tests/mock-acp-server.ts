/**
 * Scripted ACP agent for the subagent-acp tests. It speaks real ACP JSON-RPC
 * over stdio through the SDK's agent app and takes its behavior from MOCK_*
 * environment variables, so each test scripts one scenario keylessly.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, type RequestPermissionResponse } from '@agentclientprotocol/sdk'

const echoEnvName = process.env.MOCK_ECHO_ENV
const TEXT = echoEnvName !== undefined
  ? process.env[echoEnvName] ?? `<${echoEnvName} unset>`
  : process.env.MOCK_TEXT ?? 'mock child answer'
const ECHO_CWD = process.env.MOCK_ECHO_CWD === '1'
const STOP = process.env.MOCK_STOP ?? 'end_turn'
const HANG = process.env.MOCK_HANG === '1'
const WANT_PERMISSION = process.env.MOCK_PERMISSION === '1'
const NO_ALLOW = process.env.MOCK_NO_ALLOW === '1'
const THOUGHT = process.env.MOCK_THOUGHT === '1'
const CRASH_ON_CANCEL = process.env.MOCK_CRASH_ON_CANCEL === '1'
const CRASH_ON_PROMPT = process.env.MOCK_CRASH_ON_PROMPT === '1'
const IGNORE_CANCEL = process.env.MOCK_IGNORE_CANCEL === '1'
const READY_FILE = process.env.MOCK_READY_FILE
const FLUSH_ON_EOF = process.env.MOCK_FLUSH_ON_EOF
function gate(prefix: string): { ready: string; go: string } | undefined {
  const ready = process.env[`${prefix}_READY`]
  const go = process.env[`${prefix}_GO`]
  return ready !== undefined && go !== undefined ? { ready, go } : undefined
}
const INITIALIZE_GATE = gate('MOCK_INITIALIZE')
const NEWSESSION_GATE = gate('MOCK_NEWSESSION')

/** Signal `ready`, then block the request until the test writes `go`. */
async function hold(gate: { ready: string; go: string }): Promise<void> {
  writeFileSync(gate.ready, 'held')
  while (!existsSync(gate.go)) await new Promise(resolve => setTimeout(resolve, 10))
}

let resolveCancel: ((reason: string) => void) | undefined
let sessionCwd: string | undefined

const app = agent()

app.onRequest(methods.agent.initialize, async () => {
  if (INITIALIZE_GATE !== undefined) await hold(INITIALIZE_GATE)
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
    authMethods: [],
  }
})

app.onRequest(methods.agent.authenticate, () => ({}))

app.onRequest(methods.agent.session.new, async ({ params }) => {
  sessionCwd = params.cwd
  if (NEWSESSION_GATE !== undefined) await hold(NEWSESSION_GATE)
  if (process.env.MOCK_MISSING_SESSION_ID === '1') return {} as never
  return { sessionId: process.env.MOCK_SESSION_ID ?? randomUUID() }
})

app.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
  if (CRASH_ON_PROMPT) process.exit(1)
  if (WANT_PERMISSION) {
    const options: { optionId: string; name: string; kind: 'allow_once' | 'reject_once' }[] = NO_ALLOW
      ? [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }]
      : [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ]
    const decision = await client.request(methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: { toolCallId: 'mock-call', title: 'mock side effect' },
      options,
    }) as RequestPermissionResponse
    if (decision.outcome.outcome === 'cancelled') {
      return { stopReason: 'cancelled' as const }
    }
  }
  if (THOUGHT) {
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } },
    })
  }
  await client.notify(methods.client.session.update, {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: ECHO_CWD ? `${process.cwd()}\n${sessionCwd ?? ''}` : TEXT },
    },
  })
  if (READY_FILE !== undefined) writeFileSync(READY_FILE, 'ready')
  if (HANG) {
    return new Promise((resolve) => {
      resolveCancel = (reason) => { resolve({ stopReason: reason as 'end_turn' }) }
    })
  }
  return { stopReason: STOP as 'end_turn' }
})

app.onNotification(methods.agent.session.cancel, () => {
  if (CRASH_ON_CANCEL) {
    process.exit(1)
  }
  if (IGNORE_CANCEL) {
    return
  }
  resolveCancel?.('cancelled')
})

app.connect(ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
))

if (process.env.MOCK_TRAP_SIGTERM === '1') {
  process.on('SIGTERM', () => { /* trapped: refuse to exit on the graceful signal */ })
  setInterval(() => { /* stay alive until SIGKILL */ }, 1000)
  if (READY_FILE !== undefined) writeFileSync(READY_FILE, 'trap-armed')
}

if (FLUSH_ON_EOF !== undefined) {
  const flushDelayMs = Number(process.env.MOCK_FLUSH_DELAY_MS ?? '150')
  process.stdin.on('end', () => {
    setTimeout(() => {
      writeFileSync(FLUSH_ON_EOF, 'flushed')
      process.exit(0)
    }, flushDelayMs)
  })
}

if (process.env.MOCK_IGNORE_EOF === '1') {
  const sigtermFile = process.env.MOCK_SIGTERM_FILE
  process.on('SIGTERM', () => {
    if (sigtermFile !== undefined) writeFileSync(sigtermFile, 'sigterm')
    process.exit(0)
  })
  setInterval(() => { /* stay alive past EOF until SIGTERM */ }, 1000)
  if (READY_FILE !== undefined) writeFileSync(READY_FILE, 'ignore-eof-armed')
}

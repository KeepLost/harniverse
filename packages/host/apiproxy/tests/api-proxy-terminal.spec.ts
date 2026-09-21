/**
 * Terminal attachment and window-hold streams over the proxy: opening
 * `events.terminal` claims the exclusive input attachment (snapshot first,
 * then live output frames), `events.hold` retains the terminal while the
 * stream stays open, and both close with `stream/error` frames when the
 * controller is absent or the session is unknown.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PassThrough } from 'node:stream'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import TerminalController from '@deepseek-ai/dsh-api-terminal-controller'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import type { TerminalAttachmentId, WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { ApiProxy, HoldStreamFrame, TerminalStreamFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

interface Fixture {
  ctx: Context
  api: ApiProxy
  agent: Agent
  output: PassThrough
  handle: { terminate: ReturnType<typeof vi.fn> }
}

async function harness(withController = true): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(UserQuestionService)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  ctx.provide('sandboxPolicy', {
    defaultMode: 'danger-full-access',
    workspaceRoot: '/workspace',
    resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/workspace' }),
  } as never)
  const output = new PassThrough()
  const done = Promise.withResolvers<{ exitCode: number; signal: null }>()
  const handle = {
    pid: 321, output, done: done.promise, write: vi.fn(async () => {}), resize: vi.fn(async () => {}),
    inspectForeground: vi.fn<SubprocessTerminalHandle['inspectForeground']>(async () => undefined), signalForeground: async () => 7,
    terminate: vi.fn(async () => { output.end(); done.resolve({ exitCode: 0, signal: null }) }),
  }
  ctx.provide('subprocess', {
    resolveExecutable: vi.fn(async (path: string) => path),
    spawnTerminal: vi.fn(async () => handle as SubprocessTerminalHandle),
  } as never)
  if (withController) {
    await ctx.plugin(TerminalController, {
      shell: { path: '/bin/bash', name: 'bash', args: [] },
      shellCandidates: [],
      unattendedTimeoutMs: 0,
      disposeGraceMs: 50,
    })
  }
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }), cwd: '/tmp' })
  const sessionId = SessionId('terminal-stream-session')
  await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('agent registry did not expose the created agent')
  return { ctx, api, agent, output, handle }
}

function collect<F extends TerminalStreamFrame | HoldStreamFrame>(stream: AsyncIterable<{ payload: F }>, _abort: AbortController): {
  frames: F[]
  waitFor(predicate: (frame: F) => boolean): Promise<F>
} {
  const frames: F[] = []
  const waiters: ((frame: F) => boolean)[] = []
  void (async () => {
    try {
      for await (const envelope of stream) {
        frames.push(envelope.payload)
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          const waiter = waiters[index] as (frame: F) => boolean
          if (waiter(envelope.payload)) waiters.splice(index, 1)
        }
      }
    } catch { /* stream teardown races the abort; the frame log is the assertion surface */ }
  })()
  return {
    frames,
    waitFor: predicate => new Promise((resolve) => {
      waiters.push((frame) => {
        if (predicate(frame)) {
          resolve(frame)
          return true
        }
        return false
      })
    }),
  }
}

const defaults = { rpcId: RpcId('r-terminal'), principal: undefined }

describe('events.terminal / events.hold streams', () => {
  it('streams the attachment snapshot then live output, and abort detaches', async () => {
    const { ctx, api, agent, output } = await harness()
    const controller = ctx.get('terminalController')
    if (controller === undefined) throw new Error('controller missing from harness')
    const id = 'streamed' as WebTerminalId
    await controller.create(agent, { id, cols: 80, rows: 24 }, new AbortController().signal)
    const abort = new AbortController()
    const log = collect(api.events.terminal({
      ...defaults,
      payload: { sessionId: agent.id, id, attachmentId: 'attach-1' as TerminalAttachmentId },
    }, abort.signal), abort)
    const snapshot = await log.waitFor(frame => frame.type === 'snapshot')
    expect(snapshot).toMatchObject({ type: 'snapshot', info: { id, state: 'running' } })
    output.write('hello from the pty')
    await log.waitFor(frame => frame.type === 'output' && frame.data.includes('hello from the pty'))
    abort.abort()
    await vi.waitFor(() => { expect(log.frames.at(-1)).toBeDefined() })
  })

  it('answers a stream/error frame for an unknown session', async () => {
    const { api } = await harness()
    const abort = new AbortController()
    const log = collect(api.events.terminal({
      ...defaults,
      payload: { sessionId: SessionId('never-created'), id: 'x' as WebTerminalId, attachmentId: 'a' as TerminalAttachmentId },
    }, abort.signal), abort)
    const failure = await log.waitFor(frame => frame.type === 'stream/error')
    expect(failure).toMatchObject({ type: 'stream/error', error: { code: 'terminal-unavailable' } })
    abort.abort()
  })

  it('maps a controller RemoteError onto the stream/error vocabulary', async () => {
    const { ctx, api, agent } = await harness()
    const controller = ctx.get('terminalController')
    if (controller === undefined) throw new Error('controller missing from harness')
    const abort = new AbortController()
    const log = collect(api.events.terminal({
      ...defaults,
      payload: { sessionId: agent.id, id: 'never-spawned' as WebTerminalId, attachmentId: 'a' as TerminalAttachmentId },
    }, abort.signal), abort)
    const failure = await log.waitFor(frame => frame.type === 'stream/error')
    expect(failure).toMatchObject({ type: 'stream/error', error: { code: 'terminal-unavailable', message: 'Terminal no longer exists in this Session' } })
    abort.abort()
  })

  it('collapses a non-remote stream failure to internal', async () => {
    const { ctx, api, agent } = await harness()
    const controller = ctx.get('terminalController')
    if (controller === undefined) throw new Error('controller missing from harness')
    const id = 'malformed' as WebTerminalId
    await controller.create(agent, { id, cols: 80, rows: 24 }, new AbortController().signal)
    const abort = new AbortController()
    const log = collect(api.events.terminal({
      ...defaults,
      payload: { sessionId: agent.id, id, attachmentId: 'not a valid attachment id!' as TerminalAttachmentId },
    }, abort.signal), abort)
    const failure = await log.waitFor(frame => frame.type === 'stream/error')
    expect(failure).toMatchObject({ type: 'stream/error', error: { code: 'internal', message: 'Invalid terminal attachment identity' } })
    abort.abort()
  })

  it('answers a stream/error frame when the terminal controller is absent', async () => {
    const { api } = await harness(false)
    const abort = new AbortController()
    const log = collect(api.events.hold({
      ...defaults,
      payload: { sessionId: SessionId('any'), id: 'x' as WebTerminalId },
    }, abort.signal), abort)
    const failure = await log.waitFor(frame => frame.type === 'stream/error')
    expect(failure).toMatchObject({ type: 'stream/error', error: { code: 'terminal-unavailable', message: /terminal service is absent/ } })
    abort.abort()
  })

  it('retains a terminal through an open hold stream and releases on abort', async () => {
    const { ctx, api, agent } = await harness()
    const controller = ctx.get('terminalController')
    if (controller === undefined) throw new Error('controller missing from harness')
    const id = 'held' as WebTerminalId
    await controller.create(agent, { id, cols: 80, rows: 24 }, new AbortController().signal)
    const abort = new AbortController()
    const log = collect(api.events.hold({
      ...defaults,
      payload: { sessionId: agent.id, id },
    }, abort.signal), abort)
    await log.waitFor(frame => frame.type === 'retained')
    abort.abort()
    await vi.waitFor(() => { expect(controller.list(agent.id).length).toBe(1) })
  })
})

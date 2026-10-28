/**
 * Entity-stream downlink: `events.streams` binds a page-scoped carrier,
 * `events.streams.open` starts family producers as substreams (identical
 * semantics to each family's own stream), `close` detaches idempotently, the
 * per-page cap refuses, and the page's last downlink reaps every substream it
 * still holds — the substream form of stream-abort detach.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
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
import type { ApiProxy, StreamsFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

interface Fixture {
  ctx: Context
  api: ApiProxy
  agent: Agent
  output: PassThrough
}

async function harness(subsPerPage?: number): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(UserQuestionService)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [], get: () => undefined } as never)
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
  await ctx.plugin(TerminalController, {
    shell: { path: '/bin/bash', name: 'bash', args: [] },
    shellCandidates: [],
    maxTerminals: 8,
    maxCols: 500,
    maxRows: 200,
    scrollback: 1000,
    maxBufferedBytes: 2 * 1024 * 1024,
    maxInputBytes: 64 * 1024,
    disposeGraceMs: 50,
    unattendedTimeoutMs: 0,
    activityPollIntervalMs: 30_000,
    cleanupRetryMs: 60_000,
  })
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
    cwd: '/tmp',
    ...(subsPerPage === undefined ? {} : { entityStreamSubsMaxPerPage: subsPerPage }),
  })
  const sessionId = SessionId('entity-stream-session')
  await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('agent registry did not expose the created agent')
  return { ctx, api, agent, output }
}

function collect(stream: AsyncIterable<{ payload: StreamsFrame }>, _abort: AbortController): {
  frames: StreamsFrame[]
  waitFor(predicate: (frame: StreamsFrame) => boolean): Promise<StreamsFrame>
} {
  const frames: StreamsFrame[] = []
  const waiters: ((frame: StreamsFrame) => boolean)[] = []
  void (async () => {
    try {
      for await (const envelope of stream) {
        frames.push(envelope.payload)
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          const waiter = waiters[index] as (frame: StreamsFrame) => boolean
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

function request<P extends object>(payload: P): { rpcId: typeof RpcId.prototype; payload: P } {
  return { rpcId: RpcId('r-streams'), payload }
}

async function openDownlink(api: ApiProxy, page: string): Promise<{ log: ReturnType<typeof collect>; abort: AbortController }> {
  const abort = new AbortController()
  const log = collect(api.events.streams(request({ page }), abort.signal), abort)
  return { log, abort }
}

afterEach(() => { vi.restoreAllMocks() })

describe('entity-stream downlink', () => {
  it('delivers sub/ready, family frames, and sub/end for a terminal substream', async () => {
    const { ctx, api, agent, output } = await harness()
    const controller = ctx.get('terminalController')
    if (controller === undefined) throw new Error('controller missing from harness')
    const id = 'substreamed' as WebTerminalId
    await controller.create(agent, { id, cols: 80, rows: 24 }, new AbortController().signal)
    const { log, abort } = await openDownlink(api, 'page-1')
    const opened = await api.events.streamsOpen(request({
      page: 'page-1',
      family: 'terminal',
      payload: { sessionId: agent.id, id, attachmentId: 'attach-1' as TerminalAttachmentId },
    }))
    if (!opened.result.ok) throw new Error('streams.open refused')
    const sub = opened.result.value.sub
    await log.waitFor(frame => frame.type === 'sub/ready' && frame.sub === sub)
    const snapshot = await log.waitFor(frame => frame.type === 'sub/frame' && frame.sub === sub && 'type' in frame.frame && frame.frame.type === 'snapshot')
    expect(snapshot).toMatchObject({ type: 'sub/frame', sub })
    output.write('hello from the substream')
    await log.waitFor(frame => frame.type === 'sub/frame' && frame.sub === sub && 'type' in frame.frame && frame.frame.type === 'output')
    const closed = await api.events.streamsClose(request({ page: 'page-1', sub }))
    expect(closed.result.ok).toBe(true)
    await log.waitFor(frame => frame.type === 'sub/end' && frame.sub === sub)
    abort.abort()
  })

  it('delivers a hold substream and reaps it when the page downlink dies', async () => {
    const { ctx, api, agent } = await harness()
    const controller = ctx.get('terminalController')
    if (controller === undefined) throw new Error('controller missing from harness')
    const id = 'held' as WebTerminalId
    await controller.create(agent, { id, cols: 80, rows: 24 }, new AbortController().signal)
    const first = await openDownlink(api, 'page-hold')
    const opened = await api.events.streamsOpen(request({
      page: 'page-hold',
      family: 'hold',
      payload: { sessionId: agent.id, id },
    }))
    if (!opened.result.ok) throw new Error('streams.open refused')
    await first.log.waitFor(frame => frame.type === 'sub/frame' && 'type' in frame.frame && frame.frame.type === 'retained')
    // The page's last downlink dying reaps the substream: the same page can
    // open a fresh substream afterwards (the registry no longer holds the old one).
    first.abort.abort()
    const second = await openDownlink(api, 'page-hold')
    const reopened = await api.events.streamsOpen(request({
      page: 'page-hold',
      family: 'hold',
      payload: { sessionId: agent.id, id },
    }))
    expect(reopened.result.ok).toBe(true)
    if (reopened.result.ok) {
      const resub = reopened.result.value.sub
      await second.log.waitFor(frame => frame.type === 'sub/ready' && frame.sub === resub)
    }
    second.abort.abort()
  })

  it('refuses streams.open without a live downlink, idempotently closes unknown subs, and enforces the per-page cap', async () => {
    const { ctx, api, agent } = await harness(1)
    const controller = ctx.get('terminalController')
    if (controller === undefined) throw new Error('controller missing from harness')
    await controller.create(agent, { id: 'capped-1' as WebTerminalId, cols: 80, rows: 24 }, new AbortController().signal)
    const absent = await api.events.streamsOpen(request({
      page: 'no-downlink',
      family: 'hold',
      payload: { sessionId: agent.id, id: 'x' as WebTerminalId },
    }))
    expect(absent.result).toMatchObject({ ok: false, error: { code: 'stream-channel-absent' } })

    const { log, abort } = await openDownlink(api, 'page-cap')
    const first = await api.events.streamsOpen(request({
      page: 'page-cap',
      family: 'hold',
      payload: { sessionId: agent.id, id: 'capped-1' as WebTerminalId },
    }))
    if (!first.result.ok) throw new Error('first open refused')
    await log.waitFor(frame => frame.type === 'sub/frame' && 'type' in frame.frame && frame.frame.type === 'retained')
    const second = await api.events.streamsOpen(request({
      page: 'page-cap',
      family: 'hold',
      payload: { sessionId: agent.id, id: 'capped-2' as WebTerminalId },
    }))
    expect(second.result).toMatchObject({ ok: false, error: { code: 'stream-sub-limit-reached' } })
    const unknown = await api.events.streamsClose(request({ page: 'page-cap', sub: 'sub-never' }))
    expect(unknown.result.ok).toBe(true)
    abort.abort()
  })

  it('carries a files-watch refusal as a family frame inside sub/frame, then sub/end', async () => {
    const { api } = await harness()
    const { log, abort } = await openDownlink(api, 'page-watch')
    const opened = await api.events.streamsOpen(request({
      page: 'page-watch',
      family: 'files-watch',
      payload: { workspaceId: 'missing-ws' as never, path: 'src' },
    }))
    if (!opened.result.ok) throw new Error('streams.open refused')
    const sub = opened.result.value.sub
    await log.waitFor(frame => frame.type === 'sub/ready' && frame.sub === sub)
    await log.waitFor(frame => frame.type === 'sub/frame' && frame.sub === sub && 'type' in frame.frame && frame.frame.type === 'stream/error')
    await log.waitFor(frame => frame.type === 'sub/end' && frame.sub === sub)
    abort.abort()
  })
})

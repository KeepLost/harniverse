/** Peer tool behavior: target resolution, budgeting, result rendering, and error mapping. */

import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { peerInstanceId } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerRunResult, PeerTarget } from '@deepseek-ai/dsh-peer-protocol'
import { readPeerTargets, writePeerTargets } from '@deepseek-ai/dsh-peer-client'
import * as toolPeer from '../src/index.ts'

const ID_A = peerInstanceId('3f2a8f9e-1111-4222-8333-444455556666')
const ID_B = peerInstanceId('7c1d2e3f-4444-5555-8666-777788889999')

/** One captured peer RPC request. */
interface CapturedCall {
  url: string
  request: Record<string, unknown>
}

/** Scripted pairing target: token exchange plus queued delegate/followup readbacks. */
class ScriptedTarget {
  readonly requests: CapturedCall[] = []
  delegateRuns: PeerRunResult[] = []
  followupRuns: PeerRunResult[] = []
  wireError: { reason: string } | undefined
  failWith: { status: number } | undefined
  private readonly server: Server

  constructor() {
    this.server = createServer((req, response) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => { chunks.push(chunk as Buffer) })
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { rpcId?: string; payload?: { args?: { request?: Record<string, unknown> } } }
        const url = req.url ?? ''
        const send = (value: unknown, ok = true): void => {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(ok
            ? { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }
            : { type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'peer-failed', details: { reason: this.wireError?.reason }, message: `peer: ${String(this.wireError?.reason)}` } } }))
        }
        if (url === '/auth/challenge') {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ id: 'cha', payload: 'c2lnbg', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
          return
        }
        if (url === '/auth/token') {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ accessToken: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
          return
        }
        const request = body.payload?.args?.request ?? {}
        this.requests.push({ url, request })
        if (this.failWith !== undefined) {
          response.statusCode = this.failWith.status
          response.setHeader('content-type', 'text/plain')
          response.end('boom')
          return
        }
        if (this.wireError !== undefined) { send(undefined, false); return }
        if (url.endsWith('/api/peer/delegate')) {
          send(this.delegateRuns.shift() ?? { sessionId: 'peer-0', messageId: 'm', state: 'settled', reply: 'ok', endReason: 'completed' })
          return
        }
        send(this.followupRuns.shift() ?? { sessionId: 'peer-0', messageId: 'm', state: 'settled', reply: 'ok', endReason: 'completed' })
      })
    })
  }

  /** Start listening and return the reachable origin. */
  async start(): Promise<string> {
    await new Promise<void>((resolve) => { this.server.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('scripted target: no listen address')
    return `http://127.0.0.1:${String(address.port)}`
  }

  /** Stop the server. */
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
  }
}

const roots: string[] = []
const targets: ScriptedTarget[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(targets.splice(0).map(target => target.stop()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** Boot the tool against one scripted target and a home carrying the given target records. */
async function setup(records: readonly Partial<PeerTarget>[], config: toolPeer.Config = {}): Promise<{
  ctx: Context
  target: ScriptedTarget
  home: string
  fiber: { dispose(): Promise<void> }
  execute: (args: unknown) => Promise<{ isError?: boolean; text: string }>
}> {
  const target = new ScriptedTarget()
  const origin = await target.start()
  targets.push(target)
  const home = await mkdtemp(join(tmpdir(), 'peer-tool-'))
  roots.push(home)
  await writePeerTargets(home, records.map(record => ({
    targetInstanceId: ID_A,
    displayName: 'Build workstation',
    endpoint: { origin },
    transport: { kind: 'direct' },
    grantName: `peer-${ID_A}`,
    grantId: 'grant-1',
    status: 'active',
    addedAt: '2026-01-01T00:00:00.000Z',
    ...record,
  })))
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(toolPeer, Object.assign({ dshHome: home }, config))
  return {
    ctx, target, home, fiber,
    execute: async (args) => {
      const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('call-1'), name: 'peer', arguments: args })
      return {
        isError: result.isError,
        text: result.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join(''),
      }
    },
  }
}

const settled = (reply: string): PeerRunResult => ({ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'settled', reply, endReason: 'completed' })

it('delegates a prompt and renders the settled reply naming the session', async () => {
  const rig = await setup([{}])
  rig.target.delegateRuns = [settled('done: audit')]
  const result = await rig.execute({ target: ID_A, prompt: 'audit the build' })
  expect(result.isError).toBeFalsy()
  expect(result.text).toContain('Delegated session peer-01234567-89ab-cdef-0123-456789abcdef on ' + ID_A + ' replied:')
  expect(result.text).toContain('done: audit')
  expect(rig.target.requests.at(-1)?.url).toContain('/api/peer/delegate')
  expect(rig.target.requests.at(-1)?.request).toMatchObject({ prompt: 'audit the build', timeoutMs: 120_000 })
})

it('resolves targets by display name and prefers an exact instance id', async () => {
  const rig = await setup([
    { targetInstanceId: ID_A, displayName: 'Build workstation' },
    { targetInstanceId: ID_B, displayName: 'Build workstation' },
  ])
  rig.target.delegateRuns = [settled('by id')]
  const byName = await setup([{}])
  byName.target.delegateRuns = [settled('by name')]
  expect((await byName.execute({ target: 'Build workstation', prompt: 'p' })).text).toContain('by name')
  const result = await rig.execute({ target: ID_B, prompt: 'p' })
  expect(result.text).toContain('by id')
  const ambiguous = await rig.execute({ target: 'Build workstation', prompt: 'p' })
  expect(ambiguous.isError).toBe(true)
  expect(ambiguous.text).toContain('matches several instances')
  expect(ambiguous.text).toContain(ID_A)
})

it('names the recorded catalog when no target matches', async () => {
  const rig = await setup([{}])
  const unknown = await rig.execute({ target: 'nobody', prompt: 'p' })
  expect(unknown.isError).toBe(true)
  expect(unknown.text).toContain('no paired instance matches "nobody"')
  expect(unknown.text).toContain(`Build workstation (${ID_A})`)
  const inactive = await setup([{ status: 'revoked' }])
  const empty = await inactive.execute({ target: 'nobody', prompt: 'p' })
  expect(empty.text).toContain('no paired instances are recorded')
})

it('continues an existing session through followup', async () => {
  const rig = await setup([{}])
  rig.target.followupRuns = [settled('next turn')]
  const result = await rig.execute({ target: ID_A, session: 'peer-01234567-89ab-cdef-0123-456789abcdef', prompt: 'next' })
  expect(result.text).toContain('next turn')
  expect(rig.target.requests.at(-1)?.url).toContain('/api/peer/followup')
  expect(rig.target.requests.at(-1)?.request).toMatchObject({ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', prompt: 'next' })
})

it('reports a still-running turn with continuation guidance', async () => {
  const rig = await setup([{}])
  rig.target.delegateRuns = [{ sessionId: 'peer-run-1', messageId: 'm', state: 'running' }]
  const result = await rig.execute({ target: ID_A, prompt: 'p' })
  expect(result.isError).toBeFalsy()
  expect(result.text).toContain('still running')
  expect(result.text).toContain('"peer-run-1"')
  expect(result.text).not.toContain('queued message')
})

it('tracks a running turn with the outbox service and points at the queued delivery', async () => {
  const rig = await setup([{}])
  const tracked: Array<Record<string, unknown>> = []
  rig.ctx.provide('peerOutbox', {
    track: async (input: Record<string, unknown>) => {
      tracked.push(input)
      return { id: 'entry-1', ...input, state: 'watching', submittedAt: 0 }
    },
  } as never)
  rig.target.delegateRuns = [{ sessionId: 'peer-run-2', messageId: 'm2', state: 'running' }]
  const result = await rig.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('call-2'),
    name: 'peer',
    arguments: { target: ID_A, prompt: 'slow job' },
    agent: { session: { id: 'owner-session' } } as never,
  })
  expect(result.isError).toBeFalsy()
  const text = result.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
  expect(text).toContain('still running')
  expect(text).toContain('queued message')
  expect(text).toContain('"peer-run-2"')
  expect(tracked).toMatchObject([{
    targetInstanceId: ID_A,
    targetDisplayName: 'Build workstation',
    peerSessionId: 'peer-run-2',
    messageId: 'm2',
    ownerSessionId: 'owner-session',
    label: 'slow job',
  }])
  rig.target.delegateRuns = [{ sessionId: 'peer-run-3', messageId: 'm3', state: 'running' }]
  const withoutAgent = await rig.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('call-3'),
    name: 'peer',
    arguments: { target: ID_A, prompt: 'p' },
  })
  expect(withoutAgent.isError).toBeFalsy()
  expect(tracked).toHaveLength(1)
  const agentNoOutbox = await setup([{}])
  agentNoOutbox.target.delegateRuns = [{ sessionId: 'peer-run-4', messageId: 'm4', state: 'running' }]
  const bare = await agentNoOutbox.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('call-4'),
    name: 'peer',
    arguments: { target: ID_A, prompt: 'p' },
    agent: { session: { id: 'owner-session' } } as never,
  })
  expect(bare.isError).toBeFalsy()
  const bareText = bare.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
  expect(bareText).not.toContain('queued message')
})

it('maps settled non-completed turns and closed peer reasons onto errors', async () => {
  const rig = await setup([{}])
  rig.target.delegateRuns = [{ sessionId: 'peer-err', messageId: 'm', state: 'settled', endReason: 'error' }]
  const failed = await rig.execute({ target: ID_A, prompt: 'p' })
  expect(failed.isError).toBe(true)
  expect(failed.text).toContain('peer: delegated turn peer-err ended error')
  rig.target.wireError = { reason: 'SESSION_NOT_FOUND' }
  const mapped = await rig.execute({ target: ID_A, session: 'peer-x', prompt: 'p' })
  expect(mapped.isError).toBe(true)
  expect(mapped.text).toContain('peer call failed (SESSION_NOT_FOUND)')
})

it('bounds the prompt and clamps the requested budget', async () => {
  const rig = await setup([{}])
  const oversized = await rig.execute({ target: ID_A, prompt: 'x'.repeat(32_769) })
  expect(oversized.isError).toBe(true)
  expect(oversized.text).toContain('prompt exceeds 32768 characters')
  rig.target.delegateRuns = [settled('clamped low')]
  await rig.execute({ target: ID_A, prompt: 'p', timeoutMs: 5 })
  expect(rig.target.requests.at(-1)?.request).toMatchObject({ timeoutMs: 1_000 })
  rig.target.delegateRuns = [settled('clamped high')]
  await rig.execute({ target: ID_A, prompt: 'p', timeoutMs: 2_000_000 })
  expect(rig.target.requests.at(-1)?.request).toMatchObject({ timeoutMs: 900_000 })
})

it('truncates oversized replies at the configured ceiling', async () => {
  const rig = await setup([{}], { maxResultChars: 10 })
  rig.target.delegateRuns = [settled('0123456789abcdef')]
  const result = await rig.execute({ target: ID_A, prompt: 'p' })
  expect(result.text).toContain('0123456789')
  expect(result.text).toContain('… [truncated: 6 more characters]')
})

it('maps transport faults from an unreachable target and rethrows raw ssh faults', async () => {
  const rig = await setup([{}])
  await rig.target.stop()
  const result = await rig.execute({ target: ID_A, prompt: 'p' })
  expect(result.isError).toBe(true)
  expect(result.text).toContain('peer call failed (TRANSPORT_FAILED): fetch failed')
  // An ssh route without the remote-hosts-ssh service fails before the peer envelope,
  // so the raw (non-PeerError) throw surfaces verbatim.
  await writePeerTargets(rig.home, (await readPeerTargets(rig.home))
    .map(record => ({ ...record, transport: { kind: 'ssh', host: 'keybox' } })))
  const raw = await rig.execute({ target: ID_A, prompt: 'p' })
  expect(raw.isError).toBe(true)
  expect(raw.text).toContain('the ssh target needs the remote-hosts-ssh service')
})

it('renders a settled turn without a reply and a transport fault with its message', async () => {
  const rig = await setup([{}])
  rig.target.delegateRuns = [{ sessionId: 'peer-quiet', messageId: 'm', state: 'settled', endReason: 'completed' }]
  const quiet = await rig.execute({ target: ID_A, prompt: 'p' })
  expect(quiet.isError).toBeFalsy()
  expect(quiet.text).toContain('Delegated session peer-quiet on ' + ID_A + ' replied:')
  expect(quiet.text.endsWith('replied:\n\n')).toBe(true)
  rig.target.failWith = { status: 500 }
  const fault = await rig.execute({ target: ID_A, prompt: 'p' })
  expect(fault.isError).toBe(true)
  expect(fault.text).toContain('peer call failed (TRANSPORT_FAILED): HTTP 500')
})

it('validates its own arguments via the schema DSL and presents cards', async () => {
  const rig = await setup([{}])
  const missing = await rig.execute({ target: ID_A })
  expect(missing.isError).toBe(true)
  const tool = rig.ctx.tools.get('peer')
  expect(tool).toBeDefined()
  expect(tool?.presentCall?.({ target: 'Build workstation', prompt: 'p' })).toMatchObject({ card: 'generic', title: 'peer: Build workstation' })
  expect(tool?.presentResult?.({ target: 'Build workstation', prompt: 'p' }, { content: [], isError: false })).toMatchObject({ card: 'generic' })
})

it('unregisters with its fiber', async () => {
  const rig = await setup([{}])
  expect(rig.ctx.tools.get('peer')).toBeDefined()
  await rig.fiber.dispose()
  expect(rig.ctx.tools.get('peer')).toBeUndefined()
})

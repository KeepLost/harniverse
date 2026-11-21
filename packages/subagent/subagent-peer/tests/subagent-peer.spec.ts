/** Peer subagent backend behavior: prompt admission, settlement mapping, cancellation, and provider capability gating. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { peerInstanceId } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerRunResult, PeerTarget } from '@deepseek-ai/dsh-peer-protocol'
import { ensurePeerIdentityKey, writePeerTargets } from '@deepseek-ai/dsh-peer-client'
import SubagentService from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SCRIPTED_PEER_SESSION, ScriptedPeerTarget } from './scripted-peer-target.ts'
import * as subagentPeer from '../src/index.ts'

const ID_A = peerInstanceId('3f2a8f9e-1111-4222-8333-444455556666')
const ID_B = peerInstanceId('7c1d2e3f-4444-5555-8666-777788889999')
const PEER_SESSION = SCRIPTED_PEER_SESSION

/** A parent Agent stub; the peer backend reads nothing off the parent. */
const fakeParent = { id: 'parent', session: { header: {} } } as unknown as Agent

const roots: string[] = []
const targets: ScriptedPeerTarget[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) { await ctx.fiber.dispose() }
  await Promise.all(targets.splice(0).map(target => target.stop()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** Boot the subagent service plus the peer provider against one scripted target. */
async function setup(records: readonly Partial<PeerTarget>[], config: Partial<subagentPeer.Config> = {}): Promise<{
  ctx: Context
  target: ScriptedPeerTarget
  home: string
  start: (prompt: readonly ContentBlock[], signal?: AbortSignal) => ReturnType<Context['subagents']['start']>
}> {
  const target = new ScriptedPeerTarget()
  const origin = await target.start()
  targets.push(target)
  const home = await mkdtemp(join(tmpdir(), 'subagent-peer-'))
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
  await ensurePeerIdentityKey(home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SubagentService)
  await ctx.plugin(subagentPeer, { providerName: 'peer', peerTarget: ID_A, settleTimeoutMs: 120_000, dshHome: home, ...config })
  return {
    ctx, target, home,
    start: (prompt, signal = new AbortController().signal) => ctx.subagents.start('peer', {
      prompt: [...prompt],
      parent: fakeParent,
      signal,
    }),
  }
}

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

const settled = (reply: string, endReason = 'completed'): PeerRunResult =>
  ({ sessionId: PEER_SESSION, messageId: 'm1', state: 'settled', reply, endReason })

it('settles a delegated turn with the peer reply and publishes the peer session id', async () => {
  const rig = await setup([{}])
  rig.target.delegateRuns = [settled('audit done')]
  const run = await rig.start(text('audit the build'))
  expect(run.id).toBe(PEER_SESSION)
  expect(run.localAgent).toBeUndefined()
  const result = await run.result
  expect(result.stopReason).toBe('completed')
  expect(result.output).toEqual([{ type: 'text', text: 'audit done' }])
  await run.dispose()
  expect(rig.target.requests.at(-1)?.url).toContain('/api/peer/delegate')
  expect(rig.target.requests.at(-1)?.request).toMatchObject({ prompt: 'audit the build', timeoutMs: 120_000 })
})

it('emits the standard subagent run events for a remote run', async () => {
  const rig = await setup([{}])
  rig.target.delegateRuns = [settled('ok')]
  const seen: Array<{ event: string; provider: string; local: boolean }> = []
  rig.ctx.on('subagent/start', (info) => { seen.push({ event: 'start', provider: info.provider, local: info.local }) })
  rig.ctx.on('subagent/end', (info) => { seen.push({ event: 'end', provider: info.provider, local: info.local }) })
  const run = await rig.start(text('p'))
  await run.result
  expect(seen).toEqual([
    { event: 'start', provider: 'peer', local: false },
    { event: 'end', provider: 'peer', local: false },
  ])
})

it('maps the shared turn-end vocabulary onto stop reasons', async () => {
  const rig = await setup([{}])
  rig.target.delegateRuns = [settled('declined', 'refusal')]
  const refusal = await (await rig.start(text('p'))).result
  expect(refusal.stopReason).toBe('refusal')
  expect(refusal.output).toEqual([{ type: 'text', text: 'declined' }])

  rig.target.delegateRuns = [settled('', 'max-tokens')]
  const clipped = await (await rig.start(text('p'))).result
  expect(clipped.stopReason).toBe('max-tokens')
  expect(clipped.output).toEqual([])
})

it('flattens an unknown end reason to error with the raw reason as diagnostic', async () => {
  const rig = await setup([{}])
  rig.target.delegateRuns = [settled('partial', 'odd-shutdown')]
  const result = await (await rig.start(text('p'))).result
  expect(result.stopReason).toBe('error')
  expect(result.output).toEqual([{ type: 'text', text: 'partial' }])
  expect(result.diagnostic).toBe(`peer session ${PEER_SESSION} ended: odd-shutdown`)
})

it('treats a settled turn without an end reason as completed', async () => {
  const rig = await setup([{}])
  rig.target.delegateRuns = [{ sessionId: PEER_SESSION, messageId: 'm1', state: 'settled', reply: 'ok' }]
  const result = await (await rig.start(text('p'))).result
  expect(result.stopReason).toBe('completed')
})

it('reports a turn still running past the budget as an error naming the peer session', async () => {
  const rig = await setup([{}])
  rig.target.delegateRuns = [{ sessionId: PEER_SESSION, messageId: 'm1', state: 'running' }]
  const result = await (await rig.start(text('p'))).result
  expect(result.stopReason).toBe('error')
  expect(result.output).toEqual([])
  expect(result.diagnostic).toContain(PEER_SESSION)
  expect(result.diagnostic).toContain('peer tool')
})

it('rejects start with the peer reason when the wire call fails', async () => {
  const rig = await setup([{}])
  rig.target.wireError = { reason: 'TRANSPORT_FAILED' }
  await expect(rig.start(text('p'))).rejects.toThrow('peer call failed (TRANSPORT_FAILED)')
})

it('passes a non-peer transport-setup failure through unchanged', async () => {
  const rig = await setup([{}])
  rig.target.tokenGarbage = true
  await expect(rig.start(text('p'))).rejects.toThrow()
})

it('rejects an empty configured peer target at load', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SubagentService)
  await expect(ctx.plugin(subagentPeer, { providerName: 'peer', peerTarget: '' })).rejects.toThrow('peerTarget must not be empty')
})

it('rejects start when the configured target is unresolvable or ambiguous', async () => {
  const miss = await setup([{ targetInstanceId: ID_A, displayName: 'Build workstation' }], { peerTarget: 'gone' })
  await expect(miss.start(text('p'))).rejects.toThrow('no paired instance matches "gone"')

  const ambiguous = await setup([
    { targetInstanceId: ID_A, displayName: 'Twin' },
    { targetInstanceId: ID_B, displayName: 'Twin' },
  ], { peerTarget: 'Twin' })
  await expect(ambiguous.start(text('p'))).rejects.toThrow('matches several instances')
})

it('rejects non-text, empty, and oversized prompts before any wire call', async () => {
  const rig = await setup([{}])
  await expect(rig.start([{ type: 'image', attachment: { id: 'a', bytes: 1, sha256: 'x', width: 1, height: 1 } as never }])).rejects.toThrow('only text prompt blocks')
  await expect(rig.start(text(''))).rejects.toThrow('must not be empty')
  await expect(rig.start(text('x'.repeat(32_769)))).rejects.toThrow('exceeds 32768 characters')
  expect(rig.target.requests).toHaveLength(0)
})

it('rejects before publication when the caller aborts while the turn is in flight', async () => {
  const rig = await setup([{}])
  rig.target.delayMs = 500
  const controller = new AbortController()
  const pending = rig.start(text('slow'), controller.signal)
  setTimeout(() => { controller.abort() }, 20)
  await expect(pending).rejects.toThrow('aborted before the peer turn settled')
})

it('rejects an already-aborted start before dialing the target', async () => {
  const rig = await setup([{}])
  const controller = new AbortController()
  controller.abort()
  await expect(rig.start(text('p'), controller.signal)).rejects.toThrow()
  expect(rig.target.requests).toHaveLength(0)
})

it('rejects capability requests and continuable children loud through the service', async () => {
  const rig = await setup([{}])
  const provider = rig.ctx.subagents.getProvider('peer')
  expect(provider?.capabilities).toEqual({ outputSchema: false, depthLimit: false, toolFilter: false, persona: false })
  expect(provider?.inheritsParentContext).toBe(false)
  await expect(rig.ctx.subagents.start('peer', {
    prompt: text('p'),
    parent: fakeParent,
    signal: new AbortController().signal,
    outputSchema: { type: 'object', properties: {}, additionalProperties: false, required: [] },
  })).rejects.toThrow('outputSchema')
  await expect(rig.ctx.subagents.invoke('peer', 'sync', {
    prompt: text('p'),
    parent: fakeParent,
    signal: new AbortController().signal,
  })).rejects.toThrow('continuable')
})

it('clamps a configured settlement budget into the host-enforced window', async () => {
  const rig = await setup([{}], { settleTimeoutMs: 2_000_000 })
  rig.target.delegateRuns = [settled('ok')]
  await (await rig.start(text('p'))).result
  expect(rig.target.requests.at(-1)?.request).toMatchObject({ timeoutMs: 900_000 })
})

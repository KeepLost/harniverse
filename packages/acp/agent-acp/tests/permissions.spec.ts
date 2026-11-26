/**
 * The permission answerer: every mode, with and without an approval seam.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AcpPermissionRequest } from '@deepseek-ai/dsh-acp-client'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentHost } from '@deepseek-ai/dsh-agent'
import { permissionAnswerer } from '../src/driver.ts'

const DECLINED = { outcome: { outcome: 'cancelled' } }
const ALLOWED = { outcome: { outcome: 'selected', optionId: 'yes' } }

function request(overrides: Partial<AcpPermissionRequest> = {}): AcpPermissionRequest {
  return {
    sessionId: 's',
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'No', kind: 'reject_once' }],
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** An agent host whose owner context answers every approval with `outcome`, recording what it was asked. */
function host(outcome: string | undefined): { host: AgentHost; asked: unknown[] } {
  const ctx = new Context()
  const asked: unknown[] = []
  if (outcome !== undefined) {
    ctx.provide('approval', {
      request: async (req: unknown) => {
        asked.push(req)
        return outcome
      },
    })
  }
  return { host: { ownerCtx: ctx, agent: { id: SessionId('a') } } as unknown as AgentHost, asked }
}

describe('permissionAnswerer', () => {
  it('declines under reject, takes the first allow option under allow, and fails closed under ask without an answerer', async () => {
    expect(await permissionAnswerer('reject', host(undefined).host)(request())).toEqual(DECLINED)
    expect(await permissionAnswerer('allow', host(undefined).host)(request())).toEqual(ALLOWED)
    expect(await permissionAnswerer('ask', host(undefined).host)(request())).toEqual(DECLINED)
  })

  it('asks the approval seam with the tool identity and reason it was given', async () => {
    const allowed = host('allowed-once')
    expect(await permissionAnswerer('ask', allowed.host)(request({ toolCallId: 'c1', title: 'Deploy', reason: 'ships' }))).toEqual(ALLOWED)
    expect(allowed.asked).toMatchObject([{
      agent: { id: SessionId('a') },
      toolName: 'Deploy',
      callId: 'c1',
      reason: 'ships',
    }])
    expect((allowed.asked[0] as { signal: unknown }).signal).toBeInstanceOf(AbortSignal)
    const rejected = host('rejected')
    expect(await permissionAnswerer('ask', rejected.host)(request())).toEqual(DECLINED)
  })

  it('names an untitled question and omits the identity it was not given', async () => {
    const bare = host('cancelled')
    expect(await permissionAnswerer('ask', bare.host)(request({ title: '' }))).toEqual(DECLINED)
    expect(bare.asked[0]).toMatchObject({ toolName: 'an external tool' })
    expect(bare.asked[0]).not.toHaveProperty('callId')
    expect(bare.asked[0]).not.toHaveProperty('reason')
  })
})

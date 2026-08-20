/** A Session's immutable header is the authority for its Agent Profile. */

import { describe, expect, it } from 'vitest'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { resolveSessionProfile } from '../src/session.ts'

/** A header carrying the immutable profile, if any. */
function header(agentProfile?: string): SessionHeader {
  return {
    version: 0,
    id: SessionId('s'),
    createdAt: 1,
    delegationDepth: 0,
    ...agentProfile === undefined ? {} : { agentProfile },
  }
}

describe('resolving a session Agent Profile', () => {
  it('reads the immutable header identity', () => {
    expect(resolveSessionProfile({ header: header('standard'), events: [] })).toBe('standard')
  })

  it('reports none when the deployment composes no profiles', () => {
    expect(resolveSessionProfile({ header: header(), events: [] })).toBeUndefined()
  })
})

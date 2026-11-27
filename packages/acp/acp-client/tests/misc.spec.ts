/**
 * Error taxonomy, permission policies, profile selection, and the invariant companion.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as Invariant from '../src/invariant.ts'
import {
  AcpError,
  acpErrorKindForCode,
  allowAnswer,
  isAcpAuthRequired,
  isAcpError,
  isAcpNotFound,
  KNOWN_AGENTS,
  knownAgent,
  policyAnswerer,
  rejectAnswerer,
  selectProfile,
  toAcpError,
} from '../src/index.ts'
import type { AcpAgentProfile, AcpPermissionRequest } from '../src/index.ts'

const CANCELLED = { outcome: { outcome: 'cancelled' } }

function request(options: { kind: string; optionId: string }[]): AcpPermissionRequest {
  return { sessionId: 's', options: options.map(option => ({ ...option, name: option.optionId })), signal: new AbortController().signal }
}

describe('AcpError', () => {
  it('keeps its kind, code, and cause', () => {
    const cause = new Error('root')
    const error = new AcpError('auth', 'sign in', { code: -32000, cause })
    expect(error).toMatchObject({ name: 'AcpError', kind: 'auth', code: -32000, message: 'sign in' })
    expect(error.cause).toBe(cause)
    const bare = new AcpError('spawn', 'x')
    expect(bare).toMatchObject({ kind: 'spawn' })
    expect(bare.code).toBeUndefined()
    expect(bare.cause).toBeUndefined()
    expect(isAcpError(error)).toBe(true)
    expect(isAcpError(cause)).toBe(false)
  })

  it('classifies agent error codes', () => {
    expect(acpErrorKindForCode(-32000, 'protocol')).toBe('auth')
    expect(acpErrorKindForCode(-32022, 'protocol')).toBe('handshake')
    expect(acpErrorKindForCode(-32601, 'protocol')).toBe('unsupported')
    expect(acpErrorKindForCode(-32603, 'transport')).toBe('transport')
    expect(acpErrorKindForCode(undefined, 'protocol')).toBe('protocol')
  })

  it('toAcpError passes its own class through and folds other values', () => {
    const own = new AcpError('spawn', 'x')
    expect(toAcpError('protocol', own)).toBe(own)
    expect(toAcpError('protocol', { code: -32601, message: 'no' })).toMatchObject({ kind: 'unsupported', code: -32601, message: 'no' })
    const plain = new Error('plain')
    const folded = toAcpError('transport', plain)
    expect(folded).toMatchObject({ kind: 'transport', message: 'plain' })
    expect(folded.cause).toBe(plain)
    expect(toAcpError('protocol', 'a string')).toMatchObject({ kind: 'protocol', message: 'a string' })
  })
})

describe('permission policies', () => {
  it('take the first option that grants consent', () => {
    expect(allowAnswer(request([{ kind: 'reject_once', optionId: 'no' }, { kind: 'allow_always', optionId: 'always' }, { kind: 'allow_once', optionId: 'once' }])))
      .toEqual({ outcome: { outcome: 'selected', optionId: 'always' } })
    expect(allowAnswer(request([{ kind: 'reject_once', optionId: 'no' }]))).toEqual(CANCELLED)
    expect(allowAnswer(request([]))).toEqual(CANCELLED)
  })

  it('decline under the reject policy and under the bare reject answerer', () => {
    expect(policyAnswerer('reject')(request([{ kind: 'allow_once', optionId: 'yes' }]))).toEqual(CANCELLED)
    expect(rejectAnswerer(request([{ kind: 'allow_once', optionId: 'yes' }]))).toEqual(CANCELLED)
    expect(policyAnswerer('allow')(request([{ kind: 'allow_once', optionId: 'yes' }]))).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } })
  })
})

describe('selectProfile', () => {
  const profiles: AcpAgentProfile[] = [
    { id: 'first', agents: ['a'], customize: request => request },
    { id: 'second', agents: ['b', 'c'] },
    { id: 'third' },
  ]

  it('pins by id, name, or nothing', () => {
    expect(selectProfile({ profiles, pinned: 'third', agentName: undefined })).toBe(profiles[2])
    expect(selectProfile({ profiles: undefined, pinned: undefined, agentName: 'a' })).toBeUndefined()
    expect(selectProfile({ profiles, pinned: undefined, agentName: 'c' })).toBe(profiles[1])
    expect(selectProfile({ profiles, pinned: undefined, agentName: 'zzz' })).toBeUndefined()
    expect(selectProfile({ profiles, pinned: undefined, agentName: undefined })).toBeUndefined()
    expect(() => selectProfile({ profiles, pinned: 'missing', agentName: 'a' })).toThrow(AcpError)
  })
})

describe('invariant companion', () => {
  it('registers package ownership and exports the companion shape', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(Invariant)
    expect(Invariant.name).toBe('acp-client-invariant')
    expect(Invariant.inject).toEqual(['invariants'])
    await ctx.fiber.dispose()
  })
})

describe('agent answers a request can be told by', () => {
  it('names the sign-in demand and the missing session by the agent\'s own code', () => {
    const refused = new AcpError('auth', 'Authentication required', { code: -32000 })
    const gone = new AcpError('protocol', 'Resource not found', { code: -32002 })
    const other = new AcpError('protocol', 'Invalid params', { code: -32602 })
    expect(isAcpAuthRequired(refused)).toBe(true)
    expect(isAcpAuthRequired(gone)).toBe(false)
    expect(isAcpAuthRequired(new Error('Authentication required'))).toBe(false)
    expect(isAcpNotFound(gone)).toBe(true)
    expect(isAcpNotFound(other)).toBe(false)
    expect(isAcpNotFound({ code: -32002 })).toBe(false)
  })
})

describe('the known agents', () => {
  it('launch each one over stdio and say how it signs in', () => {
    expect(KNOWN_AGENTS.map(agent => [agent.id, agent.command, agent.args])).toEqual([
      ['claude-acp', 'npx', ['-y', '@agentclientprotocol/claude-agent-acp']],
      ['codex-acp', 'npx', ['-y', '@agentclientprotocol/codex-acp']],
      ['gemini', 'npx', ['-y', '@google/gemini-cli', '--acp']],
      ['antigravity-acp', 'agy', ['acp']],
    ])
    for (const agent of KNOWN_AGENTS) {
      expect(agent.name).not.toBe('')
      expect(agent.signIn).not.toBe('')
    }
    expect(knownAgent('codex-acp')?.credentialEnv).toEqual(['CODEX_API_KEY', 'OPENAI_API_KEY'])
    expect(knownAgent('claude-acp')?.agentNames).toEqual(['@agentclientprotocol/claude-agent-acp'])
    expect(knownAgent('nobody')).toBeUndefined()
  })
})

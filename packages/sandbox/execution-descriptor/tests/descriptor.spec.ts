/**
 * Tests for the execution-world descriptor contract: validation refusals,
 * digest verification, canonical-form stability, and immutability.
 */

import { describe, expect, it } from 'vitest'
import {
  buildExecutionWorldDescriptor,
  canonicalExecutionWorldJson,
  computeExecutionWorldDigest,
  ExecutionDescriptorError,
  type ExecutionWorldDescriptorInput,
  LOCAL_ONLY_PRESET_IDS,
  parseExecutionWorldDescriptor,
} from '@deepseek-ai/dsh-execution-descriptor'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

const covered: ExecutionWorldDescriptorInput = {
  worldId: 'build-box-1',
  transport: 'ssh',
  workspaceRoot: '/srv/workspace',
  capabilities: [
    { id: 'mcp-server:66696c6573', kind: 'mcp-server', name: 'files', description: 'file server', provenance: 'external', assembleable: true, available: true, defaultLoaded: true, manageable: true, requires: [] },
  ],
  presets: ['standard'],
  configOwner: 'machine',
  credentialRefs: [credentialRef('DEPLOY_KEY')],
  revision: 'r1',
}

function withDigest(overrides: Record<string, unknown> = {}, coveredOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  const next = { ...covered, ...coveredOverrides }
  return { ...next, digest: computeExecutionWorldDigest(next), ...overrides }
}

describe('parseExecutionWorldDescriptor', () => {
  it('accepts and freezes a well-formed descriptor', () => {
    const descriptor = parseExecutionWorldDescriptor(withDigest())
    expect(descriptor.worldId).toBe('build-box-1')
    expect(descriptor.transport).toBe('ssh')
    expect(descriptor.configOwner).toBe('machine')
    expect(Object.isFrozen(descriptor)).toBe(true)
    expect(Object.isFrozen(descriptor.capabilities)).toBe(true)
    expect(() => {
      (descriptor as { revision: string }).revision = 'r2'
    }).toThrow()
  })

  it('rejects malformed identity, transport, workspace root, and config owner', () => {
    const badFields: readonly (readonly [string, unknown])[] = [['worldId', 'Bad Id!'], ['worldId', 'x'], ['transport', 'e2b'], ['workspaceRoot', 'C:\\work'], ['workspaceRoot', 'relative/path'], ['configOwner', 'host'], ['revision', '']]
    for (const [field, value] of badFields) {
      expect(() => parseExecutionWorldDescriptor(withDigest({}, { [field]: value })))
        .toThrow(ExecutionDescriptorError)
    }
  })

  it('rejects capability kinds an execution world may not report', () => {
    expect(() => parseExecutionWorldDescriptor(withDigest({}, {
      capabilities: [{ id: 'x', kind: 'host-administration', name: 'x', description: '', provenance: 'external', assembleable: false, available: true, defaultLoaded: false, manageable: false, requires: [] }],
    }))).toThrow(/may report only/)
  })

  it('rejects the host-local cordis preset and non-credential references', () => {
    expect(LOCAL_ONLY_PRESET_IDS).toContain('cordis')
    expect(() => parseExecutionWorldDescriptor(withDigest({}, { presets: ['cordis'] }))).toThrow(/Host-local by design/)
    expect(() => parseExecutionWorldDescriptor(withDigest({}, { credentialRefs: ['not a name'] }))).toThrow(ExecutionDescriptorError)
    expect(() => parseExecutionWorldDescriptor(withDigest({}, { credentialRefs: [42] }))).toThrow(ExecutionDescriptorError)
  })

  it('rejects non-object input outright', () => {
    for (const bad of [null, 42, 'descriptor', true]) {
      expect(() => parseExecutionWorldDescriptor(bad)).toThrow(/must be an object/)
    }
  })

  it('rejects non-array capabilities, presets, and credential refs and non-string presets', () => {
    for (const bad of [
      { capabilities: 'nope' },
      { presets: 7 },
      { credentialRefs: {} },
    ]) {
      expect(() => parseExecutionWorldDescriptor(withDigest({}, bad))).toThrow(ExecutionDescriptorError)
    }
    expect(() => parseExecutionWorldDescriptor(withDigest({}, { presets: [42] }))).toThrow(/preset ids must be strings/)
  })

  it('verifies the digest and refuses tampering', () => {
    const tampered = withDigest()
    tampered.revision = 'r2'
    expect(() => parseExecutionWorldDescriptor(tampered)).toThrow(/digest mismatch/)
    expect(() => parseExecutionWorldDescriptor({ ...withDigest(), digest: '0'.repeat(64) })).toThrow(/digest mismatch/)
  })
})

describe('canonical digest', () => {
  it('is stable under key order and array order is preserved', () => {
    const reordered = JSON.parse(JSON.stringify(covered, null, 0)) as Record<string, unknown>
    const reorderedNested = { ...reordered, presets: ['standard'], configOwner: 'machine' }
    expect(canonicalExecutionWorldJson(covered)).toBe(canonicalExecutionWorldJson(reorderedNested as never))
    const roundTripped = JSON.parse(JSON.stringify(covered)) as ExecutionWorldDescriptorInput
    expect(computeExecutionWorldDigest(covered)).toBe(computeExecutionWorldDigest(roundTripped))
    expect(computeExecutionWorldDigest(covered)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('buildExecutionWorldDescriptor', () => {
  it('computes the digest and round-trips through parse', () => {
    const built = buildExecutionWorldDescriptor(covered)
    expect(built.digest).toBe(computeExecutionWorldDigest(covered))
    expect(parseExecutionWorldDescriptor(JSON.parse(JSON.stringify(built)) as unknown)).toEqual(built)
  })
})

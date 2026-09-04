import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { FileReferenceService } from '../src/index.ts'
import type { FileReferenceCandidate } from '../src/index.ts'
import * as FileReferenceInvariant from '../src/invariant.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-file-reference'

/** The smallest provider that satisfies the discovery contract. */
class FixedFileReferences extends FileReferenceService {
  readonly calls: { agent: Agent; query: string; signal: AbortSignal }[] = []

  static inject = []

  override readonly name = 'file-reference-fixed'

  list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    this.calls.push({ agent, query, signal })
    return Promise.resolve([{ path: 'README.md', kind: 'file' }])
  }
}

describe('file-reference invariant companion', () => {
  it('registers the package name and reserves it against a second registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(FileReferenceInvariant)

    // Candidates are validated at the provider boundary, so the companion holds
    // the name without installing a runtime rule.
    expect(() => {
      ctx.invariants.register(PACKAGE_NAME, () => {})
    }).toThrow(/already registered/)
  })

  it('releases the name when the companion is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(FileReferenceInvariant)
    await fiber.dispose()

    expect(() => {
      ctx.invariants.register(PACKAGE_NAME, () => {})
    }).not.toThrow()
  })
})

describe('file-reference discovery contract', () => {
  it('publishes the authenticated observation face for discovery', async () => {
    const ctx = new Context()
    await ctx.plugin(FixedFileReferences)

    // The Remote export is the authenticated Harniverse face, and reading a
    // workspace listing requires the observation capability.
    expect(remoteMethods(ctx.fileReferences)).toContainEqual({
      method: 'remoteExportList',
      exportName: 'list',
      invocation: { kind: 'direct' },
      requiredCapability: 'harniverse.observe',
    })
  })

  it('forwards the Remote call to the provider with its caller arguments intact', async () => {
    const ctx = new Context()
    await ctx.plugin(FixedFileReferences)
    const service = ctx.fileReferences as FixedFileReferences
    const agent = { id: 'agent-1' } as unknown as Agent
    const signal = new AbortController().signal

    const remote = service as unknown as {
      remoteExportList(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]>
    }
    await expect(remote.remoteExportList(agent, 'READ', signal))
      .resolves.toEqual([{ path: 'README.md', kind: 'file' }])

    // The wrapper adds authorization, not behavior: the provider sees exactly
    // the Agent, query, and cancellation the caller named.
    expect(service.calls).toEqual([{ agent, query: 'READ', signal }])
  })

  it('carries a provider failure back to the Remote caller', async () => {
    const ctx = new Context()
    await ctx.plugin(FixedFileReferences)
    const service = ctx.fileReferences as FixedFileReferences
    vi.spyOn(service, 'list').mockReturnValue(Promise.reject(new Error('workspace unreadable')))

    const remote = service as unknown as {
      remoteExportList(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]>
    }
    await expect(remote.remoteExportList({ id: 'agent-1' } as unknown as Agent, '', new AbortController().signal))
      .rejects.toThrow('workspace unreadable')
    vi.restoreAllMocks()
  })
})

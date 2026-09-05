// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { SessionCapabilitySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionCapabilitiesView } from '../src/client/SessionCapabilitiesView.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {
    promise,
    resolve: (value: T) => { resolve(value) },
    reject: (reason?: unknown) => { reject(reason) },
  }
}

const propsOf = (load: ComponentProps<typeof SessionCapabilitiesView>['load']) =>
  ({ load, t: (key: keyof typeof en) => en[key] }) as unknown as ComponentProps<typeof SessionCapabilitiesView>

describe('SessionCapabilitiesView', () => {
  it('renders the immutable Profile generation and actual assembly statuses', async () => {
    const load = vi.fn(async () => ({
      sessionId: 'session-1',
      agentProfile: 'standard',
      generation: 'standard@3',
      entries: [{
        id: 'plugin:tool-bash',
        kind: 'tool' as const,
        name: 'tool-bash',
        description: 'Profile plugin tool-bash',
        provenance: 'upstream' as const,
        assembleable: true,
        available: true,
        defaultLoaded: true,
        manageable: true,
        owner: '@deepseek-ai/dsh-tool-bash',
        requires: [],
        members: [{ id: 'plugin:tool-bash/tool:bash', kind: 'tool' as const, name: 'bash', description: 'Run commands.', defaultVisible: true, available: true, requires: [] }],
        memberSelection: 'custom' as const,
        memberEntries: [{ id: 'plugin:tool-bash/tool:bash', kind: 'tool' as const, name: 'bash', description: 'Run commands.', defaultVisible: true, available: true, requires: [], visible: false }],
        selection: 'inherit' as const,
        effectiveSelection: 'load' as const,
        selected: true,
        status: 'loaded' as const,
      }],
    }))
    const props = { load, t: (key: keyof typeof en) => en[key] } as unknown as ComponentProps<typeof SessionCapabilitiesView>
    render(<SessionCapabilitiesView {...props} />)

    await waitFor(() => { expect(load).toHaveBeenCalledOnce() })
    expect(await screen.findByText('standard@3')).toBeTruthy()
    expect(screen.getByText(en.statusLoaded)).toBeTruthy()
    expect(screen.getByText('tool-bash')).toBeTruthy()
    expect(screen.getByText('bash')).toBeTruthy()
    expect(screen.getByText(en.memberHidden)).toBeTruthy()
  })

  it('falls back to placeholders and shows per-entry denials without members', async () => {
    const load = vi.fn(async () => ({
      sessionId: 'session-1',
      entries: [{
        id: 'plugin:tool-web',
        kind: 'tool' as const,
        name: 'tool-web',
        description: 'Profile plugin tool-web',
        provenance: 'upstream' as const,
        assembleable: true,
        available: false,
        defaultLoaded: true,
        manageable: true,
        requires: [],
        members: [],
        memberSelection: 'inherit' as const,
        selection: 'inherit' as const,
        effectiveSelection: 'load' as const,
        selected: true,
        status: 'security-denied' as const,
        reason: 'denied by policy',
      }, {
        id: 'plugin:tool-bash',
        kind: 'tool' as const,
        name: 'tool-bash',
        description: 'Profile plugin tool-bash',
        provenance: 'upstream' as const,
        assembleable: true,
        available: true,
        defaultLoaded: true,
        manageable: true,
        owner: 'ctx.tools',
        requires: [],
        members: [{ id: 'plugin:tool-bash/tool:bash', kind: 'tool' as const, name: 'bash', description: 'Run commands.', defaultVisible: true, available: true, requires: [] }],
        memberSelection: 'custom' as const,
        memberEntries: [{ id: 'plugin:tool-bash/tool:bash', kind: 'tool' as const, name: 'bash', description: 'Run commands.', defaultVisible: true, available: true, requires: [], visible: true }],
        selection: 'inherit' as const,
        effectiveSelection: 'load' as const,
        selected: true,
        status: 'loaded' as const,
      }],
    }) satisfies SessionCapabilitySnapshot)
    render(<SessionCapabilitiesView {...propsOf(load)} />)

    expect(await screen.findByText(en.statusSecurityDenied)).toBeTruthy()
    expect(screen.getAllByText('-')).toHaveLength(2)
    expect(screen.getByText('plugin:tool-web')).toBeTruthy()
    expect(screen.getByText('denied by policy')).toBeTruthy()
    expect(screen.queryByText(en.memberHidden)).toBeNull()
    expect(screen.getByText(en.memberVisible)).toBeTruthy()
  })

  it('reports a failed load as the error surface', async () => {
    const load = vi.fn(async () => {
      throw new Error('down')
    })
    render(<SessionCapabilitiesView {...propsOf(load)} />)

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe(en.sessionError)
  })

  it('ignores an answer that arrives after the load prop changed', async () => {
    const gate = deferred<SessionCapabilitySnapshot>()
    const first = vi.fn(() => gate.promise)
    const second = vi.fn(async () => ({ ...await baseSnapshot(), generation: 'later@1' }))
    const view = render(<SessionCapabilitiesView {...propsOf(first)} />)

    view.rerender(<SessionCapabilitiesView {...propsOf(second)} />)
    expect(await screen.findByText('later@1')).toBeTruthy()

    gate.resolve({ ...(await baseSnapshot()), generation: 'earlier@1' })
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.queryByText('earlier@1')).toBeNull()
    expect(screen.getByText('later@1')).toBeTruthy()
  })

  it('ignores a failure that arrives after the load prop changed', async () => {
    const gate = deferred<SessionCapabilitySnapshot>()
    const first = vi.fn(() => gate.promise)
    const second = vi.fn(async () => ({ ...(await baseSnapshot()), generation: 'later@1' }))
    const view = render(<SessionCapabilitiesView {...propsOf(first)} />)

    view.rerender(<SessionCapabilitiesView {...propsOf(second)} />)
    expect(await screen.findByText('later@1')).toBeTruthy()

    gate.reject(new Error('down'))
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('later@1')).toBeTruthy()
  })
})

async function baseSnapshot(): Promise<SessionCapabilitySnapshot> {
  return {
    sessionId: 'session-1',
    agentProfile: 'standard',
    generation: 'standard@3',
    entries: [],
  }
}

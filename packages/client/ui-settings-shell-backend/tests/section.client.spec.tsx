// @vitest-environment jsdom
/**
 * The section's presentation behavior: load and unavailable states, the
 * PowerShell / Git Bash radio pair with dirty tracking, save and revert,
 * the restart-applied save notice, failure notices, and adoption of
 * external revisions — everything through plain props over a mutable scope
 * snapshot holder.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShellBackendSection } from '../src/client/ShellBackendSection.tsx'
import type { ShellBackendSectionInjected, ShellBackendSectionProps } from '../src/client/ShellBackendSection.tsx'
import type { ShellBackendSectionValue } from '../src/client/decode.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

type ScopeSnapshot = ShellBackendSectionProps['useScope'] extends ((select: (snapshot: infer S) => unknown) => unknown) ? S : never
type Translate = ShellBackendSectionProps['t']

/** Build a translator over the shipped Chinese dictionary. */
function tzh(): Translate {
  return ((key: keyof typeof zh, params?: Record<string, unknown>) => {
    let text: string = zh[key]
    for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
    return text
  }) as Translate
}

/** Mutable snapshot holder the useScope stub reads at each render. */
function holder(snapshot: ScopeSnapshot): { snapshot: ScopeSnapshot; useScope: ShellBackendSectionProps['useScope'] } {
  const box = { snapshot }
  return {
    snapshot,
    useScope: <T,>(select: (snapshot: ScopeSnapshot) => T) => select(box.snapshot),
  }
}

/** Build one ready snapshot over a section value. */
function readyOf(value: ShellBackendSectionValue, revision = 1, writable = true): ScopeSnapshot {
  return { status: 'ready', value, base: {}, user: undefined, revision, writable, mode: 'host' }
}

/** Assemble full props over the writable face doubles. */
function propsOf(
  scope: ScopeSnapshot,
  set: ShellBackendSectionInjected['set'] = vi.fn(async () => {}),
): ShellBackendSectionProps {
  return {
    close: () => {},
    t: tzh(),
    useScope: ((<T,>(select: (snapshot: ScopeSnapshot) => T) => select(scope)) as ShellBackendSectionProps['useScope']),
    set,
  } as unknown as ShellBackendSectionProps
}

describe('ShellBackendSection', () => {
  it('renders the loading state before the first accepted section', () => {
    const { useScope } = holder({ status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' })
    const bare = { close: () => {}, t: tzh(), useScope, set: vi.fn() } as unknown as ShellBackendSectionProps
    render(<ShellBackendSection {...bare} />)
    expect(screen.getByText(zh.loading)).toBeDefined()
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('renders the unavailable note when the namespace is not exposed', () => {
    const { useScope } = holder({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' })
    const bare = { close: () => {}, t: tzh(), useScope, set: vi.fn() } as unknown as ShellBackendSectionProps
    render(<ShellBackendSection {...bare} />)
    expect(screen.getByText(zh.unavailable)).toBeDefined()
  })

  it('shows both options with the platform default active and saving idle', () => {
    render(<ShellBackendSection {...propsOf(readyOf({ default: 'platform-default', entries: [] }))} />)
    const pwsh = screen.getByRole<HTMLInputElement>('radio', { name: new RegExp(zh['default.platform-default']) })
    const gitBash = screen.getByRole<HTMLInputElement>('radio', { name: new RegExp(zh['default.posix']) })
    expect(pwsh.checked).toBe(true)
    expect(gitBash.checked).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.save }).disabled).toBe(true)
  })

  it('marks the stored posix preference active on load', () => {
    render(<ShellBackendSection {...propsOf(readyOf({ default: 'posix', entries: [] }))} />)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: new RegExp(zh['default.posix']) }).checked).toBe(true)
  })

  it('disables every control and notes the read-only state when writes are refused', () => {
    render(<ShellBackendSection {...propsOf(readyOf({ default: 'platform-default', entries: [] }, 1, false))} />)
    expect(screen.getByText(zh.readonly)).toBeDefined()
    for (const radio of screen.getAllByRole('radio')) expect((radio as HTMLInputElement).disabled).toBe(true)
  })

  it('saves the switched preference and reports the restart effect', async () => {
    const set = vi.fn(async () => {})
    const view = render(<ShellBackendSection {...propsOf(readyOf({ default: 'platform-default', entries: [] }), set)} />)
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['default.posix']) }))
    const save = screen.getByRole<HTMLButtonElement>('button', { name: zh.save })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    await waitFor(() => { expect(screen.getByText(zh.saved)).toBeDefined() })
    expect(set.mock.calls).toEqual([['default', 'posix']])

    // A settled save adopts the host revision: the draft re-syncs and saving
    // is idle again.
    const settled = readyOf({ default: 'posix', entries: [] }, 2)
    view.rerender(<ShellBackendSection {...propsOf(settled, set)} />)
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.save }).disabled).toBe(true) })
  })

  it('revert restores the resolved preference without writing', () => {
    const set = vi.fn(async () => {})
    render(<ShellBackendSection {...propsOf(readyOf({ default: 'posix', entries: [] }), set)} />)
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['default.platform-default']) }))
    fireEvent.click(screen.getByRole('button', { name: zh.revert }))
    expect(screen.getByRole<HTMLInputElement>('radio', { name: new RegExp(zh['default.posix']) }).checked).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.save }).disabled).toBe(true)
    expect(set).not.toHaveBeenCalled()
  })

  it('shows the busy label while the write is in flight', async () => {
    const pending: (() => void)[] = []
    const set = vi.fn(async () => { await new Promise<void>((resolve) => { pending.push(resolve) }) })
    render(<ShellBackendSection {...propsOf(readyOf({ default: 'platform-default', entries: [] }), set)} />)
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['default.posix']) }))
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.saving })).toBeDefined() })

    pending.pop()?.()
    await waitFor(() => { expect(screen.getByText(zh.saved)).toBeDefined() })
  })

  it('reports a refused write with the server message', async () => {
    const set = vi.fn(async () => { throw new Error('disk full') })
    render(<ShellBackendSection {...propsOf(readyOf({ default: 'platform-default', entries: [] }), set)} />)
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['default.posix']) }))
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(screen.getByText(zh.saveFailed.replace('{message}', 'disk full'))).toBeDefined() })
    expect(screen.queryByText(zh.saved)).toBeNull()
  })

  it('saves an unchanged draft without writing and still settles', async () => {
    const set = vi.fn(async () => {})
    render(<ShellBackendSection {...propsOf(readyOf({ default: 'platform-default', entries: [] }), set)} />)
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['default.posix']) }))
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['default.platform-default']) }))
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(screen.getByText(zh.saved)).toBeDefined() })
    expect(set).not.toHaveBeenCalled()
  })

  it('reports a refused write with the unknown fallback for empty messages', async () => {
    const set = vi.fn(async () => { throw new Error('') })
    render(<ShellBackendSection {...propsOf(readyOf({ default: 'platform-default', entries: [] }), set)} />)
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['default.posix']) }))
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(screen.getByText(zh.saveFailed.replace('{message}', zh.unknownError))).toBeDefined() })
  })

  it('stringifies a non-Error rejection in the failure notice', async () => {
    const set = vi.fn(async () => { throw 'gateway closed' })
    render(<ShellBackendSection {...propsOf(readyOf({ default: 'platform-default', entries: [] }), set)} />)
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['default.posix']) }))
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(screen.getByText(zh.saveFailed.replace('{message}', 'gateway closed'))).toBeDefined() })
  })

  it('adopts an external revision while the draft is clean', async () => {
    const view = render(<ShellBackendSection {...propsOf(readyOf({ default: 'platform-default', entries: [] }))} />)
    const external = readyOf({ default: 'posix', entries: [] }, 5)
    view.rerender(<ShellBackendSection {...propsOf(external)} />)
    await waitFor(() => { expect(screen.getByRole<HTMLInputElement>('radio', { name: new RegExp(zh['default.posix']) }).checked).toBe(true) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.save }).disabled).toBe(true)
  })

  it('keeps the dirty draft over an external revision', async () => {
    const view = render(<ShellBackendSection {...propsOf(readyOf({ default: 'platform-default', entries: [] }))} />)
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['default.posix']) }))
    view.rerender(<ShellBackendSection {...propsOf(readyOf({ default: 'platform-default', entries: [] }, 5))} />)
    await waitFor(() => { expect(screen.getByRole<HTMLInputElement>('radio', { name: new RegExp(zh['default.posix']) }).checked).toBe(true) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.save }).disabled).toBe(false)
  })
})

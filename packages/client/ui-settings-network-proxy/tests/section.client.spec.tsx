// @vitest-environment jsdom
/**
 * The section's presentation behavior: load and unavailable states, the
 * off / system / manual radio fieldset with the manual-only address inputs,
 * client-side URL validation, dirty tracking with save and revert, ordered
 * field writes (empty optional fields clear their override), failure
 * notices, and adoption of external revisions — everything through plain
 * props over a mutable scope snapshot holder.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NetworkProxySection, usableProxyUrl } from '../src/client/NetworkProxySection.tsx'
import type { NetworkProxySectionInjected, NetworkProxySectionProps } from '../src/client/NetworkProxySection.tsx'
import type { NetworkProxySectionValue } from '../src/client/decode.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

type ScopeSnapshot = NetworkProxySectionProps['useScope'] extends ((select: (snapshot: infer S) => unknown) => unknown) ? S : never
type Translate = NetworkProxySectionProps['t']

/** Build a translator over the shipped Chinese dictionary. */
function tzh(): Translate {
  return ((key: keyof typeof zh, params?: Record<string, unknown>) => {
    let text: string = zh[key]
    for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
    return text
  }) as Translate
}

/** Mutable snapshot holder the useScope stub reads at each render. */
function holder(snapshot: ScopeSnapshot): { snapshot: ScopeSnapshot; useScope: NetworkProxySectionProps['useScope'] } {
  const box = { snapshot }
  return {
    snapshot,
    useScope: <T,>(select: (snapshot: ScopeSnapshot) => T) => select(box.snapshot),
  }
}

/** Build one ready snapshot over a section value. */
function readyOf(value: NetworkProxySectionValue, revision = 1, writable = true): ScopeSnapshot {
  return { status: 'ready', value, base: {}, user: undefined, revision, writable, mode: 'host' }
}

/** Assemble full props over the writable face doubles. */
function propsOf(
  scope: ScopeSnapshot,
  set: NetworkProxySectionInjected['set'] = vi.fn(async () => {}),
  unset: NetworkProxySectionInjected['unset'] = vi.fn(async () => {}),
): NetworkProxySectionProps {
  return {
    close: () => {},
    t: tzh(),
    useScope: ((<T,>(select: (snapshot: ScopeSnapshot) => T) => select(scope)) as NetworkProxySectionProps['useScope']),
    set,
    unset,
  } as unknown as NetworkProxySectionProps
}

describe('NetworkProxySection', () => {
  it('renders the loading state before the first accepted section', () => {
    const { useScope } = holder({ status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' })
    const bare = { close: () => {}, t: tzh(), useScope, set: vi.fn(), unset: vi.fn() } as unknown as NetworkProxySectionProps
    render(<NetworkProxySection {...bare} />)
    expect(screen.getByText(zh.loading)).toBeDefined()
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('renders the unavailable note when the namespace is not exposed', () => {
    const { useScope } = holder({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' })
    const bare = { close: () => {}, t: tzh(), useScope, set: vi.fn(), unset: vi.fn() } as unknown as NetworkProxySectionProps
    render(<NetworkProxySection {...bare} />)
    expect(screen.getByText(zh.unavailable)).toBeDefined()
  })

  it('shows the three modes with off active and no address inputs', () => {
    const scope = readyOf({ mode: 'off' })
    render(<NetworkProxySection {...propsOf(scope)} />)
    const off = screen.getByRole<HTMLInputElement>('radio', { name: new RegExp(zh['mode.off']) })
    const system = screen.getByRole<HTMLInputElement>('radio', { name: new RegExp(zh['mode.system']) })
    const manual = screen.getByRole<HTMLInputElement>('radio', { name: new RegExp(zh['mode.manual']) })
    expect(off.checked).toBe(true)
    expect(system.checked).toBe(false)
    expect(manual.checked).toBe(false)
    expect(screen.queryByLabelText(zh['url.label'])).toBeNull()
    expect(screen.queryByLabelText(zh['noProxy.label'])).toBeNull()
  })

  it('disables every control and notes the read-only state when writes are refused', () => {
    const scope = readyOf({ mode: 'manual', url: 'http://127.0.0.1:7890' }, 1, false)
    render(<NetworkProxySection {...propsOf(scope)} />)
    expect(screen.getByText(zh.readonly)).toBeDefined()
    for (const radio of screen.getAllByRole('radio')) expect((radio as HTMLInputElement).disabled).toBe(true)
  })

  it('reveals the address inputs on manual, gates saving on a usable http(s) URL, and warns on an unusable one', () => {
    const scope = readyOf({ mode: 'off' })
    render(<NetworkProxySection {...propsOf(scope)} />)
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['mode.manual']) }))
    const url = screen.getByLabelText<HTMLInputElement>(zh['url.label'])
    const noProxy = screen.getByLabelText<HTMLInputElement>(zh['noProxy.label'])
    expect(url).toBeDefined()
    expect(noProxy).toBeDefined()
    const save = screen.getByRole<HTMLButtonElement>('button', { name: zh.save })
    expect(save.disabled).toBe(true)
    expect(screen.queryByText(new RegExp(zh['url.invalid'].replace(/^.*:/, '')))).toBeNull()

    fireEvent.change(url, { target: { value: 'socks://127.0.0.1:1080' } })
    expect(screen.getByRole('alert').textContent).toContain(zh['url.invalid'])
    expect(save.disabled).toBe(true)

    fireEvent.change(url, { target: { value: 'http://127.0.0.1:7890' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(save.disabled).toBe(false)
  })

  it('saves changed fields in order, splits the exclusion list, clears emptied optionals, and reports the live effect', async () => {
    const scope = readyOf({ mode: 'manual', url: 'http://old.example:8080', noProxy: ['stale.example'] })
    const set = vi.fn(async () => {})
    const unset = vi.fn(async () => {})
    const typedSet = set as unknown as { mock: { calls: unknown[][] } }
    const first = propsOf(scope, set, unset)
    const view = render(<NetworkProxySection {...first} />)
    const url = screen.getByLabelText<HTMLInputElement>(zh['url.label'])
    const noProxy = screen.getByLabelText<HTMLInputElement>(zh['noProxy.label'])
    fireEvent.change(url, { target: { value: ' http://127.0.0.1:7890 ' } })
    fireEvent.change(noProxy, { target: { value: 'localhost, 127.0.0.1' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))

    await waitFor(() => { expect(screen.getByText(zh.saved)).toBeDefined() })
    expect(typedSet.mock.calls).toEqual([
      ['url', 'http://127.0.0.1:7890'],
      ['noProxy', ['localhost', '127.0.0.1']],
    ])
    expect(typedSet.mock.calls.every(call => call[0] !== 'mode')).toBe(true)
    expect(unset).not.toHaveBeenCalled()

    // A settled save adopts the host revision: the draft re-syncs and saving
    // is idle again.
    const settled = readyOf({ mode: 'manual', url: 'http://127.0.0.1:7890', noProxy: ['localhost', '127.0.0.1'] }, 2)
    view.rerender(<NetworkProxySection {...propsOf(settled, set, unset)} />)
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.save }).disabled).toBe(true) })
  })

  it('writes the mode switch and clears the address override when the fields empty', async () => {
    const scope = readyOf({ mode: 'manual', url: 'http://old.example:8080', noProxy: ['stale.example'] })
    const set = vi.fn(async () => {})
    const unset = vi.fn(async () => {})
    render(<NetworkProxySection {...propsOf(scope, set, unset)} />)
    fireEvent.change(screen.getByLabelText(zh['url.label']), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText(zh['noProxy.label']), { target: { value: '' } })
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['mode.system']) }))
    fireEvent.click(screen.getByRole('button', { name: zh.save }))

    await waitFor(() => { expect(unset.mock.calls).toEqual([['url'], ['noProxy']]) })
    expect(set.mock.calls).toEqual([['mode', 'system']])
  })

  it('validates candidate URLs before they reach the scope', () => {
    expect(usableProxyUrl('')).toBe(false)
    expect(usableProxyUrl('not a url')).toBe(false)
    expect(usableProxyUrl('ftp://127.0.0.1:21')).toBe(false)
    expect(usableProxyUrl('http://127.0.0.1:7890')).toBe(true)
    expect(usableProxyUrl('https://proxy.example')).toBe(true)
  })

  it('saves a lone mode switch without touching untouched fields', async () => {
    const scope = readyOf({ mode: 'manual' })
    const set = vi.fn(async () => {})
    const unset = vi.fn(async () => {})
    render(<NetworkProxySection {...propsOf(scope, set, unset)} />)
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['mode.off']) }))
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(screen.getByText(zh.saved)).toBeDefined() })
    expect(set.mock.calls).toEqual([['mode', 'off']])
    expect(unset).not.toHaveBeenCalled()
  })

  it('keeps unchanged fields out of the write set', async () => {
    const scope = readyOf({ mode: 'manual', url: 'http://keep.example:8080', noProxy: ['keep.example'] })
    const set = vi.fn(async () => {})
    const unset = vi.fn(async () => {})
    render(<NetworkProxySection {...propsOf(scope, set, unset)} />)
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['mode.system']) }))
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(screen.getByText(zh.saved)).toBeDefined() })
    expect(set.mock.calls).toEqual([['mode', 'system']])
    expect(unset).not.toHaveBeenCalled()
  })

  it('shows the busy label while the write is in flight', async () => {
    const pending: (() => void)[] = []
    const scope = readyOf({ mode: 'off' })
    const set = vi.fn(async () => { await new Promise<void>((resolve) => { pending.push(resolve) }) })
    render(<NetworkProxySection {...propsOf(scope, set)} />)
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['mode.manual']) }))
    fireEvent.change(screen.getByLabelText(zh['url.label']), { target: { value: 'http://127.0.0.1:7890' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.saving })).toBeDefined() })
    // Writes serialize; drain each pending settlement as the flow reaches it.
    await waitFor(() => {
      for (const resolve of pending.splice(0)) resolve()
      expect(screen.getByText(zh.saved)).toBeDefined()
    })
  })

  it('fills both manual fields from a bare manual section', async () => {
    const scope = readyOf({ mode: 'manual' })
    const set = vi.fn(async () => {})
    const unset = vi.fn(async () => {})
    render(<NetworkProxySection {...propsOf(scope, set, unset)} />)
    fireEvent.change(screen.getByLabelText(zh['url.label']), { target: { value: 'http://127.0.0.1:7890' } })
    fireEvent.change(screen.getByLabelText(zh['noProxy.label']), { target: { value: 'localhost' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(screen.getByText(zh.saved)).toBeDefined() })
    expect(set.mock.calls).toEqual([
      ['url', 'http://127.0.0.1:7890'],
      ['noProxy', ['localhost']],
    ])
    expect(unset).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error rejection for the failure notice', async () => {
    const scope = readyOf({ mode: 'off' })
    const set = vi.fn(async () => { throw 'raw refusal' })
    render(<NetworkProxySection {...propsOf(scope, set)} />)
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['mode.manual']) }))
    fireEvent.change(screen.getByLabelText(zh['url.label']), { target: { value: 'http://127.0.0.1:7890' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(screen.getByText(zh.saveFailed.replace('{message}', 'raw refusal'))).toBeDefined() })
  })

  it('falls back to the unknown-error copy for an empty message', async () => {
    const scope = readyOf({ mode: 'off' })
    const set = vi.fn(async () => { throw new Error('') })
    render(<NetworkProxySection {...propsOf(scope, set)} />)
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['mode.manual']) }))
    fireEvent.change(screen.getByLabelText(zh['url.label']), { target: { value: 'http://127.0.0.1:7890' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(screen.getByText(zh.saveFailed.replace('{message}', zh.unknownError))).toBeDefined() })
  })

  it('reports a refused write through the failure notice', async () => {
    const scope = readyOf({ mode: 'off' })
    const set = vi.fn(async () => { throw new Error('boom') })
    render(<NetworkProxySection {...propsOf(scope, set)} />)
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(zh['mode.manual']) }))
    fireEvent.change(screen.getByLabelText(zh['url.label']), { target: { value: 'http://127.0.0.1:7890' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))

    await waitFor(() => { expect(screen.getByText(zh.saveFailed.replace('{message}', 'boom'))).toBeDefined() })
  })

  it('reverts the draft to the loaded section', () => {
    const scope = readyOf({ mode: 'manual', url: 'http://old.example:8080' })
    render(<NetworkProxySection {...propsOf(scope)} />)
    fireEvent.change(screen.getByLabelText(zh['url.label']), { target: { value: 'http://new.example:8080' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.revert }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: zh.revert }))
    expect(screen.getByLabelText<HTMLInputElement>(zh['url.label']).value).toBe('http://old.example:8080')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.save }).disabled).toBe(true)
  })

  it('adopts an external revision while the draft is clean', () => {
    const scope = readyOf({ mode: 'off' })
    const view = render(<NetworkProxySection {...propsOf(scope)} />)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: new RegExp(zh['mode.off']) }).checked).toBe(true)

    view.rerender(<NetworkProxySection {...propsOf(readyOf({ mode: 'manual', url: 'http://elsewhere.example:3128' }, 7))} />)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: new RegExp(zh['mode.manual']) }).checked).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(zh['url.label']).value).toBe('http://elsewhere.example:3128')
  })
})

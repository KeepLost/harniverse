// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import {
  GovernorSettingsSection,
  type GovernorConfigRuntime,
  type GovernorSettingsSectionProps,
} from '../src/client/GovernorSettingsSection.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t: GovernorSettingsSectionProps['t'] = makeTranslate(zh)

const RUNTIME: GovernorConfigRuntime = {
  memory: { limit: 'auto' },
  sampling: { baseMs: 5_000, hotMs: 1_000 },
  history: { persist: false, resolutionMs: 5_000, retentionMs: 604_800_000 },
  globalLimitBytes: 8_589_934_592,
}

/** A minimal snapshot-store stand-in for the settings scope hook seat. */
function scopeStore(snapshot: Record<string, unknown>) {
  let current = snapshot
  return {
    getSnapshot: () => current,
    subscribe: () => () => {},
    set: (next: Record<string, unknown>) => { current = next },
  }
}

/** Mount the page with a stubbed scope snapshot and Remote/config faces.
 * @param runtime - a stable effective-config result, or a queue drained per call.
 */
function mount(
  snapshot: Record<string, unknown>,
  runtime: GovernorConfigRuntime | { ok: false; error: string }
    | Array<GovernorConfigRuntime | { ok: false; error: string }> = RUNTIME,
) {
  const setMemoryLimit = vi.fn(async () => {})
  const results = Array.isArray(runtime) ? [...runtime] : [runtime]
  const configGet = vi.fn(async () => {
    const next = results.length > 1 ? results.shift()! : results[0]!
    return 'ok' in next ? { ok: false as const, error: next.error } : { ok: true as const, value: next }
  })
  const store = scopeStore(snapshot)
  render(
    <GovernorSettingsSection
      {...{
        useScope: (selector: (value: unknown) => unknown) => selector(store.getSnapshot()),
        setMemoryLimit,
        configGet,
        t,
      } as unknown as GovernorSettingsSectionProps}
    />,
  )
  return { setMemoryLimit, configGet, store }
}

describe('GovernorSettingsSection', () => {
  it('renders the quota form with the automatic mode and the effective budget', async () => {
    mount({ status: 'ready', value: { memory: { limit: 'auto' } }, writable: true })
    expect(screen.getByText(zh['settings.intro'])).toBeDefined()
    expect(screen.getByText(zh['settings.limit.autoDesc'])).toBeDefined()
    expect(screen.getByText(zh['settings.session.note'])).toBeDefined()
    const auto = screen.getByRole('radio', { name: zh['settings.limit.auto'] }) as HTMLInputElement
    const custom = screen.getByRole('radio', { name: zh['settings.limit.custom'] }) as HTMLInputElement
    expect(auto.checked).toBe(true)
    expect(custom.checked).toBe(false)
    expect(screen.queryByLabelText(zh['settings.limit.gib'])).toBeNull()
    await waitFor(() => {
      expect(screen.getByText((content, element) => element?.tagName === 'P' && content.includes('8.0 GiB'))).toBeDefined()
    })
  })

  it('seeds the custom draft from an explicit byte budget', () => {
    mount({ status: 'ready', value: { memory: { limit: 4_294_967_296 } }, writable: true })
    const custom = screen.getByRole('radio', { name: zh['settings.limit.custom'] }) as HTMLInputElement
    expect(custom.checked).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(zh['settings.limit.gib']).value).toBe('4.0')
  })

  it('writes an explicit budget in bytes through the scope', async () => {
    const handles = mount({ status: 'ready', value: { memory: { limit: 'auto' } }, writable: true })
    fireEvent.click(screen.getByRole('radio', { name: zh['settings.limit.custom'] }))
    fireEvent.change(screen.getByLabelText(zh['settings.limit.gib']), { target: { value: '2.5' } })
    fireEvent.click(screen.getByRole('button', { name: zh['settings.limit.apply'] }))
    await waitFor(() => { expect(handles.setMemoryLimit).toHaveBeenCalledWith(2_684_354_560) })
    // The write settles, then the effective-budget reread repeats once more
    // after the Host's async re-application: mount read + 2 rereads.
    await waitFor(() => { expect(handles.configGet.mock.calls.length).toBeGreaterThanOrEqual(3) }, { timeout: 2_000 })
  })

  it('returns the budget to automatic through the scope', async () => {
    const handles = mount({ status: 'ready', value: { memory: { limit: 4_294_967_296 } }, writable: true })
    fireEvent.click(screen.getByRole('radio', { name: zh['settings.limit.auto'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['settings.limit.apply'] }))
    await waitFor(() => { expect(handles.setMemoryLimit).toHaveBeenCalledWith('auto') })
  })

  it('rejects a non-positive draft without writing', () => {
    const handles = mount({ status: 'ready', value: { memory: { limit: 'auto' } }, writable: true })
    fireEvent.click(screen.getByRole('radio', { name: zh['settings.limit.custom'] }))
    fireEvent.change(screen.getByLabelText(zh['settings.limit.gib']), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: zh['settings.limit.apply'] }))
    expect(screen.getByRole('alert').textContent).toBe(zh['settings.limit.invalid'])
    expect(handles.setMemoryLimit).not.toHaveBeenCalled()
  })

  it('disables the form and explains when the identity cannot write', () => {
    mount({ status: 'ready', value: { memory: { limit: 'auto' } }, writable: false })
    expect(screen.getByText(zh['settings.readonly'])).toBeDefined()
    expect(screen.getByRole<HTMLInputElement>('radio', { name: zh['settings.limit.auto'] }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['settings.limit.apply'] }).disabled).toBe(true)
  })

  it('degrades to the unavailable notice when the namespace is not exposed', () => {
    mount({ status: 'unavailable', writable: false })
    expect(screen.getByText(zh['settings.unavailable'])).toBeDefined()
    expect(screen.queryByRole('button', { name: zh['settings.limit.apply'] })).toBeNull()
  })

  it('surfaces a failed effective-budget read', async () => {
    mount({ status: 'ready', value: { memory: { limit: 'auto' } }, writable: true }, { ok: false, error: 'denied' })
    await waitFor(() => { expect(screen.getByText(zh['settings.effective.error'])).toBeDefined() })
  })

  it('surfaces a failed reread after a successful apply', async () => {
    const handles = mount(
      { status: 'ready', value: { memory: { limit: 'auto' } }, writable: true },
      [RUNTIME, RUNTIME, { ok: false, error: 'denied' }],
    )
    fireEvent.click(screen.getByRole('radio', { name: zh['settings.limit.custom'] }))
    fireEvent.change(screen.getByLabelText(zh['settings.limit.gib']), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: zh['settings.limit.apply'] }))
    await waitFor(() => { expect(handles.setMemoryLimit).toHaveBeenCalledWith(2 * 1024 ** 3) })
    // The trailing 600 ms reread fails and flips the effective value to its error copy.
    await waitFor(() => { expect(screen.getByText(zh['settings.effective.error'])).toBeDefined() }, { timeout: 2_000 })
  })

  it('drops an in-flight budget read that settles after unmount', async () => {
    let settle: (value: { ok: true; value: GovernorConfigRuntime }) => void = () => {}
    const configGet = vi.fn(async () => new Promise<{ ok: true; value: GovernorConfigRuntime }>((resolve) => { settle = resolve }))
    render(
      <GovernorSettingsSection
        {...{
          useScope: (selector: (value: unknown) => unknown) => selector({ status: 'ready', value: { memory: { limit: 'auto' } }, writable: true }),
          setMemoryLimit: vi.fn(async () => {}),
          configGet,
          t,
        } as unknown as GovernorSettingsSectionProps}
      />,
    )
    cleanup()
    settle({ ok: true, value: RUNTIME })
    await Promise.resolve()
  })
})

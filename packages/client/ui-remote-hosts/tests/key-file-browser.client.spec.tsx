// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { KeyFileListing } from '@deepseek-ai/dsh-remote-hosts/types'
import { KeyFileBrowser } from '../src/client/KeyFileBrowser.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh)

function listing(overrides: { path?: string | undefined; parent?: string | undefined; entries?: KeyFileListing['entries'] | undefined; truncated?: boolean | undefined } = {}): KeyFileListing {
  const level = {
    path: overrides.path ?? '/home/me/.ssh',
    entries: overrides.entries ?? [
      { name: 'keys', path: '/home/me/.ssh/keys', kind: 'directory' },
      { name: 'id_ed25519', path: '/home/me/.ssh/id_ed25519', kind: 'file' },
    ],
    truncated: overrides.truncated ?? false,
  }
  if (!('parent' in overrides)) return { ...level, parent: '/home/me' }
  return overrides.parent === undefined ? level : { ...level, parent: overrides.parent }
}

function deferred(): {
  resolve: (value: { ok: true; value: KeyFileListing }) => void
  reject: (reason: unknown) => void
  promise: Promise<{ ok: true; value: KeyFileListing }>
} {
  let settle!: (value: { ok: true; value: KeyFileListing }) => void
  let fail!: (reason: unknown) => void
  const promise = new Promise<{ ok: true; value: KeyFileListing }>((resolve, reject) => { settle = resolve; fail = reject })
  return { resolve: settle, reject: fail, promise }
}

describe('KeyFileBrowser', () => {
  it('renders nothing while closed and lists the default level on open', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: listing() }))
    const { rerender } = render(<KeyFileBrowser open={false} list={list} onPick={vi.fn()} onClose={vi.fn()} t={t} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(list).not.toHaveBeenCalled()

    rerender(<KeyFileBrowser open list={list} onPick={vi.fn()} onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: 'id_ed25519' })).toBeTruthy() })
    expect(screen.getByText('/home/me/.ssh')).toBeTruthy()
    expect(list).toHaveBeenCalledWith(undefined)
  })

  it('enters directories, walks back up, and picks a file', async () => {
    const list = vi.fn(async (path?: string) => ({ ok: true as const, value: path === '/home/me' ? listing({
      path: '/home/me', parent: '/', entries: [],
    }) : listing() }))
    const onPick = vi.fn()
    render(<KeyFileBrowser open list={list} onPick={onPick} onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: 'id_ed25519' })).toBeTruthy() })

    // A picked file is reported as-is, with the absolute host path.
    fireEvent.click(screen.getByRole('button', { name: 'id_ed25519' }))
    expect(onPick).toHaveBeenCalledWith('/home/me/.ssh/id_ed25519')

    // The up row lists the parent level; an empty level with a parent shows no empty note.
    fireEvent.click(screen.getByRole('button', { name: zh.keyBrowserUp }))
    await waitFor(() => { expect(list).toHaveBeenLastCalledWith('/home/me') })
    await waitFor(() => { expect(screen.getByText('/home/me')).toBeTruthy() })
    expect(screen.queryByText(zh.keyBrowserEmpty)).toBeNull()
  })

  it('shows the empty and truncated notes and closes on cancel', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: listing({ parent: undefined, entries: [], truncated: true }) }))
    const onClose = vi.fn()
    render(<KeyFileBrowser open list={list} onPick={vi.fn()} onClose={onClose} t={t} />)
    await waitFor(() => { expect(screen.getByText(zh.keyBrowserEmpty)).toBeTruthy() })
    expect(screen.getByText(zh.keyBrowserTruncated)).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.keyBrowserUp })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.keyBrowserCancel }))
    expect(onClose).toHaveBeenCalled()
  })

  it('surfaces a failed listing and a transport rejection as operator copy', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: { code: 'remote-host-failed', message: 'remote-hosts: KEY_DIRECTORY_UNREADABLE', details: { reason: 'KEY_DIRECTORY_UNREADABLE' } } })
      .mockRejectedValueOnce(new Error('listing transport died'))
      .mockRejectedValueOnce('plain listing failure')
    const props = { list: list as never, onPick: vi.fn(), onClose: vi.fn(), t }
    const { rerender } = render(<KeyFileBrowser open {...props} />)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.errorKeyDirectoryUnreadable) })
    // Reopening restarts the interaction and surfaces the next failure mode.
    rerender(<KeyFileBrowser open={false} {...props} />)
    rerender(<KeyFileBrowser open {...props} />)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('listing transport died') })
    rerender(<KeyFileBrowser open={false} {...props} />)
    rerender(<KeyFileBrowser open {...props} />)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('plain listing failure') })
  })

  it('ignores settlements that land after the dialog closes, for value and failure alike', async () => {
    const fresh = async (): Promise<{ ok: true; value: KeyFileListing }> => ({ ok: true, value: listing({ path: '/fresh' }) })
    const stale = deferred()
    const list = vi.fn()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(fresh)
    const props = { list: list as never, onPick: vi.fn(), onClose: vi.fn(), t }
    const { rerender } = render(<KeyFileBrowser open {...props} />)
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(zh.keyBrowserLoading) })

    // The dialog closes mid-scan; the late success must not repopulate a reopen.
    rerender(<KeyFileBrowser open={false} {...props} />)
    stale.resolve({ ok: true, value: listing({ path: '/stale' }) })
    await Promise.resolve()
    rerender(<KeyFileBrowser open {...props} />)
    await waitFor(() => { expect(screen.getByText('/fresh')).toBeTruthy() })
    expect(screen.queryByText('/stale')).toBeNull()

    // A late failure is equally inert: start a scan while open, close mid-scan, then reject.
    const late = deferred()
    list.mockImplementationOnce(() => late.promise)
    list.mockImplementation(fresh)
    fireEvent.click(screen.getByRole('button', { name: zh.keyBrowserUp }))
    await waitFor(() => { expect(list).toHaveBeenLastCalledWith('/home/me') })
    rerender(<KeyFileBrowser open={false} {...props} />)
    late.reject(new Error('stale scan failure'))
    await Promise.resolve()
    rerender(<KeyFileBrowser open {...props} />)
    await waitFor(() => { expect(screen.getByText('/fresh')).toBeTruthy() })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

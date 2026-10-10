// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PacksRow, type PacksRowProps } from '../src/client/PacksRow.tsx'
import type { OperationOutcome, PackOutcome } from '../src/client/outcomes.ts'
import { zh } from '../src/client/locales.ts'
import { libraryView, skin } from './fixtures.client.ts'
import { skinSource, t } from './component-bench.client.ts'

afterEach(cleanup)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const MINE = skin('mine', { source: 'pack', author: 'Ada', colorScheme: 'light' })
const BARE = skin('bare', { source: 'pack' })

function mount(patch: Parameters<typeof skinSource>[0] = {}) {
  const library = libraryView({ skins: [...libraryView().skins, MINE, BARE] })
  const source = skinSource({ library, ...patch })
  const face = {
    importPack: vi.fn(async (): Promise<PackOutcome> => ({ status: 'imported', skin: MINE })),
    removePack: vi.fn(async (): Promise<OperationOutcome> => ({ status: 'ok' })),
    exportActive: vi.fn(() => true),
  }
  render(<PacksRow {...{ t, useSkin: source.useSkin, ...face } as unknown as PacksRowProps} />)
  return { ...source, ...face }
}

const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement
const pick = (name = 'my.json') => { fireEvent.change(fileInput(), { target: { files: [new File(['{}'], name, { type: 'application/json' })] } }) }

describe('PacksRow', () => {
  it('lists the imported packs with scheme and author, not the built-ins', () => {
    mount()
    const list = screen.getByRole('list', { name: zh['packs.list'] })
    const items = within(list).getAllByRole('listitem')
    expect(items.map(item => item.textContent)).toEqual([
      'mine中文浅色 · 作者：Ada删除“mine中文”',
      'bare中文深色删除“bare中文”',
    ])
    expect(screen.getByText('皮肤包是不超过 256 KiB 的 .json 文件。')).toBeTruthy()
  })

  it('names packs in the active language', () => {
    mount({ locale: 'en' })
    expect(screen.getByRole('button', { name: '删除“mine en”' })).toBeTruthy()
  })

  it('says so when no pack has been imported', () => {
    mount({ library: libraryView() })
    expect(screen.queryByRole('list', { name: zh['packs.list'] })).toBeNull()
    expect(screen.getByText(zh['packs.empty'])).toBeTruthy()
  })

  it.each([
    ['imported', zh['packs.imported'].replace('{name}', 'mine中文')],
    ['replaced', zh['packs.replaced'].replace('{name}', 'mine中文')],
  ] as const)('confirms a %s pack by name', async (status, text) => {
    const m = mount()
    m.importPack.mockResolvedValueOnce({ status, skin: MINE })
    pick()
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(text) })
    expect(m.importPack).toHaveBeenCalledOnce()
  })

  it('shows progress while a pack imports', async () => {
    const pending = deferred<PackOutcome>()
    const m = mount()
    m.importPack.mockReturnValueOnce(pending.promise)
    pick()
    expect(screen.getByText(zh['packs.importing'])).toBeTruthy()
    expect(fileInput().disabled).toBe(true)
    await act(async () => { pending.resolve({ status: 'imported', skin: MINE }) })
    expect(screen.getByText(zh['packs.import'])).toBeTruthy()
  })

  it('lists the Host’s typed rejection issues verbatim', async () => {
    const m = mount()
    m.importPack.mockResolvedValueOnce({ status: 'rejected', issues: ['tokens.--x: unknown token', 'id: already used by a built-in skin'] })
    pick()
    const alert = await screen.findByRole('alert')
    expect(alert.querySelector('p')?.textContent).toBe(zh['packs.rejected'])
    expect(within(alert).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'tokens.--x: unknown token', 'id: already used by a built-in skin',
    ])
  })

  it('reports an oversized pack and a failed call in Chinese', async () => {
    const m = mount()
    m.importPack.mockResolvedValueOnce({ status: 'too-large' })
    pick()
    expect((await screen.findByRole('alert')).textContent).toBe('皮肤包超过 256 KiB 的上限。')
    m.importPack.mockResolvedValueOnce({ status: 'failed', message: 'host down' })
    pick()
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('操作失败：host down') })
  })

  it('opens the hidden picker from the styled button', () => {
    mount()
    const open = vi.spyOn(fileInput(), 'click').mockImplementation(() => {})
    expect(fileInput().hidden).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh['packs.import'] }))
    expect(open).toHaveBeenCalledOnce()
  })

  it('ignores an empty file selection', () => {
    const m = mount()
    fireEvent.change(fileInput(), { target: { files: [] } })
    expect(m.importPack).not.toHaveBeenCalled()
  })

  it('removes a pack, clearing earlier feedback, and reports a failed removal', async () => {
    const m = mount()
    m.importPack.mockResolvedValueOnce({ status: 'too-large' })
    pick()
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: '删除“mine中文”' }))
    expect(m.removePack).toHaveBeenCalledWith('mine')
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    m.removePack.mockResolvedValueOnce({ status: 'failed', message: 'denied' })
    fireEvent.click(screen.getByRole('button', { name: '删除“bare中文”' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('操作失败：denied') })
  })

  it('lists pack files on disk that failed validation', () => {
    mount({ library: libraryView({ rejected: [{ file: 'broken.json', message: 'not JSON' }] }) })
    const details = screen.getByText(zh['packs.broken']).closest('details')!
    expect(within(details).getByText('broken.json: not JSON')).toBeTruthy()
  })

  it('exports the active skin', () => {
    const m = mount({ theme: { preference: 'skin:abyss', activeId: 'skin:abyss' } })
    const button = screen.getByRole('button', { name: zh['packs.export'] }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(screen.getByText(zh['packs.exportHint'])).toBeTruthy()
    fireEvent.click(button)
    expect(m.exportActive).toHaveBeenCalledOnce()
  })

  it('has nothing to export for light and dark', () => {
    mount()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['packs.export'] }).disabled).toBe(true)
    expect(screen.getByText(zh['packs.exportNone'])).toBeTruthy()
  })

  it('shows the state read-only: import and removal disabled, export still available', () => {
    const m = mount({
      access: { status: 'ready', writable: false, denied: false },
      theme: { preference: 'skin:abyss', activeId: 'skin:abyss' },
    })
    expect(screen.getByRole('note').textContent).toBe(zh['access.readOnly'])
    expect(fileInput().disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '删除“mine中文”' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['packs.export'] }).disabled).toBe(false)
    expect(m.removePack).not.toHaveBeenCalled()
  })
})

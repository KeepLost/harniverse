// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { WallpaperRow, type WallpaperRowProps } from '../src/client/WallpaperRow.tsx'
import type { OperationOutcome, WallpaperOutcome } from '../src/client/outcomes.ts'
import { DEFAULT_SETTINGS } from '../src/client/settings.ts'
import { zh } from '../src/client/locales.ts'
import { libraryView, HASH_A, HASH_B } from './fixtures.client.ts'
import { skinSource, t } from './component-bench.client.ts'

afterEach(cleanup)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function mount(patch: Parameters<typeof skinSource>[0] = {}) {
  const source = skinSource(patch)
  const face = {
    setSetting: vi.fn(),
    uploadWallpaper: vi.fn(async (): Promise<WallpaperOutcome> => ({ status: 'ok', hash: HASH_A })),
    removeWallpaper: vi.fn(async (): Promise<OperationOutcome> => ({ status: 'ok' })),
    acquireWallpaper: vi.fn(async (hash: string): Promise<string | undefined> => `blob:${hash.slice(0, 4)}`),
    releaseWallpaper: vi.fn(),
  }
  const view = render(<WallpaperRow {...{ t, useSkin: source.useSkin, ...face } as unknown as WallpaperRowProps} />)
  return { ...source, ...face, view }
}

const upload = () => document.querySelector('input[type="file"]') as HTMLInputElement
const pick = (name = 'bg.png') => { fireEvent.change(upload(), { target: { files: [new File(['x'], name, { type: 'image/png' })] } }) }

describe('WallpaperRow', () => {
  it('states the Host limits and lists the stored wallpapers with their thumbnails', async () => {
    const m = mount()
    expect(screen.getByText('支持 PNG、JPEG、WebP，单张不超过 8 MiB，最多保留 24 张。')).toBeTruthy()
    const thumbs = screen.getAllByRole('button', { name: /^壁纸 \d/ })
    expect(thumbs.map(thumb => thumb.getAttribute('aria-label'))).toEqual(['壁纸 1（2 KiB）', '壁纸 2（2 KiB）'])
    await waitFor(() => { expect(thumbs[0]!.querySelector('img')?.getAttribute('src')).toBe('blob:aaaa') })
    expect(m.acquireWallpaper).toHaveBeenCalledWith(HASH_A)
    expect(m.acquireWallpaper).toHaveBeenCalledWith(HASH_B)
  })

  it('shows a placeholder until the thumbnail arrives and releases every reference on unmount', async () => {
    const pending = deferred<string | undefined>()
    const source = skinSource()
    const acquireWallpaper = vi.fn(() => pending.promise)
    const releaseWallpaper = vi.fn()
    const props = {
      t,
      useSkin: source.useSkin,
      setSetting: vi.fn(),
      uploadWallpaper: vi.fn(),
      removeWallpaper: vi.fn(),
      acquireWallpaper,
      releaseWallpaper,
    } as unknown as WallpaperRowProps
    const view = render(<WallpaperRow {...props} />)
    expect(view.container.querySelector('img')).toBeNull()
    await act(async () => { pending.resolve(undefined) })
    expect(view.container.querySelector('img')).toBeNull()
    view.unmount()
    expect(releaseWallpaper).toHaveBeenCalledWith(HASH_A)
    expect(releaseWallpaper).toHaveBeenCalledWith(HASH_B)
  })

  it('selects a wallpaper and marks the chosen one', () => {
    const m = mount({ settings: { ...DEFAULT_SETTINGS, wallpaper: HASH_B } })
    const thumbs = screen.getAllByRole('button', { name: /^壁纸 \d/ })
    expect(thumbs.map(thumb => thumb.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
    fireEvent.click(thumbs[0]!)
    expect(m.setSetting).toHaveBeenCalledWith('wallpaper', HASH_A)
  })

  it('clears the wallpaper', () => {
    const m = mount({ settings: { ...DEFAULT_SETTINGS, wallpaper: HASH_A } })
    fireEvent.click(screen.getByRole('button', { name: zh['wallpaper.none'] }))
    expect(m.setSetting).toHaveBeenCalledWith('wallpaper', '')
  })

  it('has nothing to clear while no wallpaper is chosen', () => {
    mount()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['wallpaper.none'] }).disabled).toBe(true)
  })

  it('uploads a picked image, showing progress and then no problem', async () => {
    const pending = deferred<WallpaperOutcome>()
    const m = mount()
    m.uploadWallpaper.mockReturnValueOnce(pending.promise)
    pick()
    expect(m.uploadWallpaper).toHaveBeenCalledOnce()
    expect((m.uploadWallpaper.mock.calls[0] as unknown as [File])[0].name).toBe('bg.png')
    expect(screen.getByText(zh['wallpaper.uploading'])).toBeTruthy()
    expect(upload().disabled).toBe(true)
    await act(async () => { pending.resolve({ status: 'ok', hash: HASH_A }) })
    expect(screen.getByText(zh['wallpaper.upload'])).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('opens the hidden picker from the styled button', () => {
    mount()
    const open = vi.spyOn(upload(), 'click').mockImplementation(() => {})
    expect(upload().hidden).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh['wallpaper.upload'] }))
    expect(open).toHaveBeenCalledOnce()
  })

  it('ignores an empty file selection', () => {
    const m = mount()
    fireEvent.change(upload(), { target: { files: [] } })
    expect(m.uploadWallpaper).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid-encoding', zh['wallpaper.reject.invalid-encoding']],
    ['too-large', '图片超过 8 MiB 的上限。'],
    ['unsupported-type', zh['wallpaper.reject.unsupported-type']],
    ['limit-reached', '壁纸已达 24 张上限，请先删除不用的。'],
  ] as const)('explains a %s rejection in Chinese', async (reason, text) => {
    const m = mount()
    m.uploadWallpaper.mockResolvedValueOnce({ status: 'rejected', reason })
    pick()
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(text) })
  })

  it('shows a failed upload and clears the message after the next success', async () => {
    const m = mount()
    m.uploadWallpaper.mockResolvedValueOnce({ status: 'failed', message: 'host down' })
    pick()
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('操作失败：host down') })
    pick()
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  })

  it('deletes a wallpaper and reports a failed deletion', async () => {
    const m = mount()
    fireEvent.click(screen.getByRole('button', { name: '删除壁纸 2' }))
    expect(m.removeWallpaper).toHaveBeenCalledWith(HASH_B)
    m.removeWallpaper.mockResolvedValueOnce({ status: 'failed', message: 'denied' })
    fireEvent.click(screen.getByRole('button', { name: '删除壁纸 1' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('操作失败：denied') })
  })

  it('blurs only while a wallpaper is chosen', () => {
    const m = mount({ settings: { ...DEFAULT_SETTINGS, wallpaper: HASH_A, wallpaperBlur: 12 } })
    const slider = screen.getByLabelText<HTMLInputElement>(zh['wallpaper.blur'])
    expect(slider.value).toBe('12')
    expect(slider.max).toBe('40')
    expect(within(slider.closest('label')!).getByText('12 px')).toBeTruthy()
    fireEvent.change(slider, { target: { value: '20' } })
    expect(m.setSetting).toHaveBeenCalledWith('wallpaperBlur', 20)
  })

  it('disables the blur slider without a wallpaper', () => {
    mount()
    expect(screen.getByLabelText<HTMLInputElement>(zh['wallpaper.blur']).disabled).toBe(true)
  })

  it('says so when nothing has been uploaded or the library cannot be read', () => {
    mount({ library: libraryView({ wallpapers: [], status: 'error' }) })
    expect(screen.getByText(zh['wallpaper.empty'])).toBeTruthy()
    expect(screen.getByText(zh['wallpaper.unavailable'])).toBeTruthy()
  })

  it('shows the state read-only, with every control disabled and a hint', () => {
    const m = mount({
      access: { status: 'ready', writable: false, denied: false },
      settings: { ...DEFAULT_SETTINGS, wallpaper: HASH_A, wallpaperBlur: 5 },
    })
    expect(screen.getByRole('note').textContent).toBe(zh['access.readOnly'])
    expect(upload().disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['wallpaper.none'] }).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(zh['wallpaper.blur']).disabled).toBe(true)
    for (const button of screen.getAllByRole('button', { name: /^(壁纸|删除壁纸) \d/ })) expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getAllByRole('button', { name: /^壁纸 \d/ })[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(m.setSetting).not.toHaveBeenCalled()
  })
})

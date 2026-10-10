// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { Backdrop, type BackdropProps } from '../src/client/Backdrop.tsx'
import { GRADIENT, HASH_A, HASH_B } from './fixtures.client.ts'
import { skinSource } from './component-bench.client.ts'

afterEach(cleanup)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function mount(patch: Parameters<typeof skinSource>[0] = {}, acquire?: (hash: string) => Promise<string | undefined>) {
  const source = skinSource(patch)
  const acquireWallpaper = vi.fn(acquire ?? (async (hash: string) => `blob:${hash.slice(0, 4)}`))
  const releaseWallpaper = vi.fn()
  const view = render(<Backdrop {...{ useSkin: source.useSkin, acquireWallpaper, releaseWallpaper } as unknown as BackdropProps} />)
  return { ...source, view, acquireWallpaper, releaseWallpaper }
}

describe('Backdrop', () => {
  it('renders nothing when nothing paints behind the frame', () => {
    const m = mount({ backdrop: { kind: 'none' } })
    expect(m.view.container.firstChild).toBeNull()
    expect(m.acquireWallpaper).not.toHaveBeenCalled()
  })

  it('paints the skin gradient without touching the wallpaper store', () => {
    const m = mount({ backdrop: { kind: 'gradient', background: GRADIENT } })
    const layer = m.view.container.firstElementChild as HTMLElement
    expect(layer.dataset.backdrop).toBe('gradient')
    expect(layer.style.getPropertyValue('--dsh-skin-image')).toBe(
      'radial-gradient(circle 60vmax at 20% 10%, #5e6ad240 0%, transparent 100%), linear-gradient(165deg, #121216 0%, #101016 100%)',
    )
    expect(layer.querySelector('[class*="image"]')).not.toBeNull()
    expect(m.acquireWallpaper).not.toHaveBeenCalled()
  })

  it('shows the wallpaper under its blur and a veil once its object URL arrives', async () => {
    const m = mount({ backdrop: { kind: 'wallpaper', hash: HASH_A, blur: 14 } })
    const layer = m.view.container.firstElementChild as HTMLElement
    expect(layer.dataset.backdrop).toBe('wallpaper')
    expect(layer.style.getPropertyValue('--dsh-skin-blur')).toBe('14px')
    await act(async () => {})
    expect(layer.style.getPropertyValue('--dsh-skin-image')).toBe('url("blob:aaaa")')
    expect(layer.querySelector('[class*="image"]')).not.toBeNull()
    expect(layer.querySelector('[class*="veil"]')).not.toBeNull()
    expect(m.acquireWallpaper).toHaveBeenCalledExactlyOnceWith(HASH_A)
  })

  it('keeps only the veil while the wallpaper is loading, and when it cannot be shown', async () => {
    const pending = deferred<string | undefined>()
    const m = mount({ backdrop: { kind: 'wallpaper', hash: HASH_A, blur: 0 } }, () => pending.promise)
    const layer = m.view.container.firstElementChild as HTMLElement
    expect(layer.querySelector('[class*="image"]')).toBeNull()
    expect(layer.querySelector('[class*="veil"]')).not.toBeNull()
    await act(async () => { pending.resolve(undefined) })
    expect(layer.querySelector('[class*="image"]')).toBeNull()
    expect(layer.style.getPropertyValue('--dsh-skin-image')).toBe('')
  })

  it('swaps the wallpaper, releasing the old reference, and releases on unmount', async () => {
    const m = mount({ backdrop: { kind: 'wallpaper', hash: HASH_A, blur: 0 } })
    await act(async () => {})
    act(() => { m.update({ backdrop: { kind: 'wallpaper', hash: HASH_B, blur: 0 } }) })
    await act(async () => {})
    expect(m.releaseWallpaper).toHaveBeenCalledWith(HASH_A)
    expect((m.view.container.firstElementChild as HTMLElement).style.getPropertyValue('--dsh-skin-image')).toBe('url("blob:bbbb")')
    act(() => { m.update({ backdrop: { kind: 'none' } }) })
    expect(m.releaseWallpaper).toHaveBeenCalledWith(HASH_B)
    expect(m.view.container.firstChild).toBeNull()
  })

  it('ignores a wallpaper that arrives after the view moved on', async () => {
    const first = deferred<string | undefined>()
    const m = mount({ backdrop: { kind: 'wallpaper', hash: HASH_A, blur: 0 } }, hash => hash === HASH_A ? first.promise : Promise.resolve('blob:bbbb'))
    act(() => { m.update({ backdrop: { kind: 'wallpaper', hash: HASH_B, blur: 0 } }) })
    await act(async () => {})
    await act(async () => { first.resolve('blob:late') })
    expect((m.view.container.firstElementChild as HTMLElement).style.getPropertyValue('--dsh-skin-image')).toBe('url("blob:bbbb")')
  })
})

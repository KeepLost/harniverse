// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ImageLightbox } from '../src/ImageLightbox.tsx'

afterEach(cleanup)

const labels = { dialog: '原图预览', close: '关闭原图预览' }

describe('ImageLightbox', () => {
  it('focuses its close control, closes by button and Escape, and restores focus', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    const close = view.getByRole('button', { name: '关闭原图预览' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('tolerates a focus owner it cannot restore (no active element at mount)', () => {
    // jsdom always reports body as the fallback active element; stub the
    // element-less state a detached focus can leave.
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => null })
    try {
      const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} />)
      view.unmount()
    } finally {
      delete (document as { activeElement?: unknown }).activeElement
    }
  })


  it('renders one labeled control per supplied action and invokes it on click', () => {
    const actions = { labels: { copy: '复制图片', download: '下载', saveAs: '另存为…' }, copy: vi.fn(), download: vi.fn() }
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} actions={actions} />)
    fireEvent.click(view.getByRole('button', { name: '复制图片' }))
    fireEvent.click(view.getByRole('button', { name: '下载' }))
    expect(actions.copy).toHaveBeenCalledOnce()
    expect(actions.download).toHaveBeenCalledOnce()
    // No saveAs callback: no third control, and the close control stays the only other button.
    expect(view.queryByRole('button', { name: '另存为…' })).toBeNull()
    view.unmount()
  })

  it('offers the save-as control only through its callback', () => {
    const saveAs = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()}
      actions={{ labels: { copy: '复制图片', download: '下载', saveAs: '另存为…' }, saveAs }} />)
    fireEvent.click(view.getByRole('button', { name: '另存为…' }))
    expect(saveAs).toHaveBeenCalledOnce()
    expect(view.queryByRole('button', { name: '复制图片' })).toBeNull()
  })

  it('renders no toolbar without actions', () => {
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} />)
    expect(view.queryByRole('toolbar')).toBeNull()
  })

  it('closes on a mask press but not on a press over the image', () => {
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    fireEvent.mouseDown(view.getByRole('img'))
    expect(onClose).not.toHaveBeenCalled()
    const mask = document.querySelector('[aria-hidden="true"]') as HTMLElement
    fireEvent.mouseDown(mask)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

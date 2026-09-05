// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { WorkbenchPreview } from '../src/client/WorkbenchPreview.tsx'
import type { WorkspaceWorkbenchProps } from '../src/client/contract/slots.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const t: WorkspaceWorkbenchProps['t'] = makeTranslate(zh, commonZh)
const htmlTab = { id: 'page', path: 'page.html', title: 'page.html', kind: 'html' as const, loading: false, content: '<h1>frame body</h1>' }

function previewProps(overrides: Partial<Parameters<typeof WorkbenchPreview>[0]> = {}) {
  return {
    tabs: [htmlTab],
    activeTabId: 'page',
    open: true,
    placement: 'in-column' as const,
    t,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  }
}

const frameKeyDown = (frame: HTMLIFrameElement, key: string, shiftKey = false): boolean => {
  const contentWindow = frame.contentWindow
  if (contentWindow === null) throw new Error('frame content window missing')
  return contentWindow.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, cancelable: true }))
}

describe('WorkbenchPreview frame focus fence', () => {
  it('dismisses on frame Escape and cycles panel focus with Tab in both directions', () => {
    const onDismiss = vi.fn()
    const view = render(<WorkbenchPreview {...previewProps({ onDismiss })} />)
    const panel = view.getByRole('region', { name: '工作区文件预览' })
    const frame = view.container.querySelector('iframe[title="page.html"]') as HTMLIFrameElement
    fireEvent.load(frame)

    expect(frameKeyDown(frame, 'a')).toBe(true)
    expect(onDismiss).not.toHaveBeenCalled()

    const hidden = document.createElement('button')
    hidden.type = 'button'
    hidden.style.display = 'none'
    panel.append(hidden)

    const tabButton = within(panel).getByRole('tab', { name: 'page.html' })
    const closeButton = within(panel).getByRole('button', { name: '关闭文件预览' })
    expect(frameKeyDown(frame, 'Tab')).toBe(false)
    expect(document.activeElement).toBe(tabButton)
    expect(frameKeyDown(frame, 'Tab', true)).toBe(false)
    expect(document.activeElement).toBe(closeButton)
    expect(hidden).toBeTruthy()

    fireEvent.load(frame)
    expect(frameKeyDown(frame, 'Escape')).toBe(false)
    expect(onDismiss).toHaveBeenCalledOnce()

    frame.style.display = 'none'
    expect(frameKeyDown(frame, 'Tab')).toBe(true)
    expect(document.activeElement).toBe(closeButton)
    frame.style.display = ''

    panel.removeAttribute('data-preview-host')
    expect(frameKeyDown(frame, 'Tab')).toBe(true)
    expect(document.activeElement).toBe(closeButton)
    panel.setAttribute('data-preview-host', '')

    document.body.append(frame)
    fireEvent.load(frame)

    view.unmount()
    frameKeyDown(frame, 'Escape')
    expect(onDismiss).toHaveBeenCalledOnce()
    frame.remove()
  })

  it('ignores frame keys for overlay placement, closed previews, and opaque or missing content windows', () => {
    const onDismiss = vi.fn()
    const view = render(<WorkbenchPreview {...previewProps({ onDismiss, placement: 'overlay' })} />)
    const frame = view.container.querySelector('iframe[title="page.html"]') as HTMLIFrameElement
    fireEvent.load(frame)
    expect(frameKeyDown(frame, 'Tab')).toBe(true)
    expect(frameKeyDown(frame, 'Escape')).toBe(false)
    expect(onDismiss).toHaveBeenCalledOnce()

    view.rerender(<WorkbenchPreview {...previewProps({ onDismiss, placement: 'overlay', open: false })} />)
    fireEvent.load(frame)
    view.unmount()

    const contentWindowGetter = vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get')
    const binding = render(<WorkbenchPreview {...previewProps({ onDismiss })} />)
    const boundFrame = binding.container.querySelector('iframe[title="page.html"]') as HTMLIFrameElement
    contentWindowGetter.mockReturnValue(null)
    fireEvent.load(boundFrame)

    contentWindowGetter.mockReturnValue({
      addEventListener() { throw new Error('opaque frame') },
    } as unknown as Window)
    fireEvent.load(boundFrame)
    expect(onDismiss).toHaveBeenCalledOnce()
    binding.unmount()
  })

  it('binds pdf frame keys after the object URL resolves', async () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:manual'), revokeObjectURL: vi.fn() })
    const onDismiss = vi.fn()
    const pdfTab = {
      id: 'manual', path: 'manual.pdf', title: 'manual.pdf', kind: 'pdf' as const, loading: false,
      dataBase64: 'AA==', mediaType: 'application/pdf',
    }
    const view = render(<WorkbenchPreview {...previewProps({ tabs: [pdfTab], activeTabId: 'manual', onDismiss })} />)
    const frame = await waitFor(() => {
      const element = view.container.querySelector('iframe[title="manual.pdf"]') as HTMLIFrameElement
      expect(element.getAttribute('src')).toBe('blob:manual')
      return element
    })
    fireEvent.load(frame)
    expect(frameKeyDown(frame, 'Escape')).toBe(false)
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})

describe('WorkbenchPreview focus management', () => {
  it('focuses the panel itself when no tab or focusable element exists and ignores non-Escape keys', async () => {
    const onDismiss = vi.fn()
    const view = render(<WorkbenchPreview {...previewProps({ tabs: [], activeTabId: null, onDismiss })} />)
    const panel = view.getByRole('region', { name: '工作区文件预览' })
    await waitFor(() => { expect(document.activeElement).toBe(panel) })

    fireEvent.keyDown(window, { key: 'a' })
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('keeps a hidden opener for a later placement instead of stealing focus', async () => {
    const opener = document.createElement('button')
    opener.type = 'button'
    opener.dataset.workbenchFocusPath = 'docs/page.html'
    opener.hidden = true
    document.body.append(opener)

    const view = render(
      <WorkbenchPreview {...previewProps({ placement: 'overlay', focusReturnPath: 'docs/page.html' })} />,
    )
    await waitFor(() => { expect(view.getByRole('region', { name: '工作区文件预览' })).toBeTruthy() })
    view.rerender(
      <WorkbenchPreview {...previewProps({ placement: 'overlay', focusReturnPath: 'docs/page.html', open: false })} />,
    )
    await waitFor(() => { expect(view.container.querySelector('[inert]')).toBeTruthy() })
    expect(document.activeElement).not.toBe(opener)
    view.unmount()

    opener.hidden = false
    opener.style.display = 'none'
    const second = render(
      <WorkbenchPreview {...previewProps({ placement: 'overlay', focusReturnPath: 'docs/page.html' })} />,
    )
    await waitFor(() => { expect(second.getByRole('region', { name: '工作区文件预览' })).toBeTruthy() })
    second.rerender(
      <WorkbenchPreview {...previewProps({ placement: 'overlay', focusReturnPath: 'docs/page.html', open: false })} />,
    )
    expect(document.activeElement).not.toBe(opener)
    second.unmount()
    opener.remove()
  })

  it('leaves focus alone when no restore target exists and focus sits outside the panel', async () => {
    const outside = document.createElement('button')
    outside.type = 'button'
    document.body.append(outside)

    const activeElementDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement')
    expect(activeElementDescriptor).toBeDefined()
    Object.defineProperty(document, 'activeElement', { ...activeElementDescriptor!, get: () => null, configurable: true })
    const view = render(
      <WorkbenchPreview {...previewProps({ placement: 'overlay', focusReturnPath: 'ghost' })} />,
    )
    delete (document as { activeElement?: unknown }).activeElement

    await waitFor(() => { expect(view.getByRole('region', { name: '工作区文件预览' })).toBeTruthy() })
    outside.focus()
    view.rerender(
      <WorkbenchPreview {...previewProps({ placement: 'overlay', focusReturnPath: 'ghost', open: false })} />,
    )
    await waitFor(() => { expect(view.container.querySelector('[inert]')).toBeTruthy() })
    expect(document.activeElement).toBe(outside)
    view.unmount()
    outside.remove()
  })
})

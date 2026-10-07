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

describe('WorkbenchPreview encoding surface', () => {
  const gbkTab = {
    id: 'file:a/legacy.txt', path: 'a/legacy.txt', title: 'legacy.txt', kind: 'code' as const, loading: false,
    content: '第一行\n', encoding: 'gb18030', encodingSource: 'host' as const, bom: false, eol: 'LF' as const,
  }

  it('shows a text encoding label with BOM and eol facts, not only color', () => {
    const view = render(<WorkbenchPreview {...previewProps({ tabs: [gbkTab], activeTabId: 'file:a/legacy.txt' })} />)
    expect(view.getByText(/gb18030/)).toBeTruthy()
    expect(view.getByText(/LF/)).toBeTruthy()
  })

  it('appends the BOM fact to the encoding label only for a BOM file', () => {
    const view = render(<WorkbenchPreview {...previewProps({ tabs: [gbkTab], activeTabId: 'file:a/legacy.txt' })} />)
    expect(view.queryByText(/BOM/)).toBeNull()
    view.rerender(
      <WorkbenchPreview {...previewProps({ tabs: [{ ...gbkTab, encoding: 'utf-8', bom: true }], activeTabId: 'file:a/legacy.txt' })} />,
    )
    expect(view.getByText(/utf-8 · BOM · LF/)).toBeTruthy()
  })

  it('offers reopen-with-encoding and forwards the selected encoding', () => {
    const onReopenEncoding = vi.fn()
    const view = render(
      <WorkbenchPreview
        {...previewProps({ tabs: [gbkTab], activeTabId: 'file:a/legacy.txt' })}
        onReopenEncoding={onReopenEncoding}
      />,
    )
    const select = view.getByRole('combobox', { name: '以指定编码重新打开' }) as HTMLSelectElement
    expect(select.value).toBe('')
    fireEvent.change(select, { target: { value: 'big5' } })
    expect(onReopenEncoding).toHaveBeenCalledWith('a/legacy.txt', 'big5')
    fireEvent.change(select, { target: { value: '' } })
    expect(onReopenEncoding).toHaveBeenLastCalledWith('a/legacy.txt', undefined)
  })

  it('keeps the explicit selection marked after reopening explicitly', () => {
    const explicitTab = { ...gbkTab, encoding: 'big5', encodingSource: 'explicit' as const }
    const view = render(
      <WorkbenchPreview
        {...previewProps({ tabs: [explicitTab], activeTabId: 'file:a/legacy.txt' })}
        onReopenEncoding={vi.fn()}
      />,
    )
    const select = view.getByRole('combobox', { name: '以指定编码重新打开' }) as HTMLSelectElement
    expect(select.value).toBe('big5')
  })

  it('hides the selector when no reopen callback is provided', () => {
    const view = render(<WorkbenchPreview {...previewProps({ tabs: [gbkTab], activeTabId: 'file:a/legacy.txt' })} />)
    expect(view.queryByRole('combobox')).toBeNull()
  })
})

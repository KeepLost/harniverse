// @vitest-environment jsdom
/**
 * The section's presentation behavior: load states, the monospace editor
 * with byte accounting against the host cap, dirty tracking with save and
 * revert, the version-echo write contract, conflict notice with reload,
 * the over-cap guard (multibyte-safe), and failure paths — everything
 * through plain props and a stubbed wire face.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatBytes, GlobalRulesSection } from '../src/client/GlobalRulesSection.tsx'
import type { GlobalRulesSectionProps, GlobalRulesSectionInjected } from '../src/client/GlobalRulesSection.tsx'
import { NavIcon } from '../src/client/NavIcon.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

type Translate = GlobalRulesSectionProps['t']

/** Build a translator over the shipped Chinese dictionary. */
function tzh(): Translate {
  return ((key: keyof typeof zh, params?: Record<string, unknown>) => {
    let text: string = zh[key]
    for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
    return text
  }) as Translate
}

/** Mutable wire face the tests shape per case. */
type ApiFace = GlobalRulesSectionInjected['api']
type ApiStub = ApiFace & {
  readonly readMock: ApiFace['read']
  readonly writeMock: ApiFace['write']
}

function stubApi(view: {
  exists: boolean
  content: string
  version?: string
  displayPath?: string
  maxBytes?: number
}): ApiStub {
  const readMock = vi.fn(async () => ({
    rpcId: RpcId('r'),
    result: {
      ok: true as const,
      value: {
        exists: view.exists,
        content: view.content,
        ...(view.version === undefined ? {} : { version: view.version }),
        displayPath: view.displayPath ?? '~/.dsh/AGENTS.md',
        maxBytes: view.maxBytes ?? 1_048_576,
      },
    },
  }))
  const writeMock = vi.fn(async () => ({ rpcId: RpcId('w'), result: { ok: true as const, value: { version: 'ff'.repeat(16) } } }))
  return {
    readMock,
    writeMock,
    read: readMock,
    write: writeMock,
  }
}

/** Props with only the shares the section reads. */
function propsOf(api: GlobalRulesSectionInjected['api']): GlobalRulesSectionProps {
  return { t: tzh(), api } as GlobalRulesSectionProps
}

/** The editor textarea, once loaded. */
async function editor(): Promise<HTMLTextAreaElement> {
  return await screen.findByLabelText(zh.editorLabel)
}

/** The primary Save button. */
function saveButton(): HTMLButtonElement {
  return screen.getAllByRole('button').find(button => button.textContent === zh.save) as HTMLButtonElement
}

describe('GlobalRulesSection', () => {
  it('renders the loaded content with the symbolic path and byte counter', async () => {
    const api = stubApi({ exists: true, content: '# hi', version: 'ab'.repeat(16) })
    render(<GlobalRulesSection {...propsOf(api)} />)
    const editorElement = await editor()
    expect(editorElement.value).toBe('# hi')
    expect(screen.getByText(zh.intro.replace('{path}', '~/.dsh/AGENTS.md'))).toBeTruthy()
    expect(screen.getByText(zh.bytes.replace('{used}', '4 B').replace('{max}', '1.0 MiB'))).toBeTruthy()
    expect(screen.queryByText(zh.notExists)).toBeNull()
  })

  it('hints at creation when the file is absent', async () => {
    const api = stubApi({ exists: false, content: '' })
    render(<GlobalRulesSection {...propsOf(api)} />)
    await editor()
    expect(screen.getByText(zh.notExists)).toBeTruthy()
  })

  it('saves only dirty content and echoes the loaded version token', async () => {
    const api = stubApi({ exists: true, content: 'base', version: 'ab'.repeat(16) })
    render(<GlobalRulesSection {...propsOf(api)} />)
    await editor()
    expect(saveButton().disabled).toBe(true)

    fireEvent.change(await editor(), { target: { value: 'base-edited' } })
    await waitFor(() => { expect(saveButton().disabled).toBe(false) })

    fireEvent.click(saveButton())
    await waitFor(() => { expect(screen.getByText(zh.saved)).toBeTruthy() })
    expect(api.writeMock).toHaveBeenCalledWith({ content: 'base-edited', expectedVersion: 'ab'.repeat(16) })
    // The accepted save clears the dirty flag: saving again is disabled.
    await waitFor(() => { expect(saveButton().disabled).toBe(true) })
    // Editing again retires the saved notice.
    fireEvent.change(await editor(), { target: { value: 'base-edited-again' } })
    await waitFor(() => { expect(screen.queryByText(zh.saved)).toBeNull() })
  })

  it('omits the expected version when the file was absent at load', async () => {
    const api = stubApi({ exists: false, content: '' })
    render(<GlobalRulesSection {...propsOf(api)} />)
    fireEvent.change(await editor(), { target: { value: 'first' } })
    fireEvent.click(saveButton())
    await waitFor(() => { expect(screen.getByText(zh.saved)).toBeTruthy() })
    expect(api.writeMock).toHaveBeenCalledWith({ content: 'first' })
  })

  it('reports a conflict and reloads on request', async () => {
    const api = stubApi({ exists: true, content: 'base', version: 'ab'.repeat(16) })
    const conflicting: ApiStub['write'] = async () => ({
      rpcId: RpcId('w'),
      result: { ok: false as const, error: { code: 'global-rules-conflict', message: 'changed', details: {} } },
    })
    api.write = conflicting
    render(<GlobalRulesSection {...propsOf(api)} />)
    fireEvent.change(await editor(), { target: { value: 'mine' } })
    fireEvent.click(saveButton())
    await waitFor(() => { expect(screen.getByText(zh.conflict)).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: zh.reload }))
    const editorElement = await editor()
    await waitFor(() => { expect(editorElement.value).toBe('base') })
    expect(api.readMock).toHaveBeenCalledTimes(2)
  })

  it('disables saving over the cap with multibyte byte accounting', async () => {
    // 三个汉字是 nine UTF-8 bytes over a cap of nine (三个字符九字节压线).
    const api = stubApi({ exists: true, content: '一二三', version: 'ab'.repeat(16), maxBytes: 9 })
    render(<GlobalRulesSection {...propsOf(api)} />)
    await editor()
    expect(screen.getByText(zh.bytes.replace('{used}', '9 B').replace('{max}', '9 B'))).toBeTruthy()

    // An equal-length replacement stays inside the cap and stays savable.
    fireEvent.change(await editor(), { target: { value: '四五六' } })
    await waitFor(() => { expect(saveButton().disabled).toBe(false) })

    fireEvent.change(await editor(), { target: { value: '一二三四' } })
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(zh.overCap.replace('{used}', '12 B').replace('{max}', '9 B'))
    })
    expect(saveButton().disabled).toBe(true)
    expect(api.writeMock).not.toHaveBeenCalled()
  })

  it('reverts the draft to the loaded content', async () => {
    const api = stubApi({ exists: true, content: 'base', version: 'ab'.repeat(16) })
    render(<GlobalRulesSection {...propsOf(api)} />)
    fireEvent.change(await editor(), { target: { value: 'scratch' } })
    fireEvent.click(screen.getByRole('button', { name: zh.revert }))
    const editorElement = await editor()
    expect(editorElement.value).toBe('base')
    expect(saveButton().disabled).toBe(true)
  })

  it('shows a thrown read failure with a retry that recovers', async () => {
    const api = stubApi({ exists: true, content: 'late' })
    const throwing: ApiStub['read'] = async () => { throw new Error('EISDIR') }
    api.read = throwing
    render(<GlobalRulesSection {...propsOf(api)} />)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('EISDIR') })

    api.read = api.readMock
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    const editorElement = await editor()
    await waitFor(() => { expect(editorElement.value).toBe('late') })
  })

  it('falls back to the generic read notice for an empty non-Error rejection', async () => {
    const api = stubApi({ exists: true, content: 'never' })
    const throwing: ApiStub['read'] = async () => { throw '' }
    api.read = throwing
    render(<GlobalRulesSection {...propsOf(api)} />)
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(zh.loadFailed.replace('{message}', zh.unknownError))
    })
  })

  it('localizes seam absence on load', async () => {
    const unavailable = stubApi({ exists: false, content: '' })
    const refusing: ApiStub['read'] = async () => ({
      rpcId: RpcId('r'),
      result: { ok: false as const, error: { code: 'global-rules-unavailable', message: 'no seam', details: {} } },
    })
    unavailable.read = refusing
    render(<GlobalRulesSection {...propsOf(unavailable)} />)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(zh.unavailable) })
  })

  it('shows the raw message for a non-unavailable read refusal', async () => {
    const api = stubApi({ exists: true, content: 'never' })
    api.read = vi.fn(async () => ({
      rpcId: RpcId('r'),
      result: { ok: false as const, error: { code: 'global-rules-read-failed', message: 'EISDIR' } },
    })) as unknown as ApiStub['read']
    render(<GlobalRulesSection {...propsOf(api)} />)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.loadFailed.replace('{message}', 'EISDIR')) })
  })

  it('reports a refused write through the server message', async () => {
    const refused = stubApi({ exists: true, content: 'base', version: 'ab'.repeat(16) })
    const rejecting: ApiStub['write'] = async () => ({
      rpcId: RpcId('w'),
      result: { ok: false as const, error: { code: 'global-rules-too-large', message: 'over the cap', details: { maxBytes: 1024 } } },
    })
    refused.write = rejecting
    render(<GlobalRulesSection {...propsOf(refused)} />)
    fireEvent.change(await editor(), { target: { value: 'x' } })
    fireEvent.click(saveButton())
    await waitFor(() => { expect(screen.getByText(zh.saveFailed.replace('{message}', 'over the cap'))).toBeTruthy() })
  })

  it('reports a thrown write rejection, Error or not', async () => {
    const api = stubApi({ exists: true, content: 'base', version: 'ab'.repeat(16) })
    const throwing: ApiStub['write'] = async () => { throw new Error('network down') }
    api.write = throwing
    render(<GlobalRulesSection {...propsOf(api)} />)
    fireEvent.change(await editor(), { target: { value: 'x' } })
    fireEvent.click(saveButton())
    await waitFor(() => { expect(screen.getByText(zh.saveFailed.replace('{message}', 'network down'))).toBeTruthy() })
  })

  it('falls back to the generic save notice for an empty server message', async () => {
    const api = stubApi({ exists: true, content: 'base', version: 'ab'.repeat(16) })
    const emptyMessage: ApiStub['write'] = async () => ({
      rpcId: RpcId('w'),
      result: { ok: false as const, error: { code: 'global-rules-write-failed', message: '', details: {} } },
    })
    api.write = emptyMessage
    render(<GlobalRulesSection {...propsOf(api)} />)
    fireEvent.change(await editor(), { target: { value: 'x' } })
    fireEvent.click(saveButton())
    await waitFor(() => { expect(screen.getByText(zh.saveFailed.replace('{message}', zh.unknownError))).toBeTruthy() })
  })

  it('stringifies a non-Error write rejection', async () => {
    const nonError = stubApi({ exists: true, content: 'base', version: 'ab'.repeat(16) })
    const plainRejection: ApiStub['write'] = async () => { throw 'plain rejection' }
    nonError.write = plainRejection
    render(<GlobalRulesSection {...propsOf(nonError)} />)
    fireEvent.change(await editor(), { target: { value: 'x' } })
    fireEvent.click(saveButton())
    await waitFor(() => { expect(screen.getByText(zh.saveFailed.replace('{message}', 'plain rejection'))).toBeTruthy() })
  })
})

describe('NavIcon', () => {
  it('renders the section glyph', () => {
    const { container } = render(<NavIcon />)
    expect(container.querySelector('svg')).toBeTruthy()
  })
})

describe('formatBytes', () => {
  it('walks the binary unit ladder', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1_048_576)).toBe('1.0 MiB')
  })
})

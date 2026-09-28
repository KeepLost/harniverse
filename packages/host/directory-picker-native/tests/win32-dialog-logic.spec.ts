/**
 * The COM conversation's sequencing against fake bindings: outcome mapping
 * (selection / cancellation / HRESULT failures at every step), folder and
 * file modes, and the release-on-every-path guarantee, all
 * platform-independent.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_PICKFOLDERS, HRESULT_CANCELLED,
  runPickDialog, type Win32DialogBindings, type Win32PickDialog, type Win32DialogSelection,
} from '../src/win32-dialog-logic.ts'

const E_FAIL = 0x80004005 | 0

interface FakeWorld {
  bindings: Win32DialogBindings
  dpi: ReturnType<typeof vi.fn>
  createDialog: ReturnType<typeof vi.fn>
  uninitialize: ReturnType<typeof vi.fn>
  dialog: {
    setOptions: ReturnType<typeof vi.fn>
    setTitle: ReturnType<typeof vi.fn>
    setDefaultFolder: ReturnType<typeof vi.fn>
    show: ReturnType<typeof vi.fn>
    resultPath: ReturnType<typeof vi.fn>
    release: ReturnType<typeof vi.fn>
  }
}

function world(overrides: Partial<Win32PickDialog> = {}, coInit = 0): FakeWorld {
  const dialog = {
    setOptions: vi.fn(() => 0),
    setTitle: vi.fn(() => 0),
    setDefaultFolder: vi.fn(() => 0),
    show: vi.fn(() => 0),
    resultPath: vi.fn(() => ({ hr: 0, path: 'C:\\picked\\目录' })),
    release: vi.fn(),
    ...overrides,
  }
  const dpi = vi.fn()
  const createDialog = vi.fn(() => dialog)
  const uninitialize = vi.fn()
  const bindings: Win32DialogBindings = {
    setThreadDpiAwareness: dpi,
    coInitializeSta: vi.fn(() => coInit),
    coUninitialize: uninitialize,
    createPickDialog: createDialog,
    currentThreadId: vi.fn(() => 4242),
  }
  return { bindings, dpi, createDialog, uninitialize, dialog: dialog as FakeWorld['dialog'] }
}

const folder: Win32DialogSelection = { title: 'Pick', mode: 'directory' }
const file: Win32DialogSelection = { title: 'Pick', mode: 'file', defaultDirectory: 'C:\\Users\\me\\.ssh' }

describe('runPickDialog', () => {
  it('sequences DPI, STA, options, title, show, result extraction, and apartment teardown', () => {
    const { bindings, dpi, dialog, uninitialize } = world()
    const showing = vi.fn()
    expect(runPickDialog(bindings, folder, showing)).toBe('C:\\picked\\目录')
    expect(dpi).toHaveBeenCalledOnce()
    expect(uninitialize).toHaveBeenCalledOnce()
    expect(dialog.release.mock.invocationCallOrder[0]).toBeLessThan(uninitialize.mock.invocationCallOrder[0] as number)
    expect(dialog.setOptions).toHaveBeenCalledWith(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR)
    expect(dialog.setTitle).toHaveBeenCalledWith('Pick')
    expect(showing).toHaveBeenCalledWith(4242)
    expect(showing.mock.invocationCallOrder[0]).toBeLessThan(dialog.show.mock.invocationCallOrder[0] as number)
    expect(dialog.release).toHaveBeenCalledOnce()
  })

  it('drops FOS_PICKFOLDERS for file mode and seeds the requested start directory', () => {
    const { bindings, dialog } = world()
    expect(runPickDialog(bindings, file, vi.fn())).toBe('C:\\picked\\目录')
    expect(dialog.setOptions).toHaveBeenCalledWith(FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR)
    expect(dialog.setDefaultFolder).toHaveBeenCalledWith('C:\\Users\\me\\.ssh')
  })

  it('keeps the pick alive when the default directory has no shell item', () => {
    const { bindings, dialog } = world({ setDefaultFolder: vi.fn(() => E_FAIL) })
    expect(runPickDialog(bindings, file, vi.fn())).toBe('C:\\picked\\目录')
    expect(dialog.setDefaultFolder).toHaveBeenCalledOnce()
    expect(dialog.show).toHaveBeenCalledOnce()
  })

  it('skips SetDefaultFolder entirely when no start directory was requested', () => {
    const { bindings, dialog } = world()
    expect(runPickDialog(bindings, { title: 'Pick', mode: 'file' }, vi.fn())).toBe('C:\\picked\\目录')
    expect(dialog.setDefaultFolder).not.toHaveBeenCalled()
  })

  it('maps the cancelled HRESULT to null and still releases the dialog and apartment', () => {
    const { bindings, dialog, uninitialize } = world({ show: vi.fn(() => HRESULT_CANCELLED) })
    expect(runPickDialog(bindings, folder, vi.fn())).toBeNull()
    expect(dialog.resultPath).not.toHaveBeenCalled()
    expect(dialog.release).toHaveBeenCalledOnce()
    expect(uninitialize).toHaveBeenCalledOnce()
  })

  it('accepts the S_FALSE re-entry HRESULT from CoInitializeEx', () => {
    const { bindings } = world({}, 1)
    expect(runPickDialog(bindings, folder, vi.fn())).toBe('C:\\picked\\目录')
  })

  it('throws on a failing CoInitializeEx without creating a dialog or uninitializing', () => {
    const { bindings, createDialog, uninitialize } = world({}, E_FAIL)
    expect(() => runPickDialog(bindings, folder, vi.fn())).toThrow('CoInitializeEx failed: HRESULT 0x80004005')
    expect(createDialog).not.toHaveBeenCalled()
    // A failed CoInitializeEx must NOT be paired with CoUninitialize.
    expect(uninitialize).not.toHaveBeenCalled()
  })

  it.each([
    ['SetOptions', { setOptions: vi.fn(() => E_FAIL) }],
    ['SetTitle', { setTitle: vi.fn(() => E_FAIL) }],
    ['Show', { show: vi.fn(() => E_FAIL) }],
    ['GetResult', { resultPath: vi.fn(() => ({ hr: E_FAIL })) }],
  ] satisfies [string, Partial<Win32PickDialog>][])('releases the dialog and apartment when %s fails', (what, overrides) => {
    const { bindings, dialog, uninitialize } = world(overrides)
    expect(() => runPickDialog(bindings, folder, vi.fn())).toThrow(`${what} failed: HRESULT 0x80004005`)
    expect(dialog.release).toHaveBeenCalledOnce()
    expect(uninitialize).toHaveBeenCalledOnce()
  })
})

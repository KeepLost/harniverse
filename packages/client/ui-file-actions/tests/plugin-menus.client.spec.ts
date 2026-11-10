// @vitest-environment jsdom
/** File-operation contributions survive removal of application-opening providers. */
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { MenuRegistry } from '@deepseek-ai/dsh-client-ui-context-menu/src/client/registry.ts'
import { apply, inject } from '../src/client/index.ts'
import type { FileActionSource } from '../src/types.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('contributes file and image operations through the workspace-keyed face and withdraws them on unload', async () => {
  const failure = vi.fn(), notify = vi.fn()
  const registry = new MenuRegistry(failure)
  onTestFinished(() => { registry.dispose() })
  const registered: string[] = []
  const iconKeys: string[] = []
  const statFile = vi.fn(async () => ({ absolutePath: '/workspace/image.png', version: '1', bytes: 3 }))
  const readFileBytes = vi.fn(async () => ({
    path: 'report.txt', offset: 0, dataBase64: btoa(String.fromCharCode(1, 2, 3)), bytes: 3, eof: true,
  }))
  const ctx = new Context()
  ctx.provide('locale', { register: (ns: string) => { registered.push(ns); return () => {} }, bind: () => (key: string) => key } as never)
  ctx.provide('contextMenus', { register: registry.register.bind(registry), notify } as never)
  ctx.provide('slots', {
    inject: (_name: string, register: Parameters<SlotRegistry['inject']>[1]) => ctx.effect(register),
    register: (entry: { options?: { key?: string } } | { name: string; key: string }, _icon: unknown) => {
      const key = 'options' in entry ? entry.options?.key : (entry as { name: string; key: string }).key
      if (key !== undefined) iconKeys.push(key)
      return () => {}
    },
  } as never)
  ctx.provide('workspaces', {
    list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', sessionIds: [SessionId('files')] }] }) },
    statFile, readFileBytes,
  } as never)
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  try {
    expect(registered).toEqual(['fileActions'])
    expect(iconKeys).toEqual(['file-actions.copy', 'file-actions.download', 'file-actions.save'])
    const file = registry.resolve({ kind: 'file', value: { sessionId: SessionId('files'), path: 'image.png' } })
    await file.ready
    expect(file.source.getSnapshot().map(action => action.id)).toEqual([
      'file-actions.file/copyImage', 'file-actions.file/download',
    ])
    expect(file.source.getSnapshot().find(action => action.id.endsWith('/download'))?.disabled).toBe(false)
    expect(statFile).toHaveBeenCalledExactlyOnceWith('w1', 'image.png', expect.any(AbortSignal))
    // A session no workspace accounts for keeps its rows but disables them without a stat call.
    const orphan = registry.resolve({ kind: 'file', value: { sessionId: SessionId('orphan'), path: 'image.png' } })
    await orphan.ready
    expect(orphan.source.getSnapshot().map(action => action.disabled)).toEqual([true, true])
    expect(statFile).toHaveBeenCalledOnce()
    const save = vi.spyOn(fiber.ctx.get('fileActions')!, 'save').mockImplementation(async (source: FileActionSource) => {
      await source.read!(new AbortController().signal)
      return { status: 'requested' }
    })
    const downloading = registry.resolve({ kind: 'file', value: { sessionId: SessionId('files'), path: 'report.txt' } })
    await downloading.ready
    expect(downloading.source.getSnapshot().map(action => action.id)).toEqual(['file-actions.file/download'])
    downloading.select('file-actions.file/download')
    await vi.waitFor(() => { expect(notify).toHaveBeenCalledWith('menu.downloadStarted', true) })
    expect(save).toHaveBeenCalledOnce()
    expect(readFileBytes).toHaveBeenCalledExactlyOnceWith('w1', 'report.txt', {}, expect.any(AbortSignal))
    save.mockRestore()
    // Stat failure keeps rows but disables them; the read carrier stays attached.
    statFile.mockRejectedValueOnce(new Error('stat failed'))
    const unreadable = registry.resolve({ kind: 'file', value: { sessionId: SessionId('files'), path: 'gone.png' } })
    await unreadable.ready
    expect(unreadable.source.getSnapshot().map(action => action.disabled)).toEqual([true, true])
    unreadable.dispose()
    // A backslash-separated name still resolves to its basename.
    const windows = registry.resolve({ kind: 'file', value: { sessionId: SessionId('files'), path: 'dir\\image.png' } })
    await windows.ready
    expect(windows.source.getSnapshot().length).toBe(2)
    windows.dispose()
    const image = registry.resolve({ kind: 'image', value: { url: 'https://example.com/image.png' } })
    await image.ready
    expect(image.source.getSnapshot().map(action => action.id)).toEqual([
      'file-actions.image/copy', 'file-actions.image/download',
    ])
    const copiedImage = vi.spyOn(fiber.ctx.get('fileActions')!, 'copyImage').mockResolvedValue(undefined)
    image.select('file-actions.image/copy')
    await vi.waitFor(() => { expect(notify).toHaveBeenCalledWith('menu.copied', true) })
    // The file menu's copy-image row (an image file target) routes to the same command.
    const fileCopy = registry.resolve({ kind: 'file', value: { sessionId: SessionId('files'), path: 'photo.png' } })
    await fileCopy.ready
    fileCopy.select('file-actions.file/copyImage')
    await vi.waitFor(() => { expect(copiedImage).toHaveBeenCalledTimes(2) })
    copiedImage.mockRestore()
    fileCopy.dispose()
    // An extensionless original reads through the byte window with no media type.
    const bare = registry.resolve({ kind: 'file', value: { sessionId: SessionId('files'), path: 'LICENSE' } })
    await bare.ready
    const bareSave = vi.spyOn(fiber.ctx.get('fileActions')!, 'save').mockImplementation(async (source: FileActionSource) => {
      const blob = await source.read!(new AbortController().signal)
      expect(blob.type).toBe('')
      return { status: 'cancelled' }
    })
    bare.select('file-actions.file/download')
    await vi.waitFor(() => { expect(bareSave).toHaveBeenCalledOnce() })
    expect(notify).toHaveBeenCalledTimes(3)
    bareSave.mockRestore()
    bare.dispose()
    await fiber.dispose()
    expect(file.source.getSnapshot()).toEqual([])
    expect(image.source.getSnapshot()).toEqual([])
    file.dispose()
    image.dispose()
    orphan.dispose()
    expect(failure).not.toHaveBeenCalled()
  } finally {
    await fiber.dispose()
  }
})

it('offers native save rows and completion notices through the Desktop adapter', async () => {
  vi.stubGlobal('harniverseFileActions', {
    save: async () => ({ status: 'saved' as const, path: '/workspace/report.txt' }),
    readClipboardImage: async () => { throw new Error('unused') },
  })
  const failure = vi.fn(), notify = vi.fn()
  const registry = new MenuRegistry(failure)
  onTestFinished(() => { registry.dispose() })
  const ctx = new Context()
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key } as never)
  ctx.provide('contextMenus', { register: registry.register.bind(registry), notify } as never)
  ctx.provide('slots', {
    inject: (_name: string, register: Parameters<SlotRegistry['inject']>[1]) => ctx.effect(register),
    register: () => () => {},
  } as never)
  ctx.provide('workspaces', {
    list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', sessionIds: [SessionId('files')] }] }) },
    statFile: async () => ({ absolutePath: '/workspace/report.txt', version: '1', bytes: 3 }),
    readFileBytes: async () => ({ path: 'report.txt', offset: 0, dataBase64: '', bytes: 0, eof: true }),
  } as never)
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  try {
    expect(fiber.ctx.get('fileActions')?.canSaveAs).toBe(true)
    const file = registry.resolve({ kind: 'file', value: { sessionId: SessionId('files'), path: 'report.txt' } })
    await file.ready
    // Desktop replaces the browser download row with its native save picker for
    // non-image originals; images keep both.
    expect(file.source.getSnapshot().map(action => action.id)).toEqual(['file-actions.file/saveAs'])
    file.select('file-actions.file/saveAs')
    await vi.waitFor(() => { expect(notify).toHaveBeenCalledWith('menu.saved', true) })
    // An attached image with a session-backed path carries the authorized read carrier.
    const attached = registry.resolve({
      kind: 'image', value: { sessionId: SessionId('files'), path: 'shot.bmp', url: 'dsh-app://shot.bmp' },
    })
    await attached.ready
    expect(attached.source.getSnapshot().map(action => action.id)).toEqual([
      'file-actions.image/copy', 'file-actions.image/download', 'file-actions.image/saveAs',
    ])
    attached.select('file-actions.image/download')
    await vi.waitFor(() => { expect(notify).toHaveBeenCalledWith('menu.downloaded', true) })
    const nativeSave = vi.spyOn(fiber.ctx.get('fileActions')!, 'save').mockResolvedValue({ status: 'saved', path: '/workspace/shot.bmp' })
    const picker = registry.resolve({
      kind: 'image', value: { sessionId: SessionId('files'), path: 'shot.bmp', url: 'dsh-app://shot.bmp' },
    })
    await picker.ready
    picker.select('file-actions.image/saveAs')
    await vi.waitFor(() => { expect(nativeSave).toHaveBeenCalledOnce() })
    nativeSave.mockRestore()
    picker.dispose()
    const named = registry.resolve({
      kind: 'image', value: { url: 'blob:opaque', name: 'avatar', mediaType: 'image/webp' },
    })
    await named.ready
    expect(named.source.getSnapshot().length).toBe(3)
    const bare = registry.resolve({ kind: 'image', value: { url: 'https://example.com/unknown' } })
    await bare.ready
    expect(bare.source.getSnapshot().length).toBe(3)
    // A session-backed path with no derivable media type still attaches the read carrier.
    const extensionless = registry.resolve({
      kind: 'image', value: { sessionId: SessionId('files'), path: 'screenshot', url: 'dsh-app://screenshot' },
    })
    await extensionless.ready
    expect(extensionless.source.getSnapshot().length).toBe(3)
    extensionless.dispose()
    const cancelled = vi.spyOn(fiber.ctx.get('fileActions')!, 'save').mockResolvedValue({ status: 'cancelled' })
    named.select('file-actions.image/download')
    await vi.waitFor(() => { expect(cancelled).toHaveBeenCalledOnce() })
    // saved, downloaded, saved (picker) — the cancelled save stays silent.
    expect(notify).toHaveBeenCalledTimes(3)
    cancelled.mockRestore()
    file.dispose()
    attached.dispose()
    named.dispose()
    bare.dispose()
    expect(failure).not.toHaveBeenCalled()
  } finally {
    await fiber.dispose()
  }
})

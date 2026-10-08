/**
 * Wire and unload-guard unit specs: the Remote binding passes arguments
 * through unchanged, the optional watch binding forwards, and the guard
 * installs nothing in environments without a window.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildWire, installUnloadGuard } from '../src/client/index.ts'
import { createWorkspaceEditorStore } from '../src/client/stores.ts'

describe('buildWire', () => {
  it('forwards open, stat, and save to the typed Remote namespace', async () => {
    const openValue = { content: 'x', version: 'v1', bytes: 1, encoding: 'utf-8', encodingSource: 'utf8' as const, bom: false, eol: 'LF' as const }
    const remote = {
      open: vi.fn(async () => ({ ok: true as const, value: openValue })),
      stat: vi.fn(async () => ({ ok: true as const, value: { version: 'v1' } })),
      save: vi.fn(async () => ({ ok: true as const, value: { version: 'v2' } })),
    }
    const wire = buildWire(remote, undefined)
    const signal = new AbortController().signal
    await wire.open('ws-1', 'a.ts', signal)
    await wire.stat('ws-1', 'a.ts', signal)
    await wire.save('ws-1', 'a.ts', { content: 'x', baseVersion: 'v1', saveId: 's' }, signal)
    expect(remote.open).toHaveBeenCalledWith('ws-1', 'a.ts', signal)
    expect(remote.stat).toHaveBeenCalledWith('ws-1', 'a.ts', signal)
    expect(remote.save).toHaveBeenCalledWith('ws-1', 'a.ts', { content: 'x', baseVersion: 'v1', saveId: 's' }, signal)
    expect(wire.watchFiles).toBeUndefined()
  })

  it('binds the watch feed when the runtime ships one', async () => {
    const frames = [{ kind: 'ready' as const }]
    const watch = vi.fn(async function* (): AsyncGenerator<{ kind: 'ready' }, void, void> {
      yield* frames
    })
    const wire = buildWire({ open: vi.fn(), stat: vi.fn(), save: vi.fn() }, watch)
    const signal = new AbortController().signal
    const seen: string[] = []
    for await (const frame of wire.watchFiles!('ws-1', 'a.ts', signal)) {
      seen.push(frame.kind)
    }
    expect(watch).toHaveBeenCalledWith('ws-1', 'a.ts', signal)
    expect(seen).toEqual(['ready'])
  })
})

describe('installUnloadGuard', () => {
  it('installs nothing outside a browser environment', () => {
    const dispose = installUnloadGuard(createWorkspaceEditorStore())
    expect(typeof dispose).toBe('function')
    dispose()
  })
})

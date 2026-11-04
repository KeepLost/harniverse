import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPORT_CAPACITY_BYTES,
  WorkspaceImageError,
  WorkspaceTarError,
  WorldWorkspace,
  applyWorkspaceDiff,
  assertValidWorkspaceTar,
  buildWorkspaceImage,
  diffWorkspaceTars,
  packWorkspaceTar,
  readWorkspaceImage,
  readWorkspaceTar,
  type WorkspaceEntry,
} from '../src/workspace.ts'

function file(path: string, text: string): WorkspaceEntry {
  return { path, kind: 'file', data: Buffer.from(text) }
}

function fileText(entries: readonly WorkspaceEntry[], path: string): string | undefined {
  const entry = entries.find(entry => entry.path === path)
  return entry?.kind === 'file' ? Buffer.from(entry.data).toString() : undefined
}

function fileBytes(entries: readonly WorkspaceEntry[], path: string): number | undefined {
  const entry = entries.find(entry => entry.path === path)
  return entry?.kind === 'file' ? entry.data.byteLength : undefined
}

describe('workspace tar utilities', () => {
  it('packs and reads back files, directories, and empty files', () => {
    const tar = packWorkspaceTar([
      file('a.txt', 'alpha'),
      file('notes/b.txt', 'beta'),
      { path: 'notes', kind: 'dir' },
      file('empty.txt', ''),
    ])
    const entries = readWorkspaceTar(tar)
    expect(entries.filter(entry => entry.kind === 'file').map(entry => entry.path).sort())
      .toEqual(['a.txt', 'empty.txt', 'notes/b.txt'])
    expect(entries.find(entry => entry.path === 'notes')?.kind).toBe('dir')
    expect(fileText(entries, 'a.txt')).toBe('alpha')
    expect(fileBytes(entries, 'empty.txt')).toBe(0)
  })

  it('adds implicit parent directories for nested files', () => {
    const entries = readWorkspaceTar(packWorkspaceTar([file('a/b/c/d.txt', 'deep')]))
    expect(entries.filter(entry => entry.kind === 'dir').map(entry => entry.path))
      .toEqual(['a', 'a/b', 'a/b/c'])
  })

  it('is byte-deterministic for the same entries in any order', () => {
    const one = packWorkspaceTar([file('x.txt', 'x'), file('y.txt', 'y')])
    const two = packWorkspaceTar([file('y.txt', 'y'), file('x.txt', 'x')])
    expect(one.equals(two)).toBe(true)
  })

  it('splits long paths into the ustar prefix field and reads them back', () => {
    const longDir = 'd'.repeat(90)
    const longName = 'n'.repeat(90)
    const path = `${longDir}/${longName}`
    const entries = readWorkspaceTar(packWorkspaceTar([file(path, 'far')]))
    expect(entries.find(entry => entry.path === path)?.kind).toBe('file')
  })

  it('reads a name that fills its whole 100-byte field without a terminator', () => {
    const exact = 'x'.repeat(100)
    const entries = readWorkspaceTar(packWorkspaceTar([file(exact, 'edge')]))
    expect(fileText(entries, exact)).toBe('edge')
  })

  it('rejects a tar truncated inside the payload of an entry', () => {
    const tar = packWorkspaceTar([file('payload.txt', 'x'.repeat(600))])
    // 512 header + at least 1024 total, but well short of the 600-byte payload.
    expect(() => readWorkspaceTar(tar.subarray(0, 1034))).toThrow('tar truncated inside payload.txt')
  })

  it('rejects a tar truncated inside a later header', () => {
    const tar = packWorkspaceTar([file('first.txt', 'one'), file('second.txt', 'two')])
    expect(() => readWorkspaceTar(tar.subarray(0, 1024 + 100))).toThrow(WorkspaceTarError)
  })

  it('reads archives the busybox guest produced, including its ./ root entry', () => {
    // Hand-assembled busybox shape: "./" dir entry then "./file".
    const header = (name: string, kind: '0' | '5', size: number): Buffer => {
      const block = Buffer.alloc(512)
      block.write(name, 0, 100, 'utf8')
      block.write('0000644\0', 100, 8, 'utf8')
      block.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8')
      block.write('10000000000\0', 136, 12, 'utf8')
      block.fill(' ', 148, 156)
      block.write(kind, 156, 1, 'utf8')
      block.write('ustar', 257, 6, 'utf8')
      block.write('00', 263, 2, 'utf8')
      let checksum = 0
      for (const byte of block) checksum += byte
      block.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8')
      return block
    }
    const blocks = [
      header('./', '5', 0),
      header('./out.txt', '0', 3),
      Buffer.from('abc'),
      Buffer.alloc(509),
      Buffer.alloc(1024),
    ]
    const entries = readWorkspaceTar(Buffer.concat(blocks))
    expect(fileText(entries, 'out.txt')).toBe('abc')
  })

  it('rejects invalid paths and oversized names', () => {
    expect(() => packWorkspaceTar([file('/abs.txt', 'x')])).toThrow(WorkspaceTarError)
    expect(() => packWorkspaceTar([file('', 'x')])).toThrow(WorkspaceTarError)
    expect(() => packWorkspaceTar([file('.', 'x')])).toThrow(WorkspaceTarError)
    expect(() => packWorkspaceTar([file('a/../b.txt', 'x')])).toThrow(WorkspaceTarError)
    expect(() => packWorkspaceTar([file(`${'x'.repeat(300)}.txt`, 'x')])).toThrow(WorkspaceTarError)
  })

  it('rejects truncated, foreign, and unsupported archives', () => {
    expect(() => readWorkspaceTar(Buffer.alloc(512))).toThrow(WorkspaceTarError)
    const tar = packWorkspaceTar([file('a.txt', 'a')])
    expect(() => readWorkspaceTar(tar.subarray(0, tar.length - 1024 - 1))).toThrow(WorkspaceTarError)
    const foreign = Buffer.from(packWorkspaceTar([file('a.txt', 'a')]))
    foreign.write('xxxx', 257, 4, 'utf8')
    expect(() => readWorkspaceTar(foreign)).toThrow(WorkspaceTarError)
    const symlink = Buffer.from(packWorkspaceTar([file('a.txt', 'a')]))
    symlink.write('2', 156, 1, 'utf8')
    expect(() => readWorkspaceTar(symlink)).toThrow(WorkspaceTarError)
    const noName = Buffer.from(packWorkspaceTar([file('a.txt', 'a')]))
    noName.fill(0, 0, 100)
    expect(() => readWorkspaceTar(noName)).toThrow(WorkspaceTarError)
    const badNumeric = Buffer.from(packWorkspaceTar([file('a.txt', 'a')]))
    badNumeric.write('zzzzzzzzzzz\0', 124, 12, 'utf8')
    expect(() => readWorkspaceTar(badNumeric)).toThrow(WorkspaceTarError)
  })

  it('assertValidWorkspaceTar enforces block alignment', () => {
    expect(() => { assertValidWorkspaceTar(Buffer.alloc(1000)) }).toThrow(WorkspaceTarError)
    expect(() => { assertValidWorkspaceTar(packWorkspaceTar([])) }).not.toThrow()
  })

  it('diffs two snapshots and applies the diff back onto the base', () => {
    const base = packWorkspaceTar([file('keep.txt', 'keep'), file('drop.txt', 'drop'), file('edit.txt', 'old'), file('nested/leaf.txt', 'leaf')])
    const next = packWorkspaceTar([file('keep.txt', 'keep'), file('edit.txt', 'new'), file('added.txt', 'added'), file('nested/leaf.txt', 'leaf')])
    const diff = diffWorkspaceTars(base, next)
    expect(diff.changed.map(entry => entry.path).sort()).toEqual(['added.txt', 'edit.txt'])
    expect(diff.removed).toEqual(['drop.txt'])
    const applied = applyWorkspaceDiff(base, diff)
    const files = new Map(readWorkspaceTar(applied).filter(entry => entry.kind === 'file')
      .map(entry => [entry.path, Buffer.from(entry.data).toString()]))
    expect(Object.fromEntries(files)).toEqual({ 'keep.txt': 'keep', 'edit.txt': 'new', 'added.txt': 'added', 'nested/leaf.txt': 'leaf' })
    expect(diffWorkspaceTars(next, applied)).toEqual({ changed: [], removed: [] })
    // A diff may carry directory entries; apply ignores them for content.
    const withDir = applyWorkspaceDiff(base, { changed: [{ path: 'nested', kind: 'dir' }, file('edit.txt', 'again')], removed: [] })
    expect(readWorkspaceTar(withDir).some(entry => entry.path === 'nested' && entry.kind === 'dir')).toBe(true)
    expect(readWorkspaceTar(withDir).some(entry => entry.path === 'edit.txt')).toBe(true)
  })
})

describe('workspace image format', () => {
  it('stages and reads back a header plus payload', () => {
    const tar = packWorkspaceTar([file('a.txt', 'a')])
    const image = buildWorkspaceImage(tar)
    expect(image.subarray(0, 8).toString('utf8')).toBe('DSHWSI01')
    const read = readWorkspaceImage(image)
    expect(read.bytes).toBe(tar.length)
    expect(read.tar.equals(tar)).toBe(true)
  })

  it('rejects short images, foreign magic, unsafe lengths, and truncated payloads', () => {
    expect(() => readWorkspaceImage(Buffer.alloc(100))).toThrow(WorkspaceImageError)
    const image = buildWorkspaceImage(packWorkspaceTar([file('a.txt', 'a')]))
    image.write('XXXXXXXX', 0, 'utf8')
    expect(() => readWorkspaceImage(image)).toThrow(WorkspaceImageError)
    const huge = Buffer.alloc(4096 + 512)
    huge.write('DSHWSI01', 0, 'utf8')
    huge.writeBigUInt64BE(1n << 60n, 8)
    expect(() => readWorkspaceImage(huge)).toThrow('length out of range')
    const fresh = buildWorkspaceImage(packWorkspaceTar([file('a.txt', 'a')]))
    expect(() => readWorkspaceImage(fresh.subarray(0, fresh.length - 1))).toThrow(WorkspaceImageError)
  })

  it('defaults the export capacity to the wrapper-aligned 1 GiB', () => {
    expect(DEFAULT_EXPORT_CAPACITY_BYTES).toBe(1 << 30)
  })
})

function fakeTransport(scripts: Record<string, () => string | Error>): { transport: import('../src/protocol.ts').ControlTransport; sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    transport: {
      send: (message) => { sent.push(JSON.stringify(message)) },
      request: async (message) => {
        sent.push(JSON.stringify(message))
        const outcome = scripts[message.t]?.()
        if (outcome === undefined) throw new Error(`unexpected request ${message.t}`)
        if (outcome instanceof Error) throw outcome
        return outcome
      },
      onEvent: (): () => void => {
        return () => undefined
      },
      onClose: (): () => void => {
        return () => undefined
      },
    },
  }
}

describe('WorldWorkspace client', () => {
  it('imports and reports the unpacked payload size', async () => {
    const { transport, sent } = fakeTransport({
      'workspace.import': () => JSON.stringify({ t: 'workspace.ok', id: 1, bytes: 4096 }),
    })
    const workspace = new WorldWorkspace(transport, () => 1, () => Promise.reject(new Error('unused')))
    await expect(workspace.import()).resolves.toEqual({ bytes: 4096 })
    expect(JSON.parse(sent[0] ?? '')).toEqual({ t: 'workspace.import', id: 1 })
  })

  it('exports and reads the image back with size agreement', async () => {
    const tar = buildWorkspaceImage(packWorkspaceTar([file('a.txt', 'a')]))
    const { transport } = fakeTransport({
      'workspace.export': () => JSON.stringify({ t: 'workspace.ok', id: 2, bytes: tar.length - 4096 }),
    })
    const workspace = new WorldWorkspace(transport, () => 2, () => Promise.resolve(tar))
    const exported = await workspace.export()
    expect(exported.bytes).toBe(tar.length - 4096)
    expect(exported.tar.length).toBe(tar.length - 4096)
  })

  it('surfaces guest errors and size mismatches', async () => {
    const denying = fakeTransport({
      'workspace.import': () => JSON.stringify({ t: 'workspace.err', id: 1, message: 'busy' }),
    })
    await expect(new WorldWorkspace(denying.transport, () => 1, () => Promise.reject(new Error('unused'))).import())
      .rejects.toThrow('busy')
    const image = buildWorkspaceImage(packWorkspaceTar([]))
    const mismatching = fakeTransport({
      'workspace.export': () => JSON.stringify({ t: 'workspace.ok', id: 1, bytes: 999 }),
    })
    await expect(new WorldWorkspace(mismatching.transport, () => 1, () => Promise.resolve(image)).export())
      .rejects.toThrow('size mismatch')
  })

  it('rejects an unparseable completion reply', async () => {
    const { transport } = fakeTransport({
      'workspace.import': () => JSON.stringify({ t: 'workspace.ok', id: 1, bytes: 'NaN' }),
    })
    await expect(new WorldWorkspace(transport, () => 1, () => Promise.reject(new Error('unused'))).import())
      .rejects.toThrow('unparseable workspace reply')
  })
})

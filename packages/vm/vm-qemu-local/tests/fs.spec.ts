import { describe, expect, it } from 'vitest'
import { GuestFsError, MAX_FS_PAYLOAD_BYTES, WorldFs } from '../src/fs.ts'
import type { ControlTransport, GuestMessage, HostMessage } from '../src/protocol.ts'

/** Deterministic transport: requests resolve from a scripted queue. */
class FakeTransport implements ControlTransport {
  readonly sent: HostMessage[] = []
  private readonly replies: string[] = []

  enqueue(message: GuestMessage | string): this {
    this.replies.push(typeof message === 'string' ? message : JSON.stringify(message))
    return this
  }

  send(message: HostMessage): void {
    this.sent.push(message)
  }

  async request(message: HostMessage, match: (payload: string) => boolean, _timeoutMs: number): Promise<string> {
    this.sent.push(message)
    const reply = this.replies.shift()
    if (reply === undefined) throw new Error('no scripted reply')
    void match(reply)
    return reply
  }

  onEvent(): () => void {
    return () => undefined
  }

  onClose(): () => void {
    return () => undefined
  }
}

function worldFs(): { transport: FakeTransport; fs: WorldFs } {
  const transport = new FakeTransport()
  let nextId = 1
  const fs = new WorldFs(transport, () => nextId++)
  return { transport, fs }
}

describe('WorldFs', () => {
  it('reads file payloads as bytes', async () => {
    const { transport, fs } = worldFs()
    transport.enqueue({ t: 'fs.ok', id: 1, d: Buffer.from('abc').toString('base64') })
    await expect(fs.readFile('/tmp/f')).resolves.toEqual(Buffer.from('abc'))
    expect(transport.sent).toEqual([{ t: 'fs', id: 1, op: 'read', path: '/tmp/f' }])
  })

  it('reads a missing d field as empty output', async () => {
    const { transport, fs } = worldFs()
    transport.enqueue({ t: 'fs.ok', id: 1 })
    await expect(fs.readFile('/tmp/f')).resolves.toEqual(Buffer.alloc(0))
  })

  it('writes base64 payloads and bounds them host-side', async () => {
    const { transport, fs } = worldFs()
    transport.enqueue({ t: 'fs.ok', id: 1 })
    await fs.writeFile('/tmp/f', 'text')
    expect(transport.sent).toEqual([{ t: 'fs', id: 1, op: 'write', path: '/tmp/f', d: Buffer.from('text').toString('base64') }])
    const big = 'x'.repeat(MAX_FS_PAYLOAD_BYTES + 1)
    await expect(fs.writeFile('/tmp/f', big)).rejects.toMatchObject({ name: 'GuestFsError', code: 'EFBIG' })
    transport.enqueue({ t: 'fs.ok', id: 2 })
    await fs.writeFile('/tmp/f2', new Uint8Array([0x61]))
    expect(transport.sent.at(-1)).toEqual({ t: 'fs', id: 2, op: 'write', path: '/tmp/f2', d: 'YQ==' })
  })

  it('stats through the st field and fails without one', async () => {
    const { transport, fs } = worldFs()
    const st = { kind: 'file' as const, size: 9, mode: 0o644, mtimeMs: 1.5 }
    transport.enqueue({ t: 'fs.ok', id: 1, st })
    await expect(fs.stat('/tmp/f')).resolves.toEqual(st)
    transport.enqueue({ t: 'fs.ok', id: 2 })
    await expect(fs.stat('/tmp/f')).rejects.toMatchObject({ name: 'GuestFsError', code: 'EIO' })
  })

  it('lists entries and defaults an absent list to empty', async () => {
    const { transport, fs } = worldFs()
    transport.enqueue({ t: 'fs.ok', id: 1, entries: [{ name: 'a', kind: 'dir' }, { name: 'b', kind: 'file' }] })
    await expect(fs.list('/tmp')).resolves.toEqual([{ name: 'a', kind: 'dir' }, { name: 'b', kind: 'file' }])
    transport.enqueue({ t: 'fs.ok', id: 2 })
    await expect(fs.list('/tmp')).resolves.toEqual([])
  })

  it('shapes mkdir with and without recursive', async () => {
    const { transport, fs } = worldFs()
    transport.enqueue({ t: 'fs.ok', id: 1 })
    transport.enqueue({ t: 'fs.ok', id: 2 })
    await fs.mkdir('/tmp/a')
    await fs.mkdir('/tmp/a', { recursive: true })
    expect(transport.sent).toEqual([
      { t: 'fs', id: 1, op: 'mkdir', path: '/tmp/a' },
      { t: 'fs', id: 2, op: 'mkdir', path: '/tmp/a', recursive: true },
    ])
  })

  it('round-trips unlink, rmdir, and rename', async () => {
    const { transport, fs } = worldFs()
    for (let id = 1; id <= 3; id++) transport.enqueue({ t: 'fs.ok', id })
    await fs.unlink('/tmp/f')
    await fs.rmdir('/tmp/d')
    await fs.rename('/tmp/f', '/tmp/g')
    expect(transport.sent).toEqual([
      { t: 'fs', id: 1, op: 'unlink', path: '/tmp/f' },
      { t: 'fs', id: 2, op: 'rmdir', path: '/tmp/d' },
      { t: 'fs', id: 3, op: 'rename', from: '/tmp/f', to: '/tmp/g' },
    ])
  })

  it('maps guest errnos to Node-style codes', async () => {
    const { transport, fs } = worldFs()
    transport.enqueue({ t: 'fs.err', id: 1, errno: 2, message: 'no such file' })
    const error = await fs.readFile('/tmp/missing').then(
      () => { throw new Error('expected rejection') },
      (caught: unknown) => caught as GuestFsError,
    )
    expect(error).toBeInstanceOf(GuestFsError)
    expect(error).toMatchObject({ code: 'ENOENT', errno: 2 })
    expect(error.message).toContain('no such file')
  })

  it('falls back to EIO for unmapped errnos', async () => {
    const { transport, fs } = worldFs()
    transport.enqueue({ t: 'fs.err', id: 1, errno: 999, message: 'odd' })
    await expect(fs.unlink('/tmp/f')).rejects.toMatchObject({ name: 'GuestFsError', code: 'EIO', errno: 999 })
  })

  it('rejects unparseable and unexpected replies as EIO', async () => {
    const { transport, fs } = worldFs()
    transport.enqueue('not json at all')
    await expect(fs.unlink('/tmp/f')).rejects.toMatchObject({ name: 'GuestFsError', code: 'EIO' })
    transport.enqueue('{"t":"pong","n":1}')
    await expect(fs.unlink('/tmp/f')).rejects.toSatisfy((error: unknown) =>
      error instanceof GuestFsError && error.message.includes('unexpected fs reply'))
  })
})

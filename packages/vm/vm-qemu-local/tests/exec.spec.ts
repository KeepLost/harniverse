import { describe, expect, it } from 'vitest'
import { ExecSession, type ExecHandle } from '../src/exec.ts'
import { PROTOCOL_VERSION, parseGuestMessage, type ControlTransport, type GuestMessage, type HostMessage } from '../src/protocol.ts'

interface ScriptedReply {
  /** Reply text the transport resolves the next matching request with. */
  payload: string
}

/**
 * Deterministic ControlTransport: requests resolve from a scripted reply
 * queue (ignoring 'match'), sends are recorded, events fire by hand.
 */
class FakeTransport implements ControlTransport {
  readonly sent: HostMessage[] = []
  private readonly replies: ScriptedReply[] = []
  private readonly events: { match: (payload: string) => boolean; handler: (payload: string) => void }[] = []
  private readonly closeHandlers: ((error: Error) => void)[] = []

  enqueue(message: GuestMessage | string): this {
    this.replies.push({ payload: typeof message === 'string' ? message : JSON.stringify(message) })
    return this
  }

  emitEvent(message: GuestMessage): void {
    const payload = JSON.stringify(message)
    for (const subscription of [...this.events]) {
      if (subscription.match(payload)) subscription.handler(payload)
    }
  }

  emitClose(): void {
    for (const handler of this.closeHandlers.splice(0)) handler(new Error('closed'))
    this.events.splice(0)
  }

  send(message: HostMessage): void {
    this.sent.push(message)
  }

  async request(message: HostMessage, match: (payload: string) => boolean, _timeoutMs: number): Promise<string> {
    this.sent.push(message)
    const reply = this.replies.shift()
    if (reply === undefined) throw new Error('no scripted reply')
    void match(reply.payload)
    return reply.payload
  }

  onEvent(match: (payload: string) => boolean, handler: (payload: string) => void): () => void {
    const subscription = { match, handler }
    this.events.push(subscription)
    return () => {
      const index = this.events.indexOf(subscription)
      if (index >= 0) this.events.splice(index, 1)
    }
  }

  onClose(handler: (error: Error) => void): () => void {
    this.closeHandlers.push(handler)
    return () => {
      const index = this.closeHandlers.indexOf(handler)
      if (index >= 0) this.closeHandlers.splice(index, 1)
    }
  }
}

function session(): { transport: FakeTransport; exec: ExecSession } {
  const transport = new FakeTransport()
  let nextId = 1
  const exec = new ExecSession(transport, () => nextId++)
  return { transport, exec }
}

async function startedSession(): Promise<{ transport: FakeTransport; exec: ExecSession; handle: ExecHandle }> {
  const base = session()
  base.transport.enqueue({ t: 'exec.started', id: 1, pid: 77 })
  const handle = await base.exec.spawn(['/bin/true'])
  return { ...base, handle }
}

describe('ExecSession', () => {
  it('streams output and settles the exit for one exec id', async () => {
    const { transport, handle } = await startedSession()
    const seen: Array<[string, string]> = []
    const off = handle.onOutput((stream, chunk) => { seen.push([stream, chunk.toString('utf8')]) })
    transport.emitEvent({ t: 'exec.out', id: 1, s: 'o', d: Buffer.from('hello').toString('base64') })
    transport.emitEvent({ t: 'exec.out', id: 1, s: 'e', d: Buffer.from('oops').toString('base64') })
    off()
    transport.emitEvent({ t: 'exec.out', id: 1, s: 'o', d: Buffer.from('ignored').toString('base64') })
    expect(seen).toEqual([['stdout', 'hello'], ['stderr', 'oops']])
    transport.emitEvent({ t: 'exec.exit', id: 1, code: 3, sig: 'SIGTERM' })
    await expect(handle.exit).resolves.toEqual({ code: 3, signal: 'SIGTERM' })
    // Events for the settled exec no longer fire.
    transport.emitEvent({ t: 'exec.out', id: 1, s: 'o', d: '' })
  })

  it('maps a null signal exit and ignores events for other ids', async () => {
    const { transport, handle } = await startedSession()
    transport.emitEvent({ t: 'exec.out', id: 999, s: 'o', d: Buffer.from('x').toString('base64') })
    transport.emitEvent({ t: 'exec.exit', id: 1, code: 0 })
    await expect(handle.exit).resolves.toEqual({ code: 0, signal: null })
  })

  it('rejects the exit when the channel closes first', async () => {
    const { transport, handle } = await startedSession()
    transport.emitClose()
    await expect(handle.exit).rejects.toThrow('closed')
  })

  it('throws the guest start rejection as ExecStartError', async () => {
    const { transport, exec } = session()
    transport.enqueue({ t: 'exec.err', id: 1, message: 'spawn failed' })
    await expect(exec.spawn(['/no/such/bin'])).rejects.toMatchObject({
      name: 'ExecStartError',
      guestMessage: 'spawn failed',
      execId: 1,
    })
  })

  it('rejects an unexpected start reply', async () => {
    const { transport, exec } = session()
    transport.enqueue('{"t":"pong","n":1}')
    await expect(exec.spawn(['/bin/true'])).rejects.toThrow('unexpected start reply')
  })

  it('delivers signals and surfaces guest signal errors', async () => {
    const { transport, handle } = await startedSession()
    transport.enqueue({ t: 'exec.acked', id: 1 })
    await expect(handle.signal('SIGTERM')).resolves.toBeUndefined()
    expect(transport.sent.filter(message => message.t === 'exec.signal')).toEqual([{ t: 'exec.signal', id: 1, sig: 'SIGTERM' }])
    transport.enqueue({ t: 'exec.err', id: 1, message: 'no such exec' })
    await expect(handle.signal('SIGKILL')).rejects.toMatchObject({ name: 'ExecStartError', guestMessage: 'no such exec' })
  })

  it('splits stdin chunks at the wire cap and closes on request', async () => {
    const { transport, handle } = await startedSession()
    const big = 'a'.repeat(600 * 1024)
    handle.writeStdin('tiny')
    handle.writeStdin(big)
    handle.writeStdin(new Uint8Array([0x62, 0x63]))
    handle.closeStdin()
    const stdinMessages = transport.sent.filter(message => message.t === 'exec.stdin') as Array<{ t: 'exec.stdin'; id: number; d: string }>
    expect(stdinMessages).toHaveLength(4)
    expect(Buffer.from(stdinMessages[0]!.d, 'base64').toString('utf8')).toBe('tiny')
    expect(Buffer.from(stdinMessages[1]!.d, 'base64').length).toBe(512 * 1024)
    expect(Buffer.from(stdinMessages[2]!.d, 'base64').length).toBe(88 * 1024)
    expect([...Buffer.from(stdinMessages[3]!.d, 'base64')]).toEqual([0x62, 0x63])
    expect(transport.sent.at(-1)).toEqual({ t: 'exec.stdin.close', id: 1 })
  })

  it('collects stdout, stderr, and stdin through exec()', async () => {
    const { transport, exec } = session()
    transport.enqueue({ t: 'exec.started', id: 1, pid: 5 })
    const pending = exec.exec(['/bin/cat'], { stdin: 'in-bytes', timeoutMs: 60_000 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(transport.sent.map(message => message.t)).toEqual(['exec', 'exec.stdin', 'exec.stdin.close'])
    transport.emitEvent({ t: 'exec.out', id: 1, s: 'o', d: Buffer.from('out-text').toString('base64') })
    transport.emitEvent({ t: 'exec.out', id: 1, s: 'e', d: Buffer.from('err-text').toString('base64') })
    transport.emitEvent({ t: 'exec.exit', id: 1, code: 0 })
    const result = await pending
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: false })
    expect(result.stdout.toString('utf8')).toBe('out-text')
    expect(result.stderr.toString('utf8')).toBe('err-text')
  })

  it('kills and flags the exec when the timeout fires', async () => {
    const { transport, exec } = session()
    transport.enqueue({ t: 'exec.started', id: 1, pid: 5 })
    const pending = exec.exec(['/bin/sleep', '60'], { timeoutMs: 30 })
    const result = await new Promise<{ timedOut: boolean }>((resolve) => {
      void pending.then(resolve)
      setTimeout(() => {
        transport.emitEvent({ t: 'exec.exit', id: 1, code: 137, sig: 'SIGKILL' })
      }, 60)
    })
    expect(result.timedOut).toBe(true)
    expect(transport.sent.some(message => message.t === 'exec.signal' && message.sig === 'SIGKILL')).toBe(true)
  })

  it('kills and rejects when collected output exceeds the bound', async () => {
    const { transport, exec } = session()
    transport.enqueue({ t: 'exec.started', id: 1, pid: 5 })
    const pending = exec.exec(['/bin/yes'], { maxOutputBytes: 4 })
    await new Promise(resolve => setTimeout(resolve, 20))
    transport.emitEvent({ t: 'exec.out', id: 1, s: 'o', d: Buffer.from('toolong').toString('base64') })
    await new Promise(resolve => setTimeout(resolve, 20))
    transport.emitEvent({ t: 'exec.exit', id: 1, code: 137, sig: 'SIGKILL' })
    await expect(pending).rejects.toMatchObject({ name: 'ExecOutputLimitError', limitBytes: 4 })
  })

  it('validates argv, env, cwd, and pty shapes before sending', async () => {
    const { exec } = session()
    await expect(exec.exec([])).rejects.toMatchObject({ name: 'ExecOptionsError' })
    await expect(exec.exec([''])).rejects.toMatchObject({ name: 'ExecOptionsError' })
    await expect(exec.exec(['a\0b'])).rejects.toMatchObject({ name: 'ExecOptionsError' })
    await expect(exec.exec(['/bin/true'], { env: { '': 'x' } })).rejects.toMatchObject({ name: 'ExecOptionsError' })
    await expect(exec.exec(['/bin/true'], { env: { K: 'v\0' } })).rejects.toMatchObject({ name: 'ExecOptionsError' })
    await expect(exec.exec(['/bin/true'], { cwd: 'relative' })).rejects.toMatchObject({ name: 'ExecOptionsError' })
    await expect(exec.exec(['/bin/true'], { cwd: '/a\0b' })).rejects.toMatchObject({ name: 'ExecOptionsError' })
    await expect(exec.exec(['/bin/true'], { pty: { rows: 0, cols: 80 } })).rejects.toMatchObject({ name: 'ExecOptionsError' })
    await expect(exec.exec(['/bin/true'], { pty: { rows: 24.5, cols: 80 } })).rejects.toMatchObject({ name: 'ExecOptionsError' })
  })

  it('shapes the wire message: defaults omitted, pty true expands, ids allocate once', async () => {
    const { transport, exec } = session()
    transport.enqueue({ t: 'exec.started', id: 1, pid: 1 })
    await exec.spawn(['/bin/sh'], { pty: true, env: { A: 'b' }, cwd: '/tmp' })
    transport.enqueue({ t: 'exec.started', id: 2, pid: 2 })
    await exec.spawn(['/bin/sh'], { pty: { rows: 10, cols: 10 } })
    expect(transport.sent).toEqual([
      { t: 'exec', id: 1, argv: ['/bin/sh'], env: { A: 'b' }, cwd: '/tmp', pty: { rows: 24, cols: 80 } },
      { t: 'exec', id: 2, argv: ['/bin/sh'], pty: { rows: 10, cols: 10 } },
    ])
  })
})

describe('protocol-level exec parsing', () => {
  it('accepts well-formed op messages and rejects malformed ones', () => {
    expect(parseGuestMessage('{\"t\":\"exec.started\",\"id\":1,\"pid\":9}')).toEqual({ t: 'exec.started', id: 1, pid: 9 })
    expect(parseGuestMessage('{\"t\":\"exec.started\",\"id\":1}')).toBeUndefined()
    expect(parseGuestMessage('{\"t\":\"exec.acked\",\"id\":2}')).toEqual({ t: 'exec.acked', id: 2 })
    expect(parseGuestMessage('{\"t\":\"exec.out\",\"id\":1,\"s\":\"e\",\"d\":\"AAAA\"}')).toEqual({ t: 'exec.out', id: 1, s: 'e', d: 'AAAA' })
    expect(parseGuestMessage('{\"t\":\"exec.out\",\"id\":1,\"s\":\"x\",\"d\":\"AAAA\"}')).toBeUndefined()
    expect(parseGuestMessage('{\"t\":\"exec.exit\",\"id\":1,\"code\":137,\"sig\":\"SIGKILL\"}')).toEqual({ t: 'exec.exit', id: 1, code: 137, sig: 'SIGKILL' })
    expect(parseGuestMessage('{\"t\":\"exec.exit\",\"id\":1,\"code\":0}')).toEqual({ t: 'exec.exit', id: 1, code: 0 })
    expect(parseGuestMessage('{\"t\":\"exec.exit\",\"id\":1,\"code\":\"x\"}')).toBeUndefined()
    expect(parseGuestMessage('{\"t\":\"exec.err\",\"id\":1,\"message\":\"no\"}')).toEqual({ t: 'exec.err', id: 1, message: 'no' })
    expect(parseGuestMessage('{\"t\":\"exec.err\",\"id\":1}')).toBeUndefined()
  })

  it('parses fs replies with per-op payloads', () => {
    expect(parseGuestMessage('{\"t\":\"fs.ok\",\"id\":1,\"d\":\"QUJD\"}')).toEqual({ t: 'fs.ok', id: 1, d: 'QUJD' })
    expect(parseGuestMessage('{\"t\":\"fs.ok\",\"id\":1,\"entries\":[{\"name\":\"a\",\"kind\":\"dir\"}]}')).toEqual({
      t: 'fs.ok',
      id: 1,
      entries: [{ name: 'a', kind: 'dir' }],
    })
    expect(parseGuestMessage('{\"t\":\"fs.ok\",\"id\":1,\"st\":{\"kind\":\"file\",\"size\":3,\"mode\":420,\"mtimeMs\":1.5}}')).toEqual({
      t: 'fs.ok',
      id: 1,
      st: { kind: 'file', size: 3, mode: 420, mtimeMs: 1.5 },
    })
    expect(parseGuestMessage('{\"t\":\"fs.ok\",\"id\":1,\"entries\":[{\"name\":\"a\",\"kind\":\"socket\"}]}')).toBeUndefined()
    expect(parseGuestMessage('{\"t\":\"fs.ok\",\"id\":1,\"st\":{\"kind\":\"file\",\"size\":\"x\",\"mode\":0,\"mtimeMs\":0}}')).toBeUndefined()
    expect(parseGuestMessage('{\"t\":\"fs.err\",\"id\":2,\"errno\":2,\"message\":\"none\"}')).toEqual({ t: 'fs.err', id: 2, errno: 2, message: 'none' })
    expect(parseGuestMessage('{\"t\":\"fs.err\",\"id\":2,\"errno\":\"x\",\"message\":\"none\"}')).toBeUndefined()
    expect(parseGuestMessage('{"t":"fs.bogus","id":2}')).toBeUndefined()
  })

  it('keeps the protocol version agreement strict', () => {
    expect(PROTOCOL_VERSION).toBe(2)
    expect(parseGuestMessage(`{"t":"welcome","v":${PROTOCOL_VERSION},"caps":["ping","exec","fs"],"agent":"x"}`)?.t).toBe('welcome')
    expect(parseGuestMessage(`{"t":"welcome","v":${PROTOCOL_VERSION + 1},"caps":[],"agent":"x"}`)?.t).toBe('welcome')
  })
})

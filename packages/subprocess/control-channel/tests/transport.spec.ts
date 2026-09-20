/**
 * Tests for the stream-attached control transport: call/reply pairing,
 * program-to-host calls, terminal outcomes and lifecycle walks, cancellation,
 * deadlines, backpressure, close-grace escalation, and real-child disposal
 * (the Linux/Windows disposal evidence).
 */

import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  ControlCallError,
  ControlChannelTransport,
  ControlFrameDecoder,
  encodeControlFrame,
} from '@deepseek-ai/dsh-control-channel'
import type { ControlChannelLimits, ControlFrame, ControlTransportHandlers } from '@deepseek-ai/dsh-control-channel'

const graceLimits: ControlChannelLimits = { maxFrameBytes: 1 << 16, maxQueuedBytes: 1 << 16, maxPendingCalls: 4, closeGraceMs: 30 }
const tightLimits: ControlChannelLimits = { maxFrameBytes: 1 << 16, maxQueuedBytes: 96, maxPendingCalls: 2, closeGraceMs: 40 }

interface PeerHandle {
  send(frame: ControlFrame): void
  frames: readonly ControlFrame[]
  end(): void
}

/** An in-memory peer speaking the same length-prefixed protocol. */
function makePeer(hostInput: PassThrough, hostOutput: PassThrough): PeerHandle {
  const decoder = new ControlFrameDecoder()
  const frames: ControlFrame[] = []
  hostOutput.on('data', (chunk) => {
    frames.push(...decoder.feed(chunk as Buffer))
  })
  return {
    send(frame) {
      hostInput.write(encodeControlFrame(frame))
    },
    frames,
    end() {
      hostInput.end()
    },
  }
}

function makeChannel(handlers?: ControlTransportHandlers, limits?: ControlChannelLimits): {
  channel: ControlChannelTransport
  peer: PeerHandle
  hostInput: PassThrough
  hostOutput: PassThrough
} {
  const hostInput = new PassThrough()
  const hostOutput = new PassThrough()
  const optional = { ...(handlers === undefined ? {} : { handlers }), ...(limits === undefined ? {} : { limits }) }
  const channel = new ControlChannelTransport({ input: hostInput, output: hostOutput, ...optional })
  const peer = makePeer(hostInput, hostOutput)
  return { channel, peer, hostInput, hostOutput }
}

describe('call and reply pairing', () => {
  it('round-trips a host call and serves program-to-host calls', async () => {
    const { channel, peer } = makeChannel({
      onCall: async frame => `served:${frame.target}`,
    })
    peer.send({ kind: 'call', id: 9, target: 'host.now', args: [] })
    await new Promise(resolve => setImmediate(resolve))
    const reply = peer.frames.find(frame => frame.kind === 'reply')
    expect(reply).toEqual({ kind: 'reply', id: 9, ok: true, value: 'served:host.now' })

    const pending = channel.call<{ echo: string }>('program.double', [21])
    peer.send({ kind: 'reply', id: 1, ok: true, value: { echo: 'program.double' } })
    await expect(pending).resolves.toEqual({ echo: 'program.double' })
    peer.send({ kind: 'done', value: 'finished' })
    const outcome = await channel.outcome()
    expect(outcome).toEqual({ kind: 'value', value: 'finished' })
    peer.end()
    await channel.waitSettled()
    await channel.dispose()
    expect(channel.lifecycleState).toBe('cleaned-up')
  })

  it('rejects failed replies, per-call timeouts, and calls after termination', async () => {
    const { channel, peer } = makeChannel()
    const failed = channel.call('program.fails')
    peer.send({ kind: 'reply', id: 1, ok: false, message: 'denied' })
    await expect(failed).rejects.toMatchObject({ failure: { kind: 'exception', message: 'denied' } })

    const slow = channel.call('program.slow', [], { timeoutMs: 20 })
    await expect(slow).rejects.toMatchObject({ failure: { kind: 'timeout' } })
    const recovered = channel.call('program.again')
    peer.send({ kind: 'reply', id: 3, ok: true, value: 3 })
    await expect(recovered).resolves.toBe(3)

    peer.send({ kind: 'done', error: { kind: 'exception', message: 'boom' } })
    expect((await channel.outcome()).kind).toBe('failure')
    await expect(channel.call('program.late')).rejects.toBeInstanceOf(ControlCallError)
    peer.end()
    await channel.dispose()
  })

  it('answers unhandled program-to-host calls with a failure reply', async () => {
    const { channel, peer } = makeChannel()
    peer.send({ kind: 'call', id: 5, target: 'host.unserved', args: [] })
    await new Promise(resolve => setImmediate(resolve))
    expect(peer.frames.find(frame => frame.kind === 'reply')).toEqual({ kind: 'reply', id: 5, ok: false, message: 'no handler serves host.unserved' })
    peer.send({ kind: 'done', value: null })
    await channel.outcome()
    peer.end()
    await channel.dispose()
  })
})

describe('terminal outcomes and lifecycle', () => {
  it('records a peer failure frame and separates cleanup reporting', async () => {
    const { channel, peer } = makeChannel()
    peer.send({ kind: 'done', error: { kind: 'output-limit', message: 'too much' } })
    const outcome = await channel.outcome()
    expect(outcome).toEqual({ kind: 'failure', failure: { kind: 'output-limit', message: 'too much' } })
    expect(channel.lifecycleState).toBe('result-recorded')
    peer.send({ kind: 'done', value: 1 })
    peer.end()
    await channel.waitSettled()
    expect(channel.lifecycleState).toBe('quiescent')
    const errors = await channel.dispose()
    expect(errors).toEqual(['peer sent a second terminal frame'])
    expect(channel.lifecycleState).toBe('cleaned-up')
  })

  it('classifies peer EOF without a terminal frame as process-exit', async () => {
    const { channel, peer } = makeChannel()
    peer.end()
    const outcome = await channel.outcome()
    expect(outcome).toEqual({ kind: 'failure', failure: { kind: 'process-exit', message: 'peer closed the channel without a terminal frame' } })
    await channel.waitSettled()
    await channel.dispose()
    expect(channel.lifecycleState).toBe('cleaned-up')
  })

  it('fails the channel on protocol violations from the peer', async () => {
    const oversized = Buffer.alloc(4)
    oversized.writeUInt32BE(1 << 20, 0)
    const { channel, peer, hostInput } = makeChannel()
    hostInput.write(oversized)
    let outcome = await channel.outcome()
    expect(outcome).toMatchObject({ kind: 'failure', failure: { kind: 'protocol', message: /above maxFrameBytes/ } })
    peer.end()

    const second = makeChannel()
    second.peer.send({ kind: 'reply', id: 77, ok: true })
    outcome = await second.channel.outcome()
    expect(outcome).toEqual({ kind: 'failure', failure: { kind: 'protocol', message: 'reply for unknown call id 77' } })
    second.peer.end()
    await channel.dispose()
    await second.channel.dispose()
  })

  it('cancels through the signal, the deadline, and explicit cancel', async () => {
    const cancelled = makeChannel()
    cancelled.channel.cancel('caller changed its mind')
    expect(await cancelled.channel.outcome()).toEqual({ kind: 'failure', failure: { kind: 'abort', message: 'caller changed its mind' } })
    expect(cancelled.channel.lifecycleState).toBe('cancelled')
    cancelled.peer.end()
    await cancelled.channel.dispose()

    const input = new PassThrough()
    const output = new PassThrough()
    const timed = new ControlChannelTransport({ input, output, deadlineMs: 20 })
    const outcome = await timed.outcome()
    expect(outcome).toMatchObject({ kind: 'failure', failure: { kind: 'timeout', message: /deadline/ } })
    expect(timed.lifecycleState).toBe('timed-out')
    await timed.dispose()

    const controller = new AbortController()
    const hostInput = new PassThrough()
    const hostOutput = new PassThrough()
    const channel = new ControlChannelTransport({ input: hostInput, output: hostOutput, signal: controller.signal })
    controller.abort('owner stopped the run')
    expect(await channel.outcome()).toEqual({ kind: 'failure', failure: { kind: 'abort', message: 'owner stopped the run' } })
    hostInput.end()
    await channel.dispose()
  })
})

describe('backpressure and close grace', () => {
  it('refuses sends above the queued-byte bound when writes never drain', async () => {
    const hostInput = new PassThrough()
    const hostOutput = new PassThrough({ transform(chunk, _enc, cb) { void chunk; void cb } })
    const channel = new ControlChannelTransport({ input: hostInput, output: hostOutput, limits: tightLimits })
    channel.sendLog('first queued line that never drains')
    expect(channel.lifecycleState).toBe('running')
    const outcomeP = channel.outcome()
    channel.sendLog('x'.repeat(60))
    const outcome = await outcomeP
    expect(outcome).toMatchObject({ kind: 'failure', failure: { kind: 'protocol', message: /maxQueuedBytes/ } })
    hostInput.end()
    await channel.dispose()
  })

  it('escalates to forced termination when the peer ignores the close', async () => {
    const hostInput = new PassThrough()
    const hostOutput = new PassThrough()
    let forced = 0
    const channel = new ControlChannelTransport({
      input: hostInput,
      output: hostOutput,
      limits: graceLimits,
      forceTerminate: () => {
        forced += 1
        hostInput.destroy()
        hostOutput.destroy()
      },
    })
    channel.cancel('done waiting')
    await channel.outcome()
    await channel.waitSettled()
    expect(forced).toBe(1)
    await channel.dispose()
  })

  it('disposes a channel that never left starting straight through cleanup', async () => {
    const channel = new ControlChannelTransport({ input: new PassThrough(), output: new PassThrough() })
    await expect(channel.dispose()).resolves.toEqual([])
    expect(channel.lifecycleState).toBe('cleaned-up')
    await expect(channel.waitSettled()).resolves.toBeUndefined()
    await expect(channel.outcome()).resolves.toEqual({ kind: 'failure', failure: { kind: 'abort', message: 'disposed before a terminal outcome' } })
  })

  it('cancels a still-running channel on dispose without waiting for the peer', async () => {
    const { channel, peer } = makeChannel()
    const pending = channel.call('program.nothing')
    pending.catch(() => undefined)
    const errors = await channel.dispose()
    const outcome = await channel.outcome()
    expect(outcome).toEqual({ kind: 'failure', failure: { kind: 'abort', message: 'disposed before a terminal outcome' } })
    expect(errors).toEqual([])
    expect(channel.lifecycleState).toBe('cleaned-up')
    await expect(pending).rejects.toMatchObject({ failure: { kind: 'abort' } })
    peer.end()
  })
})

describe('error surfaces and bounds', () => {
  it('terminates on input and output stream errors', async () => {
    const { channel, peer } = makeChannel()
    channel.sendLog('hello')
    ;(peer as { end(): void }).end()
    void channel.dispose()

    const broken = makeChannel()
    broken.hostInput.destroy(new Error('pipe broke'))
    let outcome = await broken.channel.outcome()
    expect(outcome).toEqual({ kind: 'failure', failure: { kind: 'io', message: 'input stream failed: pipe broke' } })
    await broken.channel.dispose()

    const writer = makeChannel()
    writer.hostOutput.destroy(new Error('sink broke'))
    outcome = await writer.channel.outcome()
    expect(outcome).toEqual({ kind: 'failure', failure: { kind: 'io', message: 'output stream failed: sink broke' } })
    await writer.channel.dispose()
  })

  it('terminates queued writes when the output stream errors underneath them', async () => {
    const hostInput = new PassThrough()
    const hostOutput = new PassThrough({ transform(chunk, _enc, cb) { void chunk; void cb } })
    const channel = new ControlChannelTransport({ input: hostInput, output: hostOutput })
    channel.sendLog('queued forever')
    const outcomeP = channel.outcome()
    hostOutput.destroy(new Error('write exploded'))
    const outcome = await outcomeP
    expect(outcome).toEqual({ kind: 'failure', failure: { kind: 'io', message: 'output stream failed: write exploded' } })
    hostInput.end()
    await channel.dispose()
  })

  it('propagates unencodable call arguments as the caller\u2019s own failure', async () => {
    const { channel } = makeChannel()
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    await expect(channel.call('program.bad', cyclic)).rejects.toThrow(TypeError)
    await channel.dispose()
  })

  it('surfaces handler rejections and limit frames, and reports failed forced termination', async () => {
    const limits: string[] = []
    const { channel, peer } = makeChannel({
      onLimit: limit => limits.push(limit),
      onCall: async (frame) => {
        if (frame.target === 'throw-string') throw 'plain failure'
        throw new Error('handler exploded')
      },
    })
    peer.send({ kind: 'call', id: 1, target: 'throw-error', args: [] })
    peer.send({ kind: 'call', id: 2, target: 'throw-string', args: [] })
    peer.send({ kind: 'limit', limit: 'pending-calls' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(limits).toEqual(['pending-calls'])
    const replies = peer.frames.filter(frame => frame.kind === 'reply')
    expect(replies).toEqual([
      { kind: 'reply', id: 1, ok: false, message: 'handler exploded' },
      { kind: 'reply', id: 2, ok: false, message: 'plain failure' },
    ])

    const hostile = makeChannel()
    const forced = new ControlChannelTransport({
      input: hostile.hostInput,
      output: hostile.hostOutput,
      limits: graceLimits,
      forceTerminate: () => {
        throw new Error('kill refused')
      },
    })
    forced.cancel('close now')
    await forced.outcome()
    await new Promise(resolve => setTimeout(resolve, graceLimits.closeGraceMs + 20))
    hostile.hostInput.destroy()
    hostile.hostOutput.destroy()
    const errors = await forced.dispose()
    expect(errors).toEqual(['forced termination failed: kill refused'])
    peer.end()
    await channel.dispose()
  })

  it('uses the reply-window default message and settles pending calls at done', async () => {
    const { channel, peer } = makeChannel()
    const messageless = channel.call('program.silent')
    peer.send({ kind: 'reply', id: 1, ok: false })
    await expect(messageless).rejects.toMatchObject({ failure: { kind: 'exception', message: 'call failed' } })

    const quick = channel.call('program.quick', [], { timeoutMs: 1_000 })
    peer.send({ kind: 'reply', id: 2, ok: true, value: 'fast' })
    await expect(quick).resolves.toBe('fast')

    const stranded = channel.call('program.stranded')
    stranded.catch(() => undefined)
    peer.send({ kind: 'done', value: 'complete' })
    await expect(stranded).rejects.toMatchObject({ failure: { kind: 'abort', message: /call 3/ } })
    await channel.outcome()
    peer.end()
    await channel.dispose()
    await expect(channel.dispose()).resolves.toEqual([])
  })

  it('cancels a pre-aborted signal immediately and sends limit reports', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const channel = new ControlChannelTransport({ input, output, signal: AbortSignal.abort('never started') })
    expect(await channel.outcome()).toEqual({ kind: 'failure', failure: { kind: 'abort', message: 'never started' } })
    await expect(channel.dispose()).resolves.toEqual([])

    const { channel: live, peer } = makeChannel()
    live.sendLimit('output')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(peer.frames).toEqual([{ kind: 'limit', limit: 'output' }])
    peer.end()
    await live.dispose()
  })

  it('names unreachable frame variants through the exhaustiveness guard', async () => {
    const { assertNever } = await import('@deepseek-ai/dsh-control-channel')
    expect(() => assertNever({ kind: 'rogue' } as never, 'ControlFrame dispatch')).toThrow('unreachable variant in ControlFrame dispatch: {"kind":"rogue"}')
    expect(() => assertNever(undefined as never, 'ControlFrame dispatch')).toThrow('unreachable variant in ControlFrame dispatch: undefined')
  })

  it('drops in-flight handler replies after the channel terminated', async () => {
    const { channel, peer } = makeChannel({
      onCall: async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
        return 'late'
      },
    })
    peer.send({ kind: 'call', id: 1, target: 'host.slow', args: [] })
    await new Promise(resolve => setTimeout(resolve, 10))
    channel.cancel('no longer needed')
    await channel.outcome()
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(peer.frames.filter(frame => frame.kind === 'reply')).toEqual([])
    peer.end()
    await channel.dispose()
  })

  it('contains handler crashes as cleanup notes while the channel lives on', async () => {
    const { channel, peer } = makeChannel({ onLog: (text) => { if (text === 'boom') throw new Error('log handler exploded') } })
    peer.send({ kind: 'log', text: 'boom' })
    peer.send({ kind: 'log', text: 'fine' })
    peer.send({ kind: 'done', value: 1 })
    await channel.outcome()
    peer.end()
    await channel.waitSettled()
    const errors = await channel.dispose()
    expect(errors).toEqual(['frame handler failed: log handler exploded'])
  })

  it('fails a hostile peer that sends a frame outside the union', async () => {
    const { channel, peer } = makeChannel()
    peer.send({ kind: 'rogue' } as unknown as ControlFrame)
    const outcome = await channel.outcome()
    expect(outcome).toEqual({ kind: 'failure', failure: { kind: 'protocol', message: 'unreachable variant in ControlFrame dispatch: {"kind":"rogue"}' } })
    peer.end()
    await channel.dispose()
  })

  it('clears per-call timers when the send fails and when dispose settles a pending timed call', async () => {
    const { channel } = makeChannel()
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    await expect(channel.call('program.bad', cyclic, { timeoutMs: 1_000 })).rejects.toThrow(TypeError)

    const waiting = channel.call('program.slow', [], { timeoutMs: 1_000 })
    waiting.catch(() => undefined)
    await expect(channel.dispose()).resolves.toEqual([])
    await expect(waiting).rejects.toMatchObject({ failure: { kind: 'abort', message: 'disposed before a terminal outcome' } })
  })
})

describe('real child-process disposal', () => {
  it('walks a speaking child from running to cleaned-up', async () => {
    const child = spawn(process.execPath, ['-e', [
      'const send=(f,cb)=>{const b=Buffer.from(JSON.stringify(f));const h=Buffer.alloc(4);h.writeUInt32BE(b.length,0);process.stdout.write(Buffer.concat([h,b]),cb)}',
      'let buf=Buffer.alloc(0);process.stdin.on("data",(c)=>{buf=Buffer.concat([buf,c]);while(buf.length>=4){const n=buf.readUInt32BE(0);if(buf.length<4+n)break;const f=JSON.parse(buf.subarray(4,4+n));buf=buf.subarray(4+n);if(f.kind==="call"){send({kind:"reply",id:f.id,ok:true,value:f.args[0]*2})}else if(f.kind==="log"&&f.text==="finish"){send({kind:"done",value:"child-complete"},()=>process.exit(0))}}})',
      'send({kind:"log",text:"ready"})',
    ].join('\n')])
    const logs: string[] = []
    const channel = new ControlChannelTransport({
      input: child.stdout,
      output: child.stdin,
      handlers: { onLog: text => logs.push(text) },
      forceTerminate: () => {
        child.kill('SIGKILL')
      },
    })
    await new Promise<void>((resolve) => {
      const check = () => {
        if (logs.includes('ready')) resolve()
        else setTimeout(check, 5)
      }
      check()
    })
    expect(channel.lifecycleState).toBe('running')
    await expect(channel.call('double', [3])).resolves.toBe(6)
    channel.sendLog('finish')
    expect(await channel.outcome()).toEqual({ kind: 'value', value: 'child-complete' })
    await channel.waitSettled()
    await expect(channel.dispose()).resolves.toEqual([])
    expect(channel.lifecycleState).toBe('cleaned-up')
  })

  it('force-kills an unresponsive child after the grace expires', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1<<30)'])
    let kills = 0
    const channel = new ControlChannelTransport({
      input: child.stdout,
      output: child.stdin,
      deadlineMs: 40,
      limits: graceLimits,
      forceTerminate: () => {
        kills += 1
        child.kill('SIGKILL')
      },
    })
    const outcome = await channel.outcome()
    expect(outcome).toMatchObject({ kind: 'failure', failure: { kind: 'timeout', message: /deadline/ } })
    await channel.waitSettled()
    expect(kills).toBe(1)
    await expect(channel.dispose()).resolves.toEqual([])
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once('exit', () => { resolve() })
      })
    }
    expect(child.signalCode).toBe('SIGKILL')
  })
})

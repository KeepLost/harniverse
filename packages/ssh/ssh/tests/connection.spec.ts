/** SshConnection over a mocked ssh child: handshake verification, liveness, failure paths, and disposal. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { SshConnection } from '../src/index.ts'
import { SshRpcPeer } from '../src/protocol.ts'
import { describeExecutionWorld } from '../src/world.ts'

const spawnState = vi.hoisted(() => ({
  factory: null as null | (() => object),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: () => {
      if (!spawnState.factory) throw new Error('no fake child factory installed')
      return spawnState.factory()
    },
  }
})

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  killed = false
  signals: string[] = []
  ignoreTerm = false
  delayClose = false
  private shut = false

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true
    this.signals.push(signal)
    if (signal === 'SIGTERM' && this.ignoreTerm) return true
    if (!this.shut) {
      this.shut = true
      const emit = (): void => { this.emit('close', 0, signal) }
      if (this.delayClose) setTimeout(emit, 1200)
      else queueMicrotask(emit)
    }
    return true
  }
}

const profile = { id: 'ssh', revision: 'host-1', mcp: {}, skills: [], hooks: [] }
const emptyInventory = { mcp: [], skills: [], hooks: [] }
const baseConfig = {
  host: 'target-host', node: '/usr/bin/node', helper: '/opt/helper.mjs',
  helperHash: 'a'.repeat(64), workspace: '/remote/workspace', profile,
}

interface ServerScript {
  hash?: string
  describeWorkspace?: string
  heartbeat?: () => unknown
  slow?: number
}

const tracked: { child: FakeChild; peer: SshRpcPeer }[] = []
const connections: SshConnection[] = []
const contexts: Context[] = []

const boot = (config: Record<string, unknown>, script: ServerScript = {}) => {
  const child = new FakeChild()
  spawnState.factory = () => child
  const merged = { ...baseConfig, ...config }
  const ctx = new Context()
  contexts.push(ctx)
  const connection = new SshConnection(ctx, merged)
  connections.push(connection)
  const peer = new SshRpcPeer(child.stdin, child.stdout, undefined, undefined, async (method, params) => {
    if (method === 'hello') {
      return {
        protocol: 1, hash: script.hash ?? merged.helperHash, platform: 'linux',
        nodeVersion: process.versions.node, node: merged.node, workspace: merged.workspace,
      }
    }
    if (method === 'world.describe') {
      return describeExecutionWorld(script.describeWorkspace ?? merged.workspace, profile.revision, profile, emptyInventory)
    }
    if (method === 'heartbeat') return await Promise.resolve(script.heartbeat?.() ?? null)
    if (script.slow) await new Promise((resolve) => { setTimeout(resolve, script.slow) })
    return { echoed: params }
  })
  tracked.push({ child, peer })
  return { child, peer, connection, ctx }
}

const cleanup = async (): Promise<void> => {
  await Promise.all(connections.splice(0).map(connection => connection.dispose().catch(() => {})))
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose().catch(() => {})))
  for (const { child, peer } of tracked.splice(0)) {
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    await peer.dispose().catch(() => {})
  }
  spawnState.factory = null
}

describe('SshConnection startup', () => {
  it('rejects impossible configs before spawning', () => {
    spawnState.factory = () => new FakeChild()
    const invalid = [
      { ...baseConfig, host: 'bad host!' },
      { ...baseConfig, helperHash: 'nothex' },
      { ...baseConfig, bootstrapPath: '/opt/ptc.mjs' },
      { ...baseConfig, requestTimeoutMs: 50 },
      { ...baseConfig, extra: true },
    ]
    for (const config of invalid) expect(() => new SshConnection(new Context(), config as never)).toThrow()
    spawnState.factory = null
  })

  it('requires a POSIX Host', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      expect(() => boot({})).toThrow('SSH execution requires a POSIX Host')
    } finally {
      Object.defineProperty(process, 'platform', { value: platform?.value, configurable: true })
    }
  })

  it('refuses a helper digest mismatch and a drifted workspace description', async () => {
    try {
      const mismatch = boot({ helperHash: 'b'.repeat(64) }, { hash: 'c'.repeat(64) })
      await expect(mismatch.connection.ready).rejects.toThrow('SSH helper digest mismatch')
      await expect(mismatch.connection.describeWorld()).rejects.toThrow('SSH helper digest mismatch')
      const drifted = boot({}, { describeWorkspace: '/elsewhere/workspace' })
      await expect(drifted.connection.ready).rejects.toThrow('SSH world workspace differs from handshake')
    } finally { await cleanup() }
  })

  it('completes the handshake, echoes requests, and exposes negotiated facts', async () => {
    try {
      const { connection, child } = boot({
        sshConfig: '/etc/ssh/custom', bootstrapPath: '/opt/ptc.mjs', bootstrapHash: 'e'.repeat(64),
      }, { slow: 200 })
      const hello = await connection.ready
      expect(connection.signal.aborted).toBe(false)
      expect(hello.hash).toBe('a'.repeat(64))
      expect(connection.nodeExecutable).toBe('/usr/bin/node')
      expect(connection.bootstrapPath).toBe('/opt/ptc.mjs')
      expect(await connection.describeWorld()).toHaveProperty('descriptor.transport', 'ssh')
      const echoed = await connection.request('echo', { payload: 1 }, z.unknown()) as { echoed: unknown }
      expect(echoed.echoed).toEqual({ payload: 1 })
      const waited = await connection.request('slow.echo', { payload: 2 }, z.unknown(), undefined, true) as { echoed: unknown }
      expect(waited.echoed).toEqual({ payload: 2 })
      await expect(connection.request('echo', {}, z.unknown(), AbortSignal.abort(new Error('late')))).rejects.toThrow('late')
      expect(await connection.describeWorld()).toHaveProperty('descriptor.transport', 'ssh')
      const controller = new AbortController()
      const inflight = connection.request('echo', {}, z.unknown(), controller.signal)
      await new Promise((resolve) => { setTimeout(resolve, 50) })
      controller.abort(new Error('caller stopped'))
      await expect(inflight).rejects.toThrow('SSH operation cancelled')
      await expect(connection.describeWorld()).rejects.toThrow('SSH operation cancelled')
      expect(child.signals).toContain('SIGTERM')
      await connection.dispose()
      await expect(connection.request('echo', {}, z.unknown())).rejects.toThrow()
    } finally { await cleanup() }
  })

  it('times out administrative requests that outrun their deadline', async () => {
    try {
      const { connection } = boot({ requestTimeoutMs: 100 }, { slow: 400 })
      await connection.ready
      await expect(connection.request('echo', {}, z.unknown())).rejects.toThrow()
      await expect(connection.describeWorld()).rejects.toThrow()
    } finally { await cleanup() }
  })
})

describe('SshConnection liveness', () => {
  it('fails on child error, child exit, and transport closure', async () => {
    try {
      const errored = boot({})
      await errored.connection.ready
      errored.child.emit('error', new Error('ssh binary vanished'))
      await expect(errored.connection.describeWorld()).rejects.toThrow('ssh binary vanished')
      expect(() => errored.connection.nodeExecutable).toThrow('ssh binary vanished')
      expect(() => errored.connection.bootstrapPath).toThrow('ssh binary vanished')
      expect(errored.connection.signal.aborted).toBe(true)
      const exited = boot({})
      await exited.connection.ready
      expect(() => exited.connection.bootstrapPath).toThrow('requires a configured bootstrapPath')
      exited.child.emit('close', 1, null)
      await expect(exited.connection.describeWorld()).rejects.toThrow('SSH helper disconnected')
      const severed = boot({})
      await severed.connection.ready
      severed.child.stdout.destroy()
      await new Promise((resolve) => { setImmediate(resolve) })
      await expect(severed.connection.describeWorld()).rejects.toThrow('SSH disconnected')
    } finally { await cleanup() }
  })

  it('skips overlapping heartbeats and fails the connection when one is refused', async () => {
    try {
      let slow = true
      const healthy = boot({ leaseMs: 3000 }, {
        heartbeat: async () => {
          if (!slow) return null
          slow = false
          await new Promise((resolve) => { setTimeout(resolve, 1200) })
          return null
        },
      })
      await healthy.connection.ready
      await new Promise((resolve) => { setTimeout(resolve, 2600) })
      expect(await healthy.connection.describeWorld()).toHaveProperty('descriptor.transport', 'ssh')
      await healthy.connection.dispose()
      await expect(healthy.connection.request('echo', {}, z.unknown())).rejects.toThrow('SSH connection disposed')
      const refused = boot({ leaseMs: 3000 }, { heartbeat: () => { throw new Error('heartbeat refused') } })
      await refused.connection.ready
      await new Promise((resolve) => { setTimeout(resolve, 1300) })
      await expect(refused.connection.describeWorld()).rejects.toThrow('heartbeat refused')
    } finally { await cleanup() }
  }, 15_000)

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    try {
      const { connection, child } = boot({})
      child.ignoreTerm = true
      await connection.ready
      await connection.dispose()
      expect(child.signals).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL'])
    } finally { await cleanup() }
  }, 10_000)

  it('runs both SIGKILL escalations when a failing child lingers past disposal', async () => {
    try {
      const { connection, child } = boot({ leaseMs: 600_000 }, { slow: 200 })
      child.ignoreTerm = true
      child.delayClose = true
      await connection.ready
      const controller = new AbortController()
      const inflight = connection.request('echo', {}, z.unknown(), controller.signal)
      await new Promise((resolve) => { setTimeout(resolve, 50) })
      controller.abort(new Error('caller stopped'))
      await expect(inflight).rejects.toThrow('SSH operation cancelled')
      const disposal = connection.dispose()
      await disposal
      expect(child.signals).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL', 'SIGKILL'])
    } finally { await cleanup() }
  }, 10_000)

  it('starts through the plugin lifecycle and disposes with its context', async () => {
    try {
      spawnState.factory = () => {
        const child = new FakeChild()
        const peer = new SshRpcPeer(child.stdin, child.stdout, undefined, undefined, async (method) => {
          if (method === 'hello') {
            return {
              protocol: 1, hash: baseConfig.helperHash, platform: 'linux',
              nodeVersion: process.versions.node, node: baseConfig.node, workspace: baseConfig.workspace,
            }
          }
          if (method === 'world.describe') return describeExecutionWorld(baseConfig.workspace, profile.revision, profile, emptyInventory)
          return null
        })
        tracked.push({ child, peer })
        return child
      }
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SshConnection, { ...baseConfig, leaseMs: 600_000 })
      const connection = (ctx as { ssh: SshConnection }).ssh
      expect(await connection.ready).toHaveProperty('protocol', 1)
      const child = tracked.at(-1)!.child
      await ctx.fiber.dispose()
      expect(child.signals).toContain('SIGTERM')
    } finally { await cleanup() }
  })
})

import { PassThrough } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SshRpcPeer } from '../src/protocol.ts'
import { runSshHelper } from '../src/helper.ts'
import { helloSchema, processStateSchema } from '../src/schemas.ts'
import { parseWorldDescription } from '../src/world.ts'

describe('real machine helper providers', () => {
  it('reads remote files, executes and cleans processes, and reports the captured machine inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w10-helper-'))
    const entry = join(root, 'helper.js')
    await writeFile(entry, 'fixture helper identity')
    await writeFile(`${entry}.machine.json`, JSON.stringify({ revision: 'machine-1', mcp: [], skillDirectories: [], hooks: [] }))
    await writeFile(join(root, 'remote.txt'), 'remote file')
    const input = new PassThrough()
    const output = new PassThrough()
    const controller = new AbortController()
    const running = runSshHelper({ input, output, entryPath: entry, signal: controller.signal })
    const peer = new SshRpcPeer(output, input)
    try {
      const hello = await peer.request('hello', { protocol: 1, workspace: root, leaseMs: 3000, profile: { id: 'ssh', revision: 'host-2', mcp: {}, skills: [], hooks: [] } }, helloSchema)
      expect(hello.workspace).toBe(root)
      const world = parseWorldDescription(await peer.request('world.describe', {}, z.unknown()))
      expect(world.profile.revision).toBe('host-2')
      expect(world.descriptor.revision).toBe('machine-1')
      const target = await peer.request('fs.resolve', { path: 'remote.txt' }, z.unknown())
      expect(Buffer.from(await peer.request('fs.readBytes', { target, maxBytes: 128 }, z.string()), 'base64').toString()).toBe('remote file')
      const process = await peer.request('process.spawn', { argv: ['/bin/sh', '-c', 'printf remote'], cwd: root, graceMs: 100,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } }, z.object({ id: z.string(), pid: z.number() }))
      await expect.poll(async () => (await peer.request('process.state', { id: process.id }, processStateSchema)).outcome).toEqual({ exitCode: 0, signal: null })
      expect((await peer.request('process.state', { id: process.id }, processStateSchema)).collected.stdout?.text).toBe('remote')
      await peer.request('process.release', { id: process.id }, z.null())
      await peer.request('close', {}, z.null())
    } finally {
      controller.abort()
      await peer.dispose()
      await running
      await rm(root, { recursive: true, force: true })
    }
  })
})

/** In-memory helper harness: real runSshHelper over PassThrough streams plus fake host services. */
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { MachineConfig } from '../../src/machine.ts'
import { runSshHelper } from '../../src/helper.ts'
import { SshRpcPeer } from '../../src/protocol.ts'
import { helloSchema, type Hello } from '../../src/schemas.ts'

/** Minimal captured Profile accepted by the handshake. */
export const profile = { id: 'ssh', revision: 'host-1', mcp: {}, skills: [], hooks: [] }

export interface HelperHarness {
  root: string
  entry: string
  manifest: MachineConfig
  peer: SshRpcPeer
  running: Promise<void>
  controller: AbortController
  hello: () => Promise<Hello>
  request: SshRpcPeer['request']
  close: () => Promise<void>
}

export interface HelperOptions {
  manifest?: MachineConfig
  handshake?: boolean
}

/** Boot the real helper against a temporary machine root and a client peer sharing its streams. */
export async function createHelper(options: HelperOptions = {}): Promise<HelperHarness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'w10-ssh-')))
  const entry = join(root, 'helper.js')
  await writeFile(entry, 'fixture helper identity')
  const manifest: MachineConfig = options.manifest ?? { revision: 'machine-1', mcp: [], skillDirectories: [], hooks: [] }
  await writeFile(`${entry}.machine.json`, JSON.stringify(manifest))
  const input = new PassThrough()
  const output = new PassThrough()
  const controller = new AbortController()
  const running = runSshHelper({ input, output, entryPath: entry, signal: controller.signal })
  const peer = new SshRpcPeer(output, input)
  const harness: HelperHarness = {
    root, entry, manifest, peer, running, controller,
    hello: () => peer.request('hello', { protocol: 1, workspace: root, leaseMs: 600_000, profile }, helloSchema),
    request: (method, params, schema, signal) => peer.request(method, params, schema, signal),
    close: async () => {
      controller.abort()
      await peer.dispose().catch(() => {})
      await running.catch(() => {})
      await rm(root, { recursive: true, force: true })
    },
  }
  if (options.handshake !== false) await harness.hello()
  return harness
}

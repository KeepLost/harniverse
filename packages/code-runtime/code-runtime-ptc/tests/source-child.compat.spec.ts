import { copyFile, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { ControlChannelTransport } from '@deepseek-ai/dsh-control-channel'
import { decodeWorkerJson } from '../src/json-wire.ts'

/**
 * Prove the unbuilt child is a source-closure boot: copying its four source
 * files out of the package (with a node_modules link for the shared
 * control-channel contract, which the child imports by design) runs the
 * program without this package's own `lib/` artifacts — even when they happen
 * to exist.
 */
it('boots the source child without this package\'s outputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-code-source-child-'))
  try {
    const files = ['child.ts', 'child-exec.ts', 'json-wire.ts', 'output-json.ts']
    await Promise.all(files.map(async (file) => {
      await copyFile(new URL(`../src/${file}`, import.meta.url), join(directory, file))
    }))
    await symlink(resolve(fileURLToPath(new URL('../node_modules', import.meta.url))), join(directory, 'node_modules'), 'dir')

    const child = spawn(process.execPath, [join(directory, 'child.ts')], { stdio: ['pipe', 'pipe', 'ignore'] })
    const channel = new ControlChannelTransport({ input: child.stdout, output: child.stdin })
    // Rejection is observed (the channel ends without a second call) but not
    // awaited: the done frame, not the ack, settles the assertion below.
    channel.call('run', ['return { answer: 21 * 2 }', [], 65_536, 60_000, 1_000_000]).catch(() => undefined)
    const outcome = await channel.outcome()
    expect(outcome.kind).toBe('value')
    expect(decodeWorkerJson(outcome.kind === 'value' ? outcome.value : undefined)).toEqual({ answer: 42 })
    await channel.waitSettled()
    await channel.dispose()
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolveExit) => {
        child.once('exit', () => { resolveExit() })
      })
    }
    expect(child.exitCode).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

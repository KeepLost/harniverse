import { expect, it } from 'vitest'
import type { RemoteHostSshConnection } from '@deepseek-ai/dsh-remote-hosts-ssh'
import { deploy, startDetached } from '../src/deploy.ts'
import { remoteHostId } from '../src/validation.ts'
import { hostInput } from './fixture.ts'
import type { HostRecord } from '../src/types.ts'

const host: HostRecord = { ...hostInput, id: remoteHostId('84fbdabb-7814-4d13-a19a-5afeb7b1eb50'), reverseMappings: [] }
const artifact = { digest: 'a'.repeat(64), executable: 'node', files: [
  { path: 'node', localPath: '/local/node', sha256: 'b'.repeat(64), bytes: 100, mode: 0o700 },
  { path: 'app/lib/bin.js', localPath: '/local/bin.js', sha256: 'c'.repeat(64), bytes: 100, mode: 0o600 },
] }

it('rejects native Node hash failure before any copied executable runs', async () => {
  const commands: string[] = []
  const connection = { async exec(cmd: string) {
    commands.push(cmd)
    return { stdout: Buffer.from(cmd.includes('printf yes') ? 'no' : ''), stderr: Buffer.alloc(0),
      exitCode: cmd.includes('sha256sum') ? 1 : 0, signal: null }
  }, async upload() {}, async mkdir() {} } as unknown as RemoteHostSshConnection
  await expect(deploy(connection, host, '/remote/home', artifact, new AbortController().signal)).rejects.toThrow('REMOTE_COMMAND_FAILED')
  expect(commands.some(cmd => cmd.includes('--input-type=module'))).toBe(false)
})

it('uses macOS native hashing and brokers Windows startup outside the SSH process job', async () => {
  const commands: string[] = []
  const connection = { async exec(cmd: string) {
    commands.push(cmd)
    return { stdout: Buffer.from(cmd.includes('printf yes') ? 'yes' : ''), stderr: Buffer.alloc(0), exitCode: 0, signal: null }
  } } as unknown as RemoteHostSshConnection
  await deploy(connection, { ...host, platform: 'darwin' }, '/Users/runner/.dsh', artifact, new AbortController().signal)
  expect(commands.some(cmd => cmd.includes('/usr/bin/shasum -a 256'))).toBe(true)
  commands.length = 0
  await startDetached(connection, { ...host, platform: 'win32' }, "C:/Users/Runner's Home/.dsh",
    "C:/Users/Runner's Home/.dsh/server/releases/abc", new AbortController().signal)
  const outer = Buffer.from(commands[0]!.split(' ').at(-1)!, 'base64').toString('utf16le')
  expect(outer).toContain('Win32_Process')
  expect(outer).toContain('CreateFlags=16777216')
  expect(outer).toContain('ReturnValue -ne 0')
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(outer)![1]!
  const inner = Buffer.from(encoded, 'base64').toString('utf16le')
  expect(inner).toContain('Start-Process')
  expect(inner).toContain("Runner''s Home")
  expect(inner).toContain("-ArgumentList 'app/lib/bin.js --port 0'")
})

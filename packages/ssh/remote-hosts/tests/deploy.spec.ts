import { expect, it } from 'vitest'
import type { RemoteHostSshConnection } from '@deepseek-ai/dsh-remote-hosts-ssh'
import { bootstrapGrant, deploy, processAlive, startDetached } from '../src/deploy.ts'
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
      exitCode: cmd.includes(host.platform === 'darwin' ? 'shasum' : 'sha256sum') ? 1 : 0, signal: null }
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

it('builds a PowerShell deployment command for Windows releases', async () => {
  const commands: string[] = []
  const connection = {
    async exec(cmd: string) {
      commands.push(cmd)
      const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(cmd)?.[1]
      const script = encoded === undefined ? cmd : Buffer.from(encoded, 'base64').toString('utf16le')
      return { stdout: Buffer.from(script.includes("Write-Output 'yes'") ? 'no' : ''), stderr: Buffer.alloc(0), exitCode: 0, signal: null }
    },
    async upload() {},
    async mkdir() {},
  } as unknown as RemoteHostSshConnection
  await deploy(connection, { ...host, platform: 'win32' }, 'C:/Runner/.dsh', {
    ...artifact, executable: 'node.exe', files: [{ ...artifact.files[0]!, path: 'node.exe' }, artifact.files[1]!],
  }, new AbortController().signal)
  expect(commands.some(command => command.includes('powershell.exe') && command.includes('EncodedCommand'))).toBe(true)
})

it('publishes a verified fresh release and validates grant and process probes', async () => {
  const commands: string[] = []
  const uploads: string[] = []
  const directories: string[] = []
  let processState = 'live'
  let grantResponse = '{"id":"grant-id"}'
  const connection = {
    async exec(cmd: string, input?: Buffer | string) {
      commands.push(cmd)
      if (cmd.includes('printf yes')) return { stdout: Buffer.from('no'), stderr: Buffer.alloc(0), exitCode: 0, signal: null }
      if (cmd.includes('sha256sum')) return { stdout: Buffer.from(`${'b'.repeat(64)}  node\n`), stderr: Buffer.alloc(0), exitCode: 0, signal: null }
      if (input?.toString().includes('publicKey')) return { stdout: Buffer.from(grantResponse), stderr: Buffer.alloc(0), exitCode: 0, signal: null }
      if (cmd.includes('process.kill')) return { stdout: Buffer.from(processState), stderr: Buffer.alloc(0), exitCode: 0, signal: null }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, signal: null }
    },
    async upload(_source: string, target: string) { uploads.push(target) },
    async mkdir(path: string) { directories.push(path) },
  } as unknown as RemoteHostSshConnection
  const release = await deploy(connection, host, '/remote/home', artifact, new AbortController().signal)
  expect(release).toContain(artifact.digest)
  expect(uploads).toHaveLength(2)
  expect(uploads.every(path => path.includes('/.upload-'))).toBe(true)
  expect(directories.some(path => path.endsWith('/app/lib'))).toBe(true)
  expect(commands.some(cmd => cmd.includes('mv '))).toBe(true)
  expect(await bootstrapGrant(connection, host, '/remote/home', release, 'public-key', new AbortController().signal)).toBe('grant-id')
  grantResponse = 'null'
  await expect(bootstrapGrant(connection, host, '/remote/home', release, 'public-key', new AbortController().signal)).rejects.toThrow('INVALID_GRANT')
  expect(await processAlive(connection, host, '/remote/home', release, 1234, new AbortController().signal)).toBe(true)
  processState = 'dead'
  expect(await processAlive(connection, host, '/remote/home', release, 1234, new AbortController().signal)).toBe(false)
  processState = 'unknown'
  await expect(processAlive(connection, host, '/remote/home', release, 1234, new AbortController().signal)).rejects.toThrow('INVALID_PROCESS_STATUS')
})

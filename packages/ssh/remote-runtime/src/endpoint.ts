/** Private, atomic endpoint publication under the app's exclusive home lease. */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { RuntimeEndpoint } from './types.ts'

const exec = promisify(execFile)

async function protectDirectory(directory: string): Promise<void> {
  if (process.platform !== 'win32') { await chmod(directory, 0o700); return }
  // POSIX mode bits do not establish a Windows DACL. Children inherit this owner-only rule.
  const command = [
    '$ErrorActionPreference = "Stop"',
    '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$acl = New-Object System.Security.AccessControl.DirectorySecurity',
    '$acl.SetOwner($sid)',
    '$acl.SetAccessRuleProtection($true, $false)',
    '$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")',
    '$acl.AddAccessRule($rule)',
    'Set-Acl -LiteralPath $env:DSH_ENDPOINT_DIRECTORY -AclObject $acl',
  ].join('\n')
  await exec(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { env: { ...process.env, DSH_ENDPOINT_DIRECTORY: directory }, timeout: 15_000 })
}

/**
 * Publish the listening process identity and return an ownership-checked disposer.
 * @param home - exclusively leased Harness home.
 * @param endpoint - bound listener and this runtime's boot identity.
 * @returns cleanup that preserves a descriptor published by a successor.
 */
export async function publishEndpoint(home: string, endpoint: RuntimeEndpoint): Promise<() => Promise<void>> {
  const directory = join(home, 'server')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('remote-runtime: server directory must not be a symlink')
  if (process.getuid !== undefined && info.uid !== process.getuid()) {
    throw new Error('remote-runtime: server directory must belong to the current user')
  }
  await protectDirectory(directory)
  const filename = join(directory, 'endpoint.json')
  const temporary = join(directory, `.endpoint-${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(endpoint) + '\n')
    await file.sync()
    await file.close()
    await rename(temporary, filename)
  } finally {
    await file.close()
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
  return async () => {
    let text: string
    try { text = await readFile(filename, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    let current: Partial<RuntimeEndpoint> | null
    try { current = JSON.parse(text) as Partial<RuntimeEndpoint> | null } catch {
      // An unreadable replacement is not this publisher's descriptor.
      return
    }
    if (current?.bootId !== endpoint.bootId || current.pid !== endpoint.pid) return
    await unlink(filename).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

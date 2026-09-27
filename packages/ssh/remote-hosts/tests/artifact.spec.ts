import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { inspectArtifact } from '../src/artifact.ts'
import { command, remoteHome } from '../src/platform.ts'

it('validates hashes and expands portable directory links into verified regular files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-artifact-'))
  const dir = join(root, 'linux-x64')
  try {
    await mkdir(join(dir, 'app/lib'), { recursive: true })
    const entries: Array<{ path: string; bytes: number; sha256: string; link?: string }> = []
    for (const [path, content] of [['node', 'test node'], ['app/lib/bin.js', 'test app']]) {
      await writeFile(join(dir, path!), content!)
      entries.push({ path: path!, bytes: Buffer.byteLength(content!), sha256: createHash('sha256').update(content!).digest('hex') })
    }
    await symlink('lib', join(dir, 'app/alias'))
    entries.push({ path: 'app/alias', bytes: 3, sha256: createHash('sha256').update('lib').digest('hex'), link: 'lib' })
    const manifest = JSON.stringify({ formatVersion: 1, package: '@deepseek-ai/dsh-remote-server', version: 'test',
      node: { platform: 'linux', arch: 'x64', version: 'v24.0.0', modules: '137' },
      launch: { executable: 'node', args: ['app/lib/bin.js', '--port', '0'] }, files: entries })
    await writeFile(join(dir, 'manifest.json'), manifest)
    await writeFile(join(dir, 'manifest.sha256'), `${createHash('sha256').update(manifest).digest('hex')}  manifest.json\n`)
    const artifact = await inspectArtifact(root, 'linux', 'x64')
    expect(artifact.files.map(file => file.path).sort()).toEqual(['app/alias/bin.js', 'app/lib/bin.js', 'node'])
    await writeFile(join(dir, 'node'), 'tampered!')
    await expect(inspectArtifact(root, 'linux', 'x64')).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('quotes native Windows commands and resolves server-native homes', () => {
  expect(remoteHome('win32', '/C:/Users/Runner', undefined)).toBe('C:/Users/Runner/.dsh')
  expect(remoteHome('linux', '/home/runner', undefined)).toBe('/home/runner/.dsh')
  const encoded = command('win32', "Write-Output 'x&y'").split(' ').at(-1)!
  expect(Buffer.from(encoded, 'base64').toString('utf16le')).toContain("Write-Output 'x&y'")
})

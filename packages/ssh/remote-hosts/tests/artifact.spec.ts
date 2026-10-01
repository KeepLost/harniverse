import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { inspectArtifact } from '../src/artifact.ts'
import { command, nodeCommand, quote, remoteHome } from '../src/platform.ts'

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
    await expect(inspectArtifact('relative-artifacts', 'linux', 'x64')).rejects.toThrow('ARTIFACT_ROOT_NOT_ABSOLUTE')
    const writeManifest = async (value: unknown): Promise<void> => {
      const document = JSON.stringify(value)
      await writeFile(join(dir, 'manifest.json'), document)
      await writeFile(join(dir, 'manifest.sha256'), `${createHash('sha256').update(document).digest('hex')}  manifest.json\n`)
    }
    await writeFile(join(dir, 'manifest.sha256'), 'bad  manifest.json\n')
    await expect(inspectArtifact(root, 'linux', 'x64')).rejects.toThrow('ARTIFACT_HASH_MISMATCH')
    await writeFile(join(dir, 'manifest.sha256'), `${createHash('sha256').update(manifest).digest('hex')}  manifest.json\n`)
    await writeFile(join(root, 'outside'), 'outside artifact root')
    await symlink('../../outside', join(dir, 'app/escape'))
    const escape = { path: 'app/escape', bytes: Buffer.byteLength('../../outside'),
      sha256: createHash('sha256').update('../../outside').digest('hex'), link: '../../outside' }
    await writeManifest({ ...(JSON.parse(manifest) as object), files: [...entries, escape] })
    await expect(inspectArtifact(root, 'linux', 'x64')).rejects.toThrow('ARTIFACT_LINK_ESCAPE')
    await rm(join(dir, 'app/escape'))
    await writeManifest(JSON.parse(manifest))
    const platformMismatch = JSON.parse(manifest) as { node: { platform: string } }
    platformMismatch.node.platform = 'darwin'
    const platformManifest = JSON.stringify(platformMismatch)
    await writeFile(join(dir, 'manifest.json'), platformManifest)
    await writeFile(join(dir, 'manifest.sha256'), `${createHash('sha256').update(platformManifest).digest('hex')}  manifest.json\n`)
    await expect(inspectArtifact(root, 'linux', 'x64')).rejects.toThrow('ARTIFACT_PLATFORM_MISMATCH')
    await writeFile(join(dir, 'manifest.json'), manifest)
    await writeFile(join(dir, 'manifest.sha256'), `${createHash('sha256').update(manifest).digest('hex')}  manifest.json\n`)
    await writeManifest({ ...(JSON.parse(manifest) as object), node: { platform: 'linux', arch: 'arm64', version: 'v24.0.0', modules: '137' } })
    await expect(inspectArtifact(root, 'linux', 'x64')).rejects.toThrow('ARTIFACT_PLATFORM_MISMATCH')
    await writeManifest({ ...(JSON.parse(manifest) as object), launch: { executable: 'node.exe', args: ['app/lib/bin.js', '--port', '0'] } })
    await expect(inspectArtifact(root, 'linux', 'x64')).rejects.toThrow('ARTIFACT_PLATFORM_MISMATCH')
    await writeManifest({ ...(JSON.parse(manifest) as object), files: [...entries, entries[0]] })
    await expect(inspectArtifact(root, 'linux', 'x64')).rejects.toThrow('INVALID_ARTIFACT')
    const nested = [...entries, { ...entries[1]!, path: 'app/alias/bin.js' }]
    await writeManifest({ ...(JSON.parse(manifest) as object), files: nested })
    await expect(inspectArtifact(root, 'linux', 'x64')).rejects.toThrow('INVALID_ARTIFACT')
    await writeManifest(JSON.parse(manifest))
    const missingExecutable = JSON.parse(manifest) as { files: Array<{ path: string }> }
    missingExecutable.files = missingExecutable.files.filter(file => file.path !== 'node')
    const missingManifest = JSON.stringify(missingExecutable)
    await writeFile(join(dir, 'manifest.json'), missingManifest)
    await writeFile(join(dir, 'manifest.sha256'), `${createHash('sha256').update(missingManifest).digest('hex')}  manifest.json\n`)
    await expect(inspectArtifact(root, 'linux', 'x64')).rejects.toThrow('INVALID_ARTIFACT')
    await writeFile(join(dir, 'manifest.json'), manifest)
    await writeFile(join(dir, 'manifest.sha256'), `${createHash('sha256').update(manifest).digest('hex')}  manifest.json\n`)
    await rm(join(dir, 'app/alias'))
    await symlink('lib', join(dir, 'app/alias'))
    const mismatched = JSON.parse(manifest) as { files: Array<{ path: string; link?: string }> }
    mismatched.files.find(file => file.path === 'app/alias')!.link = 'other'
    const mismatchedManifest = JSON.stringify(mismatched)
    await writeFile(join(dir, 'manifest.json'), mismatchedManifest)
    await writeFile(join(dir, 'manifest.sha256'), `${createHash('sha256').update(mismatchedManifest).digest('hex')}  manifest.json\n`)
    await expect(inspectArtifact(root, 'linux', 'x64')).rejects.toThrow('INVALID_ARTIFACT_LINK')
    await writeFile(join(dir, 'manifest.json'), manifest)
    await writeFile(join(dir, 'manifest.sha256'), `${createHash('sha256').update(manifest).digest('hex')}  manifest.json\n`)
    await writeFile(join(dir, 'extra'), 'orphan')
    await rm(join(dir, 'app/alias'))
    await symlink('../extra', join(dir, 'app/alias'))
    const missingLinkTarget = JSON.parse(manifest) as { files: Array<{ path: string; link?: string; bytes?: number; sha256?: string }> }
    const missingLink = missingLinkTarget.files.find(file => file.path === 'app/alias')!
    missingLink.link = '../extra'
    missingLink.bytes = Buffer.byteLength('../extra')
    missingLink.sha256 = createHash('sha256').update('../extra').digest('hex')
    const missingTargetManifest = JSON.stringify(missingLinkTarget)
    await writeFile(join(dir, 'manifest.json'), missingTargetManifest)
    await writeFile(join(dir, 'manifest.sha256'), `${createHash('sha256').update(missingTargetManifest).digest('hex')}  manifest.json\n`)
    await expect(inspectArtifact(root, 'linux', 'x64')).rejects.toThrow('ARTIFACT_LINK_TARGET_MISSING')
    await rm(join(dir, 'app/alias'))
    await symlink('lib', join(dir, 'app/alias'))
    await writeFile(join(dir, 'manifest.json'), manifest)
    await writeFile(join(dir, 'manifest.sha256'), `${createHash('sha256').update(manifest).digest('hex')}  manifest.json\n`)
    await writeFile(join(dir, 'node'), 'tampered!')
    await expect(inspectArtifact(root, 'linux', 'x64')).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('quotes native Windows commands and resolves server-native homes', () => {
  expect(remoteHome('win32', '/C:/Users/Runner', undefined)).toBe('C:/Users/Runner/.dsh')
  expect(remoteHome('linux', '/home/runner', undefined)).toBe('/home/runner/.dsh')
  expect(() => remoteHome('linux', '/home/runner', '/')).toThrow('INVALID_REMOTE_HOME')
  const encoded = command('win32', "Write-Output 'x&y'").split(' ').at(-1)!
  expect(Buffer.from(encoded, 'base64').toString('utf16le')).toContain("Write-Output 'x&y'")
  expect(() => quote('linux', 'bad\0path')).toThrow('INVALID_REMOTE_PATH')
  expect(nodeCommand('win32', 'C:/release', "C:/Runner's/.dsh", "console.log('ok')")).toContain('EncodedCommand')
  expect(Buffer.from(nodeCommand('win32', 'C:/release', 'C:/Runner/.dsh', 'console.log(1)', true).split(' ').at(-1)!, 'base64')
    .toString('utf16le')).toContain('C:/release/app')
})

it('names a missing platform artifact and contains an unreadable one as invalid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-artifact-missing-'))
  try {
    // No `linux-x64` directory under the root: nothing was built for this target.
    await expect(inspectArtifact(root, 'linux', 'x64')).rejects.toMatchObject({ reason: 'ARTIFACT_NOT_FOUND' })
    // A present directory without its manifest pair is not a deployable artifact.
    await mkdir(join(root, 'linux-x64'))
    await expect(inspectArtifact(root, 'linux', 'x64')).rejects.toMatchObject({ reason: 'INVALID_ARTIFACT' })
    // A directory that resolves to nothing at all is a broken root, not a missing build.
    await symlink(join(root, 'loop-a'), join(root, 'loop-b'))
    await symlink(join(root, 'loop-b'), join(root, 'loop-a'))
    await rm(join(root, 'linux-x64'), { recursive: true })
    await symlink(join(root, 'loop-a'), join(root, 'linux-x64'))
    await expect(inspectArtifact(root, 'linux', 'x64')).rejects.toMatchObject({ reason: 'INVALID_ARTIFACT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects an oversized artifact manifest before parsing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-artifact-oversized-'))
  const dir = join(root, 'linux-x64')
  try {
    await mkdir(dir)
    // The digest pair exists, so the size bound is what rejects the level.
    await writeFile(join(dir, 'manifest.sha256'), 'bad  manifest.json\n')
    await writeFile(join(dir, 'manifest.json'), Buffer.alloc(32 * 1024 * 1024 + 1))
    await expect(inspectArtifact(root, 'linux', 'x64')).rejects.toThrow('INVALID_ARTIFACT')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('selects and verifies the native Windows executable entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-artifact-windows-'))
  const dir = join(root, 'win32-x64')
  try {
    await mkdir(join(dir, 'app/lib'), { recursive: true })
    const files = []
    for (const [path, content] of [['node.exe', 'windows node'], ['app/lib/bin.js', 'windows app']]) {
      await writeFile(join(dir, path!), content!)
      files.push({ path, bytes: Buffer.byteLength(content!), sha256: createHash('sha256').update(content!).digest('hex') })
    }
    const manifest = JSON.stringify({ formatVersion: 1, package: '@deepseek-ai/dsh-remote-server', version: 'test',
      node: { platform: 'win32', arch: 'x64', version: 'v24.0.0', modules: '137' },
      launch: { executable: 'node.exe', args: ['app/lib/bin.js', '--port', '0'] }, files })
    await writeFile(join(dir, 'manifest.json'), manifest)
    await writeFile(join(dir, 'manifest.sha256'), `${createHash('sha256').update(manifest).digest('hex')}  manifest.json\n`)
    await expect(inspectArtifact(root, 'win32', 'x64')).resolves.toMatchObject({ executable: 'node.exe' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

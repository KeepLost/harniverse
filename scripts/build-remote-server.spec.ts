import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { buildRemoteServer, inspectNode, sealArtifact } from './build-remote-server.ts'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), 'remote-artifact-'))
  directories.push(path)
  return path
}

it('records the native Node version and addon ABI from the actual candidate executable', async () => {
  expect(await inspectNode(process.execPath)).toEqual({
    platform: process.platform, arch: process.arch, version: process.version, modules: process.versions.modules,
  })
  await expect(inspectNode(join(await temporary(), 'missing-node'))).rejects.toThrow()
})

it('seals portable relative paths and SHA-256 digests for the complete artifact', async () => {
  const directory = await temporary()
  await mkdir(join(directory, 'app', 'lib'), { recursive: true })
  await writeFile(join(directory, 'app', 'lib', 'bin.js'), 'console.log("built")\n')
  const node = await inspectNode(process.execPath)
  const manifest = await sealArtifact(directory, node, '1.2.3')
  expect(manifest.launch).toEqual({ executable: process.platform === 'win32' ? 'node.exe' : 'node', args: ['app/lib/bin.js', '--port', '0'] })
  expect(manifest.files).toContainEqual({
    path: 'app/lib/bin.js', bytes: 21,
    sha256: createHash('sha256').update('console.log("built")\n').digest('hex'),
  })
  const bytes = await readFile(join(directory, 'manifest.json'))
  expect(await readFile(join(directory, 'manifest.sha256'), 'utf8')).toBe(`${createHash('sha256').update(bytes).digest('hex')}  manifest.json\n`)
})

it('refuses artifact symlinks escaping into the checkout or a temporary deploy source', async () => {
  const root = await temporary()
  const artifact = join(root, 'artifact')
  await mkdir(artifact)
  await writeFile(join(root, 'outside.js'), 'outside')
  await symlink('../outside.js', join(artifact, 'dependency.js'))
  await expect(sealArtifact(artifact, await inspectNode(process.execPath), '1')).rejects.toThrow(/escapes/)
})

it('runs deploy in a disposable workspace and preserves the checkout after deployment failure', async () => {
  const root = await temporary()
  const app = join(root, 'apps', 'remote-server')
  await mkdir(app, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }))
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
  const lock = 'lockfileVersion: "9.0"\nimporters:\n  apps/remote-server: {}\n'
  await writeFile(join(root, 'pnpm-lock.yaml'), lock)
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-remote-server', version: '1', files: ['lib'] }))
  const pnpm = join(root, 'fake-pnpm.cjs')
  await writeFile(pnpm, "require('node:fs').writeFileSync('pnpm-lock.yaml', 'mutated by deploy'); process.exit(7)\n")
  await expect(buildRemoteServer({ workspace: root, output: join(root, 'release'), pnpm, skipBuild: true })).rejects.toThrow(/7/)
  expect(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(lock)
  await expect(readFile(join(root, 'release', 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports a missing coordinator lockfile integration before invoking pnpm', async () => {
  const root = await temporary()
  await mkdir(join(root, 'apps/remote-server'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{}')
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\nimporters: {}\n')
  await writeFile(join(root, 'apps/remote-server/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-remote-server', version: '1' }))
  const pnpm = join(root, 'pnpm.cjs')
  await writeFile(pnpm, 'process.exit(9)')
  await expect(buildRemoteServer({ workspace: root, output: join(root, 'release'), pnpm, skipBuild: true })).rejects.toThrow(/lockfile.*apps\/remote-server.*coordinator/)
})

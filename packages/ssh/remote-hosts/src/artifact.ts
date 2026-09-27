/** Validate native artifacts locally and materialize portable links without remote symlink privileges. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, sep } from 'node:path'
import { z } from 'zod'
import { RemoteHostsError } from './validation.ts'
import type { RemoteArchitecture, RemotePlatform } from './types.ts'

const safePath = z.string().min(1).max(4096).refine(path => !path.startsWith('/') && !/[\\:\x00-\x1f]/.test(path)
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
const manifestSchema = z.strictObject({
  formatVersion: z.literal(1), package: z.literal('@deepseek-ai/dsh-remote-server'), version: z.string().min(1),
  node: z.strictObject({ platform: z.enum(['linux', 'darwin', 'win32']), arch: z.enum(['x64', 'arm64']), version: z.string(), modules: z.string() }),
  launch: z.strictObject({ executable: z.enum(['node', 'node.exe']), args: z.tuple([z.literal('app/lib/bin.js'), z.literal('--port'), z.literal('0')]) }),
  files: z.array(z.strictObject({ path: safePath, bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), link: z.string().optional() })).min(2).max(200000),
})
/** One verified artifact file ready for transfer. */
export interface DeployFile { path: string; localPath: string; sha256: string; bytes: number; mode: number }
/** Complete verified native remote-server artifact. */
export interface Artifact { digest: string; executable: string; files: DeployFile[] }

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Verify one local platform artifact and expand its portable links.
 * @param root - absolute directory containing platform/architecture folders.
 * @param platform - target operating system.
 * @param arch - target CPU architecture.
 * @returns the verified artifact files and manifest digest.
 */
export async function inspectArtifact(root: string, platform: RemotePlatform, arch: RemoteArchitecture): Promise<Artifact> {
  if (!isAbsolute(root)) throw new RemoteHostsError('ARTIFACT_ROOT_NOT_ABSOLUTE')
  const directory = await realpath(join(root, `${platform}-${arch}`))
  const bytes = await readFile(join(directory, 'manifest.json'))
  if (bytes.length > 32 * 1024 * 1024) throw new RemoteHostsError('INVALID_ARTIFACT')
  const digest = createHash('sha256').update(bytes).digest('hex')
  if ((await readFile(join(directory, 'manifest.sha256'), 'utf8')).trim() !== `${digest}  manifest.json`) throw new RemoteHostsError('ARTIFACT_HASH_MISMATCH')
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')))
  const executable = platform === 'win32' ? 'node.exe' : 'node'
  if (manifest.node.platform !== platform || manifest.node.arch !== arch || manifest.launch.executable !== executable) throw new RemoteHostsError('ARTIFACT_PLATFORM_MISMATCH')
  const entries = new Map(manifest.files.map(file => [file.path, file]))
  if (entries.size !== manifest.files.length) throw new RemoteHostsError('INVALID_ARTIFACT')
  const regular = new Map<string, DeployFile>()
  for (const file of manifest.files) {
    const localPath = join(directory, file.path)
    const canonical = await realpath(localPath)
    const rel = relative(directory, canonical)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new RemoteHostsError('ARTIFACT_LINK_ESCAPE')
    // No entry may hide below a link: expansion owns every materialized alias.
    for (let parent = posix.dirname(file.path); parent !== '.'; parent = posix.dirname(parent)) {
      if (entries.has(parent)) throw new RemoteHostsError('INVALID_ARTIFACT')
    }
    const info = await lstat(localPath)
    if (file.link !== undefined) {
      if (!info.isSymbolicLink() || await readlink(localPath) !== file.link
        || Buffer.byteLength(file.link) !== file.bytes || createHash('sha256').update(file.link).digest('hex') !== file.sha256
        || /[:\x00-\x1f]/.test(file.link) || posix.isAbsolute(file.link.replaceAll('\\', '/'))
        || platform !== 'win32' && file.link.includes('\\')) throw new RemoteHostsError('INVALID_ARTIFACT_LINK')
    } else {
      if (!info.isFile() || info.size !== file.bytes || await hashFile(localPath) !== file.sha256) throw new RemoteHostsError('ARTIFACT_HASH_MISMATCH')
      regular.set(file.path, { path: file.path, localPath, bytes: file.bytes, sha256: file.sha256, mode: 0o600 | (info.mode & 0o111) })
    }
  }
  const result = new Map(regular)
  function expand(source: string, destination: string, seen: Set<string>): void {
    if (seen.has(source) || result.size > 200000) throw new RemoteHostsError('ARTIFACT_LINK_CYCLE')
    const next = new Set(seen).add(source)
    const file = regular.get(source)
    if (file !== undefined) { result.set(destination, { ...file, path: destination }); return }
    const link = entries.get(source)?.link
    if (link !== undefined) {
      const target = posix.normalize(posix.join(posix.dirname(source), link.replaceAll('\\', '/')))
      if (target === '..' || target.startsWith('../') || target === '.') throw new RemoteHostsError('ARTIFACT_LINK_ESCAPE')
      expand(target, destination, next)
      return
    }
    const descendants = manifest.files.filter(entry => entry.path.startsWith(`${source}/`))
    if (descendants.length === 0) throw new RemoteHostsError('ARTIFACT_LINK_TARGET_MISSING')
    for (const child of descendants) expand(child.path, `${destination}/${child.path.slice(source.length + 1)}`, next)
  }
  for (const file of manifest.files) if (file.link !== undefined) expand(file.path, file.path, new Set())
  if (!regular.has(executable) || !regular.has('app/lib/bin.js')) throw new RemoteHostsError('INVALID_ARTIFACT')
  return { digest, executable, files: [...result.values()] }
}

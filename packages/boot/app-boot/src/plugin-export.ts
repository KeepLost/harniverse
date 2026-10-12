/**
 * Plugin export core shared by the `dsh plugin export` CLI and the Host
 * `plugin.export` download: classify a profile dependency's spec, resolve
 * the directory a tarball should be packed from (the local source behind a
 * `link:`/`file:` spec when it still exists, otherwise the installed copy
 * under the profile), and run `pnpm pack` there. Both callers own their own
 * surfaces; this module never writes outside its `destination`.
 *
 * @module @deepseek-ai/dsh-app-boot/plugin-export
 */

import { spawnSync } from 'node:child_process'
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { packageDirFromAnchor } from './profile.ts'

/** How an export was satisfied; `source` is the fresher local checkout. */
export type PluginExportProvenance = 'source' | 'installed'

/** One dependency's resolved pack source. */
export interface PluginExportSource {
  /** Whether the tarball packs the spec's local source or the installed copy. */
  readonly provenance: PluginExportProvenance
  /** Absolute directory `pnpm pack` runs in. */
  readonly dir: string
}

/** A `link:`/`file:`/bare-path spec, or everything registry-like. */
export type DependencySpecClass = 'path' | 'remote'

/** A Windows drive-letter prefix (`C:\` / `c:/`) — a path spec pnpm normalizes away only after install. */
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/

/**
 * Whether one dependency spec names a filesystem location rather than a
 * registry/git reference. pnpm stores local installs as `link:`/`file:`; a
 * bare path only appears in a hand-edited manifest.
 * @param spec - the dependency spec verbatim from the profile manifest.
 * @returns the spec's filesystem class.
 */
export function classifyDependencySpec(spec: string): DependencySpecClass {
  if (spec.startsWith('link:') || spec.startsWith('file:')) return 'path'
  return spec.startsWith('/') || spec.startsWith('\\') || spec.startsWith('./') || spec.startsWith('../')
    || WINDOWS_DRIVE.test(spec)
    ? 'path'
    : 'remote'
}

/** Strip a `link:`/`file:` prefix down to the raw spec path. */
function specPath(spec: string): string {
  return spec.slice(spec.indexOf(':') + 1)
}

/**
 * Resolve one profile dependency to the directory its export tarball packs.
 * A path spec that still exists packs from that local source (the live
 * checkout); every other case — registry, git, tarball-URL specs, a deleted
 * source — packs from the installed copy under the profile.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param packageName - the dependency's package name.
 * @param spec - the dependency spec verbatim from the profile manifest.
 * @param profileDir - the profile directory (resolution anchor for relative specs).
 * @returns the pack source, or undefined when neither the spec's path nor an
 * installed copy resolves.
 */
export function resolvePluginExportSource(
  binName: string,
  packageName: string,
  spec: string,
  profileDir: string,
): PluginExportSource | undefined {
  if (classifyDependencySpec(spec) === 'path') {
    const candidate = resolve(profileDir, specPath(spec))
    // A directory holding a manifest is the checkout; a tarball file or a
    // vanished path falls through to the installed copy.
    if (existsSync(join(candidate, 'package.json')) && statSync(candidate).isDirectory()) {
      return { provenance: 'source', dir: candidate }
    }
  }
  const installed = packageDirFromAnchor(join(profileDir, 'package.json'), packageName)
  if (installed === undefined) {
    if (classifyDependencySpec(spec) !== 'path') return undefined
    // A path spec that resolved to neither a source directory nor an
    // installed copy names its defect explicitly.
    throw new Error(
      `${binName}: cannot export ${JSON.stringify(packageName)}: spec ${JSON.stringify(spec)} points at no package directory and no installed copy exists`,
    )
  }
  return { provenance: 'installed', dir: installed }
}

/** The subprocess result shape `packPluginTarball` reads; a structural subset of `SpawnSyncReturns<string>`. */
export interface PluginPackSpawnResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: Error
}

/** Subprocess runner injectable for tests; the default spawns pnpm like `dsh plugin` does. */
export type PluginPackSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => PluginPackSpawnResult

/** Successful pack result. */
export interface PluginPackOk {
  readonly ok: true
  /** Absolute path of the produced tarball. */
  readonly tarballPath: string
}

/** Failed pack result; `stderrTail` is the last pnpm diagnostic lines. */
export interface PluginPackFail {
  readonly ok: false
  readonly reason: 'pnpm-missing' | 'pack-failed'
  readonly exitCode: number
  readonly stderrTail: string
}

/** Result of one `pnpm pack` attempt: the tarball path, or the failure reason and pnpm diagnostics. */
export type PluginPackResult = PluginPackOk | PluginPackFail

const realSpawn: PluginPackSpawn = (command, args, options) => spawnSync(command, args, options)

/** Last non-empty lines of a pnpm diagnostic stream, for error surfaces. */
function tail(text: string, lines = 8): string {
  const out = text.trimEnd().split('\n')
  return out.slice(-lines).join('\n')
}

/**
 * Pack one package directory into a tarball with `pnpm pack`, mirroring the
 * `dsh plugin` forwarder's spawn posture (Windows resolves pnpm through its
 * `.cmd` shim, which spawn refuses without a shell).
 * @param binName - the diagnostic prefix on the thrown error.
 * @param packageDir - the directory `pnpm pack` runs in.
 * @param destination - the directory the tarball lands in (must exist).
 * @param spawn - subprocess runner; overridable for tests.
 * @returns the tarball path, or the pnpm failure with its exit code and
 * diagnostic tail.
 */
export function packPluginTarball(
  binName: string,
  packageDir: string,
  destination: string,
  spawn: PluginPackSpawn = realSpawn,
): PluginPackResult {
  const result = spawn('pnpm', ['pack', '--pack-destination', destination], {
    cwd: packageDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return { ok: false, reason: 'pnpm-missing', exitCode: 127, stderrTail: `${binName}: pnpm not found on PATH — install pnpm to pack plugin tarballs` }
  }
  const exitCode = result.status ?? 1
  if (result.status !== 0) {
    return { ok: false, reason: 'pack-failed', exitCode, stderrTail: tail(result.stderr) || tail(result.stdout) }
  }
  // pnpm prints `Tarball Details` then the tarball's absolute path; when the
  // print shape changes, a destination holding exactly one tarball still
  // resolves unambiguously.
  const printed = result.stdout.split('\n').map(line => line.trim()).filter(line => line.endsWith('.tgz')).pop()
  if (printed !== undefined && existsSync(printed)) return { ok: true, tarballPath: printed }
  const tarballs = readdirSync(destination).filter(name => name.endsWith('.tgz'))
  const [onlyTarball] = tarballs
  if (tarballs.length === 1 && onlyTarball !== undefined) return { ok: true, tarballPath: join(destination, onlyTarball) }
  return { ok: false, reason: 'pack-failed', exitCode, stderrTail: `${binName}: pnpm pack reported success but named no tarball in ${destination}` }
}

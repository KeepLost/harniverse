/**
 * Generate the Host-face Typert artifacts from source, skipping the pass when
 * a fingerprint of every generator input is unchanged and all artifacts still
 * exist. The tsdown workspace pass regenerates the same files when bundling.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { generateWorkspaceArtifacts } from '../packages/typert/generator/src/tsdown-plugin.ts'

/** Cache content: one fingerprint plus the repository-relative artifacts it produced. */
export interface TypertCache {
  readonly fingerprint: string
  readonly artifacts: readonly string[]
}

/** @param root - repository root. @returns the cache file location under node_modules. */
export function typertCachePath(root: string): string {
  return join(root, 'node_modules/.cache/dsh/generate-typert.json')
}

/** Read one tsconfig as JSON, tolerating comments and trailing commas. */
function readTsconfig(path: string): { references?: { path: string }[] } {
  const loaded = ts.readConfigFile(path, file => ts.sys.readFile(file)) as {
    config?: { references?: { path: string }[] }
  }
  return loaded.config ?? {}
}

/**
 * Collect the project directories the Host aggregate references, transitively:
 * exactly the packages whose sources feed the Typert analysis.
 * @param root - repository root.
 * @returns absolute, de-duplicated, sorted project directories.
 */
export function fingerprintProjectRoots(root: string): string[] {
  const visited = new Set<string>()
  const queue = [resolve(root, 'tsconfig.host.json')]
  while (queue.length > 0) {
    const configPath = queue.pop()
    if (configPath === undefined) break
    const { references } = readTsconfig(configPath)
    for (const reference of references ?? []) {
      const resolvedReference = resolve(dirname(configPath), reference.path)
      const projectConfig = resolvedReference.endsWith('.json')
        ? resolvedReference
        : join(resolvedReference, 'tsconfig.json')
      const projectDir = dirname(projectConfig)
      if (visited.has(projectDir)) continue
      visited.add(projectDir)
      queue.push(projectConfig)
    }
  }
  return [...visited].sort()
}

/** Directory names that never feed the generator: build output, installs, tests. */
const EXCLUDED_DIRECTORY_NAMES = new Set(['lib', 'node_modules', 'tests'])

/** Hash one file's bytes as hex. */
function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Fold one project tree's files (relative path and content hash) into the digest. */
function hashProjectTree(hash: ReturnType<typeof createHash>, root: string, directory: string): void {
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      hashProjectTree(hash, root, path)
    } else if (entry.isFile()) {
      hash.update(relative(root, path))
      hash.update('\0')
      hash.update(hashFile(path))
      hash.update('\0')
    }
  }
}

/**
 * Fingerprint every Typert generator input: the source trees of all Host
 * aggregate projects (lib/tests excluded), both root configs, and the
 * installed TypeScript version.
 * @param root - repository root.
 * @returns a stable hex digest; any input change produces a different one.
 */
export function computeFingerprint(root: string): string {
  const hash = createHash('sha256')
  for (const projectDir of fingerprintProjectRoots(root)) hashProjectTree(hash, root, projectDir)
  for (const config of ['tsconfig.host.json', 'tsconfig.base.json']) {
    hash.update(config)
    hash.update('\0')
    hash.update(hashFile(join(root, config)))
    hash.update('\0')
  }
  const typescriptPackage = join(root, 'node_modules/typescript/package.json')
  if (existsSync(typescriptPackage)) {
    const { version } = JSON.parse(readFileSync(typescriptPackage, 'utf8')) as { version?: string }
    hash.update(`typescript@${version ?? 'unknown'}`)
    hash.update('\n')
  }
  return hash.digest('hex')
}

/**
 * Decide whether generation can be skipped for this run.
 * @param cache - the previously recorded cache, if any.
 * @param fingerprint - this run's fingerprint.
 * @param artifactExists - whether one repository-relative artifact is present.
 * @returns true only when the fingerprint matches and every artifact exists.
 */
export function shouldSkipGeneration(
  cache: TypertCache | undefined,
  fingerprint: string,
  artifactExists: (relativePath: string) => boolean,
): boolean {
  return cache !== undefined
    && cache.fingerprint === fingerprint
    && cache.artifacts.length > 0
    && cache.artifacts.every(artifact => artifactExists(artifact))
}

/** Injection surface for {@link orchestrateGeneration}. */
export interface GenerationIO {
  readonly fingerprint: string
  readCache(): TypertCache | undefined
  writeCache(cache: TypertCache): void
  generate(): string[]
}

/**
 * Skip-or-generate orchestration: on a cache hit nothing runs; on a miss the
 * generator runs and a fresh cache is recorded; a generation failure leaves
 * the previous cache untouched.
 * @param root - repository root, for artifact existence checks.
 * @param root - repository root, for artifact existence checks.
 * @param io - injected fingerprint, cache, and generation seams.
 * @returns 'skipped' on a cache hit, 'generated' otherwise.
 */
export function orchestrateGeneration(root: string, io: GenerationIO): 'skipped' | 'generated' {
  const cache = io.readCache()
  if (shouldSkipGeneration(cache, io.fingerprint, relativePath => existsSync(join(root, relativePath)))) return 'skipped'
  const artifacts = io.generate()
  io.writeCache({ fingerprint: io.fingerprint, artifacts })
  return 'generated'
}

function readCache(root: string): TypertCache | undefined {
  const path = typertCachePath(root)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as TypertCache
    if (typeof parsed.fingerprint !== 'string' || !Array.isArray(parsed.artifacts)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function writeCache(root: string, cache: TypertCache): void {
  const path = typertCachePath(root)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`)
}

function main(): void {
  const root = resolve(import.meta.dirname, '..')
  const outcome = orchestrateGeneration(root, {
    fingerprint: computeFingerprint(root),
    readCache: () => { return readCache(root) },
    writeCache: (cache) => { writeCache(root, cache) },
    generate: () => { return generateWorkspaceArtifacts(root, ['host']).map(path => relative(root, path)) },
  })
  console.log(outcome === 'skipped'
    ? 'generate-typert: skipped (fingerprint unchanged and artifacts present)'
    : 'generate-typert: regenerated host artifacts')
}

if (import.meta.main) main()

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'

const CLIENT_BUILD_ENV_PREFIX = 'DSH_CLIENT_'

/** Non-public selector used by build orchestration to request a named client profile. */
export const CLIENT_BUILD_PROFILE_SELECTOR = 'DSH_BUILD_CLIENT_PROFILE'

/** Public client environment required by Harniverse release artifacts. */
const HARNIVERSE_CLIENT_BUILD_ENVIRONMENT = {
  DSH_CLIENT_BUILD_PROFILE: 'harniverse',
  DSH_CLIENT_TITLE: 'Harniverse',
} as const

const CLIENT_COMMIT_HASH_VARIABLE = 'DSH_CLIENT_COMMIT_HASH'

/** Repository-relative path of the complete client build record. */
export const CLIENT_BUILD_RECORD_PATH = '.harniverse-build/client-build-environment.json'

const CLIENT_BUILD_RECORD_FORMAT = 1
const CLIENT_ARTIFACT_PATTERNS = [
  'apps/web/dist/**/*',
  'packages/*/*/lib/client.js',
  'packages/*/*/lib/client.js.map',
] as const

/** Public values embedded in one set of client artifacts. */
export type ClientBuildEnvironment = Readonly<Record<string, string>>

interface ClientArtifactDigest {
  readonly fileCount: number
  readonly sha256: string
}

/** Durable description of one complete root client build. */
export interface ClientBuildRecord {
  readonly formatVersion: number
  readonly environment: ClientBuildEnvironment
  readonly artifacts: ClientArtifactDigest
}

/** Resolve the lowercase seven-character source revision used by browser build metadata. */
export function repositoryCommitHash(root: string, environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment[CLIENT_COMMIT_HASH_VARIABLE]
  const value = explicit ?? execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  if (!/^[0-9a-f]{7,40}$/iu.test(value)) {
    throw new Error(`${CLIENT_COMMIT_HASH_VARIABLE} must be a Git commit hash; got ${JSON.stringify(value)}`)
  }
  return value.slice(0, 7).toLowerCase()
}

/** Resolve the exact public values required by a Harniverse build at one commit. */
export function harniverseClientBuildEnvironment(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<Record<`DSH_CLIENT_${string}`, string>> {
  return {
    DSH_CLIENT_COMMIT_HASH: repositoryCommitHash(root, environment),
    ...HARNIVERSE_CLIENT_BUILD_ENVIRONMENT,
  }
}

function clientBuildEnvironment(environment: NodeJS.ProcessEnv): ClientBuildEnvironment {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name, value]) => name.startsWith(CLIENT_BUILD_ENV_PREFIX) && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))) as Record<string, string>
}

/** Resolve inherited public values or the exact named Harniverse profile. */
export function resolveClientBuildEnvironment(
  environment: NodeJS.ProcessEnv,
  profile: string | undefined = environment[CLIENT_BUILD_PROFILE_SELECTOR],
): ClientBuildEnvironment {
  if (profile === undefined) return clientBuildEnvironment(environment)
  if (profile === 'harniverse') {
    const commitHash = environment[CLIENT_COMMIT_HASH_VARIABLE]
    if (commitHash === undefined) {
      throw new Error(`${CLIENT_COMMIT_HASH_VARIABLE} is required for the Harniverse client build profile`)
    }
    return { DSH_CLIENT_COMMIT_HASH: commitHash, ...HARNIVERSE_CLIENT_BUILD_ENVIRONMENT }
  }
  throw new Error(`unknown client build profile ${JSON.stringify(profile)}; expected "harniverse"`)
}

/** Replace inherited client values with the selected profile for build subprocesses. */
export function clientBuildProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  clientEnvironment: ClientBuildEnvironment,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(environment)) {
    if (name === CLIENT_BUILD_PROFILE_SELECTOR || name.startsWith(CLIENT_BUILD_ENV_PREFIX)) continue
    child[name] = value
  }
  return { ...child, ...clientEnvironment }
}

/** Require the public client environment to match an artifact profile exactly. */
export function assertClientBuildEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  expected: Readonly<Record<`DSH_CLIENT_${string}`, string>>,
): void {
  const actual = Object.fromEntries(Object.entries(environment)
    .filter(([name, value]) => name.startsWith(CLIENT_BUILD_ENV_PREFIX) && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)))
  const normalizedExpected = Object.fromEntries(Object.entries(expected)
    .sort(([left], [right]) => left.localeCompare(right)))
  if (JSON.stringify(actual) === JSON.stringify(normalizedExpected)) return

  const names = [...new Set([...Object.keys(actual), ...Object.keys(normalizedExpected)])].sort()
  const differences = names.filter(name => actual[name] !== normalizedExpected[name])
  throw new Error(`client build environment differs from the required artifact profile: ${differences.join(', ')}`)
}

/** Create exact Vite and tsdown substitutions for public client values. */
export function clientBuildEnvironmentDefines(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const defines: Record<string, string> = { 'process.env': '{}' }
  for (const [name, value] of Object.entries(clientBuildEnvironment(environment))) {
    defines[`process.env.${name}`] = JSON.stringify(value)
  }
  return defines
}

/** Write a record that binds the public environment to a complete client build. */
export function writeClientBuildRecord(
  root: string,
  environment: ClientBuildEnvironment,
): ClientBuildRecord {
  const record: ClientBuildRecord = {
    formatVersion: CLIENT_BUILD_RECORD_FORMAT,
    environment: clientBuildEnvironment(environment),
    artifacts: clientArtifactDigest(root),
  }
  const path = resolve(root, CLIENT_BUILD_RECORD_PATH)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/** Read a build record and prove that it still describes the current artifacts. */
export function readClientBuildRecord(
  root: string,
  expected?: Readonly<Record<`DSH_CLIENT_${string}`, string>>,
): ClientBuildRecord {
  const path = resolve(root, CLIENT_BUILD_RECORD_PATH)
  if (!existsSync(path)) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} is missing; run a complete pnpm run build first`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} is invalid JSON: ${detail}`)
  }
  const record = parseClientBuildRecord(parsed)
  if (expected !== undefined) assertClientBuildEnvironment(record.environment, expected)

  const current = clientArtifactDigest(root)
  if (current.fileCount !== record.artifacts.fileCount || current.sha256 !== record.artifacts.sha256) {
    throw new Error(
      `client artifacts differ from ${CLIENT_BUILD_RECORD_PATH}; run a complete pnpm run build before consuming them`,
    )
  }
  return record
}

function clientArtifactDigest(root: string): ClientArtifactDigest {
  const paths = globSync([...CLIENT_ARTIFACT_PATTERNS], { cwd: root })
    .map(path => path.replaceAll('\\', '/'))
    .filter(path => statSync(resolve(root, path)).isFile())
    .sort()
  if (paths.length === 0) throw new Error('complete client build produced no Vite or dynamic client artifacts')

  const digest = createHash('sha256')
  for (const path of paths) {
    const content = readFileSync(resolve(root, path))
    digest.update(`${Buffer.byteLength(path)}:`)
    digest.update(path)
    digest.update(`${content.byteLength}:`)
    digest.update(content)
  }
  return { fileCount: paths.length, sha256: digest.digest('hex') }
}

function parseClientBuildRecord(value: unknown): ClientBuildRecord {
  if (!isObject(value) || !hasExactKeys(value, ['artifacts', 'environment', 'formatVersion'])) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid top-level schema`)
  }
  if (value.formatVersion !== CLIENT_BUILD_RECORD_FORMAT) {
    throw new Error(
      `client build record ${CLIENT_BUILD_RECORD_PATH} uses format ${String(value.formatVersion)}; expected ${String(CLIENT_BUILD_RECORD_FORMAT)}`,
    )
  }
  if (!isObject(value.environment)) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid environment`)
  }
  const environment: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value.environment).sort(([left], [right]) => left.localeCompare(right))) {
    if (!name.startsWith(CLIENT_BUILD_ENV_PREFIX) || typeof entry !== 'string') {
      throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid environment entry ${name}`)
    }
    environment[name] = entry
  }
  if (!isObject(value.artifacts) || !hasExactKeys(value.artifacts, ['fileCount', 'sha256'])) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid artifact digest`)
  }
  if (!Number.isSafeInteger(value.artifacts.fileCount) || Number(value.artifacts.fileCount) < 1) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid artifact count`)
  }
  if (typeof value.artifacts.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.artifacts.sha256)) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid SHA-256 digest`)
  }
  return {
    formatVersion: CLIENT_BUILD_RECORD_FORMAT,
    environment,
    artifacts: {
      fileCount: Number(value.artifacts.fileCount),
      sha256: value.artifacts.sha256,
    },
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

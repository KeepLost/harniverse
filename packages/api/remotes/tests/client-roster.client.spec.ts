// The client half's `$mount` roster is hand-maintained, and a namespace missing
// from it fails in the quietest possible way: the owning client plugin stays
// pending on its `remote.<namespace>` inject forever, so its UI never registers
// and nothing throws (the remoteHosts regression: the Remote hosts sidebar entry
// simply never appeared).
//
// This suite is source-plane only. The assembly value-imports generated
// `/remote` artifacts that exist only in `lib`, so it cannot be imported in a
// pre-build lane (see the coverage exclusion for `src/client/index.ts`). The
// mounted-composition half of the contract -- that the roster really mounts
// without a method/namespace collision -- runs against the built bundles in
// `tests/built-lib.e2e.ts`.
import { readFileSync } from 'node:fs'
import { glob } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Repository root: this file sits at `<root>/packages/api/remotes/tests`. */
const root = resolve(import.meta.dirname, '../../../..')
const assembly = 'packages/api/remotes/src/client/index.ts'

/** One workspace package's identity and whether it exposes a generated Remote. */
interface WorkspacePackage {
  readonly name: string
  readonly dir: string
  readonly remoteExport: boolean
  readonly dependencies: readonly string[]
}

/** Read the `/remote` export flag and dependency names of one package.json. */
function readPackage(dir: string): Omit<WorkspacePackage, 'dir'> {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as {
    name: string
    exports?: Record<string, unknown>
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const names = (section: Record<string, string> | undefined): string[] => Object.keys(section ?? {})
  return {
    name: manifest.name,
    remoteExport: manifest.exports?.['./remote'] !== undefined,
    dependencies: [
      ...names(manifest.dependencies),
      ...names(manifest.peerDependencies),
      ...names(manifest.devDependencies),
    ].filter(name => name.startsWith('@deepseek-ai/dsh-')),
  }
}

/** Every workspace package keyed by npm name. */
async function workspacePackages(): Promise<Map<string, WorkspacePackage>> {
  const packages = new Map<string, WorkspacePackage>()
  for await (const manifest of glob('packages/*/*/package.json', { cwd: root })) {
    const dir = dirname(manifest)
    const pkg = readPackage(dir)
    packages.set(pkg.name, { ...pkg, dir })
  }
  return packages
}

/**
 * The package that owns each `remote.<namespace>` a client plugin injects,
 * resolved through the plugin's own dependency list.
 * @returns one owner package per injected namespace.
 */
async function requiredRemoteOwners(
  packages: Map<string, WorkspacePackage>,
): Promise<Map<string, WorkspacePackage>> {
  // Resolve each Client entry back to its manifest by joined path instead of
  // string surgery, so the same lookup works under either separator.
  const owner = new Map<string, WorkspacePackage>()
  for (const pkg of packages.values()) {
    owner.set(join(pkg.dir, 'src', 'client', 'index.ts'), pkg)
  }
  const required = new Map<string, WorkspacePackage>()
  let entries = 0
  for await (const file of glob('packages/*/*/src/client/index.ts', { cwd: root })) {
    const match = /export const inject = \[([^\]]*)\]/.exec(readFileSync(join(root, file), 'utf8'))
    if (match === null) continue
    entries += 1
    const namespaces = [...match[1]!.matchAll(/'remote\.([^']+)'/g)].map(candidate => candidate[1]!)
    if (namespaces.length === 0) continue
    const self = owner.get(file)
    expect(self, `no manifest for ${file}`).toBeDefined()
    const owners = (self?.dependencies ?? [])
      .map(name => packages.get(name))
      .filter((dependency): dependency is WorkspacePackage => dependency?.remoteExport === true)
    for (const dependency of owners) required.set(dependency.name, dependency)
  }
  // A scan that matched nothing would let the assertions below pass vacuously.
  expect(entries).toBeGreaterThan(0)
  return required
}

describe('client Remote roster (source plane)', () => {
  it('imports and mounts every generated Remote a client plugin injects', async () => {
    const source = readFileSync(join(root, assembly), 'utf8')
    const roster = source.slice(source.indexOf('for (const contribution of ['))
    // Bindings are hand-named (`goalsRemote` for `dsh-goal`), so read the
    // import lines rather than deriving a name from the package.
    const bound = new Map(
      [...source.matchAll(/^import ([A-Za-z0-9_$]+) from '([^']+)\/remote'$/gmu)]
        .map(match => [match[2]!, match[1]!]),
    )
    const packages = await workspacePackages()
    const required = await requiredRemoteOwners(packages)
    expect(required.size).toBeGreaterThan(0)
    const missing = [...required.values()]
      .filter((owner) => {
        const binding = bound.get(owner.name)
        return binding === undefined || !roster.includes(binding)
      })
      .map(owner => owner.name)
    expect(missing).toEqual([])
  })

  it('mounts the remoteHosts contribution, whose absence hid the whole UI', async () => {
    const source = readFileSync(join(root, assembly), 'utf8')
    expect(source).toContain("import remoteHostsRemote from '@deepseek-ai/dsh-remote-hosts/remote'")
    expect(source.slice(source.indexOf('for (const contribution of ['))).toContain('remoteHostsRemote')
  })

  it('requires the Client Remote service before mounting the roster', async () => {
    const source = readFileSync(join(root, assembly), 'utf8')
    expect(/export const inject = \['remote'\]/.test(source)).toBe(true)
  })
})

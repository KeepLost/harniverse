/**
 * `dsh plugin --profile <name> <args...>` — profile plugin management as a
 * thin pnpm forwarder: initialize the profile on first use, run
 * `pnpm <args...>` in the profile directory, then reconcile the
 * `dsh.profile.bundles` layer list against the installed state (a dependency
 * resolving to a package that declares `dsh.bundle` joins the layer stack; a
 * removed or bundle-less dependency leaves it). Reconciling by installed
 * state, not by dependency diff, means `update` activates a package that
 * gained its `dsh.bundle` declaration in a newer version.
 *
 * Two subcommands are intercepted instead of forwarded: `export <name>`
 * packs one installed dependency into a tarball (`pnpm pack` from the local
 * source behind a `link:`/`file:` spec when it exists, otherwise from the
 * installed copy), and `export-manifest` prints the profile's dependency
 * replay manifest.
 * @module @deepseek-ai/dsh/plugin
 */

import { spawnSync } from 'node:child_process'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  DEFAULT_PROFILE_BUNDLES,
  initProfile,
  packPluginTarball,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveBundleDir,
  resolvePluginExportSource,
  resolveProfileDir,
  writeProfileManifest,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { INSTALL_ANCHOR } from './profile-boot.ts'

const NAME = 'dsh'

/**
 * Whether a resolved dependency exports a profile patch, i.e. is a bundle.
 * @param packageName - the dependency's package name.
 * @param profileDir - the profile directory (resolution anchor).
 * @returns true when the package manifest declares `dsh.bundle`.
 */
function exportsPatch(packageName: string, profileDir: string): boolean {
  let dir: string
  try {
    dir = resolveBundleDir(NAME, packageName, INSTALL_ANCHOR, profileDir)
  } catch {
    return false // pnpm reported success yet the package is unresolvable — treat as plain
  }
  const manifest = readProfileManifest(NAME, dir)
  return manifest.dsh?.bundle?.patch !== undefined
}

/**
 * Reconcile `dsh.profile.bundles` against the installed state: pnpm has
 * already written the real installed names (so a git/path/tarball/alias spec
 * on the command line reconciles by its true package name) and materialized
 * the packages. A dependency that resolves to a `dsh.bundle`-declaring
 * package joins the layer stack (appended in dependency order); a
 * dependency-listed name that no longer does — removed, or the installed
 * version dropped the declaration — leaves it. In-box bundles from the
 * profile template are not dependencies and are never touched. Warns once
 * per newly-added bundle-less dependency (a plain library is fine; the
 * warning is orientation).
 */
function reconcilePlugins(before: ProfileManifest, profileDir: string): void {
  const after = readProfileManifest(NAME, profileDir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const plugins = after.dsh?.profile?.bundles ?? []
  let changed = false
  for (const packageName of dependencies) {
    const isBundle = exportsPatch(packageName, profileDir)
    if (isBundle && !plugins.includes(packageName)) {
      plugins.push(packageName)
      changed = true
    } else if (!isBundle && !beforeDeps.has(packageName)) {
      process.stderr.write(
        `${NAME}: warning: ${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer `
        + '(a later update that gains one activates it automatically)\n',
      )
    }
  }
  const dependencySet = new Set(dependencies)
  for (const packageName of [...plugins]) {
    // Only dependency-managed entries are subject to removal; template
    // bundles (dsh-base and friends) are not dependencies.
    const wasDependency = beforeDeps.has(packageName) || dependencySet.has(packageName)
    const stillBundle = dependencySet.has(packageName) && exportsPatch(packageName, profileDir)
    if (wasDependency && !stillBundle) {
      plugins.splice(plugins.indexOf(packageName), 1)
      changed = true
    }
  }
  if (!changed) return
  after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles: plugins } }
  writeProfileManifest(profileDir, after)
}

/**
 * Rewrite relative filesystem specs against the user's invoking directory.
 * pnpm runs with cwd = the profile directory, so a bare `.` or `../plugin`
 * (or their `file:`/`link:` forms) would silently resolve inside the profile
 * — `add .` from a plugin checkout would self-link the profile. Absolute
 * specs, registry names, and every other pnpm argument pass through
 * untouched.
 * @param argument - one pnpm argument, verbatim from argv.
 * @param cwd - the directory `dsh` was invoked from.
 * @returns the argument with a relative path spec anchored to `cwd`.
 */
function anchorPathSpec(argument: string, cwd: string): string {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument)
  if (match?.groups?.path === undefined) return argument
  // A bare path stays bare and a prefixed spec keeps its prefix: pnpm's
  // link-vs-copy semantics differ between `file:` and a plain directory
  // path, and the anchor must not change which one the user asked for.
  const prefix = match.groups.prefix ?? ''
  return `${prefix}${resolve(cwd, match.groups.path)}`
}

/** One `export` invocation parsed down to its inputs. */
interface ExportArguments {
  readonly packageName: string
  readonly out: string | undefined
}

/** Usage line shared by both export parse failures. */
const EXPORT_USAGE = 'usage: dsh plugin --profile <name> export <package> [--out <directory>]'

/**
 * Parse `dsh plugin export` arguments: one package name plus an optional
 * `--out` directory anchored to the invoking directory.
 * @param args - arguments after the `export` subcommand.
 * @param error - sink for the diagnostic on a malformed invocation.
 * @returns the parsed inputs, or undefined after `error` reported them.
 */
function parseExportArguments(args: readonly string[], error: (line: string) => void): ExportArguments | undefined {
  let packageName: string | undefined
  let out: string | undefined
  let index = 0
  while (index < args.length) {
    const argument = args[index] ?? ''
    if (argument === '--out') {
      const value = args[index + 1]
      if (value === undefined) {
        error(`${NAME}: --out needs a directory\n${EXPORT_USAGE}`)
        return undefined
      }
      out = value
      index += 2
    } else if (argument.startsWith('--')) {
      error(`${NAME}: unknown option ${JSON.stringify(argument)}\n${EXPORT_USAGE}`)
      return undefined
    } else if (packageName === undefined) {
      packageName = argument
      index += 1
    } else {
      error(`${NAME}: unexpected extra argument ${JSON.stringify(argument)}\n${EXPORT_USAGE}`)
      return undefined
    }
  }
  if (packageName === undefined) {
    error(`${NAME}: export needs a package name\n${EXPORT_USAGE}`)
    return undefined
  }
  return { packageName, out }
}

/**
 * Run `dsh plugin export <package> [--out <dir>]`: resolve the dependency's
 * pack source (its local checkout behind a path spec, else the installed
 * copy), `pnpm pack` it into the output directory, and report the tarball
 * and its provenance.
 * @param profile - the profile name.
 * @param args - arguments after the `export` subcommand.
 * @param cwd - the directory `dsh` was invoked from (the `--out` anchor).
 * @returns the exit code.
 */
export function runPluginExport(profile: string, args: readonly string[], cwd: string = process.cwd()): number {
  const parsed = parseExportArguments(args, line => process.stderr.write(`${line}\n`))
  if (parsed === undefined) return 1
  const dir = resolveProfileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    process.stderr.write(`${NAME}: profile ${JSON.stringify(profile)} is not initialized — install a plugin first: dsh plugin --profile ${profile} add <package>\n`)
    return 1
  }
  const manifest = readProfileManifest(NAME, dir)
  const spec = (manifest.dependencies ?? {})[parsed.packageName]
  if (spec === undefined) {
    const names = Object.keys(manifest.dependencies ?? {})
    process.stderr.write(
      `${NAME}: ${JSON.stringify(parsed.packageName)} is not a dependency of profile ${JSON.stringify(profile)}`
      + `${names.length === 0 ? ' (it has no dependencies)' : ` — installed: ${names.join(', ')}`}\n`,
    )
    return 1
  }
  let source
  try {
    source = resolvePluginExportSource(NAME, parsed.packageName, spec, dir)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  if (source === undefined) {
    process.stderr.write(`${NAME}: ${JSON.stringify(parsed.packageName)} has no installed copy under profile ${JSON.stringify(profile)} — reinstall it with dsh plugin --profile ${profile} add ${JSON.stringify(spec)}\n`)
    return 1
  }
  const out = resolve(cwd, parsed.out ?? '.')
  if (!existsSync(out) || !statSync(out).isDirectory()) {
    process.stderr.write(`${NAME}: --out directory ${out} does not exist\n`)
    return 1
  }
  const result = packPluginTarball(NAME, source.dir, out)
  if (!result.ok) {
    process.stderr.write(`${NAME}: pnpm pack failed for ${JSON.stringify(parsed.packageName)} (exit ${result.exitCode})\n${result.stderrTail}\n`)
    return result.exitCode
  }
  if (source.provenance === 'source') {
    process.stderr.write(`${NAME}: packed from the local source ${source.dir}\n`)
  } else {
    process.stderr.write(`${NAME}: packed from the installed copy (spec ${JSON.stringify(spec)}) — the original source or registry form may differ\n`)
  }
  process.stdout.write(`${result.tarballPath}\n`)
  process.stderr.write(`${NAME}: install it anywhere with dsh plugin --profile <name> add ${JSON.stringify(result.tarballPath)}\n`)
  return 0
}

/**
 * Run `dsh plugin export-manifest [--out <file>]`: print (or write) the
 * profile's dependency replay manifest — its bundle layer list and every
 * dependency spec — so another instance can replay the installation with
 * `dsh plugin add`.
 * @param profile - the profile name.
 * @param args - arguments after the `export-manifest` subcommand.
 * @param cwd - the directory `dsh` was invoked from (the `--out` anchor).
 * @returns the exit code.
 */
export function runPluginExportManifest(profile: string, args: readonly string[], cwd: string = process.cwd()): number {
  let out: string | undefined
  let index = 0
  while (index < args.length) {
    const argument = args[index] ?? ''
    if (argument === '--out') {
      const value = args[index + 1]
      if (value === undefined) {
        process.stderr.write(`${NAME}: --out needs a file path\nusage: dsh plugin --profile <name> export-manifest [--out <file>]\n`)
        return 1
      }
      out = resolve(cwd, value)
      index += 2
    } else {
      process.stderr.write(`${NAME}: unexpected argument ${JSON.stringify(argument)}\nusage: dsh plugin --profile <name> export-manifest [--out <file>]\n`)
      return 1
    }
  }
  const dir = resolveProfileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    process.stderr.write(`${NAME}: profile ${JSON.stringify(profile)} is not initialized — install a plugin first: dsh plugin --profile ${profile} add <package>\n`)
    return 1
  }
  const manifest = readProfileManifest(NAME, dir)
  const payload = JSON.stringify({
    profile,
    bundles: manifest.dsh?.profile?.bundles ?? [],
    dependencies: manifest.dependencies ?? {},
  }, undefined, 2) + '\n'
  if (out === undefined) {
    process.stdout.write(payload)
    return 0
  }
  writeFileSync(out, payload)
  process.stderr.write(`${NAME}: wrote ${out}\n`)
  return 0
}

/**
 * Run one `dsh plugin` invocation: init if needed, forward to pnpm, reconcile.
 * @param profile - the profile name.
 * @param args - pnpm arguments with relative path specs anchored to the invoking directory.
 * @returns the pnpm exit code.
 */
export function runPlugin(profile: string, args: readonly string[]): number {
  if (args[0] === 'export') return runPluginExport(profile, args.slice(1))
  if (args[0] === 'export-manifest') return runPluginExportManifest(profile, args.slice(1))
  const dir = resolveProfileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES)
    process.stderr.write(`${NAME}: initialized profile ${profile} at ${dir}\n`)
  }
  const before = readProfileManifest(NAME, dir)
  // Windows resolves pnpm through its .cmd shim, which spawn() refuses
  // without a shell since the CVE-2024-27980 hardening.
  const result = spawnSync('pnpm', args.map(argument => anchorPathSpec(argument, process.cwd())), {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      process.stderr.write(`${NAME}: pnpm not found on PATH — install pnpm to manage profile plugins\n`)
      return 127
    }
    throw result.error
  }
  const exitCode = result.status ?? 1
  if (exitCode === 0) {
    reconcilePlugins(before, dir)
  } else {
    // pnpm's own diagnostics name pnpm-workspace.yaml without saying WHICH
    // one; the profile owns it, and the commonest failure here is pnpm ≥10
    // blocking a git dependency's prepare (build) script until allowlisted.
    process.stderr.write(`${NAME}: pnpm failed in profile directory ${dir}\n`)
    if (args.some(argument => /^git\+|^github:|\.git(?:#|$)/.test(argument))) {
      process.stderr.write(
        `${NAME}: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — `
        + `add the exact key pnpm printed above under allowBuilds in ${join(dir, 'pnpm-workspace.yaml')}, then re-run\n`,
      )
    }
  }
  return exitCode
}

/**
 * The shell registry: the user-editable list of named shell executables a
 * session can select, plus the single resolver that turns (registry, session
 * override, probed availability) into the one effective shell every consumer
 * — prompt fact, tool catalog restriction, and execution stamp — must derive
 * from. One resolver, one answer: the model is told exactly what runs.
 *
 * An entry routes through one of the two composed stacks: executables whose
 * basename classifies POSIX (bash, zsh, sh, dash, ksh, ash) run through the
 * POSIX stack; pwsh/powershell through the PowerShell stack. Everything else
 * is an unsupported dialect class and rejects at settings validation.
 * @module dsh-shell/registry
 */

import { basename, isAbsolute } from 'node:path'
import type { ShellBackendSelection } from './backend.ts'
import { resolveShellBackend } from './backend.ts'
import { defaultCommandShellPath } from './platform.ts'

/** Immutable id of the builtin POSIX entry (the platform's default POSIX shell). */
export const BUILTIN_POSIX_ID = 'posix'

/** Immutable id of the builtin PowerShell entry. */
export const BUILTIN_PWSH_ID = 'pwsh'

/** Reserved default value meaning "no explicit choice; split by platform". */
export const PLATFORM_DEFAULT_ID = 'platform-default'

/** Legacy family value (pre-registry logs) folding onto the POSIX builtin. */
export const LEGACY_BASH_FAMILY_ID = 'bash'

/** Ids a custom entry may never take: the reserved default, builtins, and the legacy fold. */
export const RESERVED_ENTRY_IDS: readonly string[] = [PLATFORM_DEFAULT_ID, BUILTIN_POSIX_ID, BUILTIN_PWSH_ID, LEGACY_BASH_FAMILY_ID]

/** Dialect classes the composed stacks can serve. */
export type ShellDialectClass = 'posix' | 'pwsh'

/** One registered shell: a stable id, its executable path, and a display label. */
export interface ShellRegistryEntry {
  /** Stable selector; slug-unique, never a builtin id or the reserved default. */
  id: string
  /** Executable path or PATH name; materialized by probing when available. */
  path: string
  /** User-facing label; absent means the executable's basename. */
  label?: string | undefined
}

/** Resolved shell-registry settings document. */
export interface ShellRegistryDocument {
  /** Registry default: the reserved platform split or one entry id. */
  default: string
  /** User-registered entries; builtin ids cannot be overridden here. */
  entries: readonly ShellRegistryEntry[]
}

/** One registry entry resolved against a host: routing and probe outcome. */
export interface ShellEntryStatus {
  /** The entry's selector id. */
  id: string
  /** Display label (the executable's basename when the entry carries none). */
  label: string
  /** The stack this entry routes through. */
  stack: ShellBackendSelection
  /** The entry's declared path, verbatim. */
  path: string
  /** Whether the entry probed available on this host. */
  available: boolean
  /** Probe-resolved absolute executable; present iff available. */
  resolvedPath?: string
  /** Why probing marked the entry unavailable. */
  reason?: string
}

/** The one effective shell for a session: what the model is told and what runs. */
export interface EffectiveShell {
  /** The effective entry's registry id. */
  entryId: string
  /** Display label naming the actual shell executable. */
  label: string
  /** The stack that executes this shell. */
  stack: ShellBackendSelection
  /** The executable every execution of this session must spawn. */
  executablePath: string
  /** Pinned model-facing fact line announcing this shell. */
  factText: string
  /** Why resolution fell back off the requested target, when it did. */
  degraded?: string
}

/** Basenames routing through the POSIX stack, mapped to their fact dialect word. */
const POSIX_BASENAMES: Readonly<Record<string, 'bash' | 'zsh' | 'sh'>> = {
  bash: 'bash',
  zsh: 'zsh',
  sh: 'sh',
  dash: 'sh',
  ksh: 'sh',
  ash: 'sh',
}

/** Basenames routing through the PowerShell stack. */
const PWSH_BASENAMES: readonly string[] = ['pwsh', 'powershell', 'pwsh-preview']

/** The basename of an executable path, accepting both separator conventions. */
const executableBasename = (executable: string): string => {
  const name = executable.slice(Math.max(executable.lastIndexOf('/'), executable.lastIndexOf('\\')) + 1)
  return name.toLowerCase().replace(/\.exe$/u, '')
}

/**
 * Classify one executable into the dialect class its basename routes through.
 * @param executable - executable path or PATH name.
 * @returns The dialect class, or undefined for unsupported basenames (fish, nu, …).
 */
export function classifyShellDialect(executable: string): ShellDialectClass | undefined {
  const name = executableBasename(executable)
  if (name in POSIX_BASENAMES) return 'posix'
  if (PWSH_BASENAMES.includes(name)) return 'pwsh'
  return undefined
}

/** The stack one dialect class routes through. */
const dialectStack = (dialect: ShellDialectClass): ShellBackendSelection => dialect === 'pwsh' ? 'pwsh' : 'bash'

/** One indexed entry: a registry entry (or builtin) with its routing resolved. */
interface IndexedEntry {
  id: string
  label: string
  stack: ShellBackendSelection
  path: string
}

/** The builtin pair keyed by the stack each entry routes through. */
export interface BuiltinRegistryEntries {
  /** The platform's default POSIX shell (Git Bash by PATH name on win32, zsh on darwin, bash elsewhere). */
  bash: IndexedEntry
  /** PowerShell. */
  pwsh: IndexedEntry
}

/**
 * The builtin entries every host serves without registration, keyed by the
 * stack they route through.
 * @param platform - Node platform identifier to resolve for.
 * @returns The builtin entries with routing resolved.
 */
export function builtinRegistryEntries(platform: NodeJS.Platform): BuiltinRegistryEntries {
  return {
    bash: { id: BUILTIN_POSIX_ID, label: basename(defaultCommandShellPath(platform)), stack: 'bash', path: defaultCommandShellPath(platform) },
    pwsh: { id: BUILTIN_PWSH_ID, label: 'pwsh', stack: 'pwsh', path: 'pwsh' },
  }
}

/**
 * Index every addressable entry: builtins first, then the document's custom
 * entries (settings validation rejects builtin-id collisions, so the map keeps
 * whichever the document illegally declares — the resolver still answers).
 * @param platform - Node platform identifier to resolve for.
 * @param document - resolved shell-registry settings document.
 * @returns Addressable entries keyed by id.
 */
export function registryEntryIndex(platform: NodeJS.Platform, document: ShellRegistryDocument): Map<string, IndexedEntry> {
  const index = new Map<string, IndexedEntry>()
  for (const entry of Object.values(builtinRegistryEntries(platform))) index.set(entry.id, entry)
  for (const entry of document.entries) {
    const dialect = classifyShellDialect(entry.path)
    if (dialect === undefined) continue
    index.set(entry.id, {
      id: entry.id,
      label: entry.label === undefined || entry.label.length === 0 ? basename(entry.path) : entry.label,
      stack: dialectStack(dialect),
      path: entry.path,
    })
  }
  return index
}

/**
 * Build the pinned model-facing fact for one effective shell. The name is the
 * executable's basename (never the entry id — the model must see the real
 * shell); the path disambiguates same-named installs and appears only for
 * entries that DECLARE an absolute path, so PATH-named builtins keep a
 * host-stable line.
 * @param label - display label naming the actual executable.
 * @param stack - the stack that executes this shell.
 * @param path - the declared executable, or undefined for a PATH-named shell.
 * @returns The pinned fact line.
 */
export function shellFactText(label: string, stack: ShellBackendSelection, path?: string): string {
  if (stack === 'pwsh') {
    return path === undefined
      ? `Current shell for commands: ${label} (PowerShell). Run shell commands with the \`pwsh\` tool; its syntax is PowerShell.`
      : `Current shell for commands: ${label} (PowerShell, ${path}). Run shell commands with the \`pwsh\` tool; its syntax is PowerShell.`
  }
  const name = label.toLowerCase()
  const syntax = name === 'zsh' ? 'POSIX-compatible zsh' : 'POSIX shell'
  return path === undefined
    ? `Current shell for commands: ${label}. Run shell commands with the \`bash\` tool; its syntax is ${syntax}.`
    : `Current shell for commands: ${label} (${path}). Run shell commands with the \`bash\` tool; its syntax is ${syntax}.`
}

/** Inputs to {@link resolveEffectiveShell}: one registry, one override, one probe table. */
export interface ResolveEffectiveShellInput {
  /** Node platform identifier to resolve for. */
  platform: NodeJS.Platform
  /** Resolved shell-registry settings document. */
  registry: ShellRegistryDocument
  /** Session override entry id, or null for the registry default. */
  override: string | null
  /** Probed entries by id with resolved absolute paths; undefined on unprobed hosts. */
  availability?: ReadonlyMap<string, ShellEntryStatus> | undefined
}

/**
 * The single resolver: turn the registry, a session override, and the probe
 * table into the one effective shell every consumer derives from. An
 * unavailable or missing target falls back to the platform builtin IN THE
 * RESOLVER — never silently elsewhere — and reports why.
 * @param input - registry, override, and probe table.
 * @returns The effective shell: id, stack, materialized executable, and fact.
 */
export function resolveEffectiveShell(input: ResolveEffectiveShellInput): EffectiveShell {
  const index = registryEntryIndex(input.platform, input.registry)
  const requested = input.override ?? input.registry.default
  // Pre-registry logs carry the legacy family union; 'pwsh' is already a
  // builtin id and 'bash' folds onto the POSIX builtin, so replay needs no
  // migration step.
  const folded = requested === LEGACY_BASH_FAMILY_ID ? BUILTIN_POSIX_ID : requested
  // The builtin the platform's default composition addresses: builtins are
  // engine-guaranteed present, exactly one per stack.
  const builtins = builtinRegistryEntries(input.platform)
  const platformBuiltin = resolveShellBackend(input.platform, 'platform-default') === 'pwsh'
    ? builtins.pwsh
    : builtins.bash
  const unavailable = (id: string): boolean => {
    if (input.availability === undefined) return false
    const status = input.availability.get(id)
    return status === undefined || !status.available
  }
  let degraded: string | undefined
  const selected = folded === PLATFORM_DEFAULT_ID ? undefined : index.get(folded)
  const entry = selected !== undefined && !unavailable(selected.id)
    ? selected
    : (() => {
      if (selected !== undefined) degraded = `shell entry "${selected.id}" is unavailable on this host; using the platform default`
      else if (requested !== PLATFORM_DEFAULT_ID) degraded = `shell entry "${requested}" is not registered; using the platform default`
      return platformBuiltin
    })()
  const resolved = input.availability?.get(entry.id)
  const executablePath = resolved?.resolvedPath ?? entry.path
  return {
    entryId: entry.id,
    label: entry.label,
    stack: entry.stack,
    executablePath,
    factText: shellFactText(entry.label, entry.stack, isAbsolute(entry.path) ? executablePath : undefined),
    ...(degraded !== undefined ? { degraded } : {}),
  }
}

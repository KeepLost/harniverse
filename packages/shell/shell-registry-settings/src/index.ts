/**
 * Root-owned settings contract for the shell registry: the `shell-registry`
 * namespace (`$DSH_HOME/settings.yaml`, restart-applied) holding the
 * user-registered shell entries and the registry default sessions fall back
 * to. The service exposes the resolved document in-process (`ctx.shellRegistry`)
 * for the router's entry probing and the session resolver; the app boot bridge
 * reads the stored document once per start and publishes the stack-level
 * `$DSH_SHELL_BACKEND` (plus a custom default's executable) for the shell
 * rows' `disabled` expressions.
 * @module @deepseek-ai/dsh-shell-registry-settings
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  BUILTIN_POSIX_ID,
  BUILTIN_PWSH_ID,
  classifyShellDialect,
  PLATFORM_DEFAULT_ID,
  RESERVED_ENTRY_IDS,
} from '@deepseek-ai/dsh-shell'
import type { ShellRegistryDocument } from '@deepseek-ai/dsh-shell'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace read once per start; changes apply on restart. */
export const SHELL_REGISTRY_SETTINGS_NAMESPACE = settingsNamespace('shell-registry')

/** One stored entry as the settings schema types it (schemastery nulls absent optionals). */
export interface StoredShellRegistryEntry {
  /** Stable selector; slug-unique, never a builtin id or the reserved default. */
  id: string
  /** Executable path or PATH name; materialized by probing when available. */
  path: string
  /** User-facing label; null means the executable's basename. */
  label?: string | null
}

/** Stored shell-registry settings; every field is optional over the schema defaults. */
export interface ShellRegistrySettings {
  /** Registry default: the reserved platform split, a builtin id, or one entry id. */
  default: string
  /** User-registered shell entries. */
  entries: StoredShellRegistryEntry[]
}

/** Stored shell-registry settings schema. */
export const Config: z<ShellRegistrySettings> = z.object({
  default: z.union([z.const(PLATFORM_DEFAULT_ID), z.const(BUILTIN_POSIX_ID), z.const(BUILTIN_PWSH_ID), z.string()]),
  entries: z.array(z.object({
    id: z.string(),
    path: z.string(),
    label: z.string(),
  })).default([]),
})

/** Resolved defaults applied under the user layer. */
const BASE: ShellRegistrySettings = { default: PLATFORM_DEFAULT_ID, entries: [] }

/** Cordis plugin name. */
export const name = 'shell-registry-settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The in-process shell-registry document source this plugin exposes. */
    shellRegistry: ShellRegistryService
  }
}

/**
 * Reject a resolved registry the composition cannot act on: entry ids must be
 * unique slugs outside the reserved set, every executable must classify into
 * a served dialect class, and the default must address a registered entry.
 * @param value - resolved settings value, schema-valid by construction.
 */
function validateRegistry(value: ShellRegistrySettings): void {
  const seen = new Set<string>()
  for (const entry of value.entries) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(entry.id)) {
      throw new Error(`shell-registry: entry id "${entry.id}" must be a lowercase slug ([a-z0-9-])`)
    }
    if (RESERVED_ENTRY_IDS.includes(entry.id)) {
      throw new Error(`shell-registry: entry id "${entry.id}" is reserved`)
    }
    if (seen.has(entry.id)) {
      throw new Error(`shell-registry: duplicate entry id "${entry.id}"`)
    }
    seen.add(entry.id)
    if (classifyShellDialect(entry.path) === undefined) {
      throw new Error(`shell-registry: entry "${entry.id}" paths to "${entry.path}", an unsupported shell dialect (served classes: POSIX bash/zsh/sh/dash/ksh, PowerShell pwsh)`)
    }
  }
  if (value.default !== PLATFORM_DEFAULT_ID && value.default !== BUILTIN_POSIX_ID && value.default !== BUILTIN_PWSH_ID
    && !seen.has(value.default)) {
    throw new Error(`shell-registry: default "${value.default}" addresses no registered entry`)
  }
}

/**
 * In-process source of the resolved shell registry. Consumers — the shell
 * router's entry probing and the session resolver — read {@link document};
 * nothing else re-parses the stored document.
 */
export class ShellRegistryService extends Service {
  /** The settings provider owns persistence and hot reload; consumers re-read per start. */
  static inject = ['settings']

  private readonly scope: { get(): ShellRegistrySettings }

  /**
   * Register the process-wide `shell-registry` namespace and expose its
   * resolved document.
   * @param ctx - host context carrying the settings provider.
   * @param config - composition `base` layer over the schema defaults.
   */
  constructor(ctx: Context, config: ShellRegistrySettings = { default: PLATFORM_DEFAULT_ID, entries: [] }) {
    super(ctx, 'shellRegistry')
    this.scope = ctx.settings.register(SHELL_REGISTRY_SETTINGS_NAMESPACE, Config, {
      applies: 'restart',
      base: { ...BASE, ...config },
      validate: validateRegistry,
    })
  }

  /** The resolved registry document: the default and every registered entry.
   * @returns the current shell registry document (default id plus entries).
   */
  document(): ShellRegistryDocument {
    const value = this.scope.get()
    return {
      default: value.default,
      // The namespace schema is the boundary: ids and paths arrive as
      // strings; a nulled optional label means the executable's basename.
      entries: value.entries.map(entry => ({
        id: entry.id,
        path: entry.path,
        ...(typeof entry.label === 'string' && entry.label.length > 0 ? { label: entry.label } : {}),
      })),
    }
  }
}

export default ShellRegistryService

/**
 * Boot-time host workspace import: walks the anchored host directory and
 * packs it into one v0 workspace tar (files and directories only), the shape
 * the data plane stages before boot. The v0 semantics are explicit: one
 * import per boot, no mid-session propagation, symlinks skipped and counted.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { HostWorkspaceTooLargeError } from './errors-host-import.ts'
import { packWorkspaceTar, type WorkspaceEntry } from './workspace.ts'

/** Default bound on one host workspace import: 256 MiB of file bytes. */
export const DEFAULT_HOST_IMPORT_MAX_BYTES = 256 * 1024 * 1024

/** Environment variable overriding the bound; both the boot bridge and the provider honor it. */
export const HOST_IMPORT_MAX_BYTES_ENV = 'DSH_VM_IMPORT_MAX_BYTES'

/** Options steering {@link packHostWorkspace} and {@link scanHostWorkspace}. */
export interface HostImportOptions {
  /** Bound on the summed file bytes; beyond it packing fails closed. */
  maxBytes?: number
}

/** The packed import payload plus the facts an operator needs in a notice. */
export interface HostImportPayload {
  /** The v0 workspace tar for `openWorld({ workspace: { import } })`. */
  tar: Buffer
  /** Summed file bytes that entered the tar. */
  bytes: number
  /** Symlinks and other non-file, non-directory entries the walk skipped. */
  skippedIrregular: number
}

/**
 * Resolve the effective bound: explicit option, then the env override, then the default.
 * @param option - an explicit per-call bound, when the caller carries one.
 * @param env - the environment holding the override; defaults to the process environment.
 * @returns the effective byte bound for this import.
 */
export function resolveHostImportMaxBytes(option?: number, env: NodeJS.ProcessEnv = process.env): number {
  if (option !== undefined) return option
  const raw = env[HOST_IMPORT_MAX_BYTES_ENV]?.trim()
  if (raw === undefined || raw.length === 0) return DEFAULT_HOST_IMPORT_MAX_BYTES
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${HOST_IMPORT_MAX_BYTES_ENV} must be a positive safe integer, got ${JSON.stringify(raw)}`)
  }
  return parsed
}

/**
 * Sum the file bytes one import would carry, without packing anything:
 * the boot bridge's metadata-only pre-scan.
 * @param root - the host directory an import would pack.
 * @returns summed file bytes; irregular entries do not count.
 */
export async function scanHostWorkspace(root: string): Promise<number> {
  const { bytes } = await walkHostWorkspace(root, { collect: false, maxBytes: Number.MAX_SAFE_INTEGER })
  return bytes
}

/**
 * Pack the host directory into one v0 workspace tar (deterministic order,
 * files and directories only, symlinks skipped and counted).
 * @param root - the host directory to import.
 * @param options - the byte bound; exceeding it throws {@link HostWorkspaceTooLargeError}.
 * @returns the tar, the summed file bytes, and the skipped-entry count.
 */
export async function packHostWorkspace(root: string, options: HostImportOptions = {}): Promise<HostImportPayload> {
  const maxBytes = resolveHostImportMaxBytes(options.maxBytes)
  const { entries, bytes, skipped } = await walkHostWorkspace(root, { collect: true, maxBytes })
  return { tar: packWorkspaceTar(entries), bytes, skippedIrregular: skipped }
}

/**
 * Guest memory the boot should carry for one import payload: the world's
 * root filesystem is a ramfs, so the payload rides guest RAM — two bytes of
 * headroom per payload byte plus the 256 MiB baseline (M5 measured a 100 MiB
 * payload wanting 512 MiB).
 * @param payloadBytes - summed file bytes entering the import.
 * @param configured - the operator's `memoryMiB` when set.
 * @returns the effective `memoryMiB` for this boot.
 */
export function importMemoryMiB(payloadBytes: number, configured: number): number {
  const payloadMiB = Math.ceil(payloadBytes / (1024 * 1024))
  return Math.max(configured, payloadMiB * 2 + 256)
}

/** One walk's outcome: entries for packing, or just the byte sum for scanning. */
interface WalkOutcome {
  entries: WorkspaceEntry[]
  bytes: number
  skipped: number
}

interface WalkConfig {
  collect: boolean
  maxBytes: number
}

/** Walk the host tree deterministically (name-sorted per directory), skipping irregular entries. */
async function walkHostWorkspace(root: string, config: WalkConfig): Promise<WalkOutcome> {
  const entries: WorkspaceEntry[] = []
  let bytes = 0
  let skipped = 0
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const children = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      const childPath = join(directory, child.name)
      const entryPath = prefix.length === 0 ? child.name : `${prefix}/${child.name}`
      if (child.isDirectory()) {
        entries.push({ path: entryPath, kind: 'dir' })
        await walk(childPath, entryPath)
        continue
      }
      if (!child.isFile()) {
        skipped += 1
        continue
      }
      if (config.collect) {
        const data = await readFile(childPath)
        entries.push({ path: entryPath, kind: 'file', data })
        bytes += data.byteLength
      } else {
        bytes += (await stat(childPath)).size
      }
      if (bytes > config.maxBytes) throw new HostWorkspaceTooLargeError(root, bytes, config.maxBytes)
    }
  }
  await walk(root, '')
  return { entries, bytes, skipped }
}

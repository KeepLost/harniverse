/**
 * Resolve and load generic hook configuration sources without registering a
 * Cordis plugin. Bridges call this at the start of each automatic-discovery
 * event, so a source edit is visible to the next event without changing an
 * event that already captured its snapshot.
 * @module @deepseek-ai/dsh-hook-protocol/discovery
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type {
  HookConfigDiscovery,
  HookConfigLayer,
  HookConfigSnapshot,
  HookConfigSource,
} from './types.ts'

const DISCOVERY_LAYERS: readonly HookConfigLayer[] = ['user', 'project', 'plugin', 'policy']

/** Freeze a parsed JSON value and all of its descendants. */
function freezeValue(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return
  Object.freeze(value)
  for (const child of Object.values(value)) freezeValue(child)
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function pathFor(
  layer: HookConfigLayer,
  filename: string,
  cwd: string | undefined,
  root: string | undefined,
): string | undefined {
  if (filename.length === 0) return undefined
  if (layer === 'project') return cwd === undefined ? undefined : resolve(cwd, filename)
  if (isAbsolute(filename)) return resolve(filename)
  return root === undefined ? undefined : resolve(root, filename)
}

/**
 * Resolve configured source names in `user`, `project`, `plugin`, `policy`
 * order. The default is only `hooks.json` in a supplied session cwd. Project
 * sources are omitted when no session cwd exists, rather than using the host
 * process cwd. A resolved path appears at most once.
 * @param cwd - the session workspace used for relative project paths.
 * @param discovery - optional generic source roots and layer path lists.
 * @returns immutable resolved source descriptors in execution order.
 */
export function discoverHookConfigSources(
  cwd: string | undefined,
  discovery: HookConfigDiscovery = {},
): readonly HookConfigSource[] {
  const root = discovery.root === undefined || discovery.root.length === 0
    ? undefined
    : resolve(discovery.root)
  const paths: Readonly<Record<HookConfigLayer, readonly string[]>> = {
    user: discovery.user ?? [],
    project: discovery.project ?? ['hooks.json'],
    plugin: discovery.plugin ?? [],
    policy: discovery.policy ?? [],
  }
  const seen = new Set<string>()
  const sources: HookConfigSource[] = []
  for (const layer of DISCOVERY_LAYERS) {
    for (const filename of paths[layer]) {
      const path = pathFor(layer, filename, cwd, root)
      if (path === undefined || seen.has(path)) continue
      seen.add(path)
      sources.push(Object.freeze({ layer, path }))
    }
  }
  return Object.freeze(sources)
}

/**
 * Read and parse each resolved source independently. A failed source is
 * retained in `failures` while healthy sources remain available. The source
 * JSON and parser result are recursively frozen before being returned.
 * @param sources - resolved files from {@link discoverHookConfigSources}.
 * @param parse - dialect-owned parser for one decoded JSON source.
 * @returns an immutable per-event snapshot.
 */
export function readHookConfigSnapshot<T>(
  sources: readonly HookConfigSource[],
  parse: (raw: unknown, source: HookConfigSource) => T,
): HookConfigSnapshot<T> {
  const loaded: { source: HookConfigSource; value: T }[] = []
  const failures: HookConfigSnapshot<T>['failures'][number][] = []
  for (const source of sources) {
    try {
      const raw: unknown = JSON.parse(readFileSync(source.path, 'utf8'))
      freezeValue(raw)
      const value = parse(raw, source)
      freezeValue(value)
      loaded.push(Object.freeze({ source, value }))
    } catch (error: unknown) {
      if (!isMissingFile(error)) failures.push(Object.freeze({ source, error }))
    }
  }
  return Object.freeze({ loaded: Object.freeze(loaded), failures: Object.freeze(failures) })
}

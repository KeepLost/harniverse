/** The installed app manifest owns its bundle order and shipped Agent Presets. */
import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadOverlayPatches, readProfileManifest, resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Resolver anchor shared by source and built layouts. */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/**
 * Read the app's profile tuple and layer its bundle patches over an empty tree.
 * @param anchor - installed app manifest, also the dependency resolver anchor.
 * @returns patches consumed unchanged by the Cordis Loader.
 */
export function composeRemoteServer(anchor: string = INSTALL_ANCHOR): PatchOptions[] {
  const dir = dirname(anchor)
  const manifest = readProfileManifest('dsh-remote-server', dir)
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.length === 0) throw new Error('remote-server: profile must declare bundles')
  const patches = bundles.flatMap((name) => {
    const root = name === manifest.name ? dir : resolveBundleDir('dsh-remote-server', name, anchor, dir)
    const bundle = readProfileManifest('dsh-remote-server', root)
    const patch = bundle.dsh?.bundle?.patch
    if (typeof patch !== 'string') throw new Error(`remote-server: ${name} declares no bundle patch`)
    return loadOverlayPatches('dsh-remote-server', join(root, patch))
  })
  const rows = new Map(composeEntries([patches]).map(row => [row.id, row]))
  const cli = resolveBundleDir('dsh-remote-server', '@deepseek-ai/dsh', anchor, dir)
  const presets = join(cli, 'config', 'agent-presets')
  if (!statSync(presets).isDirectory()) throw new Error('remote-server: shipped Agent Presets are missing')
  patches.push({
    id: 'agent-presets',
    config: {
      ...rows.get('agent-presets')?.config as object,
      roots: [{ path: presets, trust: 'system' }],
    },
  })
  patches.push({ id: 'remote-hosts', config: { dshHome: dshHomePath(), artifactsRoot: dshHomePath('artifacts') } })
  return patches
}

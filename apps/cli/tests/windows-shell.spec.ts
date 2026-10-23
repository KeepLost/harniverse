/**
 * The shipped shell composition: the base bundle gates both shell stacks on
 * the boot-published `$DSH_SHELL_BACKEND` (`disabled: !!js` pairs over the
 * env value with a platform fallback), so exactly one shell stack mounts per
 * host and no separate platform layer exists — the launcher applies nothing
 * beyond the bundle layers. The spec composes the REAL shipped bundle layers
 * (dsh-base + dsh-web-app resolved from the app installation anchor) through
 * the boot's patch algorithm and pins the effective per-platform roster, the
 * git-bash preference swap, the preset-level gates that keep tool-bash out of
 * win32 sessions and tool-pwsh out of POSIX sessions, and the cold-start
 * resolution closure for the shell rows' bare plugin names.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, initProfile, loadProfile, PROFILES_DIR } from '@deepseek-ai/dsh-app-boot'

/**
 * The effective disabled state of one row on one platform and backend
 * selection: a `!!js` expression evaluates with a scoped `process` (platform
 * plus a `$DSH_SHELL_BACKEND` mapping) so every outcome pins on any host.
 */
function disabledOn(
  row: { disabled?: unknown },
  platform: 'win32' | 'linux',
  backend?: 'bash' | 'pwsh',
): boolean {
  const value = row.disabled
  if (value !== null && typeof value === 'object' && '__jsExpr' in value) {
    return Boolean(evaluate(
      { process: { platform, env: { DSH_SHELL_BACKEND: backend } } },
      (value as { __jsExpr: string }).__jsExpr,
    ))
  }
  return value === true
}

describe('the shipped shell composition (real bundle layers)', () => {
  let home: string
  afterEach(() => { if (home !== undefined) rmSync(home, { recursive: true, force: true }) })
  // The app installation anchor, mirroring profile-boot.ts: the bundle layers
  // resolve from the REAL dsh-base/dsh-web-app packages through it, so this
  // suite composes the shipped patch files, not test fixtures.
  const anchor = fileURLToPath(new URL('../package.json', import.meta.url))

  it('composes the confined pwsh roster on win32 and the bash roster on POSIX from the same rows', () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-windows-home-'))
    initProfile(join(home, PROFILES_DIR, 'web'), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const profile = loadProfile('dsh', 'web', anchor, home)
    const warnings: string[] = []
    const rows = composeEntries(
      profile.layers.map(layer => layer.patches),
      message => warnings.push(message),
    )
    const byId = new Map(rows.map(row => [row.id, row]))
    // One shared patch set, two rosters: the shell stacks gate themselves on
    // the boot-published backend, falling back to the platform split when the
    // value is unset.
    for (const id of ['bash-sandbox', 'pwsh-sandbox', 'tool-bash', 'tool-pwsh']) {
      expect(byId.has(id), `row ${id}`).toBe(true)
    }
    expect(disabledOn(byId.get('bash-sandbox')!, 'win32'), 'bash-sandbox on win32').toBe(true)
    expect(disabledOn(byId.get('bash-sandbox')!, 'linux'), 'bash-sandbox on linux').toBe(false)
    expect(disabledOn(byId.get('pwsh-sandbox')!, 'win32'), 'pwsh-sandbox on win32').toBe(false)
    expect(disabledOn(byId.get('pwsh-sandbox')!, 'linux'), 'pwsh-sandbox on linux').toBe(true)
    // A published selection replaces the platform split: git-bash composes
    // the confined bash roster on win32, and an explicit pwsh keeps it on POSIX.
    expect(disabledOn(byId.get('bash-sandbox')!, 'win32', 'bash'), 'bash-sandbox on win32 under git-bash').toBe(false)
    expect(disabledOn(byId.get('pwsh-sandbox')!, 'win32', 'bash'), 'pwsh-sandbox on win32 under git-bash').toBe(true)
    expect(disabledOn(byId.get('bash-sandbox')!, 'linux', 'pwsh'), 'bash-sandbox on linux under pwsh').toBe(true)
    expect(disabledOn(byId.get('pwsh-sandbox')!, 'linux', 'pwsh'), 'pwsh-sandbox on linux under pwsh').toBe(false)
    // Host shell-tool rows are disabled on every platform; sessions mount
    // their own rows instead.
    expect(byId.get('tool-bash')?.disabled).toBe(true)
    expect(byId.get('tool-pwsh')?.disabled).toBe(true)
    // The permission surface never moves: the sandbox/policy rows, the
    // permission switcher, fs-sandbox, and the approval service stay enabled
    // exactly as on POSIX — the confined pwsh executor is what changes.
    for (const id of ['permission', 'ui-permission', 'sandbox', 'sandbox-policy', 'fs-sandbox', 'approval']) {
      expect(byId.get(id)?.disabled, `row ${id}`).not.toBe(true)
    }
    // The launcher's cold-start module fallback BFS-links the apps/cli
    // dependency closure into the profile's node_modules, so every bare
    // plugin name in the base patch must resolve from there.
    const cliManifest = JSON.parse(readFileSync(anchor, 'utf8')) as { dependencies?: Record<string, string> }
    for (const name of [
      '@deepseek-ai/dsh-pwsh-sandbox',
      '@deepseek-ai/dsh-tool-pwsh',
      '@deepseek-ai/dsh-shell-backend-settings',
    ]) {
      expect(cliManifest.dependencies?.[name], `cold-start closure must reach ${name}`).toBeDefined()
    }
    expect(warnings).toEqual([])
  })

  it('base-only profiles carry both stacks with the same platform gating', () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-windows-home-'))
    initProfile(join(home, PROFILES_DIR, 'base-only'), ['@deepseek-ai/dsh-base'])
    const profile = loadProfile('dsh', 'base-only', anchor, home)
    const warnings: string[] = []
    const rows = composeEntries(
      profile.layers.map(layer => layer.patches),
      message => warnings.push(message),
    )
    const byId = new Map(rows.map(row => [row.id, row]))
    for (const id of ['bash-sandbox', 'tool-bash', 'pwsh-sandbox', 'tool-pwsh']) {
      expect(byId.has(id), `row ${id}`).toBe(true)
    }
    // No web overlay: the tool rows keep their own gating, with the same
    // backend swap over the platform split.
    expect(disabledOn(byId.get('tool-bash')!, 'win32'), 'tool-bash on win32').toBe(true)
    expect(disabledOn(byId.get('tool-bash')!, 'linux'), 'tool-bash on linux').toBe(false)
    expect(disabledOn(byId.get('tool-pwsh')!, 'win32'), 'tool-pwsh on win32').toBe(false)
    expect(disabledOn(byId.get('tool-pwsh')!, 'linux'), 'tool-pwsh on linux').toBe(true)
    expect(disabledOn(byId.get('tool-bash')!, 'win32', 'bash'), 'tool-bash on win32 under git-bash').toBe(false)
    expect(disabledOn(byId.get('tool-pwsh')!, 'win32', 'bash'), 'tool-pwsh on win32 under git-bash').toBe(true)
    expect(warnings).toEqual([])
  })
})

describe('shipped agent presets gate both shell tools by platform', () => {
  const presetRoot = resolve(fileURLToPath(new URL('../package.json', import.meta.url)), '..', 'config', 'agent-presets')

  it.each(['standard', 'code', 'minimal', 'cordis'])('preset %s gates its shell tool rows by platform', (preset) => {
    const entries: unknown = yaml.load(
      readFileSync(join(presetRoot, preset, 'agent.cordis.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(entries)) throw new TypeError(`preset ${preset} must parse to an entry array`)
    for (const [id, win32] of [['tool-bash', true], ['tool-pwsh', false]] as const) {
      const row = entries.find((entry): entry is Record<string, unknown> => (
        typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).id === id
      ))
      if (row === undefined) throw new TypeError(`preset ${preset} must mount ${id}`)
      expect(row.disabled).toMatchObject({ __jsExpr: expect.any(String) as string })
      // A platform-and-backend scoped context pins every outcome on any host:
      // the platform split when the boot value is unset, and the published
      // selection when it carries one.
      const expression = (row.disabled as { __jsExpr: string }).__jsExpr
      const on = (platform: 'win32' | 'linux', backend?: 'bash' | 'pwsh'): boolean =>
        Boolean(evaluate({ process: { platform, env: { DSH_SHELL_BACKEND: backend } } }, expression))
      expect(on('win32'), `${id} on win32`).toBe(win32)
      expect(on('linux'), `${id} on linux`).toBe(!win32)
      // A published selection replaces the platform split on both sides.
      expect(on('win32', 'bash'), `${id} on win32 under git-bash`).toBe(id === 'tool-bash' ? false : true)
      expect(on('linux', 'pwsh'), `${id} on linux under pwsh`).toBe(id === 'tool-bash' ? true : false)
    }
  })

})

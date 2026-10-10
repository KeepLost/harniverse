/**
 * REAL-composition coverage: a test-only cordis.yml booted through the vendored
 * Loader mounts the file settings provider, the web server, a stand-in for the
 * theme plugin's `ui-theme` section, and the skin library. Every assertion
 * observes what the composition produces: the settings registry, the index
 * HTML the web server renders through its taps, and the Remote service.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import z from '@deepseek-ai/schemastery'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import SkinLibrary from '../src/index.ts'
import { PACK_FORMAT } from '../src/pack.ts'
import { BUILTIN_SKINS } from '../src/palette.ts'
import { wallpaperHash } from '../src/wallpaper.ts'

const THEME = settingsNamespace('ui-theme')
const SKIN = settingsNamespace('ui-skin')
const INDEX = '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('composition')])

function packText(id: string, accent: string): string {
  return JSON.stringify({
    format: PACK_FORMAT,
    version: 1,
    id,
    name: { zh: '手工', en: 'Hand' },
    colorScheme: 'light',
    tokens: {
      '--dsw-accent': accent,
      '--dsw-alias-bg-base': '#ffffff',
      '--dsw-alias-bg-layer-1': '#f8f8f8',
      '--dsw-alias-border-l1': '#eeeeee',
      '--dsw-alias-border-l2': '#dddddd',
      '--dsw-alias-label-primary': '#111111',
      '--dsw-alias-label-secondary': '#555555',
    },
  })
}

interface Composition {
  readonly ctx: Context
  readonly root: string
  readonly library: string
  readonly service: SkinLibrary
  /** The stand-in `ui-theme` scope; updating it models the user selecting a theme. */
  readonly theme: SettingsScope<{ preference: string }> | undefined
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(options: { preference?: string; full?: boolean } = {}): Promise<Composition> {
  const full = options.full ?? true
  root = await mkdtemp(join(tmpdir(), 'dsh-skin-composition-'))
  const library = join(root, 'skins')
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, `ui-theme:\n  preference: ${JSON.stringify(options.preference ?? 'system')}\n`)
  let theme: SettingsScope<{ preference: string }> | undefined
  // Stand-in for the theme plugin's host half, which owns the `ui-theme` section.
  const themeSection = {
    name: 'test-ui-theme-section',
    apply(ctx: Context) {
      ctx.inject(['settings'], (settingsCtx) => {
        theme = settingsCtx.settings.register(THEME, z.object({ preference: z.string().default('system') }))
      })
    },
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    ...full
      ? [
        '- id: settings',
        "  name: '@deepseek-ai/dsh-settings-file'",
        '  config:',
        `    path: ${JSON.stringify(settingsPath)}`,
        '    watch: false',
        "- name: '@deepseek-ai/dsh-host-webserver'",
        '  config:',
        "    host: '127.0.0.1'",
        '    port: 0',
        '- name: test-ui-theme-section',
      ]
      : [],
    '- id: skin-library',
    "  name: '@deepseek-ai/dsh-host-skin-library'",
    '  config:',
    `    dir: ${JSON.stringify(library)}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['test-ui-theme-section', themeSection],
    ['@deepseek-ai/dsh-host-skin-library', SkinLibrary],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, root, library, service: ctx.get('skinLibrary') as SkinLibrary, theme }
}

function renderIndex(ctx: Context): string {
  return ctx.get('webServer')!.applyIndexTaps(INDEX)
}

describe('skin-library real composition', () => {
  it('registers the ui-skin section with the contract defaults', async () => {
    const { ctx } = await boot()
    const settings = ctx.get('settings')!
    expect(settings.describe().map(entry => entry.ns)).toEqual(expect.arrayContaining(['ui-theme', 'ui-skin']))
    expect(settings.get(SKIN)).toEqual({
      accent: '', wallpaper: '', wallpaperBlur: 0, panelOpacity: 0.82, composerOpacity: 0.9, popoverOpacity: 0.96, material: 'off',
    })
    await settings.update(SKIN, { accent: '#112233', wallpaperBlur: 12 })
    expect(settings.get(SKIN)).toMatchObject({ accent: '#112233', wallpaperBlur: 12 })
    await expect(settings.update(SKIN, { panelOpacity: 0.1 })).rejects.toThrow()
    await expect(settings.update(SKIN, { material: 'glass' })).rejects.toThrow()
  })

  it('embeds the stored built-in skin in the rendered index, after the body content', async () => {
    const { ctx } = await boot({ preference: 'skin:abyss' })
    const html = renderIndex(ctx)
    expect(html.indexOf('<script>')).toBeGreaterThan(html.indexOf('src="/main.js"'))
    expect(html.endsWith('</script></body></html>')).toBe(true)
    for (const [name, value] of Object.entries(BUILTIN_SKINS[0]!.tokens)) expect(html).toContain(`"${name}":"${value}"`)
    expect(html).toContain('"dark":true')
  })

  it('follows the stored preference: pack skins appear, unresolvable and built-in themes leave the index alone', async () => {
    const { ctx, library, service, theme } = await boot()
    expect(renderIndex(ctx)).toBe(INDEX)

    const result = await service.importPack(packText('hand-made', '#abcdef'))
    expect(result).toMatchObject({ status: 'imported', skin: { id: 'hand-made', source: 'pack' } })
    await theme!.update({ preference: 'skin:hand-made' })
    const html = renderIndex(ctx)
    expect(html).toContain('"--dsw-accent":"#abcdef"')
    expect(html).toContain('"dark":false')

    // A file dropped in by hand is read on the next index render, with no restart.
    await writeFile(join(library, 'packs', 'dropped.json'), packText('dropped', '#123456'))
    await theme!.update({ preference: 'skin:dropped' })
    expect(renderIndex(ctx)).toContain('"--dsw-accent":"#123456"')

    for (const preference of ['skin:ghost', 'skin:Bad Id', 'light', 'dark', 'system']) {
      await theme!.update({ preference })
      expect(renderIndex(ctx), preference).toBe(INDEX)
    }
  })

  it('serves the catalog and manages packs and wallpapers through the Remote methods', async () => {
    const { library, service } = await boot()
    const first = await service.list()
    expect(first.skins.map(skin => skin.id)).toEqual(BUILTIN_SKINS.map(skin => skin.id))
    expect(first.limits).toEqual({ maxPackBytes: 262144, maxWallpaperBytes: 8388608, maxWallpapers: 24 })
    expect(first).toMatchObject({ wallpapers: [], rejected: [] })

    await mkdir(join(library, 'packs'), { recursive: true })
    await writeFile(join(library, 'packs', 'broken.json'), '{')
    expect(await service.importPack(packText('zz-pack', '#010203'))).toMatchObject({ status: 'imported' })
    expect(await service.importPack(packText('zz-pack', '#010204'))).toMatchObject({ status: 'replaced', skin: { tokens: { '--dsw-accent': '#010204' } } })
    const rejectedImport = await service.importPack(packText('abyss', '#010203'))
    expect(rejectedImport).toMatchObject({ status: 'rejected' })
    expect(rejectedImport.status === 'rejected' && rejectedImport.issues.join(' ')).toContain('built-in skin')
    const second = await service.list()
    expect(second.skins.map(skin => skin.id)).toEqual([...BUILTIN_SKINS.map(skin => skin.id), 'zz-pack'])
    expect(second.rejected.map(item => item.file)).toEqual(['broken.json'])
    expect(second.rejected[0]!.message).toContain('not valid JSON')
    expect((await stat(join(library, 'packs', 'zz-pack.json'))).isFile()).toBe(true)

    expect(await service.removePack('zz-pack')).toBe(true)
    expect(await service.removePack('zz-pack')).toBe(false)
    expect(await service.removePack('abyss')).toBe(false)

    const hash = wallpaperHash(PNG)
    expect(await service.putWallpaper(PNG.toString('base64'))).toMatchObject({ status: 'stored', wallpaper: { hash, mime: 'image/png', bytes: PNG.length } })
    expect(await service.putWallpaper(PNG.toString('base64'))).toMatchObject({ status: 'existing' })
    expect(await service.putWallpaper('not base64!')).toEqual({ status: 'rejected', reason: 'invalid-encoding' })
    expect(await service.putWallpaper(Buffer.from('<svg/>').toString('base64'))).toEqual({ status: 'rejected', reason: 'unsupported-type' })
    expect((await service.list()).wallpapers.map(wallpaper => wallpaper.hash)).toEqual([hash])
    expect(await service.readWallpaper(hash)).toEqual({ mime: 'image/png', contentBase64: PNG.toString('base64') })
    expect(await readFile(join(library, 'wallpapers', `${hash}.png`))).toEqual(PNG)
    expect(await service.readWallpaper('0'.repeat(64))).toBeUndefined()
    expect(await service.removeWallpaper(hash)).toBe(true)
    expect(await service.removeWallpaper(hash)).toBe(false)
    expect(await service.readWallpaper(hash)).toBeUndefined()
  })

  it('gates the Remote methods behind observe and administer capabilities', async () => {
    const { service } = await boot()
    const gates = Object.fromEntries(remoteMethods(service).map(marker => [marker.exportName ?? marker.method, marker.requiredCapability]))
    expect(gates).toEqual({
      list: 'harniverse.observe',
      readWallpaper: 'harniverse.observe',
      importPack: 'harniverse.administer',
      removePack: 'harniverse.administer',
      putWallpaper: 'harniverse.administer',
      removeWallpaper: 'harniverse.administer',
    })
  })

  it('releases the settings section and the index tap when its fiber is disposed (HMR safety)', async () => {
    const { ctx, theme } = await boot({ preference: 'skin:abyss' })
    expect(renderIndex(ctx)).not.toBe(INDEX)
    expect(ctx.get('settings')!.get(SKIN)).toBeDefined()
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'skin-library')
    expect(entry).toBeDefined()
    await entry!.fiber?.dispose()
    expect(renderIndex(ctx)).toBe(INDEX)
    expect(ctx.get('settings')!.get(SKIN)).toBeUndefined()
    expect(ctx.get('settings')!.describe().map(item => item.ns)).not.toContain('ui-skin')
    expect(ctx.get('skinLibrary')).toBeUndefined()
    await theme!.update({ preference: 'skin:abyss' })
  })

  it('serves the library when no settings service or web server is composed', async () => {
    const { ctx, service, library } = await boot({ full: false })
    expect(ctx.get('settings')).toBeUndefined()
    expect(ctx.get('webServer')).toBeUndefined()
    expect(await service.importPack(packText('solo', '#0a0b0c'))).toMatchObject({ status: 'imported' })
    expect((await service.list()).skins.map(skin => skin.id)).toContain('solo')
    expect((await stat(library)).isDirectory()).toBe(true)
  })

  it('refuses a relative library directory at construction', async () => {
    const ctx = new Context()
    context = ctx
    await expect(ctx.plugin(SkinLibrary, { dir: 'relative/skins' }).await())
      .rejects.toThrow('skin-library dir must be absolute, got "relative/skins"')
  })
})

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadProfile } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'
import { desktopEntries, prepareDesktopProfile } from '../src/profile.ts'

it('adapts the shipped downstream web profile with authenticated loopback and native providers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'desktop-profile-'))
  try {
    const anchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
    const profile = loadProfile('desktop-test', 'web', anchor, home, { userLayer: false })
    const entries = desktopEntries(composeEntries(profile.layers.map(layer => layer.patches)), home, anchor)
    const defaults = composeEntries(profile.layers.map(layer => layer.patches))
    for (const entry of defaults.filter(entry => entry.disabled)) {
      expect(entries.find(candidate => candidate.id === entry.id)?.disabled, entry.id).toEqual(entry.disabled)
    }
    expect(entries.find(entry => entry.id === 'tool-bash')?.disabled).toBe(true)
    expect(entries.find(entry => entry.id === 'tool-pwsh')?.disabled).toBe(true)
    expect(entries.find(entry => entry.id === 'authentication')).toMatchObject({
      name: '@deepseek-ai/dsh-authentication-local', config: { mode: 'authenticated', dshHome: home }, disabled: false,
    })
    expect(entries.find(entry => entry.id === 'webserver')).toMatchObject({
      name: 'cordis:desktop-webserver', config: { host: '127.0.0.1', port: 19387 }, disabled: false,
    })
    expect(entries.find(entry => entry.id === 'directory-picker')?.name).toBe('cordis:desktop-directory-picker')
    expect(entries.find(entry => entry.id === 'scheduler')?.name).toBe('@deepseek-ai/dsh-scheduler')
    expect(entries.find(entry => entry.id === 'browser-controller')?.config ?? {}).not.toHaveProperty('executablePath')
    expect(entries.some(entry => /office|plugin-manager/iu.test(entry.name))).toBe(false)
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('routes the packaged browser from the install anchor and fails before boot when its payload is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-browser-profile-'))
  const home = join(root, 'home')
  try {
    const developmentAnchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
    const profile = loadProfile('desktop-test', 'web', developmentAnchor, home, { userLayer: false })
    const defaults = composeEntries(profile.layers.map(layer => layer.patches))
    const anchor = join(root, 'node_modules/@deepseek-ai/dsh/package.json')
    const executable = join(root, 'browser/chrome')
    await mkdir(join(root, 'browser'))
    await writeFile(executable, 'chromium')
    await chmod(executable, 0o755)
    const inventory = join(root, 'offline-assets.json')
    await writeFile(inventory, JSON.stringify({ browser: { executable: 'browser/chrome' } }))
    const entries = desktopEntries(defaults, home, anchor)
    expect(entries.find(entry => entry.id === 'browser-controller')).toMatchObject({
      name: '@deepseek-ai/dsh-api-browser-controller', disabled: false,
      config: { executablePath: executable, sandbox: 'auto' },
    })
    await writeFile(inventory, JSON.stringify({ browser: { executable: '../outside/chrome' } }))
    expect(() => desktopEntries(defaults, home, anchor)).toThrow(/browser/)
    await writeFile(inventory, JSON.stringify({ browser: { executable: 'browser/chrome' } }))
    await rm(executable)
    expect(() => desktopEntries(defaults, home, anchor)).toThrow(/browser/)
    await rm(inventory)
    expect(() => desktopEntries(defaults, home, anchor)).toThrow(/browser/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps persisted profile edits byte-for-byte and gives concurrent attempts distinct Loader roots', async () => {
  const home = await mkdtemp(join(tmpdir(), 'desktop-profile-'))
  const anchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
  try {
    const profile = loadProfile('desktop-test', 'web', anchor, home)
    const path = join(profile.dir, 'cordis.yml')
    await writeFile(path, '# user data must survive\n[]\n')
    const first = await prepareDesktopProfile(home, anchor, 0)
    const second = await prepareDesktopProfile(home, anchor, 0)
    expect(first.configPath).not.toBe(second.configPath)
    expect(await readFile(first.configPath, 'utf8')).toBe('[]\n')
    expect(await readFile(path, 'utf8')).toBe('# user data must survive\n[]\n')
    expect(first.entries.find(entry => entry.id === 'webserver')?.config).toMatchObject({ port: 0 })
    await first.dispose(); await second.dispose()
    expect(await readFile(path, 'utf8')).toBe('# user data must survive\n[]\n')
  } finally { await rm(home, { recursive: true, force: true }) }
})

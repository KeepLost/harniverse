import { readFile, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { expect, it } from 'vitest'
import { composeRemoteServer } from '../src/composition.ts'

it('composes the shipped plugin layers into an authenticated loopback-only locked server', async () => {
  const rows = new Map(composeEntries([composeRemoteServer()]).map(row => [row.id, row]))
  expect(rows.get('credentials')?.disabled).toBe(true)
  expect(rows.get('credentials-encrypted')?.name).toBe('@deepseek-ai/dsh-credentials-encrypted')
  expect(rows.get('authentication')?.config).toMatchObject({ mode: 'authenticated' })
  expect(rows.get('webserver')?.config).toMatchObject({ host: '127.0.0.1', port: 0 })
  expect(rows.get('remote-runtime')?.name).toBe('@deepseek-ai/dsh-remote-runtime')
  expect(rows.get('agent-loop')?.inject).toContain('remoteRuntime')
  expect(rows.get('harness-source')?.disabled).toBe(true)
  expect(rows.get('client-hmr')?.disabled).toBe(true)
  expect(rows.get('web-runtime')?.config).toMatchObject({ surfaceContext: false })
  expect(rows.get('directory-picker')?.disabled).toBe(true)
  expect(rows.get('directory-picker-browse')?.name).toBe('@deepseek-ai/dsh-host-directory-picker-browse')
  expect(rows.get('remote-hosts')?.config).toMatchObject({
    dshHome: dshHomePath(),
    artifactsRoot: dshHomePath('artifacts'),
  })
  const preset = rows.get('agent-presets')?.config as { default: string; roots: Array<{ path: string; trust: string }> }
  expect(preset.default).toBe('standard')
  expect(preset.roots).toHaveLength(1)
  expect(preset.roots[0]?.trust).toBe('system')
  expect(await realpath(preset.roots[0]!.path)).toBe(await realpath(fileURLToPath(new URL('../../cli/config/agent-presets/', import.meta.url))))
})

it('retains the CLI package as the shipped preset and plugin dependency closure', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
  expect(manifest.dependencies['@deepseek-ai/dsh']).toBe('workspace:^')
  expect(manifest.dependencies['@deepseek-ai/dsh-authentication-local']).toBe('workspace:^')
  expect(manifest.dsh.profile.bundles).toEqual([
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-remote-server',
  ])
})

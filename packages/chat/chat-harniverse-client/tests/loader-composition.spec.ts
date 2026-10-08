/** Real Loader composition: the client service mounts from yaml over the local credentials provider and signs against a fake carrier. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import HarniverseClient from '../src/index.ts'
import { FakeCarrier } from './fixtures/carrier.ts'
import { restoreInternals } from './helpers.ts'
import { internals } from '../src/internals.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  restoreInternals()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(credentials: Record<string, string>, clientConfig: string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-chat-harniverse-client-loader-'))
  const credentialsPath = join(root, 'credentials.yaml')
  await writeFile(credentialsPath, Object.entries(credentials).map(([key, value]) => `${key}: ${value}\n`).join(''), { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(credentialsPath)}`,
    '    watch: false',
    "- name: '@deepseek-ai/dsh-chat-harniverse-client'",
    ...clientConfig,
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', CredentialsLocal],
    ['@deepseek-ai/dsh-chat-harniverse-client', HarniverseClient],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it('mounts the client with yaml config and calls the carrier with credentials from the local provider', async () => {
    const carrier = new FakeCarrier()
    internals.fetch = carrier.fetch
    carrier.ok('POST /api/host.describe', { bootId: 'boot-7', version: '9' })
    const loaded = await loadYaml(
      { DSH_CHAT_BRIDGE_GRANT_ID: 'grant-1', DSH_CHAT_BRIDGE_SIGNING: carrier.signingKey },
      ['  config:', '    origin: http://127.0.0.1:3081', '    requestTimeoutMs: 5000'],
    )
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.harniverseClient.config).toMatchObject({ origin: 'http://127.0.0.1:3081', requestTimeoutMs: 5_000, grantIdRef: 'DSH_CHAT_BRIDGE_GRANT_ID' })
    await expect(loaded.harniverseClient.describeHost()).resolves.toMatchObject({ bootId: 'boot-7' })
    expect(carrier.requests[0]?.url.origin).toBe('http://127.0.0.1:3081')
    expect(carrier.authRequests[0]?.body).toMatchObject({ grantId: 'grant-1', purpose: 'access-token' })
  })

  it('refuses a mux renewal interval beyond the token lifetime cap at load time', async () => {
    await expect(loadYaml({}, ['  config:', '    muxRenewAfterMs: 900000'])).rejects.toThrow()
  })

  it('fails calls with an actionable error while no Grant was initialized', async () => {
    const carrier = new FakeCarrier()
    internals.fetch = carrier.fetch
    const loaded = await loadYaml({ OTHER: 'x' }, [])
    await expect(loaded.harniverseClient.describeHost()).rejects.toThrow('dsh chat init')
  })
})
